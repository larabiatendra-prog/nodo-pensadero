/**
 * Media Identity — Pensadero
 *
 * Identidad PORTABLE de un archivo, independiente de la ruta absoluta.
 *
 * Problema: hasta ahora el `id` de un archivo era md5(rutaAbsoluta). Eso ata la
 * identidad a la letra de unidad y a la carpeta del repo: si una biblioteca
 * cambia de D:\Fotos a K:\Fotos, todos los favoritos / notas / colecciones que
 * referencian ese archivo se rompen, porque el md5 cambia.
 *
 * Solucion: la identidad persistente es la `mediaKey`:
 *
 *     mediaKey = "<libraryId>:<relativePathNormalizado>"
 *
 *   - libraryId    -> id estable de la biblioteca (el `id` ya existente en
 *                     scan_paths.json, un hex aleatorio que NO depende de la
 *                     ruta; sobrevive al remapeo de la raiz).
 *   - relativePath -> ruta del archivo DENTRO de la biblioteca, normalizada
 *                     (NFC + separadores '/' + minusculas en Windows).
 *
 * Consecuencia buscada:
 *   - Si cambia SOLO la raiz de la biblioteca (D:\Fotos -> K:\Fotos), la mediaKey
 *     NO cambia (mismo libraryId, mismo relativePath) -> favoritos/notas/
 *     colecciones se conservan.
 *   - Si el archivo se mueve DENTRO de la biblioteca, su mediaKey cambia (su
 *     relativePath cambio). Es el comportamiento deseado: es "otro" sitio.
 *
 * El `id` md5(fullPath) se mantiene como TOKEN DE RUNTIME (URLs de stream /
 * thumbnail / clipIndex), no como identidad persistente. fullPath es dato
 * operativo de runtime, nunca identidad guardada.
 *
 * @module utils/mediaIdentity
 */

const path = require('path');
const crypto = require('crypto');

/**
 * Normaliza un path RELATIVO para usarlo como parte estable de la identidad.
 * - NFC: unifica acentos (la "é" de "Edición" puede llegar como NFD desde el FS).
 * - separadores unificados a '/'.
 * - sin '/' inicial ni final.
 * - minusculas: el FS de Windows es case-insensitive, asi que la clave debe
 *   coincidir aunque la ruta venga con mayusculas distintas.
 * Devuelve '' si la entrada no es valida.
 */
function normalizeRelativePath(rel) {
  if (typeof rel !== 'string') return '';
  let r = rel.normalize('NFC').trim();
  if (!r) return '';
  r = r.replace(/[\\/]+/g, '/');     // separadores -> '/'
  r = r.replace(/^\/+|\/+$/g, '');   // sin barra inicial/final
  r = r.toLowerCase();
  return r;
}

/**
 * Normaliza la raiz de una biblioteca para comparaciones de prefijo.
 * Absoluta + minusculas + sin separador final.
 */
function normalizeLibraryRoot(root) {
  if (typeof root !== 'string' || !root.trim()) return '';
  return path.resolve(root).normalize('NFC').toLowerCase().replace(/[\\/]+$/, '');
}

/**
 * Construye la mediaKey portable: "<libraryId>:<relativePathNormalizado>".
 * Devuelve '' si falta libraryId o relativePath.
 */
function makeMediaKey(libraryId, relativePath) {
  const lib = String(libraryId || '').trim();
  const rel = normalizeRelativePath(relativePath);
  if (!lib || !rel) return '';
  return `${lib}:${rel}`;
}

/**
 * Clave de carpeta portable para folder_names: "<libraryId>:<relativeDirNorm>".
 * A diferencia de makeMediaKey, admite relativeDir vacio (carpeta = raiz de la
 * biblioteca) devolviendo "<libraryId>:".
 */
function makeFolderKey(libraryId, relativeDir) {
  const lib = String(libraryId || '').trim();
  if (!lib) return '';
  return `${lib}:${normalizeRelativePath(relativeDir)}`;
}

/**
 * Hash estable de una mediaKey. Util cuando se necesita un id compacto de ancho
 * fijo (40 hex) en vez de la mediaKey legible. NO es el `id` de runtime.
 */
function mediaIdFromKey(mediaKey) {
  const k = String(mediaKey || '');
  if (!k) return '';
  return crypto.createHash('sha1').update(k).digest('hex');
}

/**
 * Deriva el relativePath normalizado de un archivo respecto a la raiz de su
 * biblioteca. Devuelve '' si el archivo NO cae dentro de la raiz (no es de esa
 * biblioteca) para no fabricar identidades con "..".
 */
function deriveRelativePath(rootPath, fullPath) {
  if (!rootPath || !fullPath) return '';
  const rel = path.relative(rootPath, fullPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return normalizeRelativePath(rel);
}

/**
 * Reconstruye un fullPath de runtime a partir de la raiz actual de la biblioteca
 * y el relativePath portable. Best-effort: en Windows la insensibilidad a
 * mayusculas hace que el join funcione aunque el case difiera.
 */
function resolveFullPath(rootPath, relativePath) {
  if (!rootPath || typeof relativePath !== 'string') return '';
  const rel = normalizeRelativePath(relativePath);
  if (!rel) return path.resolve(rootPath);
  return path.join(path.resolve(rootPath), rel.split('/').join(path.sep));
}

/**
 * Dado un fullPath y la lista de bibliotecas [{id, path}], encuentra a cual
 * pertenece (coincidencia de prefijo mas largo, igual criterio que
 * resolveScanRoot) y devuelve su identidad portable o null.
 *
 * @param {string} fullPath
 * @param {Array<{id:string, path:string}>} libraries
 * @returns {{libraryId:string, relativePath:string, mediaKey:string, mediaId:string}|null}
 */
function deriveMediaKeyForPath(fullPath, libraries) {
  if (!fullPath || !Array.isArray(libraries) || libraries.length === 0) return null;
  const target = path.resolve(fullPath).toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const lib of libraries) {
    if (!lib || !lib.path || !lib.id) continue;
    const root = path.resolve(lib.path).toLowerCase();
    if (target === root || target.startsWith(root + path.sep) || target.startsWith(root + '/')) {
      if (root.length > bestLen) {
        best = lib;
        bestLen = root.length;
      }
    }
  }
  if (!best) return null;
  const relativePath = deriveRelativePath(best.path, fullPath);
  if (!relativePath) return null;
  const mediaKey = makeMediaKey(best.id, relativePath);
  if (!mediaKey) return null;
  return { libraryId: best.id, relativePath, mediaKey, mediaId: mediaIdFromKey(mediaKey) };
}

// ============================================
// ESQUEMA DE SCAN_PATHS (bibliotecas)
// ============================================

/**
 * Nombre de presentacion por defecto para una biblioteca: el ultimo segmento
 * de su ruta ("Y:\\Edición_DF\\Biblioteca Clips" -> "Biblioteca Clips").
 */
function defaultLibraryDisplayName(p) {
  if (typeof p !== 'string' || !p.trim()) return 'Biblioteca';
  const base = path.basename(p.replace(/[\\/]+$/, ''));
  return base || p;
}

/**
 * Asegura que una entrada de scan_paths tenga el esquema portable completo, SIN
 * destruir nada existente. Reutiliza el `id` ya presente como libraryId estable;
 * solo rellena campos que falten (displayName, role). Idempotente.
 */
function ensureScanPathSchema(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  if (!out.id) out.id = crypto.randomBytes(8).toString('hex');
  if (typeof out.displayName !== 'string' || !out.displayName.trim()) {
    out.displayName = defaultLibraryDisplayName(out.path);
  }
  if (!('role' in out)) out.role = null; // clips | fotos | brutos | exports | proyectos | otro | null
  if (!('isActive' in out)) out.isActive = false;
  if (!('lastScan' in out)) out.lastScan = null;
  if (!('fileCount' in out)) out.fileCount = 0;
  if (!('status' in out)) out.status = out.isActive ? 'connected' : 'disconnected';
  return out;
}

/**
 * Migra in-memory un array de scan_paths al esquema portable. Devuelve un nuevo
 * array; no escribe a disco (el llamante decide si persistir).
 */
function migrateScanPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.map(ensureScanPathSchema);
}

module.exports = {
  normalizeRelativePath,
  normalizeLibraryRoot,
  makeMediaKey,
  makeFolderKey,
  mediaIdFromKey,
  deriveRelativePath,
  resolveFullPath,
  deriveMediaKeyForPath,
  defaultLibraryDisplayName,
  ensureScanPathSchema,
  migrateScanPaths,
};
