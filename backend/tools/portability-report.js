#!/usr/bin/env node
/**
 * Reporte de portabilidad — Pensadero (read-only)
 *
 * Diagnostica el estado de portabilidad SIN tocar nada. Lo invoca
 * Pensadero_Doctor.bat. Reporta:
 *   - ruta actual del repo
 *   - bibliotecas configuradas, su id estable y si existen en disco
 *   - library_id duplicados
 *   - folder_names: cuantas claves portables vs legacy (pendientes de migrar)
 *   - favoritos / colecciones / notas: cuantas entradas legacy (por ruta/md5)
 *     siguen pendientes de pasar a mediaKey
 *   - media_cache: entradas sin mediaKey (pendientes de backfill en el proximo sync)
 *
 * Codigo de salida: 0 si no hay nada pendiente; 1 si hay pendientes (para que
 * Doctor lo sume al recuento global).
 */

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(BACKEND_DIR, '..');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}

function isMd5(s) { return typeof s === 'string' && /^[a-f0-9]{32}$/i.test(s) && !s.includes('\\') && !s.includes('/'); }
function isLegacyAbsoluteKey(k) { return typeof k === 'string' && (/^[a-zA-Z]:[\\/]/.test(k) || k.includes('\\')); }

let pending = 0;
const line = (s) => console.log(s);

line('  Repo actual: ' + path.resolve(REPO_DIR));

// --- Bibliotecas ---
const scan = readJson(path.join(BACKEND_DIR, 'scan_paths.json'), []);
const libs = Array.isArray(scan) ? scan : [];
line('');
line('  Bibliotecas configuradas: ' + libs.length);
const idCount = new Map();
for (const l of libs) {
  if (!l || !l.id) continue;
  idCount.set(l.id, (idCount.get(l.id) || 0) + 1);
  const exists = l.path && fs.existsSync(l.path);
  const active = l.isActive ? 'activa' : 'inactiva';
  const dn = l.displayName ? ` "${l.displayName}"` : '';
  line(`    [${exists ? 'OK ' : '!! '}] ${l.id}${dn} ${active} -> ${l.path}${exists ? '' : '  (NO EXISTE)'}`);
  if (!exists && l.isActive) pending++;
}
const dups = [...idCount.entries()].filter(([, n]) => n > 1);
if (dups.length) {
  line('  [!!] library_id DUPLICADOS: ' + dups.map(([id, n]) => `${id} x${n}`).join(', '));
  pending += dups.length;
}

// --- folder_names ---
const fn = readJson(path.join(BACKEND_DIR, 'data', 'folder_names.json'), { folders: {} });
const folders = (fn && fn.folders) || {};
let fnPortable = 0, fnLegacy = 0;
for (const k of Object.keys(folders)) (isLegacyAbsoluteKey(k) ? fnLegacy++ : fnPortable++);
line('');
line(`  folder_names: ${fnPortable} portables, ${fnLegacy} legacy (ruta absoluta)`);
if (fnLegacy > 0) { line('     -> pendiente: node backend/tools/migrate-portable-state.js --apply'); pending++; }

// --- favoritos ---
const favs = readJson(path.join(BACKEND_DIR, 'favorites_persistent.json'), []);
let favLegacy = 0, favPortable = 0;
if (Array.isArray(favs)) for (const f of favs) {
  if (!f || !f.fileId) continue;
  if (f.fileId.includes('\\') || f.fileId.includes('/')) favLegacy++; else favPortable++;
}
line('');
line(`  favoritos: ${favs.length || 0} (${favPortable} mediaKey, ${favLegacy} por ruta legacy)`);
if (favLegacy > 0) { line('     -> pendiente: migrar a mediaKey'); pending++; }

// --- colecciones ---
const cols = readJson(path.join(BACKEND_DIR, 'collections_persistent.json'), []);
let colLegacy = 0, colStatic = 0, colSmart = 0;
if (Array.isArray(cols)) for (const c of cols) {
  if (!c) continue;
  if (c.type === 'smart') { colSmart++; continue; }
  colStatic++;
  for (const m of (c.mediaFiles || [])) {
    if (isMd5(m) || (typeof m === 'string' && (m.includes('\\') || m.includes('/')))) colLegacy++;
  }
}
line('');
line(`  colecciones: ${colStatic} static, ${colSmart} smart; ${colLegacy} miembros legacy (ruta/md5)`);
if (colLegacy > 0) { line('     -> pendiente: migrar a mediaKey'); pending++; }

// --- notas ---
const notes = readJson(path.join(BACKEND_DIR, 'notes_persistent.json'), { files: {}, sessions: {} });
let noteLegacy = 0, notePortable = 0;
for (const k of Object.keys(notes.files || {})) (isMd5(k) ? noteLegacy++ : notePortable++);
line('');
line(`  notas de archivo: ${notePortable} mediaKey, ${noteLegacy} md5 legacy; sesiones: ${Object.keys(notes.sessions || {}).length} (portables por nombre)`);
if (noteLegacy > 0) { line('     -> pendiente: migrar a mediaKey'); pending++; }

// --- media_cache ---
const cache = readJson(path.join(BACKEND_DIR, 'media_cache.json'), {});
let cacheTotal = 0, cacheNoKey = 0;
for (const entry of Object.values(cache || {})) {
  const fd = entry && entry.fileData;
  if (!fd) continue;
  cacheTotal++;
  if (!fd.mediaKey) cacheNoKey++;
}
line('');
line(`  media_cache: ${cacheTotal} entradas, ${cacheNoKey} sin mediaKey (se rellenan en el proximo sync)`);

line('');
if (pending === 0) line('  [OK] Portabilidad: sin pendientes.');
else line(`  [WARN] Portabilidad: ${pending} punto(s) pendiente(s) (ver arriba).`);

process.exit(pending === 0 ? 0 : 1);
