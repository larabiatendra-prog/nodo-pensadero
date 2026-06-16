/**
 * Módulo de configuración de rutas — Pensadero
 *
 * Centraliza la gestión de rutas de medios. Lee de variables de entorno
 * y de scan_paths.json. Sin rutas corporativas hardcodeadas.
 *
 * @module config/paths
 */

const path = require('path');
const os = require('os');
const fs = require('fs').promises;

// Cargar variables de entorno
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Configuración del servidor
 */
const serverConfig = {
  port: parseInt(process.env.PORT, 10) || 5000,
  serverUrl: process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5000}`,
};

/**
 * Obtiene el directorio de contenido base.
 * Usa CONTENT_DIR del .env, o ~/Pensadero como fallback razonable.
 * @returns {string} Ruta normalizada
 */
function getContentDir() {
  const contentDir = process.env.CONTENT_DIR;

  if (contentDir && contentDir.trim().length > 0) {
    return path.normalize(contentDir);
  }

  // Fallback: carpeta Pensadero en home del usuario
  const fallback = path.join(os.homedir(), 'Pensadero');
  console.warn(`⚠️ CONTENT_DIR no configurado. Usando fallback: ${fallback}`);
  return fallback;
}

/**
 * Carga scan_paths.json
 * @returns {Promise<Array>} Configuraciones de rutas
 */
async function loadScanPathsFromFile() {
  try {
    const scanPathsFile = path.join(__dirname, '..', 'scan_paths.json');
    const data = await fs.readFile(scanPathsFile, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

/**
 * Devuelve todas las bibliotecas activas (CONTENT_DIR + scan_paths.json activas)
 * @returns {Promise<string[]>}
 */
async function getActiveLibraries() {
  const libraries = new Set();

  const contentDir = getContentDir();
  if (contentDir) libraries.add(contentDir);

  const scanPaths = await loadScanPathsFromFile();
  scanPaths
    .filter(p => p.isActive)
    .forEach(p => libraries.add(path.normalize(p.path)));

  return Array.from(libraries);
}

/**
 * Devuelve rutas marcadas como exports (las que contengan "export" en el path)
 * @returns {Promise<string[]>}
 */
async function getExportsPaths() {
  const scanPaths = await loadScanPathsFromFile();
  return scanPaths
    .filter(p => p.isActive && p.path.toLowerCase().includes('export'))
    .map(p => path.normalize(p.path).toLowerCase());
}

/**
 * Genera URL de thumbnail (relativa al origen).
 * Sin host hardcodeado: el navegador la resuelve contra el host actual
 * (localhost, pensadero, IP de LAN/VPN). Imprescindible para servir un unico
 * build desde cualquier origen. Ver src/config/index.ts (origen unico).
 */
function getThumbnailUrl(thumbnailName) {
  return `/thumbnails/${thumbnailName}`;
}

/**
 * Genera URL de streaming (relativa al origen). Mismo motivo que arriba.
 */
function getStreamUrl(fileId) {
  return `/api/stream/${fileId}`;
}

/**
 * Nombre de thumbnail seguro y estable. No depende solo del nombre de archivo
 * (puede haber duplicados): añade los primeros 8 chars del fileId.
 */
function buildThumbnailName(fileName, fileId) {
  const nameWithoutExt = path.basename(fileName, path.extname(fileName));
  const sanitized = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${sanitized}_${fileId.substring(0, 8)}_thumbnail.jpg`;
}

/**
 * Resuelve la raiz de biblioteca (scanRoot) a la que pertenece un archivo,
 * por coincidencia de prefijo mas largo contra las bibliotecas activas
 * (CONTENT_DIR + scan_paths activas). Necesario para los thumbnails que viven
 * junto a cada disco (<scanRoot>\.pensadero\thumbnails). Devuelve la ruta de
 * biblioteca original, o null si el archivo no cae bajo ninguna activa.
 *
 * Normaliza a minusculas para tolerar la insensibilidad a mayusculas de
 * Windows (Y: vs y:, mayusculas mezcladas en scan_paths.json). Si hay
 * bibliotecas anidadas, gana la mas profunda (prefijo mas largo).
 */
async function resolveScanRoot(fullPath) {
  if (!fullPath) return null;
  const libraries = await getActiveLibraries();
  const target = path.resolve(fullPath).toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const lib of libraries) {
    const norm = path.resolve(lib).toLowerCase();
    if (target === norm || target.startsWith(norm + path.sep)) {
      if (norm.length > bestLen) {
        best = lib;
        bestLen = norm.length;
      }
    }
  }
  return best;
}

/**
 * Funcion centralizada que resuelve donde guardar/servir un thumbnail.
 * El thumbnail pertenece a la biblioteca, no al backend: vive en
 * <scanRoot>\.pensadero\thumbnails. Si no se puede determinar scanRoot, cae al
 * directorio legacy (backend/thumbnails) y marca legacy:true para que el
 * llamante loguee un warning.
 *
 * @param {Object} args
 * @param {string} args.fullPath  Ruta absoluta del archivo de medios.
 * @param {string} [args.scanRoot] Raiz de biblioteca ya conocida (durante el
 *   escaneo es el baseDir). Si se omite, el llamante debe resolverla antes con
 *   resolveScanRoot() (esta funcion es sincrona; no hace I/O).
 * @param {string} args.fileId
 * @param {string} args.fileName
 * @returns {{thumbnailDir:string, thumbnailName:string, thumbnailPath:string, thumbnailUrl:string, legacy:boolean}}
 */
function resolveThumbnailLocation({ fullPath, scanRoot, fileId, fileName }) {
  const thumbnailName = buildThumbnailName(fileName, fileId);
  let thumbnailDir;
  let legacy = false;
  if (scanRoot) {
    thumbnailDir = path.join(scanRoot, '.pensadero', 'thumbnails');
  } else {
    thumbnailDir = systemPaths.thumbnails;
    legacy = true;
  }
  return {
    thumbnailDir,
    thumbnailName,
    thumbnailPath: path.join(thumbnailDir, thumbnailName),
    // URL estable por fileId: el endpoint resuelve el disco internamente.
    thumbnailUrl: `/api/thumbnails/${fileId}`,
    legacy,
  };
}

/**
 * Verifica accesibilidad de una ruta
 */
async function isPathAccessible(dirPath) {
  try {
    await fs.access(dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Devuelve bibliotecas con su estado de accesibilidad
 */
async function getLibrariesWithStatus() {
  const libraries = await getActiveLibraries();
  return Promise.all(
    libraries.map(async (lib) => ({
      path: lib,
      accessible: await isPathAccessible(lib)
    }))
  );
}

/**
 * Directorios del sistema
 */
const systemPaths = {
  thumbnails: path.join(__dirname, '..', 'thumbnails'),
  cache: path.join(__dirname, '..', 'media_cache.json'),
  scanPaths: path.join(__dirname, '..', 'scan_paths.json'),
};

/**
 * Configuración de Ollama (búsqueda en lenguaje natural sobre tags/metadatos)
 */
const aiConfig = {
  ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1:8b',
};

module.exports = {
  serverConfig,
  getContentDir,
  loadScanPathsFromFile,
  getActiveLibraries,
  getExportsPaths,
  getLibrariesWithStatus,
  isPathAccessible,
  getThumbnailUrl,
  getStreamUrl,
  buildThumbnailName,
  resolveScanRoot,
  resolveThumbnailLocation,
  systemPaths,
  aiConfig,
};
