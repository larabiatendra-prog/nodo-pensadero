/**
 * Pensadero — Servidor backend (single-user)
 *
 * Servidor Express + WebSocket para gestionar la biblioteca local
 * de medios del usuario. Sin auth, sin multi-tenant, sin Supabase.
 *
 * Lee opcionalmente un catalog JSON `_marina.json` por carpeta, generado
 * por la herramienta externa Marina Video Batch personal, y mergea los
 * datos enriquecidos del clip correspondiente sobre el MediaFile en
 * memoria. Ver `catalogReader.js` para el formato y comportamiento.
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs').promises;
const mime = require('mime-types');
const chokidar = require('chokidar');
const sharp = require('sharp');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const WebSocket = require('ws');
const http = require('http');

const colorAnalyzer = require('./colorAnalyzer');
const favoritesManager = require('./favoritesManager');
const collectionsManager = require('./collectionsManager');
const catalogReader = require('./catalogReader');
const peopleRegistry = require('./peopleRegistry');
const personsAggregator = require('./personsAggregator');
const multer = require('multer');
require('dotenv').config();

// Configuración de rutas
const pathsConfig = require('./config/paths');

// Routers modulares
const createAiRoutes = require('./routes/aiRoutes');
const createOrganizationRoutes = require('./routes/organizationRoutes');
const createMediaRoutes = require('./routes/mediaRoutes');
const createSystemRoutes = require('./routes/systemRoutes');
const createScanRoutes = require('./routes/scanRoutes');
const createPersonsManageRoutes = require('./routes/personsManageRoutes');
const createColorSearchRoutes = require('./routes/colorSearchRoutes');
const createAliasRoutes = require('./routes/aliasRoutes');
const aliasTable = require('./aliasTable');
const clipIndex = require('./clipIndex');
const spacesRegistry = require('./spacesRegistry');
const createSpacesManageRoutes = require('./routes/spacesManageRoutes');

// Multer para uploads de imagen (lo conservamos por si lo usa el frontend en
// la búsqueda por imagen futura; actualmente no hay endpoint que lo consuma).
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'];
    cb(allowedTypes.includes(file.mimetype) ? null : new Error('Tipo no soportado'), allowedTypes.includes(file.mimetype));
  }
});

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 5000;

// Servidor HTTP
const server = http.createServer(app);

// WebSocket para progreso en tiempo real
const wss = new WebSocket.Server({ server, path: '/ws' });
const progressClients = new Set();

// Directorios
const CONTENT_DIR = pathsConfig.getContentDir();
const THUMBNAILS_DIR = pathsConfig.systemPaths.thumbnails;

// People registry (config desde .env)
// Si las variables de entorno no están definidas, usamos una ubicación
// por defecto dentro de backend/data/ para que NODO arranque "out of the box"
// sin necesidad de configurar nada manualmente. La carpeta y el archivo se
// crean al primer guardado desde la UI de gestión de personas.
const DEFAULT_DATA_DIR = path.join(__dirname, 'data');
const PERSONS_REGISTRY_PATH = (process.env.PERSONS_REGISTRY || '').trim() ||
  path.join(DEFAULT_DATA_DIR, 'people_registry.json');
const PERSONS_AVATARS_BASE = (process.env.PERSONS_AVATARS_BASE || '').trim() ||
  DEFAULT_DATA_DIR;
// Spaces comparten el mismo avatarsBase que personas. El registry es un
// archivo aparte (spaces_registry.json) por default en la misma carpeta.
const SPACES_REGISTRY_PATH = (process.env.SPACES_REGISTRY || '').trim() ||
  path.join(DEFAULT_DATA_DIR, 'spaces_registry.json');

// Rutas de exports cargadas desde scan_paths.json
let EXPORTS_PATHS = [];

// Cargar rutas de escaneo
async function loadScanPaths() {
  try {
    const scanPathsFile = path.join(__dirname, 'scan_paths.json');
    const data = await fs.readFile(scanPathsFile, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

// Guardar configuración de rutas
async function saveScanPaths(paths) {
  try {
    const scanPathsFile = path.join(__dirname, 'scan_paths.json');
    await fs.writeFile(scanPathsFile, JSON.stringify(paths, null, 2));
  } catch (error) {
    console.error('❌ Error guardando rutas:', error.message);
  }
}

async function loadExportsPaths() {
  try {
    EXPORTS_PATHS = await pathsConfig.getExportsPaths();
    if (EXPORTS_PATHS.length > 0) {
      console.log(`📦 Rutas de exports: ${EXPORTS_PATHS.join(', ')}`);
    }
  } catch (error) {
    EXPORTS_PATHS = [];
  }
}

// === MIDDLEWARE ===

// CORS abierto a localhost (single-user, sin auth)
app.use(cors());

// Compresión gzip para respuestas API y assets
app.use(compression({
  threshold: 1024,
  level: 6,
  filter: (req, res) => {
    if (req.headers['range']) return false;
    return compression.filter(req, res);
  }
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Servir thumbnails con cache largo
app.use('/thumbnails', express.static(THUMBNAILS_DIR, {
  maxAge: '7d',
  etag: true,
  lastModified: true
}));

// Servir avatares de personas. Se monta SOLO si la carpeta base existe
// (mejor 404 explícito que un 500 si falta). Lo registra `mountPersonsAvatars()`.
function mountPersonsAvatars() {
  const base = peopleRegistry.getState().avatarsBase;
  if (!base) return; // sin registry → nada que servir
  try {
    const fsSync = require('fs');
    const stat = fsSync.statSync(base);
    if (!stat.isDirectory()) {
      console.warn(`⚠️ PERSONS_AVATARS_BASE no es carpeta: ${base}. /persons-avatars no se monta.`);
      return;
    }
    app.use('/persons-avatars', express.static(base, {
      maxAge: '1d',
      etag: true,
      lastModified: true,
      // Sin index.html, sin redirects de carpeta (fallback al siguiente middleware
      // si el archivo no existe → 404 limpio).
      fallthrough: true
    }));
    console.log(`🖼️ Avatares servidos desde: ${base}`);
    // Spaces comparten avatarsBase. Servimos las fotos de referencia y covers
    // en /spaces-covers/spaces/<id>/... usando el mismo dir base.
    app.use('/spaces-covers', express.static(base, {
      maxAge: '1d',
      etag: true,
      lastModified: true,
      fallthrough: true,
    }));
    console.log(`🏢 Covers de espacios servidos desde: ${base}`);
  } catch (err) {
    console.warn(`⚠️ No se monta /persons-avatars (${base}): ${err.message}`);
  }
}

// Servir media original con cache moderado
app.use('/media', express.static(CONTENT_DIR, {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res, p) => {
    if (p.endsWith('.mp4') || p.endsWith('.mov') || p.endsWith('.avi')) {
      res.set('Content-Type', 'video/mp4');
    } else if (p.endsWith('.mp3') || p.endsWith('.wav')) {
      res.set('Content-Type', 'audio/mpeg');
    } else if (p.endsWith('.jpg') || p.endsWith('.jpeg')) {
      res.set('Content-Type', 'image/jpeg');
    } else if (p.endsWith('.png')) {
      res.set('Content-Type', 'image/png');
    }
    res.set('Accept-Ranges', 'bytes');
  }
}));

// === ESTADO EN MEMORIA ===

// Lista en vivo de archivos
let mediaFiles = [];

// Cache persistente de archivos analizados
const CACHE_FILE = path.join(__dirname, 'media_cache.json');
let fileCache = new Map(); // filePath → { hash, mtime, fileData }

// Agregado de personas memoizado. Se recalcula al final de syncFiles() y
// cuando cambia el registry o se llama a /api/persons/refresh. Sin I/O por
// request: getAvatarUrl chequea fs.existsSync una sola vez al recalcular.
let personsAggregate = [];

function recomputePersonsAggregate() {
  personsAggregate = personsAggregator.recomputePersons(mediaFiles);
  return personsAggregate;
}

// === WEBSOCKET ===

wss.on('connection', (ws) => {
  console.log('📡 Cliente WS conectado');
  progressClients.add(ws);
  ws.on('close', () => progressClients.delete(ws));
  ws.on('error', () => progressClients.delete(ws));
});

function broadcastProgress(data) {
  const message = JSON.stringify(data);
  progressClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(message); } catch { progressClients.delete(ws); }
    }
  });
}

// === CACHE ===

async function loadCache() {
  try {
    await favoritesManager.loadFavorites();
    await collectionsManager.loadCollections();

    const exists = await fs.access(CACHE_FILE).then(() => true).catch(() => false);
    if (exists) {
      const cacheData = await fs.readFile(CACHE_FILE, 'utf-8');
      fileCache = new Map(Object.entries(JSON.parse(cacheData)));
      console.log(`📦 Cache cargado: ${fileCache.size} archivos`);
    } else {
      console.log('📦 Sin cache previo');
    }
  } catch (error) {
    console.warn('⚠️ Error cargando cache:', error.message);
    fileCache = new Map();
  }
}

async function saveCache() {
  try {
    const obj = Object.fromEntries(fileCache);
    await fs.writeFile(CACHE_FILE, JSON.stringify(obj));
  } catch (error) {
    console.error('❌ Error guardando cache:', error.message);
  }
}

function generateFileHash(filePath, stats) {
  const content = `${filePath}-${stats.size}-${stats.mtime.getTime()}`;
  return crypto.createHash('md5').update(content).digest('hex');
}

function generateFileId(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}

// === CATALOG (_marina.json) ===
// La lectura del catalog y el merge sobre MediaFile están en `catalogReader.js`.
// Se aplica al vuelo (no se persiste en `media_cache.json`) para que el
// frontend siempre vea la última versión del catalog sin reindexar.

// === DIRECTORIOS ===

async function ensureDirectories() {
  try {
    try {
      await fs.access(CONTENT_DIR);
      console.log(`✅ Carpeta de contenido: ${CONTENT_DIR}`);
    } catch {
      console.warn(`⚠️ No se puede acceder a CONTENT_DIR: ${CONTENT_DIR}`);
      console.warn('   Añade rutas desde la UI o crea la carpeta. El servidor seguirá arrancando.');
    }

    await fs.mkdir(THUMBNAILS_DIR, { recursive: true });
    console.log(`📁 Carpeta de miniaturas: ${THUMBNAILS_DIR}`);
  } catch (error) {
    console.error('Error preparando directorios:', error);
  }
}

// === EXTRACCIÓN DE TAGS ===

function extractSmartTags(filename) {
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
  const tags = [];
  let extractedDate = null;

  // Contenido entre paréntesis
  const parenthesesMatches = nameWithoutExt.match(/\(([^)]+)\)/g);
  if (parenthesesMatches) {
    parenthesesMatches.forEach(match => {
      const content = match.replace(/[()]/g, '').trim();
      if (content && !/^\d+$/.test(content)) {
        tags.push(content);
      }
    });
  }

  const nameWithoutParentheses = nameWithoutExt.replace(/\([^)]*\)/g, '').trim();
  const parts = nameWithoutParentheses.split(/[-_,]+/).map(p => p.trim()).filter(p => p.length > 0);

  parts.forEach(part => {
    const cleanPart = part.trim();
    if (!cleanPart) return;

    // Fechas YYMMDD
    const datePatterns = [/^(\d{2})(\d{2})(\d{2})$/, /^(\d{2})-?(\d{2})-?(\d{2})$/];
    let isDate = false;
    for (const pattern of datePatterns) {
      const m = cleanPart.match(pattern);
      if (m) {
        const [_, year, month, day] = m;
        const fullYear = 2000 + parseInt(year);
        const dateObj = new Date(fullYear, parseInt(month) - 1, parseInt(day));
        if (dateObj.getFullYear() === fullYear &&
            dateObj.getMonth() === parseInt(month) - 1 &&
            dateObj.getDate() === parseInt(day)) {
          extractedDate = dateObj;
          tags.push(`${year}-${month}-${day}`);
          tags.push(`20${year}`);
          const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                          'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
          tags.push(months[parseInt(month) - 1]);
          isDate = true;
          break;
        }
      }
    }
    if (isDate) return;

    if (/^\d+$/.test(cleanPart)) return;
    if (cleanPart.length === 1 && !/^[A-Z]$/i.test(cleanPart)) return;

    if (cleanPart.length === 2) {
      if (!/^[A-Z]{2}$/i.test(cleanPart)) return;
    }

    let cleanedTag = cleanPart.replace(/[[\]{}]/g, '').trim();
    if (!/^(HD|4K|3D|VR|AR|360)$/i.test(cleanedTag)) {
      cleanedTag = cleanedTag.replace(/\s+\d+$/, '').trim();
      cleanedTag = cleanedTag.replace(/^\d+\s+/, '').trim();
      if (/^\d+$/.test(cleanedTag)) return;
    }

    if (cleanedTag.length > 0) tags.push(cleanedTag);
  });

  const uniqueTags = [...new Set(tags.filter(t => t && t.length > 0))];
  return { tags: uniqueTags, extractedDate };
}

// === TIPO DE ARCHIVO ===

function getFileType(filePath) {
  const normalizedPath = path.normalize(filePath).toLowerCase();
  const isExport = EXPORTS_PATHS.some(exportPath => normalizedPath.startsWith(exportPath));
  if (isExport) return 'export';

  const mimeType = mime.lookup(filePath);
  if (!mimeType) return null;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

// === THUMBNAIL ===

async function generateThumbnail(filePath, fileId, fileName) {
  const fileType = getFileType(filePath);
  const nameWithoutExt = path.basename(fileName, path.extname(fileName));
  const sanitizedName = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_');
  const thumbnailName = `${sanitizedName}_${fileId.substring(0, 8)}_thumbnail.jpg`;
  const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailName);

  try {
    await fs.access(thumbnailPath);
    return pathsConfig.getThumbnailUrl(thumbnailName);
  } catch {
    // No existe — generar
  }

  let actualFileType = fileType;
  if (fileType === 'export') {
    const mimeType = mime.lookup(filePath);
    if (mimeType) {
      if (mimeType.startsWith('image/')) actualFileType = 'image';
      else if (mimeType.startsWith('video/')) actualFileType = 'video';
      else if (mimeType.startsWith('audio/')) actualFileType = 'audio';
    }
  }

  try {
    if (actualFileType === 'image') {
      const imageBuffer = await fs.readFile(filePath);
      const metadata = await sharp(imageBuffer).metadata();
      const targetWidth = 600;
      const targetHeight = Math.round((metadata.height / metadata.width) * targetWidth);

      await sharp(imageBuffer)
        .resize(targetWidth, targetHeight, { fit: 'inside', withoutEnlargement: false })
        .jpeg({ quality: 80 })
        .toFile(thumbnailPath);

      return pathsConfig.getThumbnailUrl(thumbnailName);
    }

    if (actualFileType === 'video') {
      const MAX_PATH = 260;
      let effectivePath = filePath;
      let tempCopy = null;

      if (filePath.length >= MAX_PATH) {
        try {
          const tempName = `temp_video_${fileId.substring(0, 12)}${path.extname(fileName)}`;
          tempCopy = path.join(THUMBNAILS_DIR, tempName);
          const CHUNK_SIZE = 5 * 1024 * 1024;
          const srcHandle = await fs.open(filePath, 'r');
          const buffer = Buffer.alloc(CHUNK_SIZE);
          const { bytesRead } = await srcHandle.read(buffer, 0, CHUNK_SIZE, 0);
          await srcHandle.close();
          await fs.writeFile(tempCopy, buffer.subarray(0, bytesRead));
          effectivePath = tempCopy;
        } catch {
          tempCopy = null;
        }
      }

      return new Promise((resolve) => {
        const cleanup = async () => {
          if (tempCopy) { try { await fs.unlink(tempCopy); } catch {} }
        };

        const tryAt = (attempts = 0) => {
          if (attempts > 2) {
            cleanup().then(() => resolve(svgPlaceholder('VIDEO', fileName, '%236366f1')));
            return;
          }
          const timestamps = [2, 5, 1];
          ffmpeg(effectivePath)
            .screenshot({
              timestamps: [timestamps[attempts]],
              filename: thumbnailName,
              folder: THUMBNAILS_DIR
            })
            .on('end', () => cleanup().then(() => resolve(pathsConfig.getThumbnailUrl(thumbnailName))))
            .on('error', () => tryAt(attempts + 1));
        };
        tryAt();
      });
    }

    if (actualFileType === 'audio') {
      return svgPlaceholder('AUDIO', fileName, '%2310b981');
    }

    return svgPlaceholder('Archivo', fileName, '%23f3f4f6');
  } catch (error) {
    console.error(`Error generando miniatura para ${filePath}:`, error.message);
    return svgPlaceholder('Error', fileName, '%23fee2e2');
  }
}

function svgPlaceholder(label, fileName, bg) {
  const shortName = fileName.length > 25 ? fileName.substring(0, 22) + '...' : fileName;
  return `data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="${bg}"/><text x="150" y="105" font-family="Arial" font-size="14" fill="white" text-anchor="middle" font-weight="bold">${label}</text><text x="150" y="135" font-family="Arial" font-size="10" fill="white" text-anchor="middle">${encodeURIComponent(shortName)}</text></svg>`;
}

// === ESCANEO ===

async function scanDirectory(dir, baseDir = dir, totalFiles = 0, processedFiles = 0) {
  const files = [];
  let newFiles = 0, cachedFiles = 0, modifiedFiles = 0;
  let lastSaveTime = Date.now();

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const sub = await scanDirectory(fullPath, baseDir, totalFiles, processedFiles);
        files.push(...sub.files);
        newFiles += sub.stats.newFiles;
        cachedFiles += sub.stats.cachedFiles;
        modifiedFiles += sub.stats.modifiedFiles;
        processedFiles = sub.currentProcessed;
      } else if (entry.isFile()) {
        const fileType = getFileType(fullPath);
        if (!fileType) continue;

        const stats = await fs.stat(fullPath);
        const currentHash = generateFileHash(fullPath, stats);
        processedFiles++;

        // Cache hit
        if (fileCache.has(fullPath)) {
          const cached = fileCache.get(fullPath);
          if (cached.hash === currentHash) {
            // Re-mergear catalog siempre (puede haber cambiado fuera de banda)
            const merged = await catalogReader.applyCatalog(cached.fileData);
            files.push(merged);
            cachedFiles++;
            if (totalFiles > 0) {
              broadcastProgress({
                type: 'scan_progress',
                current: processedFiles,
                total: totalFiles,
                percentage: Math.round((processedFiles / totalFiles) * 100),
                status: `Cargando desde cache: ${entry.name}`,
                action: 'cached'
              });
            }
            continue;
          }
          modifiedFiles++;
        } else {
          newFiles++;
        }

        if (totalFiles > 0) {
          broadcastProgress({
            type: 'scan_progress',
            current: processedFiles,
            total: totalFiles,
            percentage: Math.round((processedFiles / totalFiles) * 100),
            status: `Procesando: ${entry.name}`,
            action: fileCache.has(fullPath) ? 'modified' : 'new'
          });
        }

        const relativePath = path.relative(baseDir, fullPath);
        const fileId = generateFileId(fullPath);

        let thumbnail;
        try {
          thumbnail = await generateThumbnail(fullPath, fileId, entry.name);
        } catch {
          thumbnail = svgPlaceholder('Error', entry.name, '%23fee2e2');
        }

        const smartTagsResult = extractSmartTags(entry.name);

        // Análisis de colores si hay thumbnail real (no SVG)
        let colorData = null;
        if (thumbnail && !thumbnail.includes('data:image/svg+xml')) {
          try {
            const thumbName = thumbnail.split('/thumbnails/').pop();
            const fullThumbnailPath = path.join(THUMBNAILS_DIR, thumbName);
            colorData = await colorAnalyzer.analyzeFileColors(fullThumbnailPath, fileType);
          } catch {}
        }

        const fileData = {
          id: fileId,
          name: entry.name,
          path: relativePath,
          fullPath,
          type: fileType,
          size: stats.size,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime,
          url: pathsConfig.getStreamUrl(fileId),
          thumbnail,
          tags: smartTagsResult.tags,
          extractedDate: smartTagsResult.extractedDate,
          colorData,
          isFavorite: favoritesManager.isFavorite(fullPath)
        };

        // Persistimos en cache la versión SIN catalog (el catalog se mergea siempre al vuelo)
        fileCache.set(fullPath, {
          hash: currentHash,
          mtime: stats.mtime,
          fileData
        });

        const merged = await catalogReader.applyCatalog(fileData);
        files.push(merged);

        if (newFiles % 10 === 0 || Date.now() - lastSaveTime > 5000) {
          await saveCache().catch(err => console.error('❌ Error cache incremental:', err));
          lastSaveTime = Date.now();
        }
      }
    }
  } catch (error) {
    console.error(`Error escaneando ${dir}:`, error);
  }

  return {
    files,
    stats: { newFiles, cachedFiles, modifiedFiles },
    currentProcessed: processedFiles
  };
}

async function countMediaFiles(dir) {
  let count = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += await countMediaFiles(fullPath);
      } else if (entry.isFile() && getFileType(fullPath)) {
        count++;
      }
    }
  } catch {}
  return count;
}

async function syncFiles() {
  console.log('🔄 Sincronizando...');

  const paths = await loadScanPaths();
  const activePaths = paths.filter(p => p.isActive);

  if (activePaths.length === 0) {
    activePaths.push({ id: 'default', path: CONTENT_DIR, isActive: true });
  }

  broadcastProgress({ type: 'sync_start', status: 'Contando archivos...', percentage: 0 });

  let allFiles = [];
  let totalStats = { newFiles: 0, cachedFiles: 0, modifiedFiles: 0 };

  try {
    for (const pathConfig of activePaths) {
      try {
        await fs.access(pathConfig.path);
      } catch {
        console.warn(`⚠️ Ruta no accesible: ${pathConfig.path}`);
        continue;
      }

      const totalFiles = await countMediaFiles(pathConfig.path);
      console.log(`📊 ${totalFiles} archivos en ${pathConfig.path}`);

      broadcastProgress({
        type: 'sync_progress',
        status: `Escaneando ${pathConfig.path}...`,
        percentage: 0,
        total: totalFiles
      });

      const result = await scanDirectory(pathConfig.path, pathConfig.path, totalFiles, 0);
      allFiles.push(...result.files);
      totalStats.newFiles += result.stats.newFiles;
      totalStats.cachedFiles += result.stats.cachedFiles;
      totalStats.modifiedFiles += result.stats.modifiedFiles;

      pathConfig.lastScan = new Date().toISOString();
      pathConfig.fileCount = result.files.length;
      pathConfig.status = 'connected';
    }

    if (paths.length > 0) {
      await saveScanPaths(paths);
    }

    // Limpiar cache de archivos inexistentes
    const existingPaths = new Set(allFiles.map(f => f.fullPath).filter(Boolean));
    if (existingPaths.size > 0) {
      for (const cachedPath of fileCache.keys()) {
        if (!existingPaths.has(cachedPath)) fileCache.delete(cachedPath);
      }
    }

    if (totalStats.newFiles > 0 || totalStats.modifiedFiles > 0) {
      await saveCache();
    }

    // Aplicar favoritos
    mediaFiles = favoritesManager.applyFavoritesToFiles(allFiles);

    // Limpieza de huérfanos
    const currentFileIds = mediaFiles.map(f => f.id);
    const currentPaths = mediaFiles.map(f => f.fullPath).filter(Boolean);
    await favoritesManager.cleanupOrphanedFavorites(currentPaths);
    await collectionsManager.cleanupOrphanedFiles(currentFileIds);

    // Recalcular agregado de personas tras cada sync (memoización)
    recomputePersonsAggregate();

    broadcastProgress({
      type: 'sync_complete',
      status: 'Sincronización completada',
      percentage: 100,
      total: mediaFiles.length,
      stats: {
        nuevos: totalStats.newFiles,
        cache: totalStats.cachedFiles,
        modificados: totalStats.modifiedFiles,
        total: mediaFiles.length,
        favoritos: favoritesManager.getStats().totalFavorites,
        personas: personsAggregate.length
      }
    });

    console.log(`✨ Nuevos: ${totalStats.newFiles} | 📦 Cache: ${totalStats.cachedFiles} | 📝 Modificados: ${totalStats.modifiedFiles} | 👥 Personas: ${personsAggregate.length}`);
    return mediaFiles;
  } catch (error) {
    console.error('❌ Error en sync:', error);
    broadcastProgress({ type: 'sync_error', status: 'Error', error: error.message });
    return allFiles;
  } finally {
    if (fileCache.size > 0) {
      await saveCache().catch(() => {});
    }
  }
}

// Watcher de filesystem
function watchFileSystem() {
  if (!CONTENT_DIR) return;
  try {
    // Ignorar JSONs en general, EXCEPTO `_marina.json` (lo vigilamos para
    // invalidar el cache de catalogs en cambios fuera de banda).
    const watcher = chokidar.watch(CONTENT_DIR, {
      persistent: true,
      ignoreInitial: true,
      ignored: (p) => {
        if (!/\.json$/i.test(p)) return false;
        return path.basename(p).toLowerCase() !== '_marina.json';
      }
    });

    const isCatalog = (p) => path.basename(p).toLowerCase() === '_marina.json';

    const handleCatalogChange = (filePath) => {
      const dir = path.dirname(filePath);
      catalogReader.invalidateCatalog(dir);
      console.log(`🔄 Catalog invalidado: ${dir}`);
      // Refrescar in-place los MediaFile en memoria de esa carpeta
      // (no requiere resync completo).
      refreshFilesInDir(dir).catch(err =>
        console.warn('⚠️ Error refrescando archivos tras cambio de catalog:', err.message)
      );
    };

    watcher
      .on('add', async (p) => {
        if (isCatalog(p)) { handleCatalogChange(p); return; }
        await syncFiles();
      })
      .on('unlink', async (p) => {
        if (isCatalog(p)) { handleCatalogChange(p); return; }
        await syncFiles();
      })
      .on('change', async (p) => {
        if (isCatalog(p)) { handleCatalogChange(p); return; }
        await syncFiles();
      });
  } catch (err) {
    console.warn('⚠️ No se pudo iniciar watcher:', err.message);
  }
}

/**
 * Refresca los MediaFile en memoria que viven en `dirPath`, re-aplicando
 * el catalog. No toca el filesystem ni dispara un sync completo.
 */
async function refreshFilesInDir(dirPath) {
  const normalized = path.normalize(dirPath).toLowerCase();
  for (let i = 0; i < mediaFiles.length; i++) {
    const f = mediaFiles[i];
    if (!f.fullPath) continue;
    if (path.dirname(f.fullPath).toLowerCase() !== normalized) continue;

    // Tomar el fileData base del cache (sin catalog) y re-aplicar
    const cached = fileCache.get(f.fullPath);
    const base = cached ? cached.fileData : f;
    mediaFiles[i] = await catalogReader.applyCatalog(base);
  }
  broadcastProgress({ type: 'catalog_refresh', dir: dirPath });
}

// === ROUTERS ===

const aiRoutes = createAiRoutes({
  broadcastProgress,
  getMediaFiles: () => mediaFiles,
  getFileCache: () => fileCache,
  imageUpload,
  // Hints para el LLM: TODAS las personas conocidas por Pensadero, sin cap.
  // Conjunto = aggregate (incluye huérfanos detectados en mediaFiles aunque
  // no estén en registry) ∪ entradas del registry que aún no aparecen en
  // ningún archivo (útil al arrancar antes del primer sync).
  // Sin filtrado por popularidad: una persona con una sola aparición debe
  // ser igualmente reconocible por el LLM.
  getPeopleHints: () => {
    const seen = new Set();
    const list = [];
    for (const p of (personsAggregate || [])) {
      if (!p || !p.person_id || seen.has(p.person_id)) continue;
      seen.add(p.person_id);
      list.push({
        person_id: p.person_id,
        display_name: p.display_name || p.person_id,
        aliases: peopleRegistry.getAliases(p.person_id),
      });
    }
    for (const [pid, entry] of peopleRegistry.entries()) {
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      list.push({
        person_id: pid,
        display_name: (entry && entry.display_name) || pid,
        aliases: peopleRegistry.getAliases(pid),
      });
    }
    return list;
  },
});
app.use('/api', aiRoutes);

const organizationRoutes = createOrganizationRoutes({
  getMediaFiles: () => mediaFiles
});
app.use('/api', organizationRoutes);

const mediaRoutes = createMediaRoutes({
  getMediaFiles: () => mediaFiles,
  setMediaFiles: (files) => { mediaFiles = files; },
  getFileCache: () => fileCache,
  setFileCache: (p, data) => { fileCache.set(p, data); },
  saveCache,
  syncFiles,
  broadcastProgress,
  generateThumbnail,
  extractSmartTags,
  CONTENT_DIR
});
app.use('/api', mediaRoutes);

const systemRoutes = createSystemRoutes({
  getMediaFiles: () => mediaFiles,
  setMediaFiles: (files) => { mediaFiles = files; },
  getCollections: () => collectionsManager.getAllCollections(),
  broadcastProgress,
  saveCache,
  scanDirectory,
  countMediaFiles,
  generateThumbnail,
  CONTENT_DIR
});
app.use('/api', systemRoutes);

// Escaneo visual con VLM local (qwen2.5vl via Ollama). Genera _pensadero.json
// en cada carpeta procesada y refresca el sync para que el frontend vea la
// metadata sin pulsar "sincronizar".
const scanRoutes = createScanRoutes({
  broadcastProgress,
  syncFiles,
  loadScanPaths,
});
app.use('/api', scanRoutes);

// CRUD del registry de personas + fotos de referencia. Se aplica a continuación
// del agregado memoizado (que ya escucha /api/persons en GET para listado de
// apariciones). Estas rutas son /api/persons/registry/... — sin colisión.
const personsManageRoutes = createPersonsManageRoutes({
  recomputePersonsAggregate,
  broadcastProgress,
  getScanPaths: loadScanPaths,
});
app.use('/api', personsManageRoutes);

// Registry de espacios + training del centroide CLIP por espacio.
const spacesManageRoutes = createSpacesManageRoutes({
  broadcastProgress,
  getScanPaths: loadScanPaths,
});
app.use('/api', spacesManageRoutes);

// Busqueda por color (Delta E sobre la palette del schema v2). Alimenta
// la "rueda de colores" del frontend.
const colorSearchRoutes = createColorSearchRoutes({
  getMediaFiles: () => mediaFiles,
});
app.use('/api', colorSearchRoutes);

// Tabla de sinonimos para expandir queries (Stage 1). El LLM propone grupos
// que el usuario revisa via /api/tags/aliases/propose.
const aliasRoutes = createAliasRoutes({
  getMediaFiles: () => mediaFiles,
});
app.use('/api', aliasRoutes);

// === PERSONS (registry + agregado memoizado) ===

// GET /api/persons — devuelve el agregado memoizado. Sin I/O por request.
app.get('/api/persons', (req, res) => {
  res.json({
    success: true,
    data: personsAggregate
  });
});

// POST /api/persons/refresh — fuerza recálculo sin resync de archivos. Útil
// si el usuario edita el registry o añade un avatar manualmente.
app.post('/api/persons/refresh', (req, res) => {
  // Recargar el registry desde disco por si cambió
  if (PERSONS_REGISTRY_PATH) {
    peopleRegistry.loadRegistry(PERSONS_REGISTRY_PATH, PERSONS_AVATARS_BASE);
  }
  // Re-aplicar catalog en memoria para que faces[].display_name reflejen el
  // registry actualizado. No relee disco más allá del registry.
  for (let i = 0; i < mediaFiles.length; i++) {
    const f = mediaFiles[i];
    if (!f || !Array.isArray(f.faces) || f.faces.length === 0) continue;
    f.faces = f.faces.map(face => {
      if (!face || !face.person_id) return face;
      const fromRegistry = peopleRegistry.getDisplayName(face.person_id);
      // Solo actualizamos si el registry tiene un nombre distinto del id
      if (fromRegistry && fromRegistry !== face.person_id) {
        return { ...face, display_name: fromRegistry };
      }
      // Si registry no tiene entrada, mantener el display_name actual
      return face;
    });
  }
  recomputePersonsAggregate();
  res.json({ success: true, count: personsAggregate.length });
});

// Limpieza de thumbnails huérfanos
async function cleanOrphanedThumbnails() {
  try {
    const thumbnailFiles = await fs.readdir(THUMBNAILS_DIR);
    const valid = new Set();
    mediaFiles.forEach(file => {
      if (file.thumbnail && file.thumbnail.includes('/thumbnails/')) {
        valid.add(file.thumbnail.split('/thumbnails/')[1]);
      }
    });

    let removed = 0;
    for (const t of thumbnailFiles) {
      if (!valid.has(t)) {
        try { await fs.unlink(path.join(THUMBNAILS_DIR, t)); removed++; } catch {}
      }
    }
    if (removed > 0) console.log(`🧹 Thumbnails huérfanos eliminados: ${removed}`);
  } catch (error) {
    console.error('Error limpiando thumbnails:', error.message);
  }
}

// === ARRANQUE ===

async function initialize() {
  await ensureDirectories();
  await loadExportsPaths();

  // Cargar registry de personas ANTES del primer sync — así applyCatalog
  // resuelve display_name desde el registry desde el primer pase.
  // Si el archivo no existe aún (primer arranque), creamos la carpeta y
  // dejamos el registry vacío pero con la ruta lista para escrituras desde
  // la UI de gestión de personas.
  try {
    await fs.mkdir(path.dirname(PERSONS_REGISTRY_PATH), { recursive: true });
    await fs.mkdir(path.join(PERSONS_AVATARS_BASE, 'people'), { recursive: true });
  } catch (err) {
    console.warn(`⚠️ No se pudo preparar carpeta de personas: ${err.message}`);
  }

  const loadResult = peopleRegistry.loadRegistry(PERSONS_REGISTRY_PATH, PERSONS_AVATARS_BASE);
  if (!loadResult.ok && loadResult.count === 0) {
    // El archivo no existe todavía: dejamos la ruta configurada para futuros
    // saveToDisk(), sin warnings ruidosos.
    peopleRegistry.setRegistryPath(PERSONS_REGISTRY_PATH, PERSONS_AVATARS_BASE);
    console.log(`👥 Registry vacío. Se creará en ${PERSONS_REGISTRY_PATH} al guardar la primera persona.`);
  }
  // Spaces: mismo patron. Comparten avatarsBase con personas.
  try {
    await fs.mkdir(path.dirname(SPACES_REGISTRY_PATH), { recursive: true });
    await fs.mkdir(path.join(PERSONS_AVATARS_BASE, 'spaces'), { recursive: true });
  } catch (err) {
    console.warn(`⚠️ No se pudo preparar carpeta de spaces: ${err.message}`);
  }
  const spacesLoadResult = spacesRegistry.loadRegistry(SPACES_REGISTRY_PATH, PERSONS_AVATARS_BASE);
  if (!spacesLoadResult.ok && spacesLoadResult.count === 0) {
    spacesRegistry.setRegistryPath(SPACES_REGISTRY_PATH, PERSONS_AVATARS_BASE);
    console.log(`🏢 Spaces registry vacío. Se creará en ${SPACES_REGISTRY_PATH} al guardar el primer espacio.`);
  }
  mountPersonsAvatars();
  watchPersonsRegistry();

  // Cargar la tabla de sinonimos. Si no existe el archivo, opera vacia.
  await aliasTable.load();

  // Cargar el indice de embeddings CLIP en memoria. Si no existe, opera vacio.
  // El daemon Python CLIP se carga lazy (solo al primer embedImage / embedText).
  await clipIndex.load();

  await loadCache();
  await syncFiles();

  setTimeout(() => cleanOrphanedThumbnails(), 5000);

  watchFileSystem();

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`🚀 Pensadero backend en http://127.0.0.1:${PORT}`);
    console.log(`📡 WebSocket en ws://127.0.0.1:${PORT}/ws`);
    console.log(`📂 Carpeta de contenido: ${CONTENT_DIR}`);
    console.log(`💾 Cache: ${fileCache.size} archivos`);
    console.log(`👥 Personas: ${personsAggregate.length} con apariciones`);
  });
}

/**
 * Vigila el archivo `people_registry.json` para invalidar el agregado
 * cuando cambia. Solo el archivo concreto, NO la carpeta de avatares.
 */
function watchPersonsRegistry() {
  if (!PERSONS_REGISTRY_PATH) return;
  try {
    const watcher = chokidar.watch(PERSONS_REGISTRY_PATH, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    });

    const handleChange = () => {
      console.log('🔄 people_registry.json cambió: recargando');
      peopleRegistry.loadRegistry(PERSONS_REGISTRY_PATH, PERSONS_AVATARS_BASE);
      // Re-resolver display_names en faces existentes
      for (let i = 0; i < mediaFiles.length; i++) {
        const f = mediaFiles[i];
        if (!f || !Array.isArray(f.faces) || f.faces.length === 0) continue;
        f.faces = f.faces.map(face => {
          if (!face || !face.person_id) return face;
          const fromRegistry = peopleRegistry.getDisplayName(face.person_id);
          if (fromRegistry && fromRegistry !== face.person_id) {
            return { ...face, display_name: fromRegistry };
          }
          return face;
        });
      }
      recomputePersonsAggregate();
      broadcastProgress({ type: 'persons_refresh', count: personsAggregate.length });
    };

    watcher
      .on('change', handleChange)
      .on('add', handleChange)
      .on('unlink', () => {
        console.warn('⚠️ people_registry.json eliminado. Personas operarán como vacío hasta que se restaure.');
        peopleRegistry.loadRegistry(null);
        recomputePersonsAggregate();
      });
  } catch (err) {
    console.warn('⚠️ No se pudo vigilar people_registry.json:', err.message);
  }
}

process.on('uncaughtException', (error) => console.error('Error no capturado:', error));
process.on('unhandledRejection', (error) => console.error('Promesa rechazada:', error));

initialize();
