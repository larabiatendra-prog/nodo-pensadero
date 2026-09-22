/**
 * Pensadero — Servidor backend (single-user)
 *
 * Servidor Express + WebSocket para gestionar la biblioteca local
 * de medios del usuario. Sin auth, sin multi-tenant, sin Supabase.
 *
 * Lee el catalog JSON por carpeta (`_pensadero.json`, o `_marina.json`
 * legado) que Pensadero genera al escanear, y mergea los datos enriquecidos
 * del clip correspondiente sobre el MediaFile en memoria. Ver
 * `catalogReader.js` para el formato y comportamiento.
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
const { atomicWriteFile, quarantineCorrupt } = require('./utils/jsonStore');
const peopleRegistry = require('./peopleRegistry');
const personsAggregator = require('./personsAggregator');
const multer = require('multer');
require('dotenv').config();

// Configuración de rutas
const pathsConfig = require('./config/paths');

// Routers modulares
const createAiRoutes = require('./routes/aiRoutes');
const createOrganizationRoutes = require('./routes/organizationRoutes');
const createDuplicatesRoutes = require('./routes/duplicatesRoutes');
const createMediaRoutes = require('./routes/mediaRoutes');
const createSystemRoutes = require('./routes/systemRoutes');
const createScanRoutes = require('./routes/scanRoutes');
const createPersonsManageRoutes = require('./routes/personsManageRoutes');
const createColorSearchRoutes = require('./routes/colorSearchRoutes');
const createAliasRoutes = require('./routes/aliasRoutes');
const createNotesRoutes = require('./routes/notesRoutes');
const createOcultosRoutes = require('./routes/ocultosRoutes');
const createProxiesRoutes = require('./routes/proxiesRoutes');
const createPersonaArchivosRoutes = require('./routes/personaArchivosRoutes');
const createGruposRoutes = require('./routes/gruposRoutes');
const ocultosManager = require('./ocultosManager');
const portada = require('./services/portada');

// La primera sincronizacion tras arrancar ya termino: hasta entonces la lista
// de archivos esta vacia o a medias y la portada no ofrece "Entrar".
let arranqueListo = false;
const aliasTable = require('./aliasTable');
const folderNames = require('./folderNames');
const mediaIdentity = require('./utils/mediaIdentity');
const clipIndex = require('./clipIndex');
const fallos = require('./utils/failureReason');
const { esCarpetaExcluida, esArchivoBasura } = require('./utils/carpetasExcluidas');
const fechaArchivo = require('./utils/fechaArchivo');
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
// Interfaz de escucha. Default 127.0.0.1 (solo local, sin exposicion a red).
// Para acceso LAN/VPN: define HOST=0.0.0.0 en backend/.env. La app NO tiene
// auth: hazlo solo tras montar la VPN o en una red de confianza.
const HOST = process.env.HOST || '127.0.0.1';

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
  const scanPathsFile = path.join(__dirname, 'scan_paths.json');
  let data;
  try {
    data = await fs.readFile(scanPathsFile, 'utf-8');
  } catch (error) {
    return []; // no existe o no accesible
  }
  try {
    return JSON.parse(data);
  } catch (error) {
    // scan_paths.json NO es regenerable (son las bibliotecas del usuario). Si
    // está corrupto, NO devolver [] y dejar que un saveScanPaths posterior lo
    // machaque: cuarentena para recuperación manual.
    console.error(`❌ scan_paths.json corrupto: ${error.message}`);
    await quarantineCorrupt(scanPathsFile);
    return [];
  }
}

// Guardar configuración de rutas (escritura atómica: tmp + rename).
async function saveScanPaths(paths) {
  try {
    const scanPathsFile = path.join(__dirname, 'scan_paths.json');
    await atomicWriteFile(scanPathsFile, JSON.stringify(paths, null, 2));
  } catch (error) {
    console.error('❌ Error guardando rutas:', error.message);
  }
}

/**
 * Guarda lo que una sincronizacion sabe de cada ruta (estado, conteo, ultima
 * pasada) ENCIMA de lo que haya en disco en ese momento. La sincronizacion
 * carga las rutas al empezar y puede durar minutos: guardarlas tal cual
 * pisaba lo que el usuario hubiera cambiado entretanto (un interruptor de
 * escaneo, un nombre, desvincular una ruta).
 */
async function guardarEstadoDeRutas(rutasSync) {
  const frescas = await loadScanPaths();
  if (!Array.isArray(frescas) || frescas.length === 0) return saveScanPaths(rutasSync);
  const porId = new Map(rutasSync.map(r => [r.id, r]));
  for (const r of frescas) {
    const s = porId.get(r.id);
    if (!s) continue;
    for (const k of ['status', 'lastError', 'lastScan', 'fileCount']) {
      if (Object.prototype.hasOwnProperty.call(s, k)) r[k] = s[k];
    }
  }
  return saveScanPaths(frescas);
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

// CORS restringido. En producción el backend sirve el frontend en el MISMO
// origen que la API, así que el navegador NO aplica CORS a las llamadas
// normales. El único cross-origin legítimo es desarrollo: Vite en :5173 → API
// en :5000 (mismo host). Permitimos solo orígenes locales (localhost /
// 127.0.0.1 / ::1, cualquier puerto) y peticiones sin Origin (navegación
// same-origin, <video>, curl). Una web externa queda sin ACAO → el navegador
// le bloquea leer la respuesta (anti-exfiltración), crítico al no haber auth.
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
app.use(cors({
  origin(origin, cb) {
    if (!origin || LOCAL_ORIGIN_RE.test(origin)) return cb(null, true);
    return cb(null, false); // sin cabecera ACAO → el navegador bloquea la lectura
  },
}));

// Defensa anti-CSRF / anti-DNS-rebinding. Como no hay auth, una web externa
// podría disparar POSTs cross-origin que mutan estado (scan, tags, etc.). Para
// métodos que mutan, si viene Origin exigimos que sea el MISMO host que sirve
// la API (same-origin real) o un origen local de desarrollo; si no, 403. Los
// GET/HEAD se dejan pasar: su respuesta ya queda protegida por la política CORS.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (LOCAL_ORIGIN_RE.test(origin)) return next();
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch { /* Origin malformado: tratar como no permitido abajo */ }
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return res.status(403).json({ success: false, error: 'Origin no permitido' });
});

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
    const VIDEO_SERVE_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.mpg', '.mpeg', '.mts', '.m2ts', '.wmv', '.flv', '.3gp', '.ts', '.ogv', '.vob', '.dv']);
    const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
    if (VIDEO_SERVE_EXTS.has(ext)) {
      res.set('Content-Type', 'video/mp4');
    } else if (p.endsWith('.webm')) {
      res.set('Content-Type', 'video/webm');
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

// Migracion a origen unico: convierte URLs absolutas horneadas
// (http://host:port/...) en relativas. El cache viejo guardaba
// http://localhost:5000/... que rompe en acceso remoto (LAN/VPN). Respeta los
// data: URI (placeholders SVG). Idempotente: en arranques ya migrados es no-op.
function toRelativeAssetUrl(u) {
  if (typeof u !== 'string' || u.startsWith('data:')) return u;
  return u.replace(/^https?:\/\/[^/]+/i, '');
}

function migrateCacheUrlsToRelative() {
  let changed = 0;
  for (const entry of fileCache.values()) {
    if (!entry || !entry.fileData) continue;
    const fd = entry.fileData;
    const newUrl = toRelativeAssetUrl(fd.url);
    const newThumb = toRelativeAssetUrl(fd.thumbnail);
    if (newUrl !== fd.url || newThumb !== fd.thumbnail) {
      fd.url = newUrl;
      fd.thumbnail = newThumb;
      changed++;
    }
  }
  return changed;
}

async function loadCache() {
  try {
    await favoritesManager.loadFavorites();
    await collectionsManager.loadCollections();
    await ocultosManager.ensureLoaded();

    const exists = await fs.access(CACHE_FILE).then(() => true).catch(() => false);
    if (exists) {
      const cacheData = await fs.readFile(CACHE_FILE, 'utf-8');
      fileCache = new Map(Object.entries(JSON.parse(cacheData)));
      console.log(`📦 Cache cargado: ${fileCache.size} archivos`);
      // Migrar URLs absolutas heredadas a relativas (origen unico). Solo
      // re-guarda si algo cambio; en arranques posteriores es no-op.
      const migrated = migrateCacheUrlsToRelative();
      if (migrated > 0) {
        console.log(`🔧 Cache migrado a URLs relativas: ${migrated} entradas`);
        await saveCache();
      }
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
    // Escritura atómica: el watcher puede disparar varios saveCache solapados;
    // tmp + rename evita que se entrelacen y corrompan media_cache.json.
    await atomicWriteFile(CACHE_FILE, JSON.stringify(obj));
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

// Respaldo extension -> tipo para contenedores que `mime-types` NO conoce
// (formatos de camara/legacy). Sin esto, getFileType los descarta y quedan
// invisibles aunque el escaneo visual si los procese (caso .m2ts: 120 videos
// con thumbnail y sidecar pero "Archivos: 0"). Solo se consulta cuando
// mime.lookup falla, asi que incluir extensiones que mime ya resuelve es inocuo.
const EXT_TYPE_FALLBACK = new Map([
  ['.m2ts', 'video'], ['.mts', 'video'], ['.ts', 'video'], ['.vob', 'video'],
  ['.dv', 'video'], ['.ogv', 'video'], ['.mxf', 'video'], ['.mkv', 'video'],
  ['.flv', 'video'], ['.3gp', 'video'], ['.m4v', 'video'], ['.mpg', 'video'],
  ['.mpeg', 'video'], ['.wmv', 'video'], ['.mov', 'video'], ['.avi', 'video'],
]);

function getFileType(filePath) {
  const normalizedPath = path.normalize(filePath).toLowerCase();
  const isExport = EXPORTS_PATHS.some(exportPath => normalizedPath.startsWith(exportPath));
  if (isExport) return 'export';

  const mimeType = mime.lookup(filePath);
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return null;
  }
  // mime-types no reconoce la extension: respaldo por extension.
  return EXT_TYPE_FALLBACK.get(path.extname(filePath).toLowerCase()) || null;
}

// === THUMBNAIL ===

async function generateThumbnail(filePath, fileId, fileName) {
  const fileType = getFileType(filePath);

  // El thumbnail vive junto al archivo, en <dir-del-archivo>\.pensadero\thumbnails.
  // Si el destino no es escribible, el resolver cae al legacy (backend/thumbnails).
  let loc = pathsConfig.resolveThumbnailLocation({ fullPath: filePath, fileId, fileName });

  // Crear el directorio destino de forma lazy (no en el arranque): los discos
  // externos pueden estar desconectados o ser de solo lectura. Si falla, caer al
  // directorio legacy local; si eso tambien falla, el llamante recibe placeholder.
  const ensureDir = async () => {
    try {
      await fs.mkdir(loc.thumbnailDir, { recursive: true });
      return true;
    } catch (err) {
      if (!loc.legacy) {
        console.warn(`⚠️ No se pudo crear ${loc.thumbnailDir} (${err.message}). Fallback a thumbnails legacy.`);
        loc = pathsConfig.resolveThumbnailLocation({ fullPath: filePath, fileId, fileName, legacy: true });
        try { await fs.mkdir(loc.thumbnailDir, { recursive: true }); return true; } catch { return false; }
      }
      return false;
    }
  };

  // Cache hit: si ya existe en el destino esperado, devolver la URL sin regenerar.
  try {
    await fs.access(loc.thumbnailPath);
    return loc.thumbnailUrl;
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
      if (!(await ensureDir())) return svgPlaceholder('Error', fileName, '%23fee2e2');
      const imageBuffer = await fs.readFile(filePath);
      const metadata = await sharp(imageBuffer).metadata();
      const targetWidth = 600;
      const targetHeight = Math.round((metadata.height / metadata.width) * targetWidth);

      await sharp(imageBuffer)
        .resize(targetWidth, targetHeight, { fit: 'inside', withoutEnlargement: false })
        .jpeg({ quality: 80 })
        .toFile(loc.thumbnailPath);

      return loc.thumbnailUrl;
    }

    if (actualFileType === 'video') {
      if (!(await ensureDir())) return svgPlaceholder('VIDEO', fileName, '%236366f1');
      const MAX_PATH = 260;
      let effectivePath = filePath;
      let tempCopy = null;

      if (filePath.length >= MAX_PATH) {
        try {
          const tempName = `temp_video_${fileId.substring(0, 12)}${path.extname(fileName)}`;
          // Staging en el dir legacy local (ruta corta) para no chocar con el
          // limite de 260 chars de ffmpeg, independientemente de donde viva el
          // thumbnail final (que puede estar en un disco externo de ruta larga).
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
              filename: loc.thumbnailName,
              folder: loc.thumbnailDir
            })
            .on('end', () => cleanup().then(() => resolve(loc.thumbnailUrl)))
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

/**
 * Progreso del indexado en curso.
 *
 * Lo abre quien lanza el recorrido (performSync, o la sincronizacion de una
 * sola ruta) y lo va anotando scanDirectory archivo a archivo. Existe para que
 * la pantalla de progreso muestre cifras de TODO el proceso —hechos de cuantos,
 * cuanto lleva, en que biblioteca va— y no un porcentaje que volvia a cero en
 * cada disco y decia "Escaneando" cuando no habia IA de por medio.
 */
let indexado = null;

function abrirIndexado({ total = 0, bibliotecasTotal = 1 } = {}) {
  indexado = {
    inicio: Date.now(),
    total,
    hechos: 0,
    nuevos: 0,
    enCache: 0,
    modificados: 0,
    biblioteca: null,
    bibliotecaN: 0,
    bibliotecasTotal,
    ultimoEnvio: 0,
  };
  return indexado;
}

/** Campos comunes de todos los frames del indexado. */
function camposIndexado(extra = {}) {
  const x = indexado;
  if (!x) return extra;
  return {
    inicio: x.inicio,
    hechos: x.hechos,
    total: x.total,
    nuevos: x.nuevos,
    enCache: x.enCache,
    modificados: x.modificados,
    biblioteca: x.biblioteca,
    bibliotecaN: x.bibliotecaN,
    bibliotecasTotal: x.bibliotecasTotal,
    percentage: x.total > 0 ? Math.min(100, Math.round((x.hechos / x.total) * 100)) : 0,
    ...extra,
  };
}

/**
 * Anota un archivo recorrido y emite progreso. Los aciertos de cache van a
 * miles por segundo: se emite como mucho cada 120 ms para no inundar el
 * WebSocket (antes salia un frame por archivo, 28.000 en una sincronizacion).
 * Los nuevos y modificados, que tardan de verdad, se emiten siempre.
 * @param {'cache'|'nuevo'|'modificado'} accion
 */
function anotarIndexado(nombre, accion) {
  const x = indexado;
  if (!x) return;
  x.hechos++;
  if (accion === 'cache') x.enCache++;
  else if (accion === 'modificado') x.modificados++;
  else x.nuevos++;
  const ahora = Date.now();
  if (accion === 'cache' && ahora - x.ultimoEnvio < 120 && x.hechos < x.total) return;
  x.ultimoEnvio = ahora;
  broadcastProgress({
    type: 'sync_progress',
    ...camposIndexado({ fase: 'indexando', archivo: nombre, accion }),
  });
}

async function scanDirectory(dir, baseDir = dir, totalFiles = 0, processedFiles = 0, libraryId = null) {
  // Llamada de primer nivel sin progreso abierto (p.ej. sincronizar una sola
  // ruta): se abre aqui y se cierra al terminar.
  const abreProgreso = !indexado && dir === baseDir;
  if (abreProgreso) abrirIndexado({ total: totalFiles });
  try {
    return await recorrerDirectorio(dir, baseDir, totalFiles, processedFiles, libraryId);
  } finally {
    if (abreProgreso) indexado = null;
  }
}

async function recorrerDirectorio(dir, baseDir = dir, totalFiles = 0, processedFiles = 0, libraryId = null) {
  const files = [];
  let newFiles = 0, cachedFiles = 0, modifiedFiles = 0;
  let lastSaveTime = Date.now();

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Saltar carpetas tecnicas (.pensadero, .git, etc.). Critico: dentro de
        // cada biblioteca vive <scanRoot>\.pensadero\thumbnails; si no se excluye,
        // el escaner re-indexaria sus propios thumbnails .jpg como medios
        // (duplicados que se persisten en media_cache.json).
        if (entry.name.startsWith('.')) continue;
        // Previews de render, auto-saves y caches de las suites de edicion:
        // son archivos que el programa regenera solo, no son material.
        if (esCarpetaExcluida(entry.name)) continue;
        const sub = await recorrerDirectorio(fullPath, baseDir, totalFiles, processedFiles, libraryId);
        files.push(...sub.files);
        newFiles += sub.stats.newFiles;
        cachedFiles += sub.stats.cachedFiles;
        modifiedFiles += sub.stats.modifiedFiles;
        processedFiles = sub.currentProcessed;
      } else if (entry.isFile()) {
        if (esArchivoBasura(entry.name)) continue;
        const fileType = getFileType(fullPath);
        if (!fileType) continue;

        const stats = await fs.stat(fullPath);
        const currentHash = generateFileHash(fullPath, stats);
        processedFiles++;

        // Cache hit
        if (fileCache.has(fullPath)) {
          const cached = fileCache.get(fullPath);
          if (cached.hash === currentHash) {
            // Backfill de identidad portable en entradas de cache antiguas (que
            // se cachearon antes de existir mediaKey). No invalida el cache ni
            // toca el id md5: solo anade los campos portables que falten.
            if (libraryId && cached.fileData && !cached.fileData.mediaKey) {
              const relCached = path.relative(baseDir, fullPath);
              const mkCached = mediaIdentity.makeMediaKey(libraryId, relCached);
              if (mkCached) {
                cached.fileData.libraryId = libraryId;
                cached.fileData.relativePath = mediaIdentity.normalizeRelativePath(relCached);
                cached.fileData.mediaKey = mkCached;
                cached.fileData.mediaId = mediaIdentity.mediaIdFromKey(mkCached);
              }
            }
            // Re-mergear catalog siempre (puede haber cambiado fuera de banda)
            const merged = await catalogReader.applyCatalog(cached.fileData);
            files.push(merged);
            cachedFiles++;
            anotarIndexado(entry.name, 'cache');
            continue;
          }
          modifiedFiles++;
        } else {
          newFiles++;
        }

        // Se anota ANTES de procesarlo: lo que tarda es la miniatura de este
        // archivo, y la pantalla debe decir en cual esta, no el anterior.
        anotarIndexado(entry.name, fileCache.has(fullPath) ? 'modificado' : 'nuevo');

        const relativePath = path.relative(baseDir, fullPath);
        const fileId = generateFileId(fullPath);
        // Identidad portable: mediaKey = "<libraryId>:<relativePathNorm>". No
        // depende de la ruta absoluta; sobrevive al remapeo de la raiz de la
        // biblioteca. El id md5 se conserva como token de runtime (URLs).
        const mediaKey = libraryId ? mediaIdentity.makeMediaKey(libraryId, relativePath) : '';

        // El thumbnail se guarda junto al archivo, en <su-carpeta>\.pensadero\thumbnails.
        let thumbnail;
        try {
          thumbnail = await generateThumbnail(fullPath, fileId, entry.name);
        } catch {
          thumbnail = svgPlaceholder('Error', entry.name, '%23fee2e2');
        }

        const smartTagsResult = extractSmartTags(entry.name);

        // Análisis de colores si hay thumbnail real (no placeholder SVG inline).
        // La ruta de disco se resuelve con el mismo resolver que generó el
        // thumbnail; ya no se reconstruye desde la URL (ahora /api/thumbnails/:id).
        // generateThumbnail puede haber caido al dir legacy si fallo el mkdir del
        // destino por-disco, asi que probamos ambos (igual que el endpoint).
        let colorData = null;
        if (thumbnail && !thumbnail.startsWith('data:')) {
          const newLoc = pathsConfig.resolveThumbnailLocation({ fullPath, fileId, fileName: entry.name });
          const legacyLoc = pathsConfig.resolveThumbnailLocation({ fullPath, fileId, fileName: entry.name, legacy: true });
          for (const cand of [newLoc.thumbnailPath, legacyLoc.thumbnailPath]) {
            try {
              await fs.access(cand);
              colorData = await colorAnalyzer.analyzeFileColors(cand, fileType);
              break;
            } catch {}
          }
        }

        const fileData = {
          id: fileId,
          libraryId: libraryId || null,
          relativePath: mediaIdentity.normalizeRelativePath(relativePath),
          mediaKey: mediaKey || null,
          mediaId: mediaKey ? mediaIdentity.mediaIdFromKey(mediaKey) : null,
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
        // Mismo skip que scanDirectory: no contar archivos dentro de .pensadero.
        if (entry.name.startsWith('.')) continue;
        // Mismo criterio que scanDirectory: contar lo que se va a catalogar.
        if (esCarpetaExcluida(entry.name)) continue;
        count += await countMediaFiles(fullPath);
      } else if (entry.isFile() && !esArchivoBasura(entry.name) && getFileType(fullPath)) {
        count++;
      }
    }
  } catch {}
  return count;
}

async function performSync() {
  console.log('🔄 Sincronizando...');

  const paths = await loadScanPaths();
  const activePaths = paths.filter(p => p.isActive);

  if (activePaths.length === 0) {
    activePaths.push({ id: 'default', path: CONTENT_DIR, isActive: true });
  }

  // Inyectar las bibliotecas activas en folderNames para que pueda resolver
  // carpetas absolutas -> identidad portable (libraryId + relativeDir). Se hace
  // en cada sync para reflejar remapeos de raiz al instante.
  folderNames.setLibraries(activePaths.map(p => ({ id: p.id, path: p.path })));
  // Mismo motivo para favoritos: sin las bibliotecas no puede derivar la
  // mediaKey y se quedaria guardando por ruta absoluta (no portable).
  favoritesManager.setLibraries(activePaths.map(p => ({ id: p.id, path: p.path })));

  // Se cuenta TODO antes de recorrer nada: asi el total es el del proceso
  // entero y el porcentaje no vuelve a cero al cambiar de disco.
  abrirIndexado({ bibliotecasTotal: activePaths.length });
  broadcastProgress({ type: 'sync_start', ...camposIndexado({ fase: 'contando', status: 'Contando archivos...' }) });
  const conteos = new Map();
  for (const pathConfig of activePaths) {
    try {
      await fs.access(pathConfig.path);
    } catch {
      continue;
    }
    indexado.biblioteca = pathConfig.path;
    indexado.bibliotecaN = conteos.size + 1;
    broadcastProgress({ type: 'sync_progress', ...camposIndexado({ fase: 'contando' }) });
    const n = await countMediaFiles(pathConfig.path);
    conteos.set(pathConfig.id, n);
    indexado.total += n;
    console.log(`📊 ${n} archivos en ${pathConfig.path}`);
  }
  indexado.bibliotecasTotal = conteos.size;
  indexado.bibliotecaN = 0;

  let allFiles = [];
  let totalStats = { newFiles: 0, cachedFiles: 0, modifiedFiles: 0 };
  // Bibliotecas que se han podido LEER en esta pasada. Solo sobre estas se
  // puede afirmar que un archivo ha desaparecido; sobre un disco desconectado
  // la ausencia no prueba nada (ver cleanupOrphanedFavorites).
  const librariesScanned = new Set();

  try {
    for (const pathConfig of activePaths) {
      try {
        await fs.access(pathConfig.path);
      } catch {
        // Marcar el estado real: sin esto se quedaba el 'connected' de la
        // ultima sincronizacion buena y la UI seguia pintando como conectada
        // una biblioteca que ya no existe (disco desenchufado, carpeta movida).
        console.warn(`⚠️ Ruta no accesible: ${pathConfig.path}`);
        pathConfig.status = 'disconnected';
        pathConfig.lastError = 'No accesible en la ultima sincronizacion';
        continue;
      }

      librariesScanned.add(pathConfig.id);

      // Contada arriba; si el disco aparecio entre medias, se cuenta ahora.
      let totalFiles = conteos.get(pathConfig.id);
      if (typeof totalFiles !== 'number') {
        totalFiles = await countMediaFiles(pathConfig.path);
        indexado.total += totalFiles;
        indexado.bibliotecasTotal++;
      }
      indexado.biblioteca = pathConfig.path;
      indexado.bibliotecaN++;
      broadcastProgress({ type: 'sync_progress', ...camposIndexado({ fase: 'indexando' }) });

      const result = await scanDirectory(pathConfig.path, pathConfig.path, totalFiles, 0, pathConfig.id);
      allFiles.push(...result.files);
      totalStats.newFiles += result.stats.newFiles;
      totalStats.cachedFiles += result.stats.cachedFiles;
      totalStats.modifiedFiles += result.stats.modifiedFiles;

      pathConfig.lastScan = new Date().toISOString();
      pathConfig.fileCount = result.files.length;
      pathConfig.status = 'connected';
      pathConfig.lastError = null;
    }

    if (paths.length > 0) {
      await guardarEstadoDeRutas(paths);
    }

    // Tras el recorrido quedan unos segundos sin archivos que contar: nombres
    // de carpeta, favoritos, indice visual, colecciones y personas. Sin este
    // aviso la pantalla se quedaba clavada en el ultimo archivo.
    broadcastProgress({ type: 'sync_progress', ...camposIndexado({ fase: 'rematando', percentage: 100 }) });

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

    // Aplicar nombres de carpeta (display name editable) + enumeracion _NNN +
    // re-derivar tags/fecha desde el nombre nuevo. El archivo fisico no se toca.
    allFiles = folderNames.applyFolderNames(allFiles, { smartTags: extractSmartTags });

    // Herencia de la carpeta FISICA para las que no tienen nombre propio: el
    // material de camara ("P1248278.MP4") hereda las etiquetas y la fecha de su
    // carpeta-evento ("260811_Ondara") y pasa a ser buscable como lo busca una
    // persona. No se persiste: se recalcula en cada sync.
    allFiles = folderNames.applyFolderInheritance(allFiles, { smartTags: extractSmartTags });

    // UNA sola fecha por archivo, decidida aqui y usada en todas partes
    // (ver utils/fechaArchivo.js): nombre > carpeta > camara > disco. Antes la
    // galeria, los filtros y las estadisticas la calculaban cada uno a su
    // manera, y los filtros por año/mes dejaban fuera a 639 archivos.
    allFiles = fechaArchivo.aplicar(allFiles);

    // Aplicar favoritos
    mediaFiles = favoritesManager.applyFavoritesToFiles(allFiles);

    // Limpieza de huérfanos
    await favoritesManager.cleanupOrphanedFavorites(mediaFiles, librariesScanned);
    await sincronizarIndiceClip(mediaFiles, librariesScanned.size === activePaths.length);
    await collectionsManager.cleanupOrphanedFiles(mediaFiles, {
      scannedLibraryIds: librariesScanned,
      todasLasBibliotecasLeidas: librariesScanned.size === activePaths.length,
    });

    // Recalcular agregado de personas tras cada sync (memoización)
    recomputePersonsAggregate();

    // La portada de la proxima apertura se prepara ahora, con la lista recien
    // hecha. Sin await: no retrasa el aviso de sincronizacion completada.
    portada.regenerar(mediaFiles, { clipIndex });

    broadcastProgress({
      type: 'sync_complete',
      status: 'Sincronización completada',
      percentage: 100,
      inicio: indexado ? indexado.inicio : undefined,
      duracionMs: indexado ? Date.now() - indexado.inicio : undefined,
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
    indexado = null;
    if (fileCache.size > 0) {
      await saveCache().catch(() => {});
    }
  }
}

/**
 * Mantiene el indice de busqueda visual (CLIP/SigLIP-2) a la par de la
 * biblioteca: quita las entradas que apuntan a archivos que ya no existen.
 *
 * Por que importa y no es solo disco: `searchNearest` coge los N mejores del
 * indice ENTERO y los huerfanos se descartan DESPUES. Con el indice sucio se
 * pedian 50 resultados y llegaban 19 — medido: en "una playa con el mar al
 * fondo", 31 de los 50 mejores apuntaban a material borrado. La busqueda
 * rendia a una fraccion de lo que puede sin que nada lo dijera.
 *
 * Mismo criterio que los favoritos: solo se poda si TODAS las bibliotecas
 * activas se han podido leer. Con un disco desconectado la ausencia no prueba
 * nada, y aqui el error seria caro: borrar el indice entero de esa biblioteca.
 */
async function sincronizarIndiceClip(files, todasLasBibliotecasLeidas) {
  try {
    if (!todasLasBibliotecasLeidas) return;
    if (!clipIndex.isLoaded()) await clipIndex.load();
    if (clipIndex.size() === 0) return;
    const antes = clipIndex.size();
    const quitados = clipIndex.pruneOrphans(files.map(f => f.id));
    if (quitados > 0) {
      await clipIndex.save();
      console.log(`🧹 Indice visual podado: ${quitados} entradas huerfanas (${antes} -> ${clipIndex.size()})`);
    }
  } catch (err) {
    // El indice es regenerable desde los `clip_embedding_b64` de cada sidecar:
    // que falle la poda no puede tumbar el sync.
    fallos.record('podar el indice de busqueda visual', err);
  }
}

// === GUARD DE CONCURRENCIA DE SYNC ===
// Nunca corren dos syncs a la vez. Si llega una petición mientras uno está en
// curso, se marca y se hace UNA re-pasada al terminar (coalescing). Sin esto, el
// watcher de FS dispara un syncFiles por cada evento; copiar/borrar N archivos
// lanzaría N escaneos solapados con writes concurrentes sobre scan_paths.json y
// media_cache.json (corrupción) y un thrash severo de CPU/IO.
let _syncInFlight = null;
let _syncQueuedAgain = false;

async function syncFiles() {
  if (_syncInFlight) {
    _syncQueuedAgain = true;
    return _syncInFlight.then(() => mediaFiles);
  }
  _syncInFlight = (async () => {
    let result;
    do {
      _syncQueuedAgain = false;
      result = await performSync();
    } while (_syncQueuedAgain);
    return result;
  })();
  try {
    return await _syncInFlight;
  } finally {
    _syncInFlight = null;
  }
}

// Debounce del watcher: agrupa ráfagas de eventos de FS en una sola pasada.
let _resyncTimer = null;
const RESYNC_DEBOUNCE_MS = 1500;
function scheduleResync() {
  if (_resyncTimer) clearTimeout(_resyncTimer);
  _resyncTimer = setTimeout(() => {
    _resyncTimer = null;
    syncFiles().catch(err => console.error('❌ Error en resync del watcher:', err.message));
  }, RESYNC_DEBOUNCE_MS);
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
      // Esperar a que el archivo termine de escribirse antes de emitir el
      // evento (copias grandes, descargas). Evita escanear ficheros a medias.
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignored: (p) => {
        // Ignorar la carpeta tecnica .pensadero (cachés regenerables: thumbnails).
        // Si la biblioteca escaneada es CONTENT_DIR, escribir thumbnails ahi
        // dispararia un resync en bucle.
        if (/(^|[\\/])\.pensadero([\\/]|$)/i.test(p)) return true;
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
      .on('add', (p) => {
        if (isCatalog(p)) { handleCatalogChange(p); return; }
        scheduleResync();
      })
      .on('unlink', (p) => {
        if (isCatalog(p)) { handleCatalogChange(p); return; }
        scheduleResync();
      })
      .on('change', (p) => {
        if (isCatalog(p)) { handleCatalogChange(p); return; }
        scheduleResync();
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
  const touched = [];
  for (let i = 0; i < mediaFiles.length; i++) {
    const f = mediaFiles[i];
    if (!f.fullPath) continue;
    if (path.dirname(f.fullPath).toLowerCase() !== normalized) continue;

    // Tomar el fileData base del cache (sin catalog) y re-aplicar
    const cached = fileCache.get(f.fullPath);
    const base = cached ? cached.fileData : f;
    mediaFiles[i] = await catalogReader.applyCatalog(base);
    touched.push(mediaFiles[i]);
  }
  // Re-aplicar el display name de carpeta (+ enumeracion) sobre los refrescados:
  // applyCatalog parte del base sin esta capa, asi que hay que volver a ponerla.
  folderNames.applyFolderNames(touched, { smartTags: extractSmartTags });
  folderNames.applyFolderInheritance(touched, { smartTags: extractSmartTags });
  // Misma fecha que en el sync completo: refrescar una carpeta no puede dejar
  // sus archivos con otra fecha que el resto del catalogo.
  fechaArchivo.aplicar(touched);
  // Recalcular el agregado de personas: si el refresco cambio las caras de un
  // archivo (re-id, assign-face, promote), los conteos/bubbles del home deben
  // reflejarlo. Sin esto, el mediaFile se actualizaba pero personsAggregate no.
  recomputePersonsAggregate();
  broadcastProgress({ type: 'catalog_refresh', dir: dirPath });
}

// === ROUTERS ===

// Lo que la aplicacion puede enseñar: todo menos lo que esta bajo candado.
// Lo reciben las rutas que ENTREGAN material (galeria, busquedas, recuerdos,
// colecciones, gemelas). Las que escanean, sincronizan o limpian siguen viendo
// el catalogo entero: ocultar algo no puede sacarlo del archivo.
const mediaFilesVisibles = () => ocultosManager.visibles(mediaFiles);

const aiRoutes = createAiRoutes({
  broadcastProgress,
  getMediaFiles: mediaFilesVisibles,
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
  getMediaFiles: mediaFilesVisibles
});
app.use('/api', organizationRoutes);

// Tomas gemelas: deteccion de material casi identico y lista de descartes.
const duplicatesRoutes = createDuplicatesRoutes({
  getMediaFiles: mediaFilesVisibles
});
app.use('/api', duplicatesRoutes);

const mediaRoutes = createMediaRoutes({
  getMediaFiles: () => mediaFiles,
  // /files, /files/:id y /tags entregan solo lo visible; stream, miniatura y
  // descarga siguen resolviendo cualquier id (la caja de ocultos los usa).
  getMediaFilesVisibles: mediaFilesVisibles,
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
  refreshDir: refreshFilesInDir,
  // El inventario lo usa para contar, por subcarpeta, cuantos archivos tienen
  // ya descripcion visual. Sin esto la UI de Rutas puede listar subcarpetas
  // pero no decir cuales estan pendientes, que es lo que hace falta para
  // decidir donde lanzar un escaneo.
  getMediaFiles: () => mediaFiles,
});
app.use('/api', scanRoutes);

// CRUD del registry de personas + fotos de referencia. Se aplica a continuación
// del agregado memoizado (que ya escucha /api/persons en GET para listado de
// apariciones). Estas rutas son /api/persons/registry/... — sin colisión.
const personsManageRoutes = createPersonsManageRoutes({
  recomputePersonsAggregate,
  broadcastProgress,
  getScanPaths: loadScanPaths,
  syncFiles, // fallback; promote prefiere refreshDir (refresco por carpeta, sin full-sync)
  refreshDir: refreshFilesInDir, // refresca solo las carpetas afectadas tras promote
});
app.use('/api', personsManageRoutes);

// === ARCHIVOS DE UNA PERSONA (ocultar / papelera) y PAPELERA ===
app.use('/api', createPersonaArchivosRoutes({
  getMediaFiles: () => mediaFiles,
  getScanPaths: loadScanPaths,
  syncFiles,
  broadcastProgress,
}));

// === GRUPOS DE PERSONAS ("Familia", "Rodaje"...: se buscan con @nombre) ===
app.use('/api', createGruposRoutes());

// Registry de espacios + training del centroide CLIP por espacio.
const spacesManageRoutes = createSpacesManageRoutes({
  broadcastProgress,
  getScanPaths: loadScanPaths,
});
app.use('/api', spacesManageRoutes);

// Busqueda por color (Delta E sobre la palette del schema v2). Alimenta
// la "rueda de colores" del frontend.
const colorSearchRoutes = createColorSearchRoutes({
  getMediaFiles: mediaFilesVisibles,
});
app.use('/api', colorSearchRoutes);

// Tabla de sinonimos para expandir queries (Stage 1). El LLM propone grupos
// que el usuario revisa via /api/tags/aliases/propose.
const aliasRoutes = createAliasRoutes({
  getMediaFiles: mediaFilesVisibles,
});
app.use('/api', aliasRoutes);

// === NOTAS (notas humanas por archivo y por sesion colapsada) ===
const notesRoutes = createNotesRoutes();
app.use('/api', notesRoutes);

// === ARRANQUE Y PORTADA ===
// Estado del arranque para la pantalla de inicio: si la primera sincronizacion
// ha terminado y, si no, por donde va.
app.get('/api/arranque', (req, res) => {
  res.json({
    success: true,
    data: {
      listo: arranqueListo,
      indexando: !!indexado,
      progreso: indexado ? camposIndexado({ fase: indexado.bibliotecaN === 0 ? 'contando' : 'indexando' }) : null,
      archivos: arranqueListo ? mediaFilesVisibles().length : null,
    },
  });
});

// Recuerdos e hilos de la portada. Sale de la ultima portada preparada (en
// disco), asi que responde desde el primer segundo aunque aun se este
// indexando. Si nunca se preparo ninguna y ya hay lista, se prepara al vuelo.
app.get('/api/portada', async (req, res) => {
  try {
    let p = portada.leer();
    if (!p && arranqueListo && mediaFiles.length > 0) {
      p = await portada.regenerar(mediaFiles, { clipIndex });
    }
    res.json({ success: true, data: portada.servir(p, f => ocultosManager.estaOculto(f)) });
  } catch (err) {
    const causa = fallos.record('servir la portada', err, {});
    res.status(500).json({ success: false, error: causa.reason });
  }
});

// === MATERIAL OCULTO (candado con clave) ===
const ocultosRoutes = createOcultosRoutes({
  getMediaFiles: () => mediaFiles,
  broadcastProgress,
});
app.use('/api', ocultosRoutes);

// === VIDEOS PREPARADOS (estado y tope por disco) ===
app.use('/api', createProxiesRoutes({ getMediaFiles: () => mediaFiles }));

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

// Limpieza de thumbnails legacy huérfanos (solo el directorio central
// backend/thumbnails). Los thumbnails por-disco (<scanRoot>\.pensadero) son
// regenerables y desaparecen con el disco; no se limpian aqui. El matching es
// por id8 (primeros 8 chars del fileId, embebidos en el nombre): NO se borra a
// partir del campo file.thumbnail (que ahora es /api/thumbnails/:id y no
// codifica el nombre de archivo en disco).
async function cleanOrphanedThumbnails() {
  try {
    // Guard: sin medios cargados (sync fallido) no borramos nada.
    if (!Array.isArray(mediaFiles) || mediaFiles.length === 0) return;
    const thumbnailFiles = await fs.readdir(THUMBNAILS_DIR);
    const validIds = new Set(
      mediaFiles.map(f => f && f.id && f.id.substring(0, 8).toLowerCase()).filter(Boolean)
    );

    let removed = 0;
    for (const t of thumbnailFiles) {
      const m = t.match(/_([0-9a-f]{8})_thumbnail\.jpg$/i);
      // Solo borramos si reconocemos el patron y su medio ya no existe.
      // Conservamos thumbnails de medios vivos (fallback) y nombres no
      // reconocidos (p.ej. temp_video_*).
      if (m && !validIds.has(m[1].toLowerCase())) {
        try { await fs.unlink(path.join(THUMBNAILS_DIR, t)); removed++; } catch {}
      }
    }
    if (removed > 0) console.log(`🧹 Thumbnails legacy huérfanos eliminados: ${removed}`);
  } catch (error) {
    console.error('Error limpiando thumbnails:', error.message);
  }
}

// === FRONTEND (origen unico) ===
// El backend sirve el bundle de produccion (dist/) en el MISMO origen que la
// API. Asi el frontend usa URLs relativas y funciona desde cualquier host
// (localhost, pensadero, IP de LAN/VPN) sin reconstruir. Se monta el ULTIMO,
// despues de /api y de los estaticos, para no pisar ninguna ruta. El fallback
// SPA deja listo el routing por archivo del Eje B (deep links /archivo/<id>).
function mountFrontend() {
  const fsSync = require('fs');
  const DIST_DIR = path.join(__dirname, '..', 'dist');
  if (!fsSync.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.warn('⚠️ No existe dist/index.html. Ejecuta "npm run build". El backend sirve solo la API.');
    return;
  }
  // index.html sin cache: con maxAge de 1 h, tras cada build el navegador
  // seguia cargando el bundle ANTERIOR durante una hora y los cambios no se
  // veian. Los assets llevan hash en el nombre, asi que esos si pueden
  // guardarse mucho tiempo: un bundle nuevo siempre tiene otro nombre.
  app.use(express.static(DIST_DIR, {
    index: 'index.html',
    etag: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (filePath.includes(path.sep + 'assets' + path.sep)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  }));
  app.get('*', (req, res, next) => {
    const p = req.path;
    if (p.startsWith('/api') || p.startsWith('/ws') ||
        p.startsWith('/thumbnails') || p.startsWith('/media') ||
        p.startsWith('/persons-avatars') || p.startsWith('/spaces-covers')) {
      return next();
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => { if (err) next(); });
  });
  console.log(`🖥️ Frontend servido desde: ${DIST_DIR}`);
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
  // Montar el frontend (dist/) al final del stack: despues de /persons-avatars
  // y /spaces-covers para que el fallback SPA no los intercepte.
  mountFrontend();
  watchPersonsRegistry();

  // Cargar la tabla de sinonimos. Si no existe el archivo, opera vacia.
  await aliasTable.load();

  // Nombres de presentacion por carpeta (display name editable desde la UI).
  await folderNames.load();
  // Inyectar bibliotecas ya en arranque (antes del primer sync) para que la
  // resolucion de claves portables funcione en el inventario inicial.
  try {
    const _bootPaths = await loadScanPaths();
    folderNames.setLibraries(_bootPaths.filter(p => p.isActive).map(p => ({ id: p.id, path: p.path })));
  } catch {}

  // Cargar el indice de embeddings CLIP en memoria. Si no existe, opera vacio.
  // El daemon Python CLIP se carga lazy (solo al primer embedImage / embedText).
  await clipIndex.load();

  await loadCache();

  // Arrancamos el listen ANTES de la sincronizacion inicial para que el
  // frontend pueda conectarse de inmediato. La sync (que puede tardar varios
  // minutos en bibliotecas grandes) corre en background; el watcher y la
  // limpieza de thumbnails se enganchan cuando la primera pasada termina.
  server.listen(PORT, HOST, () => {
    console.log(`🚀 Pensadero en http://${HOST}:${PORT} (frontend + API, origen unico)`);
    console.log(`📡 WebSocket en ws://${HOST}:${PORT}/ws`);
    console.log(`📂 Carpeta de contenido: ${CONTENT_DIR}`);
    console.log(`💾 Cache: ${fileCache.size} archivos`);
    console.log(`👥 Personas: ${personsAggregate.length} con apariciones`);
  });

  syncFiles()
    .then(() => {
      arranqueListo = true;
      console.log(`✅ Sync inicial completado: ${fileCache.size} archivos`);
      setTimeout(() => cleanOrphanedThumbnails(), 5000);
      watchFileSystem();
      // Si el proceso anterior murio con un escaneo en marcha, retomarlo.
      // Va DESPUES del sync porque el escaneo necesita la lista de archivos ya
      // en memoria. Sin esto el supervisor devolvia el backend en segundos
      // pero la GPU se quedaba parada el resto de la noche.
      if (typeof scanRoutes.reanudarSiQuedoAMedias === 'function') {
        scanRoutes.reanudarSiQuedoAMedias(PORT).catch(err => {
          console.warn('🔁 Reanudacion de escaneo fallo:', err.message);
        });
      }
    })
    .catch(err => {
      // Tambien "listo": con la sync rota la aplicacion debe poder abrirse
      // para ver que ha pasado, no quedarse en la portada para siempre.
      arranqueListo = true;
      console.error('❌ Error en sync inicial:', err);
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
