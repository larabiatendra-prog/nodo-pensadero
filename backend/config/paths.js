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
 * Genera URL de thumbnail
 */
function getThumbnailUrl(thumbnailName) {
  return `${serverConfig.serverUrl}/thumbnails/${thumbnailName}`;
}

/**
 * Genera URL de streaming
 */
function getStreamUrl(fileId) {
  return `${serverConfig.serverUrl}/api/stream/${fileId}`;
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
  systemPaths,
  aiConfig,
};
