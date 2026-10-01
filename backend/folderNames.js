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
 * Este modulo tiene dos mitades, con la misma idea detras (la carpeta es la
 * unidad atomica de significado): `applyFolderNames` aplica los nombres
 * puestos a mano desde la UI, y `applyFolderInheritance` hace que los
 * archivos hereden nombre, etiquetas y fecha de la carpeta que YA esta bien
 * nombrada en disco ("260811_Ondara"). Ver esa funcion mas abajo.
 *
 * IDENTIDAD PORTABLE (clave de carpeta):
 *   - Clave NUEVA (portable): "<libraryId>:<relativeDirNorm>" — sobrevive al
 *     remapeo de la raiz de la biblioteca (D:\Fotos -> K:\Fotos), porque el
 *     libraryId y el relativeDir no cambian.
 *   - Clave LEGACY (absoluta): "d:\\fotos\\amsterdam" — fragil al mover el disco.
 *
 * DUAL-READ: ambas conviven. La resolucion prueba primero la portable y luego
 * la legacy, asi que migrar es ADITIVO (no se pierde nada nunca). El migrador
 * (tools/migrate-portable-state.js) anade las claves portables a partir de las
 * legacy; renombrar una carpeta desde la UI tambien escribe ya la portable.
 *
 * Persistencia: `data/folder_names.json`. Formato:
 *   {
 *     "version": 1,
 *     "folders": {
 *       "a18dfd8d85e9c831:mde/0.01- instalaciones": { "displayName": "...", "updatedAt": "ISO" },
 *       "d:\\fotos\\amsterdam": { "displayName": "...", "updatedAt": "ISO" }   // legacy
 *     },
 *     "updated_at": "ISO8601"
 *   }
 *
 * Enumeracion: cuando una carpeta con override tiene >1 archivo, cada archivo
 * recibe sufijo "_NNN" (orden natural por nombre fisico) para desambiguar:
 *   250412_Viaje, Amsterdam_001 ... _069
 * El indice es solo-digitos => `extractSmartTags` lo descarta, no ensucia tags.
 */

const path = require('path');
const fs = require('fs').promises;
const { atomicWriteFile } = require('./utils/jsonStore');
const fallos = require('./utils/failureReason');
const mediaIdentity = require('./utils/mediaIdentity');
const { esCarpetaTecnica } = require('./utils/etiquetas');

const NAMES_FILE = path.join(__dirname, 'data', 'folder_names.json');

let _data = { version: 1, folders: {}, updated_at: null };
// Indices planos para lookup O(1), separados por tipo de clave.
let _portableIndex = new Map(); // "libraryId:relDir" -> displayName
let _legacyIndex = new Map();   // "d:\\abs\\dir"      -> displayName
// Bibliotecas activas [{id, path}], inyectadas por server.js para poder
// resolver una carpeta absoluta a su (libraryId, relativeDir) de forma sincrona.
let _libraries = [];
let _loaded = false;

/**
 * Normaliza una ruta de carpeta ABSOLUTA para usarla como clave legacy estable.
 * En Windows el FS es case-insensitive: minusculas + sin separador final.
 */
function normalizeDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return '';
  return path.resolve(dir).toLowerCase().replace(/[\\/]+$/, '');
}

/**
 * Una clave es LEGACY (ruta absoluta) si empieza por "<letra>:<sep>" o contiene
 * una barra invertida. Las portables usan "<libraryId>:<relDir>" con '/'.
 */
function isLegacyAbsoluteKey(key) {
  return /^[a-zA-Z]:[\\/]/.test(key) || key.includes('\\');
}

/**
 * Inyecta la lista de bibliotecas activas (de scan_paths) para resolver
 * carpetas absolutas -> identidad portable. server.js la llama en cada sync.
 */
function setLibraries(libraries) {
  _libraries = Array.isArray(libraries)
    ? libraries.filter(l => l && l.id && l.path).map(l => ({ id: l.id, path: l.path }))
    : [];
}

/**
 * Resuelve una carpeta ABSOLUTA a su identidad portable {libraryId, relDir}
 * usando las bibliotecas inyectadas (prefijo mas largo). null si no cae bajo
 * ninguna biblioteca conocida.
 */
function resolvePortableDir(absDir) {
  if (!absDir || _libraries.length === 0) return null;
  const target = path.resolve(absDir).toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const lib of _libraries) {
    const root = path.resolve(lib.path).toLowerCase();
    if (target === root || target.startsWith(root + path.sep) || target.startsWith(root + '/')) {
      if (root.length > bestLen) {
        best = lib;
        bestLen = root.length;
      }
    }
  }
  if (!best) return null;
  // deriveRelativePath devuelve '' si la carpeta ES la raiz de la biblioteca.
  const relDir = mediaIdentity.deriveRelativePath(best.path, absDir);
  return { libraryId: best.id, relDir };
}

/** dir relativo (normalizado) del archivo a partir de su relativePath. */
function relativeDirOf(relativePath) {
  if (typeof relativePath !== 'string') return null;
  const norm = mediaIdentity.normalizeRelativePath(relativePath);
  if (!norm) return '';
  const parts = norm.split('/');
  parts.pop(); // quitar el nombre de archivo
  return parts.join('/');
}

function rebuildIndex() {
  _portableIndex = new Map();
  _legacyIndex = new Map();
  const folders = (_data && _data.folders) || {};
  for (const [key, entry] of Object.entries(folders)) {
    const name = entry && typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
    if (!name) continue;
    if (isLegacyAbsoluteKey(key)) _legacyIndex.set(key, name);
    else _portableIndex.set(key, name);
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
  console.log(`🏷️  Folder names: ${_portableIndex.size + _legacyIndex.size} carpetas con nombre propio (${_portableIndex.size} portables, ${_legacyIndex.size} legacy)`);
}

async function save() {
  _data.updated_at = new Date().toISOString();
  try {
    await atomicWriteFile(NAMES_FILE, JSON.stringify(_data, null, 2));
    rebuildIndex();
  } catch (err) {
    fallos.record('guardar los nombres de carpeta', err, { path: NAMES_FILE });
    throw err;
  }
}

/**
 * Devuelve el display name de una carpeta (por ruta absoluta), o null.
 * Prueba primero la clave portable (resolviendo la biblioteca) y luego la
 * legacy absoluta, para tolerar datos sin migrar y remapeos de raiz.
 */
function getName(dir) {
  // Portable primero (gana tras un remapeo de raiz).
  const p = resolvePortableDir(dir);
  if (p) {
    const pk = mediaIdentity.makeFolderKey(p.libraryId, p.relDir);
    if (pk && _portableIndex.has(pk)) return _portableIndex.get(pk);
  }
  // Legacy absoluta.
  const absKey = normalizeDir(dir);
  if (_legacyIndex.has(absKey)) return _legacyIndex.get(absKey);
  return null;
}

/**
 * Asigna (o borra, si vacio/null) el display name de una carpeta. Escribe la
 * clave PORTABLE cuando la carpeta cae bajo una biblioteca conocida; si no,
 * cae a la clave legacy absoluta. Al escribir portable, elimina cualquier
 * entrada legacy de la misma carpeta (migracion al vuelo, sin duplicar).
 * Devuelve { displayName: string|null }.
 */
async function setName(dir, displayName) {
  if (!dir || typeof dir !== 'string') throw new Error('dir requerido');
  const clean = typeof displayName === 'string' ? displayName.trim() : '';
  const absKey = normalizeDir(dir);
  const p = resolvePortableDir(dir);
  const portableKey = p ? mediaIdentity.makeFolderKey(p.libraryId, p.relDir) : '';
  const key = portableKey || absKey;
  if (!key) throw new Error('dir requerido');

  if (!clean) {
    delete _data.folders[key];
    if (key !== absKey) delete _data.folders[absKey]; // borrar tambien legacy
    await save();
    return { displayName: null };
  }

  _data.folders[key] = { displayName: clean, updatedAt: new Date().toISOString() };
  // Si escribimos portable, retiramos la legacy equivalente para no duplicar.
  if (portableKey && _data.folders[absKey]) delete _data.folders[absKey];
  await save();
  return { displayName: clean };
}

/** Borra el override (restaura original). */
async function clearName(dir) {
  return setName(dir, '');
}

/** Devuelve todos los overrides como { clave: displayName } (portables + legacy). */
function getAll() {
  return { ...Object.fromEntries(_portableIndex), ...Object.fromEntries(_legacyIndex) };
}

/** Pad del indice: minimo 3 digitos, mas si la carpeta tiene >999 archivos. */
function padIndex(n, total) {
  const width = Math.max(3, String(total).length);
  return String(n).padStart(width, '0');
}

/**
 * Resuelve el display name de un MediaFile por su carpeta. Devuelve
 * { name, groupKey } o null. Prueba portable (libraryId + relativeDir del
 * propio archivo, sincrono y sin depender de _libraries) y luego legacy
 * (dirname de fullPath).
 */
function lookupForFile(f) {
  if (!f) return null;
  if (f.libraryId && typeof f.relativePath === 'string') {
    const relDir = relativeDirOf(f.relativePath);
    if (relDir !== null) {
      const pk = mediaIdentity.makeFolderKey(f.libraryId, relDir);
      if (pk && _portableIndex.has(pk)) return { name: _portableIndex.get(pk), groupKey: 'p:' + pk };
    }
  }
  if (f.fullPath) {
    const absKey = normalizeDir(path.dirname(f.fullPath));
    if (_legacyIndex.has(absKey)) return { name: _legacyIndex.get(absKey), groupKey: 'l:' + absKey };
  }
  return null;
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
  if (!Array.isArray(files) || (_portableIndex.size === 0 && _legacyIndex.size === 0)) return files;
  const smartTags = typeof opts.smartTags === 'function' ? opts.smartTags : null;

  // Agrupar los archivos por carpeta con override (clave de grupo estable).
  const byGroup = new Map(); // groupKey -> { displayName, files: [] }
  for (const f of files) {
    if (!f || !f.fullPath) continue;
    const hit = lookupForFile(f);
    if (!hit) continue;
    if (!byGroup.has(hit.groupKey)) byGroup.set(hit.groupKey, { displayName: hit.name, files: [] });
    byGroup.get(hit.groupKey).files.push(f);
  }

  for (const { displayName, files: group } of byGroup.values()) {
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

/**
 * Carpeta cuyo nombre empieza por fecha ("260811_Ondara"). Es la convencion
 * del archivo: AAMMDD_Evento, Lugar.
 */
const FOLDER_DATE_PREFIX = /^\d{6}[_\s]/;

/**
 * Carpeta de evento con la fecha escrita de otra forma: "2026-06-14_Ana_y_Pablo",
 * "2026-03_Congreso", "FONDO_FAMILIAR_1930-1959", "Boda de la nieta 2011".
 * Antes solo valia AAMMDD_ y el material de camara de esas carpetas no
 * heredaba su nombre: no se podia buscar "Ana y Pablo".
 */
const FOLDER_DATE_OTRA = /^(19|20)\d{2}[-_. ]?\d{2}(?!\d)|(^|[\s_-])(19|20)\d{2}(?=$|[\s_-])/;
const tieneFecha = (nombre) => FOLDER_DATE_PREFIX.test(nombre) || FOLDER_DATE_OTRA.test(nombre);

/**
 * Cadena de carpetas de las que hereda un archivo, de la mas cercana a la mas
 * lejana y SIEMPRE por debajo de la biblioteca: su raiz nunca entra, porque
 * "BRUTOS" o "F:\" no significan nada y ensuciarian todas las etiquetas.
 *
 * Sube desde la carpeta contenedora, que va siempre, y por encima recoge solo
 * los ancestros con fecha: asi un "clips" dentro de "260811_Ondara" hereda las
 * dos, y los tramos organizativos intermedios no meten ruido.
 *
 * Los nombres salen de `fullPath` y no de `relativePath` para conservar
 * mayusculas y acentos, que la ruta relativa normaliza a minusculas.
 */
function inheritedFolderChain(f) {
  if (!f || !f.fullPath) return [];
  const absSegs = String(f.fullPath).split(/[\\/]/).filter(Boolean);
  if (absSegs.length < 2) return [];

  // Cuantas carpetas del final cuelgan de la biblioteca. Con relativePath es
  // exacto; sin el (datos legacy) nos quedamos con la carpeta contenedora.
  let dirCount = 1;
  if (typeof f.relativePath === 'string') {
    const rel = mediaIdentity.normalizeRelativePath(f.relativePath);
    if (rel) dirCount = rel.split('/').length - 1;
  }
  if (dirCount <= 0) return []; // el archivo cuelga de la raiz de la biblioteca

  const start = Math.max(0, absSegs.length - 1 - dirCount);
  const dirs = absSegs.slice(start, absSegs.length - 1); // sin el nombre de archivo
  if (dirs.length === 0) return [];

  // La contenedora, o la mas cercana que no sea de la camara: "CLIP",
  // "100MSDCF" o "DCIM" no dicen nada y salian como etiquetas.
  let i = dirs.length - 1;
  while (i >= 0 && esCarpetaTecnica(dirs[i])) i--;
  if (i < 0) return [];
  const chain = [dirs[i]];
  for (let j = i - 1; j >= 0; j--) {
    if (tieneFecha(dirs[j])) chain.push(dirs[j]);
  }
  return chain;
}

/**
 * Hace que cada archivo herede el significado de su carpeta FISICA. Es la otra
 * mitad de `applyFolderNames`: aquella cubre las carpetas renombradas a mano,
 * esta las que ya estan bien nombradas en disco ("260811_Ondara"), que son la
 * convencion del archivo y hasta ahora no heredaban nada.
 *
 * Sin esto, "P1248278.MP4" solo aparece tecleando "P1248278" — un nombre que
 * no sirve para buscar como busca una persona.
 *
 * Por archivo:
 *   - `folderName`: nombre crudo de la carpeta contenedora, buscable tal cual
 *     ("260811_Ondara", y por tanto tambien "260811" o "Ondara").
 *   - tags: las derivadas del nombre de la carpeta y de los ancestros con
 *     fecha, ANTEPUESTAS a las que ya tenia. Son etiquetas de verdad: entran
 *     en el autocompletado del buscador, en TagManager y en estadisticas.
 *   - `extractedDate`: la fecha de la carpeta, solo si el archivo no traia una
 *     (la del propio nombre del archivo es mas especifica y manda).
 *
 * Los archivos de una carpeta con nombre propio quedan fuera: ese nombre es
 * una decision explicita del usuario y `applyFolderNames` ya derivo de el sus
 * tags y su fecha. Solo se les rellena `folderName`, para que buscar por
 * carpeta sea una sola cosa se llame como se llame.
 *
 * NO se persiste: se recalcula en cada sync (indices reconstruibles). Renombrar
 * una carpeta en disco cambia lo que heredan sus archivos sin reescanear nada.
 */
function applyFolderInheritance(files, opts = {}) {
  if (!Array.isArray(files)) return files;
  const smartTags = typeof opts.smartTags === 'function' ? opts.smartTags : null;

  for (const f of files) {
    if (!f) continue;

    // Carpeta con nombre propio: manda el override, ya aplicado. Se le quita
    // la enumeracion "_NNN" para que el nombre de carpeta sea uno solo.
    if (f.displayName) {
      f.folderName = String(f.displayName).replace(/_\d{3,}$/, '');
      continue;
    }

    const chain = inheritedFolderChain(f);
    if (chain.length === 0) continue;

    // Rastro de carpetas, de fuera a dentro ("260811_Ondara / clips"), con el
    // mismo formato que la etiqueta de sesion del front. Asi el archivo de una
    // subcarpeta tambien se encuentra tecleando la carpeta-evento entera.
    f.folderName = chain.slice().reverse().join(' / ');
    if (!smartTags) continue;

    const heredadas = [];
    let fecha = null;
    for (const nombre of chain) {
      const derived = smartTags(nombre) || {};
      if (Array.isArray(derived.tags)) heredadas.push(...derived.tags);
      if (!fecha && derived.extractedDate) fecha = derived.extractedDate;
    }

    if (heredadas.length > 0) {
      const previas = Array.isArray(f.tags) ? f.tags : [];
      f.tags = [...new Set([...heredadas, ...previas])];
    }
    if (fecha && !f.extractedDate) f.extractedDate = fecha;
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
  applyFolderInheritance,
  setLibraries,
  // Para testing/debug
  _normalizeDir: normalizeDir,
  _resolvePortableDir: resolvePortableDir,
};
