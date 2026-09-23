#!/usr/bin/env node
/**
 * Barrido de etiquetas de cara huerfanas — Pensadero
 *
 * Recorre los `_pensadero.json` de las bibliotecas activas y busca detecciones
 * cuyo `person_id` YA NO EXISTE en `people_registry.json`. Son etiquetas
 * fantasma: el visor les pinta un nombre (getDisplayName cae al propio id) y
 * `GET /api/persons` las lista como persona, pero no se pueden gestionar desde
 * PersonsManager porque no estan en el registry.
 *
 * De donde salen: al borrar una persona, la purga de catalogos corre en
 * `setImmediate` fire-and-forget (personsManageRoutes). Si el proceso muere,
 * la biblioteca estaba desconectada o la peticion llego justo antes de un
 * reinicio, las etiquetas se quedan y nada vuelve a mirarlas.
 *
 * Uso:
 *   node tools/orphan-face-tags.js                  → DRY-RUN, solo informa
 *   node tools/orphan-face-tags.js --apply          → limpia las huerfanas
 *   node tools/orphan-face-tags.js --root "K:\Fotos"  → acota a una raiz
 *   node tools/orphan-face-tags.js --verbose        → lista archivo por archivo
 *
 * Que limpia `--apply`: SOLO las huerfanas (person_id que no esta en el
 * registry), incluidas las `assigned_manually` — si la persona ya no existe, la
 * asignacion manual tampoco vale. Quita person_id/display_name/confidence/
 * assigned_manually y recalcula faces[]/face_count con los helpers compartidos
 * (faceCatalog), asi el significado de esos campos no depende de quien escriba.
 * Escritura atomica CON backup: el sidecar guarda embeddings no regenerables.
 *
 * Que NO limpia: las etiquetas "obsoletas" (persona registrada cuyo embedding
 * ya no re-matchea por encima del umbral). Esas son trabajo del re-identificador
 * — se informan aqui solo para que sepas cuantas tocaria el proximo re-id.
 *
 * Codigo de salida: 0 si no hay huerfanas; 1 si las hay (para Doctor).
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const peopleRegistry = require('../peopleRegistry');
const { getInstance: getFaceService } = require('../services/faceService');
const { atomicWriteFile, withFileLock, normalizeLockKey } = require('../utils/jsonStore');
const { computeFaceCount, rebuildFaces } = require('../utils/faceCatalog');

const BACKEND_DIR = path.join(__dirname, '..');
const CATALOG = '_pensadero.json';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const rootFlag = process.argv.indexOf('--root');
const ROOT_OVERRIDE = rootFlag !== -1 ? process.argv[rootFlag + 1] : null;

// Mismos defaults que server.js, para que el tool mire donde mira el backend.
const DEFAULT_DATA_DIR = path.join(BACKEND_DIR, 'data');
const REGISTRY_PATH = (process.env.PERSONS_REGISTRY || '').trim()
  || path.join(DEFAULT_DATA_DIR, 'people_registry.json');
const AVATARS_BASE = (process.env.PERSONS_AVATARS_BASE || '').trim() || DEFAULT_DATA_DIR;

const line = (s = '') => console.log(s);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}

async function findCatalogs(rootDir) {
  const results = [];
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name.startsWith('$')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && ent.name === CATALOG) results.push(full);
    }
  }
  await walk(rootDir);
  return results;
}

(async () => {
  line();
  line('  Barrido de etiquetas de cara huerfanas' + (APPLY ? '  [APLICAR]' : '  [DRY-RUN]'));
  line('  ' + '-'.repeat(60));

  // --- Registry ---
  // soloLectura: un diagnostico no aparta ni recupera nada del registro.
  const reg = peopleRegistry.loadRegistry(REGISTRY_PATH, AVATARS_BASE, { soloLectura: true });
  if (!reg.ok && reg.count === 0) {
    line(`  ⚠️ No se pudo leer el registry (${REGISTRY_PATH}): ${reg.error}`);
    line('     Sin registry TODA etiqueta pareceria huerfana. Abortando por seguridad.');
    process.exit(2);
  }
  const regIds = new Set(peopleRegistry.getState().personIds);
  line(`  Registry: ${regIds.size} personas (${REGISTRY_PATH})`);

  // --- Embeddings, para el recuento de "obsoletas" (matching puro JS, sin Python) ---
  const faceSvc = getFaceService();
  await faceSvc.loadAllEmbeddings(AVATARS_BASE);
  const threshold = faceSvc.getStatus().threshold;
  line(`  Entrenadas: ${faceSvc.embeddingsCache.size} | umbral de match: ${threshold}`);

  // --- Raices ---
  let roots;
  if (ROOT_OVERRIDE) {
    roots = [{ path: ROOT_OVERRIDE, displayName: ROOT_OVERRIDE }];
  } else {
    const scanPaths = readJson(path.join(BACKEND_DIR, 'scan_paths.json'), []);
    roots = (Array.isArray(scanPaths) ? scanPaths : []).filter(p => p && p.isActive !== false && p.path);
  }
  if (roots.length === 0) {
    line('  ⚠️ No hay bibliotecas activas configuradas. Nada que recorrer.');
    process.exit(0);
  }

  const catalogPaths = [];
  const inaccesibles = [];
  for (const r of roots) {
    if (!fs.existsSync(r.path)) {
      // Importante decirlo: una biblioteca desconectada no es "0 huerfanas",
      // es "no lo se". Sin este aviso el informe mentiria por omision.
      inaccesibles.push(r.path);
      continue;
    }
    catalogPaths.push(...await findCatalogs(r.path));
  }
  line(`  Bibliotecas: ${roots.length} | catalogos encontrados: ${catalogPaths.length}`);
  for (const p of inaccesibles) line(`  ⚠️ INACCESIBLE (no revisada): ${p}`);
  line();

  // --- Recorrido ---
  const huerfanas = new Map();   // person_id → { caras, archivos:Set, manuales }
  const obsoletas = new Map();   // person_id → { caras, archivos:Set }
  let entradas = 0, sinDetections = 0, sinEmbedding = 0, etiquetasOk = 0;
  const detalle = [];
  const dirtyCatalogs = new Map(); // catalogPath → nº de caras a limpiar

  for (const catalogPath of catalogPaths) {
    const catalog = readJson(catalogPath, null);
    if (!catalog) { line(`  ⚠️ ilegible: ${catalogPath}`); continue; }
    const photos = catalog.photos || catalog.clips || {};
    const folder = path.dirname(catalogPath);
    let aLimpiar = 0;

    for (const [basename, entry] of Object.entries(photos)) {
      entradas++;
      const dets = entry && entry.identity && entry.identity.detections;
      if (!Array.isArray(dets)) { sinDetections++; continue; }

      const identified = faceSvc.identifyFaces(dets, threshold);
      dets.forEach((det, i) => {
        if (!det || !det.person_id) return;
        const fileKey = path.join(folder, basename);
        if (!regIds.has(det.person_id)) {
          const e = huerfanas.get(det.person_id)
            || { caras: 0, archivos: new Set(), manuales: 0 };
          e.caras++;
          e.archivos.add(fileKey);
          if (det.assigned_manually) e.manuales++;
          huerfanas.set(det.person_id, e);
          aLimpiar++;
          if (VERBOSE) detalle.push(`     ${det.person_id.padEnd(22)} cara #${i}  ${fileKey}`);
          return;
        }
        const m = identified[i];
        if (m && m.unverifiable) { sinEmbedding++; return; }
        if (det.assigned_manually) { etiquetasOk++; return; }
        if (!m || m.person_id !== det.person_id) {
          const e = obsoletas.get(det.person_id) || { caras: 0, archivos: new Set() };
          e.caras++;
          e.archivos.add(fileKey);
          obsoletas.set(det.person_id, e);
          return;
        }
        etiquetasOk++;
      });
    }
    if (aLimpiar > 0) dirtyCatalogs.set(catalogPath, aLimpiar);
  }

  // --- Informe ---
  const totalHuerfanas = [...huerfanas.values()].reduce((a, e) => a + e.caras, 0);
  const totalObsoletas = [...obsoletas.values()].reduce((a, e) => a + e.caras, 0);

  line(`  Entradas revisadas: ${entradas}`);
  line(`  Etiquetas sanas: ${etiquetasOk}`);
  line();
  line(`  HUERFANAS (person_id que no esta en el registry): ${totalHuerfanas} caras`);
  if (totalHuerfanas === 0) {
    line('     ninguna.');
  } else {
    for (const [pid, e] of [...huerfanas.entries()].sort((a, b) => b[1].caras - a[1].caras)) {
      const dir = path.join(AVATARS_BASE, 'people', pid);
      const restos = fs.existsSync(dir) ? ' | queda carpeta people/' + pid : '';
      const man = e.manuales > 0 ? ` | ${e.manuales} asignadas a mano` : '';
      line(`     ${pid.padEnd(22)} ${String(e.caras).padStart(4)} caras en ${e.archivos.size} archivo(s)${man}${restos}`);
    }
    line(`     en ${dirtyCatalogs.size} catalogo(s)`);
  }
  if (VERBOSE && detalle.length) { line(); detalle.forEach(line); }

  line();
  line(`  OBSOLETAS (persona registrada, pero ya no re-matchea >= ${threshold}): ${totalObsoletas} caras`);
  if (totalObsoletas === 0) {
    line('     ninguna.');
  } else {
    for (const [pid, e] of [...obsoletas.entries()].sort((a, b) => b[1].caras - a[1].caras).slice(0, 15)) {
      line(`     ${pid.padEnd(22)} ${String(e.caras).padStart(4)} caras en ${e.archivos.size} archivo(s)`);
    }
    line('     Este tool NO las toca: las limpia el proximo "Re-identificar biblioteca".');
  }

  line();
  if (sinDetections > 0) {
    line(`  Entradas SIN detections (escaneadas antes de que se guardaran los`);
    line(`  embeddings, o con las caras caidas): ${sinDetections}`);
    line('     No las arregla ni el re-id ni este tool: necesitan re-escaneo con force.');
  }
  if (sinEmbedding > 0) {
    line(`  Etiquetas sin embedding, imposibles de verificar (se conservan): ${sinEmbedding}`);
  }

  // --- Aplicar ---
  if (!APPLY) {
    line();
    line(totalHuerfanas > 0
      ? '  DRY-RUN. Repite con --apply para quitar las huerfanas (con backup .bak).'
      : '  DRY-RUN completado.');
    process.exit(totalHuerfanas > 0 ? 1 : 0);
  }

  if (totalHuerfanas === 0) {
    line();
    line('  Nada que limpiar.');
    process.exit(0);
  }

  line();
  line('  ⚠️ Si hay un escaneo en marcha, PARALO antes: mantiene los catalogos en');
  line('     memoria y su siguiente volcado pisaria esta limpieza.');
  line();

  let escritos = 0, limpiadas = 0;
  for (const catalogPath of dirtyCatalogs.keys()) {
    await withFileLock(normalizeLockKey(catalogPath), async () => {
      const catalog = readJson(catalogPath, null);
      if (!catalog) return;
      const photos = catalog.photos || catalog.clips || {};
      let dirty = false;
      for (const entry of Object.values(photos)) {
        const dets = entry && entry.identity && entry.identity.detections;
        if (!Array.isArray(dets)) continue;
        let cambiada = false;
        for (const det of dets) {
          if (!det || !det.person_id || regIds.has(det.person_id)) continue;
          delete det.person_id;
          delete det.display_name;
          delete det.confidence;
          delete det.assigned_manually;
          cambiada = true;
          limpiadas++;
        }
        if (cambiada) {
          entry.identity.faces = rebuildFaces(dets, peopleRegistry.getDisplayName);
          entry.identity.face_count = computeFaceCount(dets);
          dirty = true;
        }
      }
      if (!dirty) return;
      catalog.processed = new Date().toISOString();
      try {
        await atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2), { backup: true });
        escritos++;
        line(`     limpiado: ${catalogPath}`);
      } catch (err) {
        line(`     ⚠️ no se pudo escribir ${catalogPath}: ${err.message}`);
      }
    });
  }

  line();
  line(`  Hecho: ${limpiadas} etiquetas quitadas en ${escritos} catalogo(s).`);
  line('  Copia previa de cada uno en <catalogo>.bak');
  line('  Reinicia el backend (o lanza un sync) para que el cambio llegue a la UI.');
  process.exit(0);
})().catch(err => {
  console.error('  Error fatal:', err.message);
  process.exit(2);
});
