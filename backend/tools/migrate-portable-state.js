#!/usr/bin/env node
/**
 * Migrador de estado a identidad portable — Pensadero
 *
 * Convierte el estado humano (no regenerable) a claves portables basadas en
 * mediaKey = "<libraryId>:<relativePathNorm>", de forma SEGURA:
 *
 *   - DRY-RUN por defecto: no escribe nada, solo informa que haria.
 *     Para aplicar:  node tools/migrate-portable-state.js --apply
 *   - BACKUP antes de tocar cualquier JSON (copia <archivo>.bak-<timestamp>).
 *   - ADITIVO donde se puede (favoritos, notas, folder_names): NO borra las
 *     claves viejas, solo anade las nuevas portables. Asi convivir = imposible
 *     perder datos. Lo que no se puede mapear queda en "unresolved" sin tocar.
 *
 * Qué migra:
 *   1. scan_paths.json     -> rellena esquema portable (displayName, role).
 *   2. folder_names.json   -> anade clave portable "<libraryId>:<relDir>" para
 *                             cada clave legacy absoluta que resuelva.
 *   3. notes (files)       -> anade nota bajo mediaKey para cada fileId md5 que
 *                             resuelva (la nota md5 se conserva).
 *   4. favorites           -> anade favorito bajo mediaKey para cada entrada por
 *                             ruta que resuelva (la entrada vieja se conserva).
 *   5. collections (static)-> reescribe mediaFiles ruta/md5 -> mediaKey cuando
 *                             resuelva (se conserva backup del archivo entero).
 *
 * El mapeo md5/ruta -> mediaKey se reconstruye desde media_cache.json (que tiene
 * fullPath + id + mediaKey tras un sync) y, si falta, calculando desde
 * scan_paths. Por eso conviene ejecutar tras al menos un sync.
 */

const fs = require('fs');
const path = require('path');
const mediaIdentity = require('../utils/mediaIdentity');

const BACKEND_DIR = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

const FILES = {
  scanPaths: path.join(BACKEND_DIR, 'scan_paths.json'),
  folderNames: path.join(BACKEND_DIR, 'data', 'folder_names.json'),
  notes: path.join(BACKEND_DIR, 'notes_persistent.json'),
  favorites: path.join(BACKEND_DIR, 'favorites_persistent.json'),
  collections: path.join(BACKEND_DIR, 'collections_persistent.json'),
  mediaCache: path.join(BACKEND_DIR, 'media_cache.json'),
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`  ⚠️ No se pudo leer ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

function backupAndWrite(file, data) {
  if (!APPLY) return;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, bak);
    console.log(`  💾 backup: ${path.basename(bak)}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  ✅ escrito: ${path.basename(file)}`);
}

// Clave canonica legacy de favoritos/colecciones: ruta minusculas + separadores
// colapsados (igual que backend/favoritesManager.js y src/utils/formatData.ts).
function normLegacyPath(p) {
  if (!p) return '';
  return String(p).replace(/\\+/g, '\\').trim().toLowerCase();
}

function isMd5(s) {
  return typeof s === 'string' && /^[a-f0-9]{32}$/i.test(s) && !s.includes('\\') && !s.includes('/');
}

function isLegacyAbsoluteKey(key) {
  return /^[a-zA-Z]:[\\/]/.test(key) || key.includes('\\');
}

// Resuelve un dir absoluto a {libraryId, relDir} por prefijo mas largo.
function resolveDirToPortable(absDir, libraries) {
  const target = path.resolve(absDir).toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const lib of libraries) {
    if (!lib || !lib.path || !lib.id) continue;
    const root = path.resolve(lib.path).toLowerCase();
    if (target === root || target.startsWith(root + path.sep) || target.startsWith(root + '/')) {
      if (root.length > bestLen) { best = lib; bestLen = root.length; }
    }
  }
  if (!best) return null;
  const relDir = mediaIdentity.deriveRelativePath(best.path, absDir);
  return { libraryId: best.id, relDir };
}

function main() {
  console.log('========================================');
  console.log('  Pensadero — Migracion a estado portable');
  console.log(`  Modo: ${APPLY ? 'APLICAR (escribe + backups)' : 'DRY-RUN (solo informe)'}`);
  console.log('========================================\n');

  // --- scan_paths + bibliotecas ---
  const rawScan = readJson(FILES.scanPaths, []);
  const libraries = mediaIdentity.migrateScanPaths(Array.isArray(rawScan) ? rawScan : []);
  console.log(`[1/5] scan_paths: ${libraries.length} bibliotecas`);
  const scanChanged = JSON.stringify(rawScan) !== JSON.stringify(libraries);
  if (scanChanged) {
    console.log('  -> se rellenara el esquema portable (displayName/role)');
    backupAndWrite(FILES.scanPaths, libraries);
  } else {
    console.log('  -> ya tiene esquema portable, sin cambios');
  }

  // --- mapeo md5/ruta -> mediaKey desde media_cache ---
  const mediaCache = readJson(FILES.mediaCache, {});
  const idToKey = new Map();
  const pathToKey = new Map();
  let cacheFiles = 0;
  for (const [fullPath, entry] of Object.entries(mediaCache || {})) {
    const fd = entry && entry.fileData;
    if (!fd) continue;
    cacheFiles++;
    let mediaKey = fd.mediaKey;
    if (!mediaKey) {
      const d = mediaIdentity.deriveMediaKeyForPath(fullPath, libraries);
      mediaKey = d && d.mediaKey;
    }
    if (!mediaKey) continue;
    if (fd.id) idToKey.set(fd.id, mediaKey);
    pathToKey.set(normLegacyPath(fullPath), mediaKey);
  }
  console.log(`\n  mapa de identidad: ${idToKey.size} ids md5 y ${pathToKey.size} rutas -> mediaKey (de ${cacheFiles} en cache)`);
  if (cacheFiles === 0) {
    console.log('  ⚠️ media_cache vacio: ejecuta un sync antes para poder mapear notas/favoritos/colecciones por ruta.');
  }

  // --- folder_names (aditivo) ---
  console.log('\n[2/5] folder_names');
  const fn = readJson(FILES.folderNames, { version: 1, folders: {}, updated_at: null });
  const folders = fn.folders || {};
  let fnAdded = 0;
  const fnUnresolved = [];
  for (const [key, val] of Object.entries(folders)) {
    if (!isLegacyAbsoluteKey(key)) continue; // ya portable
    const resolved = resolveDirToPortable(key, libraries);
    if (!resolved) { fnUnresolved.push(key); continue; }
    const pk = mediaIdentity.makeFolderKey(resolved.libraryId, resolved.relDir);
    if (pk && !folders[pk]) {
      folders[pk] = { ...val };
      fnAdded++;
      console.log(`  + ${pk}   (desde ${key})`);
    }
  }
  if (fnUnresolved.length) {
    console.log(`  ⚠️ ${fnUnresolved.length} carpetas no resueltas (fuera de bibliotecas activas), se conservan tal cual:`);
    fnUnresolved.forEach(k => console.log(`      ${k}`));
  }
  if (fnAdded > 0) {
    fn.folders = folders;
    backupAndWrite(FILES.folderNames, fn);
  } else {
    console.log('  -> nada que anadir');
  }

  // --- notes (files, aditivo) ---
  console.log('\n[3/5] notes (por archivo)');
  const notes = readJson(FILES.notes, { version: 1, files: {}, sessions: {} });
  notes.files = notes.files || {};
  let notesAdded = 0;
  const notesUnresolved = [];
  for (const [k, v] of Object.entries({ ...notes.files })) {
    if (!isMd5(k)) continue; // ya es mediaKey u otra cosa
    const mk = idToKey.get(k);
    if (mk && !notes.files[mk]) { notes.files[mk] = v; notesAdded++; console.log(`  + nota ${mk} (desde ${k})`); }
    else if (!mk) notesUnresolved.push(k);
  }
  if (notesUnresolved.length) console.log(`  ⚠️ ${notesUnresolved.length} notas md5 sin mapeo (archivo no en cache), se conservan.`);
  if (notesAdded > 0) backupAndWrite(FILES.notes, notes);
  else console.log('  -> nada que anadir');

  // --- favorites (aditivo) ---
  console.log('\n[4/5] favorites');
  const favs = readJson(FILES.favorites, []);
  let favAdded = 0;
  if (Array.isArray(favs)) {
    const existingKeys = new Set(favs.map(f => f && f.fileId));
    const toAdd = [];
    for (const fav of favs) {
      if (!fav || !fav.fileId) continue;
      if (!fav.fileId.includes('\\') && !fav.fileId.includes('/')) continue; // ya no es ruta
      const mk = pathToKey.get(normLegacyPath(fav.fileId));
      if (mk && !existingKeys.has(mk)) {
        toAdd.push({ ...fav, fileId: mk });
        existingKeys.add(mk);
        favAdded++;
        console.log(`  + favorito ${mk}`);
      }
    }
    if (favAdded > 0) { backupAndWrite(FILES.favorites, favs.concat(toAdd)); }
    else console.log('  -> nada que anadir');
  }

  // --- collections (static, reescribe mediaFiles) ---
  console.log('\n[5/5] collections (static)');
  const cols = readJson(FILES.collections, []);
  let colChanged = 0;
  if (Array.isArray(cols)) {
    for (const col of cols) {
      if (!col || col.type === 'smart' || !Array.isArray(col.mediaFiles)) continue;
      let changed = false;
      col.mediaFiles = col.mediaFiles.map(m => {
        if (typeof m !== 'string') return m;
        let mk = null;
        if (isMd5(m)) mk = idToKey.get(m);
        else if (m.includes('\\') || m.includes('/')) mk = pathToKey.get(normLegacyPath(m));
        if (mk && mk !== m) { changed = true; return mk; }
        return m;
      });
      if (changed) { colChanged++; console.log(`  ~ coleccion "${col.name}" -> mediaFiles a mediaKey`); }
    }
    if (colChanged > 0) backupAndWrite(FILES.collections, cols);
    else console.log('  -> nada que reescribir');
  }

  console.log('\n========================================');
  console.log(APPLY ? '  Migracion APLICADA.' : '  DRY-RUN completado. Repite con --apply para escribir.');
  console.log(`  Resumen: scan_paths ${scanChanged ? 'actualizado' : 'ok'}, folder_names +${fnAdded}, notas +${notesAdded}, favoritos +${favAdded}, colecciones ~${colChanged}`);
  console.log('========================================');
}

main();
