/**
 * Face Reidentifier — Pensadero
 *
 * Re-identifica todas las caras ya detectadas en los _pensadero.json sin
 * necesidad de volver a correr InsightFace sobre las imagenes. Util cuando
 * se añade una persona nueva al registry: las fotos que ya tenian su cara
 * detectada (sin matchear) pasan a estar correctamente asociadas.
 *
 * Requiere que las entries del catalogo tengan `identity.detections` con los
 * embeddings persistidos (base64). Entries antiguas sin ese campo se cuentan
 * en `skippedNoDetections` y solo se actualizan haciendo re-scan con force=true.
 *
 * Diseño:
 *  - Job en background con jobId, status, progreso por WebSocket.
 *  - Idempotente: re-correr no rompe nada, solo recalcula matches.
 *  - Serie y rapido: matching es solo producto escalar; el cuello de botella
 *    es I/O de los catalogos.
 *  - Cancelable.
 */

const fs = require('fs').promises;
const path = require('path');
const { getInstance: getFaceService } = require('./faceService');
const peopleRegistry = require('../peopleRegistry');
const catalogReader = require('../catalogReader');
const { atomicWriteFile, withFileLock, normalizeLockKey } = require('../utils/jsonStore');
const { computeFaceCount, rebuildFaces, inferDemographics } = require('../utils/faceCatalog');

const PENSADERO_CATALOG_FILENAME = '_pensadero.json';

// Yield al event-loop cada N entradas: el matching es CPU sincrono; sin esto un
// catalogo grande congela el server (otras requests, heartbeats WS y los
// propios frames de progreso se encolan y salen a golpes).
const YIELD_EVERY = 200;
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

const activeJobs = new Map();

// Single-flight: solo un re-id global a la vez. Un segundo disparo mientras hay
// uno en curso no lanza un re-walk redundante del arbol entero; se marca como
// "rerun pendiente" y se ejecuta una sola vez al terminar el actual.
let _activeJobId = null;
let _pendingRerun = false;
// Debounce del disparo en background (assign-face): coalescer rafagas de
// asignaciones manuales en un unico re-id tras unos segundos de calma.
let _bgTimer = null;
let _bgOpts = null;
const BG_DEBOUNCE_MS = 4000;

function makeJobId() {
  return `reid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Recorre recursivamente `rootDir` y devuelve todos los archivos _pensadero.json.
 */
async function findCatalogs(rootDir) {
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name.startsWith('$')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile() && ent.name === PENSADERO_CATALOG_FILENAME) {
        results.push(full);
      }
    }
  }
  await walk(rootDir);
  return results;
}

/**
 * Re-identifica una entry concreta del catalogo usando sus detections.
 * Devuelve { changed, hadDetections } indicando si la entry se modifico.
 */
function reidentifyEntry(entry, faceSvc) {
  if (!entry || !entry.identity) return { changed: false, hadDetections: false, newlyTagged: [] };
  const detections = entry.identity.detections;
  if (!Array.isArray(detections) || detections.length === 0) {
    return { changed: false, hadDetections: false, newlyTagged: [] };
  }

  // Snapshot de los person_id actuales antes de mutar — para detectar cambio
  const prevPersonIds = detections.map(d => d.person_id || null);

  // identifyFaces acepta `embedding_b64` (lo decodifica internamente).
  const identified = faceSvc.identifyFaces(detections);

  // Actualizar el person_id por detección (uno-a-uno con cada cara fisica)
  // para que el visor pueda etiquetar cada bbox.
  const newlyTagged = [];
  for (let i = 0; i < detections.length; i++) {
    const det = detections[i];
    // Respetar asignaciones manuales: el usuario las fijo a mano (assign-face).
    // El re-id automatico NO debe recalcularlas ni borrarlas — si no, la propia
    // re-id que dispara assign-face (o un re-id global posterior) borraria la
    // asignacion justo en el caso que la necesitaba (cosine < umbral).
    if (det.assigned_manually) continue;
    const match = identified[i];
    if (match && match.person_id) {
      det.person_id = match.person_id;
      det.display_name = peopleRegistry.getDisplayName(match.person_id);
      det.confidence = match.similarity;
    } else {
      delete det.person_id;
      delete det.display_name;
      delete det.confidence;
    }
    // Etiqueta nueva: esta cara gano (o cambio a) un person_id que antes no
    // tenia. Sirve para el resumen "que cambio" por persona.
    const now = det.person_id || null;
    if (now && now !== prevPersonIds[i]) newlyTagged.push(now);
  }

  // faces[]: deduplicado por person_id (mayor confidence), incluyendo las
  // asignadas a mano. Misma definicion que scan/promote/assign (faceCatalog).
  const newFaces = rebuildFaces(detections, peopleRegistry.getDisplayName);

  // Cambio real: bien el set agregado faces[] cambia, bien alguna detection
  // tiene person_id distinto del previo (caso: una segunda aparicion de la
  // misma persona pasa a estar etiquetada aunque no añada un nombre nuevo)
  const prevFaces = Array.isArray(entry.identity.faces) ? entry.identity.faces : [];
  const sameFaces = prevFaces.length === newFaces.length &&
    prevFaces.every(p => newFaces.find(n => n.person_id === p.person_id && Math.abs((n.confidence || 0) - (p.confidence || 0)) < 1e-4));
  const detectionsChanged = detections.some((det, i) => (det.person_id || null) !== prevPersonIds[i]);

  entry.identity.faces = newFaces;
  entry.identity.face_count = computeFaceCount(detections);
  const demo = inferDemographics(detections);
  entry.demographics = entry.demographics || {};
  if (demo.age_ranges) entry.demographics.age_ranges = demo.age_ranges;
  if (demo.genders) entry.demographics.genders = demo.genders;

  return { changed: !sameFaces || detectionsChanged, hadDetections: true, newlyTagged };
}

/**
 * Re-identifica todos los catalogos bajo `rootDirs`.
 *
 * @param {object} opts
 *   - rootDirs: string[] de rutas raiz a recorrer
 *   - broadcastProgress: fn(data) para WebSocket
 *   - jobId: string opcional
 */
async function reidentifyAll(opts = {}) {
  const {
    rootDirs = [],
    broadcastProgress = () => {},
    jobId = makeJobId(),
    refreshDir,   // opcional: refresca mediaFiles en memoria por carpeta escrita
  } = opts;

  // Single-flight: si ya hay un re-id en curso, no lanzamos un re-walk completo
  // en paralelo (desperdicio de I/O en discos externos y ventana de escritura
  // pisada). Marcamos rerun y devolvemos el job activo. Registramos el jobId
  // entrante como ALIAS del job activo para que el polling de estado del cliente
  // funcione (sin esto, el jobId que devolvio la ruta manual daria 404 para
  // siempre cuando coincide con un re-id de fondo ya en curso).
  if (_activeJobId) {
    _pendingRerun = true;
    const active = activeJobs.get(_activeJobId);
    if (active && jobId !== _activeJobId) {
      activeJobs.set(jobId, active);
      setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
    }
    return active || { jobId: _activeJobId, status: 'running', coalesced: true };
  }

  const faceSvc = getFaceService();
  const job = {
    jobId,
    status: 'running',
    total: 0,
    done: 0,
    changed: 0,
    skippedNoDetections: 0,
    catalogsWritten: 0,
    cancelRequested: false,
    startedAt: Date.now(),
    perPerson: {}, // person_id → nº de caras recien etiquetadas (resumen "que cambio")
  };

  try {
    // Dentro del try para que el finally limpie _activeJobId pase lo que pase.
    _activeJobId = jobId;
    activeJobs.set(jobId, job);
    broadcastProgress({ type: 'reidentify_start', jobId, status: 'Cargando embeddings...' });

    // El matching es 100% JS sobre embeddings ya persistidos: NO necesita el
    // daemon Python. Intentamos arrancarlo best-effort (para display names u
    // otros usos), pero si falla NO abortamos — el re-id funciona offline.
    await faceSvc.init().catch(() => {});
    await faceSvc.loadAllEmbeddings(peopleRegistry.getState().avatarsBase);
    if (faceSvc.embeddingsCache.size === 0) {
      job.status = 'done';
      job.finishedAt = Date.now();
      job.errorMessage = 'No hay personas entrenadas. Sube fotos de referencia y vuelve a intentar.';
      broadcastProgress({ type: 'reidentify_done', jobId, total: 0, done: 0, changed: 0, skippedNoDetections: 0, status: job.errorMessage });
      return job;
    }

    // Localizar todos los _pensadero.json bajo las rutas configuradas
    const catalogPaths = [];
    for (const root of rootDirs) {
      const found = await findCatalogs(root);
      catalogPaths.push(...found);
    }

    if (catalogPaths.length === 0) {
      job.status = 'done';
      job.finishedAt = Date.now();
      broadcastProgress({ type: 'reidentify_done', jobId, total: 0, done: 0, changed: 0, skippedNoDetections: 0, status: 'Sin catalogos para procesar' });
      return job;
    }

    // Pre-pasada LIGERA: contar entradas sin retener los catalogos en RAM.
    // Antes se guardaba cada catalogo parseado (con TODOS los embeddings b64)
    // en un array para toda la vida del job → footprint proporcional a la
    // biblioteca entera. Ahora solo guardamos path + nº de entradas; cada
    // catalogo se relee y libera durante el procesado (memoria acotada a uno).
    let totalEntries = 0;
    const catalogMeta = [];
    for (const cp of catalogPaths) {
      try {
        const raw = await fs.readFile(cp, 'utf-8');
        const catalog = JSON.parse(raw);
        const photosKey = catalog.photos ? 'photos' : (catalog.clips ? 'clips' : 'photos');
        const count = Object.keys(catalog[photosKey] || {}).length;
        totalEntries += count;
        catalogMeta.push({ catalogPath: cp, photosKey });
      } catch (err) {
        console.warn(`[reidentify] no se pudo leer ${cp}: ${err.message}`);
      }
    }

    job.total = totalEntries;
    broadcastProgress({
      type: 'reidentify_progress',
      jobId,
      total: job.total,
      done: 0,
      changed: 0,
      skippedNoDetections: 0,
      catalogsTotal: catalogMeta.length,
      status: `Re-identificando ${job.total} entradas en ${catalogMeta.length} carpetas...`,
      percentage: 0,
    });

    // Procesar carpeta por carpeta (releyendo cada catalogo justo antes de usarlo)
    for (const { catalogPath, photosKey } of catalogMeta) {
      if (job.cancelRequested) { job.status = 'cancelled'; break; }

      // Serializar el ciclo releer->mutar->escribir de ESTE catalogo (lock por
      // path): evita que un promote/assign-face o el re-id de espacios sobre la
      // misma carpeta lean/escriban a la vez y se pierdan asignaciones manuales
      // (lost-update). Carpetas distintas siguen procesandose en paralelo.
      await withFileLock(normalizeLockKey(catalogPath), async () => {
        let catalog;
        try {
          catalog = JSON.parse(await fs.readFile(catalogPath, 'utf-8'));
        } catch (err) {
          console.warn(`[reidentify] no se pudo releer ${catalogPath}: ${err.message}`);
          return;
        }
        const folder = path.dirname(catalogPath);
        const photos = catalog[photosKey] || {};
        let dirty = false;

        for (const basename of Object.keys(photos)) {
          if (job.cancelRequested) break;
          const entry = photos[basename];
          const { changed, hadDetections, newlyTagged } = reidentifyEntry(entry, faceSvc);
          if (!hadDetections) job.skippedNoDetections++;
          if (changed) {
            dirty = true;
            job.changed++;
            for (const pid of newlyTagged) job.perPerson[pid] = (job.perPerson[pid] || 0) + 1;
          }
          job.done++;
          // Yield periodico para no congelar el event-loop en catalogos grandes.
          if (job.done % YIELD_EVERY === 0) await yieldToLoop();
          if (job.done % 25 === 0 || job.done === job.total) {
            broadcastProgress({
              type: 'reidentify_progress',
              jobId,
              total: job.total,
              done: job.done,
              changed: job.changed,
              skippedNoDetections: job.skippedNoDetections,
              catalogsWritten: job.catalogsWritten,
              file: basename,
              folder, // carpeta actual — para mostrar "en qué va"
              percentage: job.total > 0 ? Math.round((job.done / job.total) * 100) : 100,
            });
          }
        }

        if (dirty) {
          catalog.processed = new Date().toISOString();
          try {
            await atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2));
            catalogReader.invalidateCatalog(folder);
            job.catalogsWritten++;
            // Refrescar mediaFiles en memoria de esta carpeta para que el home
            // vea las nuevas etiquetas sin un sync completo (el re-id solo cambia
            // catalogos en disco; sin esto, /api/files seguiria sirviendo lo viejo).
            if (typeof refreshDir === 'function') { try { await refreshDir(folder); } catch {} }
          } catch (err) {
            console.warn(`[reidentify] error escribiendo ${catalogPath}: ${err.message}`);
          }
        }
      });
    }

    job.status = job.cancelRequested ? 'cancelled' : 'done';
    job.finishedAt = Date.now();
    broadcastProgress({
      type: 'reidentify_done',
      jobId,
      total: job.total,
      done: job.done,
      changed: job.changed,
      skippedNoDetections: job.skippedNoDetections,
      catalogsWritten: job.catalogsWritten,
      perPerson: job.perPerson,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      status: job.status === 'cancelled' ? 'Re-identificacion cancelada' : 'Re-identificacion completada',
      percentage: 100,
    });
    return job;
  } catch (err) {
    job.status = 'error';
    job.finishedAt = Date.now();
    job.errorMessage = err.message;
    broadcastProgress({ type: 'reidentify_error', jobId, error: err.message });
    return job;
  } finally {
    setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
    _activeJobId = null;
    // Si llegaron disparos mientras corria, ejecutar UNA rerun coalescida.
    if (_pendingRerun) {
      _pendingRerun = false;
      setImmediate(() => reidentifyAll({ rootDirs, broadcastProgress, refreshDir }).catch(e => console.error('[reidentify-rerun]', e)));
    }
  }
}

/**
 * Disparo en BACKGROUND con debounce (lo usa assign-face). Coalescer una rafaga
 * de asignaciones manuales en un unico re-id tras unos segundos de calma, en
 * vez de lanzar un re-walk completo de la biblioteca por CADA cara asignada.
 */
function requestBackgroundReidentify(opts = {}) {
  _bgOpts = opts;
  if (_bgTimer) clearTimeout(_bgTimer);
  _bgTimer = setTimeout(() => {
    _bgTimer = null;
    const o = _bgOpts; _bgOpts = null;
    if (!o || !Array.isArray(o.rootDirs) || o.rootDirs.length === 0) return;
    // reidentifyAll ya es single-flight: si hay uno corriendo, se coalescer.
    reidentifyAll(o).catch(err => console.error('[reidentify-bg]', err));
  }, BG_DEBOUNCE_MS);
}

/**
 * Reescribe un person_id en TODOS los catalogos:
 *   - toId === null  → BORRAR (purga): quita person_id/display_name/confidence/
 *     assigned_manually de cada deteccion de `fromId`. Lo usa el borrado de
 *     persona para no dejar etiquetas fantasma.
 *   - toId definido  → REMAPEAR fromId→toId (conserva assigned_manually). Lo usa
 *     la fusion de personas para reasignar las caras del perdedor al
 *     superviviente.
 * En ambos casos recalcula faces[]/face_count. Job en background con progreso
 * WebSocket (events reidentify_*).
 */
async function rewritePersonInCatalogs(fromId, toId, opts = {}) {
  const { rootDirs = [], broadcastProgress = () => {}, jobId = makeJobId() } = opts;
  if (!fromId) return { catalogsWritten: 0, facesUpdated: 0 };

  const catalogPaths = [];
  for (const root of rootDirs) {
    const found = await findCatalogs(root);
    catalogPaths.push(...found);
  }

  let catalogsWritten = 0;
  let facesUpdated = 0;
  let processed = 0;
  const toName = toId ? peopleRegistry.getDisplayName(toId) : null;
  const verb = toId ? `Reasignando "${fromId}" → "${toId}"` : `Limpiando "${fromId}"`;

  broadcastProgress({ type: 'reidentify_start', jobId, status: `${verb} en la biblioteca...` });

  for (const catalogPath of catalogPaths) {
    // Lock por path: serializa con re-id, promote y assign-face sobre la misma
    // carpeta para que la reasignacion/limpieza de persona no pise (ni la pisen).
    await withFileLock(normalizeLockKey(catalogPath), async () => {
      let catalog;
      try {
        catalog = JSON.parse(await fs.readFile(catalogPath, 'utf-8'));
      } catch { return; }
      const folder = path.dirname(catalogPath);
      const photos = catalog.photos || catalog.clips || {};
      let dirty = false;

      for (const basename of Object.keys(photos)) {
        const entry = photos[basename];
        const detections = entry?.identity?.detections;
        if (!Array.isArray(detections)) continue;
        let entryChanged = false;
        for (const det of detections) {
          if (det.person_id === fromId) {
            if (toId) {
              det.person_id = toId;
              det.display_name = toName || toId;
              // se conserva confidence y assigned_manually
            } else {
              delete det.person_id;
              delete det.display_name;
              delete det.confidence;
              delete det.assigned_manually;
            }
            entryChanged = true;
            facesUpdated++;
          }
        }
        if (entryChanged) {
          entry.identity.faces = rebuildFaces(detections, peopleRegistry.getDisplayName);
          entry.identity.face_count = computeFaceCount(detections);
          dirty = true;
        }
        processed++;
        if (processed % YIELD_EVERY === 0) await yieldToLoop();
      }

      if (dirty) {
        catalog.processed = new Date().toISOString();
        try {
          await atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2));
          catalogReader.invalidateCatalog(folder);
          catalogsWritten++;
        } catch (err) {
          console.warn(`[rewrite-person] error escribiendo ${catalogPath}: ${err.message}`);
        }
      }
    });
  }

  broadcastProgress({
    type: 'reidentify_done', jobId,
    total: processed, done: processed, changed: facesUpdated,
    catalogsWritten, skippedNoDetections: 0,
    status: toId
      ? `"${fromId}" reasignado a "${toId}" en ${catalogsWritten} carpeta(s)`
      : `"${fromId}" eliminado de ${catalogsWritten} carpeta(s)`,
    percentage: 100,
  });

  return { catalogsWritten, facesUpdated };
}

// Purga (borra) un person_id de los catalogos. Wrapper de rewrite con toId=null.
function purgePersonFromCatalogs(personId, opts = {}) {
  return rewritePersonInCatalogs(personId, null, opts);
}

function getJobStatus(jobId) {
  return activeJobs.get(jobId) || null;
}

function cancelJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  job.cancelRequested = true;
  return true;
}

function isRunning() {
  return _activeJobId !== null;
}

module.exports = {
  reidentifyAll,
  requestBackgroundReidentify,
  purgePersonFromCatalogs,
  rewritePersonInCatalogs,
  getJobStatus,
  cancelJob,
  isRunning,
};
