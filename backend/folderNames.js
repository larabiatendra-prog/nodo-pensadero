/**
 * Folder Names — Pensadero
 *
 * Nombres de presentacion (display name) por CARPETA, editables desde el
 * frontend. Resuelve el caso de archivos brutos mal nombrados ("P48931",
 * "PANA_103912") que no aportan ni fecha ni etiquetas utiles: el usuario
 * renombra la carpeta-evento (p.ej. "250412_Viaje, Amsterdam") y TODOS sus
 * archivos heredan ese nombre + las etiquetas/fecha derivadas de el.
 *
 * El archivo FISICO no se toca nunca (regla canonica de Pensadero). Esto es
 * solo una capa de presentacion persistida aparte.
 *
 * Persistencia: `data/folder_names.json` (clave = ruta absoluta normalizada
 * de la carpeta). Formato:
 *   {
 *     "version": 1,
 *     "folders": {
 *       "d:\\fotos\\amsterdam": { "displayName": "250412_Viaje, Amsterdam", "updatedAt": "ISO8601" }
 *     },
 *     "updated_at": "ISO8601"
 *   }
 *
 * Fragilidad asumida: la clave es la RUTA. Si la carpeta fisica se mueve o
 * renombra, el vinculo se pierde (decision de diseno: store central, no
 * sidecar). Mover material es raro y consciente.
 *
 * Enumeracion: cuando una carpeta con override tiene >1 archivo, cada archivo
 * recibe sufijo "_NNN" (orden natural por nombre fisico) para desambiguar:
 *   250412_Viaje, Amsterdam_001 ... _069
 * El indice es solo-digitos => `extractSmartTags` lo descarta, no ensucia tags.
 */

const path = require('path');
const fs = require('fs').promises;
const { atomicWriteFile } = require('./utils/jsonStore');

const NAMES_FILE = path.join(__dirname, 'data', 'folder_names.json');

let _data = { version: 1, folders: {}, updated_at: null };
// dirNormalizado → displayName (copia plana para lookup O(1))
let _index = new Map();
let _loaded = false;

/**
 * Normaliza una ruta de carpeta para usarla como clave estable. En Windows el
 * FS es case-insensitive, asi que minusculas + sin separador final es lo
 * correcto para que coincida sin importar como llegue escrita.
 */
function normalizeDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return '';
  return path.resolve(dir).toLowerCase().replace(/[\\/]+$/, '');
}

function rebuildIndex() {
  _index = new Map();
  const folders = (_data && _data.folders) || {};
  for (const [key, entry] of Object.entries(folders)) {
    const name = entry && typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
    if (name) _index.set(key, name);
  }
}

async function load() {
  try {
    const raw = await fs.readFile(NAMES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.folders === 'object' && parsed.folders) {
      _data = {
        version: parsed.version || 1,
        folders: parsed.folders,
        updated_at: parsed.updated_at || null,
      };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[folderNames] no se pudo leer:', err.message);
    }
    _data = { version: 1, folders: {}, updated_at: null };
  }
  rebuildIndex();
  _loaded = true;
  console.log(`🏷️  Folder names: ${_index.size} carpetas con nombre propio`);
}

async function save() {
  _data.updated_at = new Date().toISOString();
  try {
    await atomicWriteFile(NAMES_FILE, JSON.stringify(_data, null, 2));
    rebuildIndex();
  } catch (err) {
    console.error('[folderNames] error guardando:', err.message);
    throw err;
  }
}

/** Devuelve el display name de una carpeta, o null si no tiene override. */
function getName(dir) {
  const key = normalizeDir(dir);
  return _index.get(key) || null;
}

/**
 * Asigna (o sobrescribe) el display name de una carpeta. Si `displayName`
 * viene vacio/null, borra el override (restaura el nombre original).
 * Devuelve { displayName: string|null }.
 */
async function setName(dir, displayName) {
  const key = normalizeDir(dir);
  if (!key) throw new Error('dir requerido');
  const clean = typeof displayName === 'string' ? displayName.trim() : '';
  if (!clean) {
    delete _data.folders[key];
    await save();
    return { displayName: null };
  }
  _data.folders[key] = { displayName: clean, updatedAt: new Date().toISOString() };
  await save();
  return { displayName: clean };
}

/** Borra el override (restaura original). */
async function clearName(dir) {
  return setName(dir, '');
}

/** Devuelve todos los overrides como { dirNormalizado: displayName }. */
function getAll() {
  return Object.fromEntries(_index);
}

/** Pad del indice: minimo 3 digitos, mas si la carpeta tiene >999 archivos. */
function padIndex(n, total) {
  const width = Math.max(3, String(total).length);
  return String(n).padStart(width, '0');
}

/**
 * Decora una lista de MediaFile con el display name de su carpeta (cuando la
 * carpeta tiene override). Muta los objetos in-place y devuelve la misma lista.
 *
 * Por cada archivo de una carpeta con override:
 *   - `displayName` = "<nombreCarpeta>" o "<nombreCarpeta>_NNN" si hay >1 archivo.
 *   - `folderIndex` / `folderTotal` para la UI.
 *   - tags: REEMPLAZA las derivadas del nombre fisico por las del display name,
 *     preservando las de VLM/caras/espacios (que vienen de otra fuente).
 *
 * @param {Array} files  lista de MediaFile (ya con catalog aplicado)
 * @param {object} opts  { smartTags } — funcion extractSmartTags inyectada para
 *                       evitar dependencia circular con server.js
 */
function applyFolderNames(files, opts = {}) {
  if (!Array.isArray(files) || _index.size === 0) return files;
  const smartTags = typeof opts.smartTags === 'function' ? opts.smartTags : null;

  // Agrupar los archivos por carpeta, solo las que tienen override.
  const byDir = new Map();
  for (const f of files) {
    if (!f || !f.fullPath) continue;
    const key = normalizeDir(path.dirname(f.fullPath));
    if (!_index.has(key)) continue;
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key).push(f);
  }

  for (const [key, group] of byDir) {
    const displayName = _index.get(key);
    // Orden natural por nombre fisico: P48931 antes que P48999, _2 antes que _10.
    group.sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), 'es', { numeric: true, sensitivity: 'base' }));
    const total = group.length;

    // Tags del display name (comunes a toda la carpeta) — se calculan una vez.
    const derived = smartTags ? (smartTags(displayName) || {}) : null;
    const folderTags = derived && Array.isArray(derived.tags) ? derived.tags : [];

    group.forEach((f, i) => {
      const idx = i + 1;
      f.displayName = total > 1 ? `${displayName}_${padIndex(idx, total)}` : displayName;
      f.folderIndex = idx;
      f.folderTotal = total;

      if (smartTags) {
        // Quitar las tags que aporto el nombre fisico crudo; lo demas (VLM,
        // colores, etc.) se conserva. Anteponer las del display name.
        const nameTags = (smartTags(f.name) || {}).tags || [];
        const rest = Array.isArray(f.tags) ? f.tags.filter(t => !nameTags.includes(t)) : [];
        f.tags = [...new Set([...folderTags, ...rest])];
        if (derived && derived.extractedDate) f.extractedDate = derived.extractedDate;
      }
    });
  }

  return files;
}

module.exports = {
  load,
  save,
  getName,
  setName,
  clearName,
  getAll,
  applyFolderNames,
  // Para testing/debug
  _normalizeDir: normalizeDir,
};
