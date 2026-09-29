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
const { LOCAL_ORIGIN_RE, hostPermitido, origenPermitido } = require('./utils/origenLocal');
const http = require('http');
const { execFile } = require('child_process');

const colorAnalyzer = require('./colorAnalyzer');
const favoritesManager = require('./favoritesManager');
const collectionsManager = require('./collectionsManager');
const catalogReader = require('./catalogReader');
const { anotarCruces } = require('./utils/recolocar');
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
const createMomentosRoutes = require('./routes/momentosRoutes');
const createPersonaArchivosRoutes = require('./routes/personaArchivosRoutes');
const createGruposRoutes = require('./routes/gruposRoutes');
const createCopiasRoutes = require('./routes/copiasRoutes');
const copiasExactas = require('./services/copiasExactas');
const notesManager = require('./notesManager');
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
const volumen = require('./utils/volumen');
const reenlazar = require('./services/reenlazar');
const etiquetasManuales = require('./services/etiquetasManuales');
const descartesManager = require('./descartesManager');
const videoProxyService = require('./services/videoProxyService');
const { paresParaHuerfanos, clasificar } = require('./utils/huerfanosPorLetra');
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
// El WebSocket no pasa por CORS ni por los middlewares de Express: cualquier
// web abierta en el navegador podia conectarse y leer el progreso (rutas y
// nombres de archivo). Mismas reglas que la API (utils/origenLocal.js).
const wss = new WebSocket.Server({
  server,
  path: '/ws',
  verifyClient: ({ req, origin }) => hostPermitido(req.headers.host) && origenPermitido(origin, req.headers.host),
});
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
    // Esquema portable (displayName, role...) en memoria. UNA sola version de
    // esta funcion: la pestaña Rutas tenia la suya propia, que migraba el
    // esquema, y la sincronizacion esta, que no.
    return mediaIdentity.migrateScanPaths(JSON.parse(data));
  } catch (error) {
    // scan_paths.json NO es regenerable (son las bibliotecas del usuario). Si
    // está corrupto, NO devolver [] y dejar que un saveScanPaths posterior lo
    // machaque: cuarentena para recuperación manual.
    console.error(`❌ scan_paths.json corrupto: ${error.message}`);
    await quarantineCorrupt(scanPathsFile);
    return [];
  }
}

// Guardar configuración de rutas (escritura atómica: tmp + rename). Si falla,
// se apunta con su causa y se RELANZA: antes solo salia por consola y la
// pantalla decia "Ruta añadida" sin haberla guardado.
async function saveScanPaths(paths) {
  const scanPathsFile = path.join(__dirname, 'scan_paths.json');
  try {
    await atomicWriteFile(scanPathsFile, JSON.stringify(paths, null, 2));
  } catch (error) {
    fallos.record('guardar las rutas', error, { path: scanPathsFile });
    throw error;
  }
}

/**
 * Guarda lo que una sincronizacion sabe de cada ruta (estado, conteo, ultima
 * pasada, disco) ENCIMA de lo que haya en disco en ese momento. La
 * sincronizacion carga las rutas al empezar y puede durar minutos: guardarlas
 * tal cual pisaba lo que el usuario hubiera cambiado entretanto (un
 * interruptor de escaneo, un nombre, desvincular una ruta).
 * @param {Array} rutasSync
 * @param {Set<string>} [tocadas] - solo estas rutas (sincronizar una sola)
 */
async function guardarEstadoDeRutas(rutasSync, tocadas = null) {
  const frescas = await loadScanPaths();
  if (!Array.isArray(frescas) || frescas.length === 0) return saveScanPaths(rutasSync);
  const porId = new Map(rutasSync.map(r => [r.id, r]));
  for (const r of frescas) {
    const s = porId.get(r.id);
    if (!s || (tocadas && !tocadas.has(r.id))) continue;
    // Si el usuario cambio la ruta (otra letra) mientras se sincronizaba, lo
    // que sabe esta pasada es de la ruta vieja: no se mezcla.
    if (s.path !== r.path) continue;
    for (const k of ['status', 'lastError', 'lastScan', 'fileCount', 'volumen', 'sugerencia', 'disco']) {
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

// Anti-DNS-rebinding, lo primero de todo: una web con un dominio suyo
// apuntando a 127.0.0.1 pasaba la comprobacion de Origin (su Origin y su Host
// coinciden) y podia leer el archivo entero. Ver utils/origenLocal.js.
app.use((req, res, next) => {
  if (hostPermitido(req.headers.host)) return next();
  res.status(403).type('text/plain; charset=utf-8')
    .send('Pensadero solo responde en este PC (localhost o su IP). Si entras por un nombre de red propio, ponlo en HOSTS_PERMITIDOS en backend/.env.');
});

// CORS restringido. En producción el backend sirve el frontend en el MISMO
// origen que la API, así que el navegador NO aplica CORS a las llamadas
// normales. El único cross-origin legítimo es desarrollo: Vite en :5173 → API
// en :5000 (mismo host). Permitimos solo orígenes locales (localhost /
// 127.0.0.1 / ::1, cualquier puerto) y peticiones sin Origin (navegación
// same-origin, <video>, curl). Una web externa queda sin ACAO → el navegador
// le bloquea leer la respuesta (anti-exfiltración), crítico al no haber auth.
app.use(cors({
  origin(origin, cb) {
    if (!origin || LOCAL_ORIGIN_RE.test(origin)) return cb(null, true);
    return cb(null, false); // sin cabecera ACAO → el navegador bloquea la lectura
  },
}));

// Defensa anti-CSRF. Como no hay auth, una web externa
// podría disparar POSTs cross-origin que mutan estado (scan, tags, etc.). Para
// métodos que mutan, si viene Origin exigimos que sea el MISMO host que sirve
// la API (same-origin real) o un origen local de desarrollo; si no, 403. Los
// GET/HEAD se dejan pasar: su respuesta ya queda protegida por la política CORS.
app.use((req, res, next) => {
  if (origenPermitido(req.headers.origin, req.headers.host)) return next();
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

// Cuando se guardo la cache por ultima vez. Durante un recorrido se guarda
// por TIEMPO (cada GUARDAR_CACHE_CADA_MS), no cada 10 archivos nuevos: con
// 16.000 entradas la cache pesa ~37 MB, y reindexar un disco de 12.000
// archivos la reescribia unas 1.200 veces (~44 GB de escrituras). Ademas, con
// solo archivos modificados (0 nuevos) `0 % 10 === 0` la guardaba en CADA uno.
// El coste de un corte sigue acotado: lo caro (miniaturas) ya esta en disco.
let ultimoGuardadoCache = 0;
const GUARDAR_CACHE_CADA_MS = 15000;

async function saveCache() {
  try {
    ultimoGuardadoCache = Date.now();
    const obj = Object.fromEntries(fileCache);
    // Escritura atómica: el watcher puede disparar varios saveCache solapados;
    // tmp + rename evita que se entrelacen y corrompan media_cache.json.
    await atomicWriteFile(CACHE_FILE, JSON.stringify(obj));
  } catch (error) {
    // Regenerable, asi que no para nada; pero se dice por que.
    fallos.record('guardar la cache de archivos', error, { path: CACHE_FILE });
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
        // Misma regla de siglo que utils/fechaArchivo.js (AA > 50 -> 19AA):
        // antes "951225" daba la etiqueta "2095".
        const yy = parseInt(year, 10);
        const fullYear = yy > 50 ? 1900 + yy : 2000 + yy;
        const dateObj = new Date(fullYear, parseInt(month) - 1, parseInt(day));
        if (dateObj.getFullYear() === fullYear &&
            dateObj.getMonth() === parseInt(month) - 1 &&
            dateObj.getDate() === parseInt(day)) {
          extractedDate = dateObj;
          tags.push(`${year}-${month}-${day}`);
          tags.push(String(fullYear));
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

// Imagenes que ni sharp ni ffmpeg han podido leer en esta vida del proceso.
const _miniaturaImposible = new Set();

/**
 * Miniatura (600 px de ancho) con el ffmpeg del sistema, para lo que sharp no
 * lee. El ffmpeg incluido en node_modules es antiguo y no sabe de HEIC; el del
 * PATH (el mismo que usan los proxies y el escaneo) si.
 * @returns {Promise<boolean>} si ha quedado escrita
 */
async function miniaturaConFfmpeg(origen, destino) {
  // Primero la imagen entera y luego la reduce sharp: una HEIC de iPhone son
  // teselas que ffmpeg une con su propio filtro, y pedirle ademas que escale
  // (-vf) falla ("Simple and complex filtering cannot be used together").
  const tmp = path.join(require('os').tmpdir(), `pensadero-mini-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  const decodificada = await new Promise((resolve) => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', origen, '-frames:v', '1', '-q:v', '2', tmp],
      { timeout: 60000, windowsHide: true },
      (err) => resolve(!err));
  });
  try {
    if (!decodificada) return false;
    await sharp(tmp).rotate().resize({ width: 600 }).jpeg({ quality: 80 }).toFile(destino);
    return true;
  } catch {
    return false;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

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
      // .rotate() sin argumentos = girar segun la orientacion EXIF ANTES de
      // redimensionar. Sin el, la foto vertical de un movil (guardada apaisada
      // con "giro 90" en el EXIF) salia tumbada: la miniatura no lleva EXIF y
      // el navegador ya no sabe girarla. Pasaba en 633 de 637 fotos verticales.
      // Solo ancho: el alto sale de la proporcion YA girada. Se lee a buffer
      // desde Node (que si sabe de rutas de mas de 260 caracteres).
      if (_miniaturaImposible.has(fileId)) return svgPlaceholder('Error', fileName, '%23fee2e2');
      try {
        const imageBuffer = await fs.readFile(filePath);
        await sharp(imageBuffer)
          .rotate()
          .resize({ width: 600, withoutEnlargement: false })
          .jpeg({ quality: 80 })
          .toFile(loc.thumbnailPath);
        return loc.thumbnailUrl;
      } catch (errSharp) {
        // Lo que sharp no decodifica lo intenta ffmpeg: las HEIC de iPhone
        // (van en HEVC, que el sharp que usamos no trae; 79 fotos sin
        // miniatura el 23/09/2026) y los PSD.
        if (await miniaturaConFfmpeg(filePath, loc.thumbnailPath)) return loc.thumbnailUrl;
        // Ni una ni otra: no se reintenta en cada vista (lo pedia la galeria
        // cada vez, y cada vez apuntaba el mismo error en el log).
        _miniaturaImposible.add(fileId);
        console.error(`Error generando miniatura para ${filePath}: ${errSharp.message}`);
        return svgPlaceholder('Error', fileName, '%23fee2e2');
      }
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
          // Tiempo limite: un video corrupto podia dejar a ffmpeg colgado y con
          // el la sincronizacion entera, que espera a cada miniatura.
          ffmpeg(effectivePath, { timeout: 60 })
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

function abrirIndexado({ total = 0, bibliotecasTotal = 1, enSegundoPlano = false } = {}) {
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
    // Lanzada por el vigilante de discos: la UI no abre la pantalla de
    // progreso por cada copia, solo recarga la galeria al terminar.
    enSegundoPlano,
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
    ...(x.enSegundoPlano ? { enSegundoPlano: true } : {}),
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

// La cache ha cambiado desde el ultimo guardado. Guardarla sin cambios (37 MB)
// al final de cada sincronizacion era escribir por escribir, y con el
// vigilante de discos las sincronizaciones son mas frecuentes.
let cacheSucia = false;

/**
 * Rehace la miniatura de una foto con giro EXIF hecha antes de respetar la
 * orientacion (salia tumbada). Se mira UNA vez por foto: la marca
 * `miniaturaOrientada` evita volver a leer su cabecera en cada pasada.
 * @returns {Promise<boolean>} si se ha rehecho
 */
async function orientarMiniatura(fileData) {
  fileData.miniaturaOrientada = true;
  cacheSucia = true;
  let orientacion;
  try {
    orientacion = (await sharp(fileData.fullPath).metadata()).orientation;
  } catch {
    return false; // formato que sharp no lee (HEIC...): se queda como estaba
  }
  if (!orientacion || orientacion === 1) return false;
  for (const legacy of [false, true]) {
    const loc = pathsConfig.resolveThumbnailLocation({ fullPath: fileData.fullPath, fileId: fileData.id, fileName: fileData.name, legacy });
    await fs.unlink(loc.thumbnailPath).catch(() => {});
  }
  const url = await generateThumbnail(fileData.fullPath, fileData.id, fileData.name);
  // ?o=1: la miniatura tumbada sigue 7 dias en la cache del navegador con la
  // URL de siempre; con otra URL se pide la nueva.
  fileData.thumbnail = typeof url === 'string' && url.startsWith('/api/') ? `${url}?o=1` : url;
  return true;
}

/**
 * Segunda oportunidad para una foto que se quedo sin miniatura: si ahora sale
 * (ffmpeg lee HEIC y PSD), se apunta con sus colores, como una nueva.
 */
async function rehacerMiniaturaFallida(fileData) {
  const url = await generateThumbnail(fileData.fullPath, fileData.id, fileData.name);
  if (typeof url !== 'string' || url.startsWith('data:')) return false;
  fileData.thumbnail = url;
  const loc = pathsConfig.resolveThumbnailLocation({ fullPath: fileData.fullPath, fileId: fileData.id, fileName: fileData.name });
  const legacy = pathsConfig.resolveThumbnailLocation({ fullPath: fileData.fullPath, fileId: fileData.id, fileName: fileData.name, legacy: true });
  for (const cand of [loc.thumbnailPath, legacy.thumbnailPath]) {
    try {
      await fs.access(cand);
      fileData.colorData = await colorAnalyzer.analyzeFileColors(cand, 'image');
      break;
    } catch { /* sin colores: la miniatura ya vale */ }
  }
  cacheSucia = true;
  return true;
}

/**
 * Indexa UN archivo: acierto de cache, o nuevo/modificado (miniatura, colores,
 * identidad portable). Lanza si no se puede leer: quien llama lo apunta.
 * @returns {Promise<{file: object, accion: 'cache'|'nuevo'|'modificado'}>}
 */
async function indexarArchivo(fullPath, nombre, fileType, baseDir, libraryId) {
  const stats = await fs.stat(fullPath);
  const currentHash = generateFileHash(fullPath, stats);
  const cached = fileCache.get(fullPath);

  if (cached && cached.hash === currentHash) {
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
        cacheSucia = true;
      }
    }
    // Foto cuya miniatura se hizo sin respetar el giro EXIF: se rehace una vez.
    if (fileType === 'image' && cached.fileData && !cached.fileData.miniaturaOrientada) {
      await orientarMiniatura(cached.fileData);
    }
    // Foto que se quedo con el cartel de "Error" (HEIC, PSD: sharp no las lee):
    // se reintenta una vez por arranque, ahora con ffmpeg de respaldo.
    if (fileType === 'image' && cached.fileData && typeof cached.fileData.thumbnail === 'string'
        && cached.fileData.thumbnail.startsWith('data:') && !_miniaturaImposible.has(cached.fileData.id)) {
      await rehacerMiniaturaFallida(cached.fileData);
    }
    // Re-mergear catalog siempre (puede haber cambiado fuera de banda)
    const merged = await catalogReader.applyCatalog(cached.fileData);
    anotarIndexado(nombre, 'cache');
    return { file: merged, accion: 'cache' };
  }

  const accion = cached ? 'modificado' : 'nuevo';
  // Se anota ANTES de procesarlo: lo que tarda es la miniatura de este
  // archivo, y la pantalla debe decir en cual esta, no el anterior.
  anotarIndexado(nombre, accion);

  const relativePath = path.relative(baseDir, fullPath);
  const fileId = generateFileId(fullPath);
  // Identidad portable: mediaKey = "<libraryId>:<relativePathNorm>". No
  // depende de la ruta absoluta; sobrevive al remapeo de la raiz de la
  // biblioteca. El id md5 se conserva como token de runtime (URLs).
  const mediaKey = libraryId ? mediaIdentity.makeMediaKey(libraryId, relativePath) : '';

  // El thumbnail se guarda junto al archivo, en <su-carpeta>\.pensadero\thumbnails.
  let thumbnail;
  try {
    thumbnail = await generateThumbnail(fullPath, fileId, nombre);
  } catch {
    thumbnail = svgPlaceholder('Error', nombre, '%23fee2e2');
  }

  const smartTagsResult = extractSmartTags(nombre);

  // Análisis de colores si hay thumbnail real (no placeholder SVG inline).
  // La ruta de disco se resuelve con el mismo resolver que generó el
  // thumbnail; ya no se reconstruye desde la URL (ahora /api/thumbnails/:id).
  // generateThumbnail puede haber caido al dir legacy si fallo el mkdir del
  // destino por-disco, asi que probamos ambos (igual que el endpoint).
  let colorData = null;
  if (thumbnail && !thumbnail.startsWith('data:')) {
    const newLoc = pathsConfig.resolveThumbnailLocation({ fullPath, fileId, fileName: nombre });
    const legacyLoc = pathsConfig.resolveThumbnailLocation({ fullPath, fileId, fileName: nombre, legacy: true });
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
    name: nombre,
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
  // Las miniaturas nuevas ya salen giradas bien (ver generateThumbnail).
  if (fileType === 'image') fileData.miniaturaOrientada = true;

  // Persistimos en cache la versión SIN catalog (el catalog se mergea siempre al vuelo)
  fileCache.set(fullPath, { hash: currentHash, mtime: stats.mtime, fileData });
  cacheSucia = true;
  if (Date.now() - ultimoGuardadoCache > GUARDAR_CACHE_CADA_MS) await saveCache();

  const merged = await catalogReader.applyCatalog(fileData);
  return { file: merged, accion };
}

/**
 * @param {{noLeido: string[]}} pasada - aqui se apunta lo que no se pudo leer
 */
async function scanDirectory(dir, baseDir = dir, totalFiles = 0, libraryId = null, pasada = { noLeido: [] }) {
  // Llamada de primer nivel sin progreso abierto: se abre aqui y se cierra al terminar.
  const abreProgreso = !indexado && dir === baseDir;
  if (abreProgreso) abrirIndexado({ total: totalFiles });
  try {
    return await recorrerDirectorio(dir, baseDir, libraryId, pasada);
  } finally {
    if (abreProgreso) indexado = null;
  }
}

async function recorrerDirectorio(dir, baseDir, libraryId, pasada) {
  const files = [];
  const stats = { newFiles: 0, cachedFiles: 0, modifiedFiles: 0 };

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // Una carpeta que no se puede leer NO es una carpeta vacia. Antes el error
    // se tragaba y lo de dentro "desaparecia": la limpieza de huerfanos
    // borraba sus favoritos y sus referencias en colecciones. Ahora se apunta y
    // lo de esa carpeta se conserva como estaba (ver performSync).
    pasada.noLeido.push(dir);
    fallos.record('leer una carpeta al sincronizar', error, { path: dir });
    return { files, stats };
  }

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
      const sub = await recorrerDirectorio(fullPath, baseDir, libraryId, pasada);
      for (const f of sub.files) files.push(f);
      stats.newFiles += sub.stats.newFiles;
      stats.cachedFiles += sub.stats.cachedFiles;
      stats.modifiedFiles += sub.stats.modifiedFiles;
      continue;
    }

    if (!entry.isFile() || esArchivoBasura(entry.name)) continue;
    const fileType = getFileType(fullPath);
    if (!fileType) continue;

    try {
      const r = await indexarArchivo(fullPath, entry.name, fileType, baseDir, libraryId);
      files.push(r.file);
      if (r.accion === 'cache') stats.cachedFiles++;
      else if (r.accion === 'modificado') stats.modifiedFiles++;
      else stats.newFiles++;
    } catch (error) {
      // Un archivo que no se puede leer (bloqueado, borrado a mitad) ya no
      // corta su carpeta: antes un solo stat fallido saltaba fuera del bucle y
      // todo lo que venia detras en esa carpeta desaparecia.
      pasada.noLeido.push(fullPath);
      fallos.record('leer un archivo al sincronizar', error, { path: fullPath, silencioso: true });
    }
  }

  return { files, stats };
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

/** ¿`ruta` es una de `lista` o esta dentro de alguna? (sin distinguir mayusculas) */
function dentroDeAlguna(ruta, lista) {
  if (!ruta || !lista || lista.length === 0) return false;
  const r = String(ruta).toLowerCase();
  return lista.some(p => {
    const b = String(p).toLowerCase().replace(/[\\/]+$/, '');
    return r === b || r.startsWith(b + '\\') || r.startsWith(b + '/');
  });
}

/**
 * Sincroniza las bibliotecas con lo que hay en disco.
 *
 * @param {{soloIds?: Set<string>}} [opts] - solo esas bibliotecas; el resto
 *   se queda en memoria tal cual. Es lo que usa "Sincronizar" en una ruta, el
 *   vigilante de discos y los cambios de ruta: el MISMO camino que la
 *   sincronizacion completa. Antes sincronizar una ruta tenia su propio
 *   camino, que se saltaba nombres de carpeta, fecha y favoritos (sus archivos
 *   desaparecian de los filtros por año) y no esperaba a otra sincronizacion.
 * @returns {Promise<{files, stats, porBiblioteca, reenlazados, error?}>}
 */
async function performSync(opts = {}) {
  const paths = await loadScanPaths();
  // Sin rutas configuradas solo existe la carpeta por defecto: todo es completo.
  const soloIds = paths.length > 0 && opts.soloIds instanceof Set && opts.soloIds.size > 0 ? opts.soloIds : null;
  console.log(soloIds
    ? `🔄 Sincronizando ${soloIds.size === 1 ? 'una ruta' : `${soloIds.size} rutas`}...`
    : '🔄 Sincronizando...');

  const activePaths = paths.filter(p => p.isActive);

  if (activePaths.length === 0 && !soloIds) {
    activePaths.push({ id: 'default', path: CONTENT_DIR, isActive: true });
  }

  // Inyectar las bibliotecas activas en folderNames para que pueda resolver
  // carpetas absolutas -> identidad portable (libraryId + relativeDir). Se hace
  // en cada sync para reflejar remapeos de raiz al instante.
  const librerias = activePaths.map(p => ({ id: p.id, path: p.path }));
  folderNames.setLibraries(librerias);
  // Mismo motivo para favoritos: sin las bibliotecas no puede derivar la
  // mediaKey y se quedaria guardando por ruta absoluta (no portable).
  favoritesManager.setLibraries(librerias);

  // De que biblioteca (activa o no) es cada archivo.
  const configuradas = paths.map(p => ({ id: p.id, path: p.path }));
  if (activePaths.some(p => p.id === 'default')) configuradas.push({ id: 'default', path: CONTENT_DIR });
  const idsConfiguradas = new Set(configuradas.map(l => l.id));
  const bibliotecaDe = (f) => {
    if (!f) return null;
    if (f.libraryId && idsConfiguradas.has(f.libraryId)) return f.libraryId;
    const d = f.fullPath ? mediaIdentity.deriveMediaKeyForPath(f.fullPath, configuradas) : null;
    return d ? d.libraryId : null;
  };

  const objetivo = soloIds ? activePaths.filter(p => soloIds.has(p.id)) : activePaths;
  // En una sincronizacion parcial, lo de las demas bibliotecas sigue tal cual.
  // Lo que ya no es de ninguna (una ruta recien quitada) sale.
  const conservados = soloIds
    ? mediaFiles.filter(f => { const lib = bibliotecaDe(f); return lib && !soloIds.has(lib); })
    : [];

  // Se cuenta TODO antes de recorrer nada: asi el total es el del proceso
  // entero y el porcentaje no vuelve a cero al cambiar de disco.
  abrirIndexado({ bibliotecasTotal: objetivo.length, enSegundoPlano: !!opts.enSegundoPlano });
  broadcastProgress({ type: 'sync_start', ...camposIndexado({ fase: 'contando', status: 'Contando archivos...' }) });

  // 1) Que disco hay en cada ruta. La letra la reparte Windows; el numero de
  // serie del volumen es del disco (utils/volumen.js). Si en la ruta hay otro
  // disco no se lee: se mezclarian las identidades de los dos. Y si el disco
  // de una biblioteca aparece en otra letra, se propone (no se hace solo).
  let unidades = null;
  const sugerir = async (p) => {
    if (!p.volumen) return null;
    if (!unidades) unidades = await volumen.seriesDeUnidades();
    const ruta = await volumen.buscarDisco(p.volumen, p.path, unidades);
    if (!ruta) return null;
    const norm = mediaIdentity.normalizeLibraryRoot(ruta);
    const otra = paths.find(q => q.id !== p.id && mediaIdentity.normalizeLibraryRoot(q.path) === norm);
    return { ruta, ocupadaPor: otra ? { id: otra.id, nombre: otra.displayName || otra.path } : null };
  };
  const legibles = [];
  for (const p of objetivo) {
    const accesible = await fs.access(p.path).then(() => true).catch(() => false);
    if (!accesible) {
      // Marcar el estado real: sin esto se quedaba el 'connected' de la
      // ultima sincronizacion buena y la UI seguia pintando como conectada
      // una biblioteca que ya no existe (disco desenchufado, carpeta movida).
      console.warn(`⚠️ Ruta no accesible: ${p.path}`);
      p.status = 'disconnected';
      p.lastError = 'No accesible en la ultima sincronizacion';
      p.sugerencia = await sugerir(p);
      continue;
    }
    const serie = p.id === 'default' ? null : await volumen.serialDe(p.path);
    if (p.volumen && serie && serie !== p.volumen) {
      console.warn(`⚠️ En ${p.path} hay otro disco (serie ${serie}; la biblioteca es del ${p.volumen})`);
      p.status = 'otro_disco';
      // Si ese disco es el de otra biblioteca, se dice cual: "otro disco" a
      // secas no dejaba ver que eran dos discos con las letras cruzadas.
      const duena = paths.find(q => q.id !== p.id && q.volumen === serie);
      const info = (await volumen.infoDiscos().catch(() => new Map())).get(serie);
      const cual = [info && info.etiqueta ? `«${info.etiqueta}»` : null, duena ? `el disco de «${duena.displayName || duena.path}»` : null].filter(Boolean).join(', ');
      p.lastError = `En esta ruta está ahora ${cual || 'otro disco'}, no el de esta biblioteca. No se ha leído para no mezclar lo de los dos.`;
      p.sugerencia = await sugerir(p);
      continue;
    }
    if (serie && !p.volumen) p.volumen = serie;
    p.sugerencia = null;
    legibles.push(p);
  }

  // Letras cruzadas: si la ruta a la que ha ido el disco de una biblioteca la
  // tiene otra que es OTRO disco, no son "el mismo disco" (lo que decia el
  // aviso): se anota donde esta el de la otra para poder ponerlos en su sitio.
  await anotarCruces(objetivo, paths, async (serie, rutaVieja) => {
    if (!unidades) unidades = await volumen.seriesDeUnidades();
    return volumen.buscarDisco(serie, rutaVieja, unidades);
  }).catch(err => fallos.record('comprobar las letras de los discos', err, {}));
  // Nombre y tamaño de cada disco (el ultimo que se vio): distinguen dos
  // bibliotecas que se llaman igual.
  const infoDisco = await volumen.infoDiscos().catch(() => new Map());
  for (const p of objetivo) {
    const d = p.volumen ? infoDisco.get(p.volumen) : null;
    if (d) p.disco = { etiqueta: d.etiqueta, capacidad: d.capacidad };
  }

  const conteos = new Map();
  for (const p of legibles) {
    indexado.biblioteca = p.path;
    indexado.bibliotecaN = conteos.size + 1;
    broadcastProgress({ type: 'sync_progress', ...camposIndexado({ fase: 'contando' }) });
    const n = await countMediaFiles(p.path);
    conteos.set(p.id, n);
    indexado.total += n;
    console.log(`📊 ${n} archivos en ${p.path}`);
  }
  indexado.bibliotecasTotal = legibles.length;
  indexado.bibliotecaN = 0;

  let allFiles = [];
  const totalStats = { newFiles: 0, cachedFiles: 0, modifiedFiles: 0 };
  // Bibliotecas leidas ENTERAS en esta pasada. Solo sobre estas se puede
  // afirmar que un archivo ha desaparecido; sobre un disco desconectado, o
  // con una carpeta que no se pudo leer, la ausencia no prueba nada.
  const librariesScanned = new Set();
  // Las recorridas con el disco presente, con lo que no se pudo leer de cada una.
  const leidas = new Map();
  const clavesPrevias = new Set(fileCache.keys());

  try {
    for (const p of legibles) {
      indexado.biblioteca = p.path;
      indexado.bibliotecaN++;
      broadcastProgress({ type: 'sync_progress', ...camposIndexado({ fase: 'indexando' }) });

      const pasada = { noLeido: [] };
      const result = await scanDirectory(p.path, p.path, conteos.get(p.id) || 0, p.id, pasada);

      // Si el disco se desenchufo a mitad, lo leido no prueba nada: cuenta
      // como desconectado y no se toca nada suyo.
      if (!(await fs.access(p.path).then(() => true).catch(() => false))) {
        console.warn(`⚠️ ${p.path} se desconecto durante la sincronizacion`);
        p.status = 'disconnected';
        p.lastError = 'Se desconectó durante la sincronización';
        continue;
      }

      let deEsta = result.files.length;
      for (const f of result.files) allFiles.push(f);
      totalStats.newFiles += result.stats.newFiles;
      totalStats.cachedFiles += result.stats.cachedFiles;
      totalStats.modifiedFiles += result.stats.modifiedFiles;
      leidas.set(p.id, pasada);

      if (pasada.noLeido.length > 0) {
        // Lo que no se pudo leer (una carpeta sin permiso, un archivo
        // bloqueado) se conserva como estaba en la cache: sin esto desaparecia
        // de la galeria y la limpieza borraba sus favoritos y colecciones.
        const vistos = new Set(result.files.map(f => f.fullPath));
        for (const [ruta, entrada] of fileCache) {
          if (vistos.has(ruta) || !entrada.fileData) continue;
          if (!dentroDeAlguna(ruta, pasada.noLeido)) continue;
          if (bibliotecaDe(entrada.fileData) !== p.id) continue;
          allFiles.push(await catalogReader.applyCatalog(entrada.fileData));
          deEsta++;
        }
        const n = pasada.noLeido.length;
        p.lastError = `Lectura incompleta: no se ${n === 1 ? 'pudo' : 'pudieron'} leer ${n} ${n === 1 ? 'elemento' : 'elementos'} (por ejemplo ${pasada.noLeido[0]}). Lo de ahí se conserva como estaba.`;
      } else {
        librariesScanned.add(p.id);
        p.lastError = null;
      }

      p.lastScan = new Date().toISOString();
      p.fileCount = deEsta;
      p.status = 'connected';
    }

    if (paths.length > 0) {
      // Si no se puede guardar ya queda apuntado (saveScanPaths): no para la pasada.
      await guardarEstadoDeRutas(paths, soloIds).catch(() => {});
    }

    // Tras el recorrido quedan unos segundos sin archivos que contar: nombres
    // de carpeta, favoritos, indice visual, colecciones y personas. Sin este
    // aviso la pantalla se quedaba clavada en el ultimo archivo.
    broadcastProgress({ type: 'sync_progress', ...camposIndexado({ fase: 'rematando', percentage: 100 }) });

    // De que biblioteca es una referencia guardada por id de ruta o por ruta
    // (colecciones antiguas). Se toma de la cache ANTES de podarla: recuerda
    // tambien lo de las rutas desactivadas y los discos desconectados, que es
    // justo lo que la limpieza de huerfanos no puede dar por desaparecido.
    const bibliotecaDeRef = new Map();
    for (const [ruta, entrada] of fileCache) {
      const lib = bibliotecaDe(entrada.fileData || { fullPath: ruta });
      if (!lib) continue;
      bibliotecaDeRef.set(collectionsManager.normRuta(ruta), lib);
      if (entrada.fileData && entrada.fileData.id) bibliotecaDeRef.set(entrada.fileData.id, lib);
    }
    const ubicarRef = (ref) => bibliotecaDeRef.get(ref)
      || bibliotecaDeRef.get(collectionsManager.normRuta(ref))
      || (/^[a-z]:[\\/]|^\\\\/i.test(String(ref)) ? bibliotecaDe({ fullPath: ref }) : null);

    // 2) Cache: fuera SOLO lo que se puede probar que ya no esta (su
    // biblioteca se ha leido y su carpeta tambien) y lo de bibliotecas que ya
    // no existen. Antes se podaba todo lo que no apareciera, asi que
    // desenchufar un disco vaciaba su cache y al volver se reindexaba entero
    // (11.949 archivos "nuevos" el 22/09/2026).
    const existentes = new Set(allFiles.map(f => f.fullPath).filter(Boolean));
    const desaparecidos = [];
    for (const [ruta, entrada] of fileCache) {
      if (existentes.has(ruta)) continue;
      const lib = bibliotecaDe(entrada.fileData || { fullPath: ruta });
      let fuera = false;
      if (lib && leidas.has(lib)) fuera = !dentroDeAlguna(ruta, leidas.get(lib).noLeido);
      else if (!lib || !idsConfiguradas.has(lib)) fuera = true;
      if (fuera) {
        desaparecidos.push(entrada.fileData || { fullPath: ruta });
        fileCache.delete(ruta);
      }
    }
    if (desaparecidos.length > 0) {
      cacheSucia = true;
      console.log(`🧹 ${desaparecidos.length} archivo(s) ya no estan donde estaban`);
    }

    // 3) Lo movido: lo que ha desaparecido (en esta pasada o hace pocos dias)
    // y aparece en otro sitio conserva sus favoritos, notas, colecciones,
    // candado e indice visual (services/reenlazar.js).
    let reenlazados = null;
    try {
      await reenlazar.recordar(desaparecidos);
      const llegados = allFiles.filter(f => f.fullPath && !clavesPrevias.has(f.fullPath));
      const pares = await reenlazar.casar(llegados);
      if (pares.length > 0) {
        reenlazados = await reenlazar.aplicar(pares, {
          favoritos: favoritesManager,
          colecciones: collectionsManager,
          notas: notesManager,
          ocultos: ocultosManager,
          etiquetas: etiquetasManuales,
          clipIndex,
          descartes: descartesManager,
          proxies: videoProxyService,
        });
        reenlazados.archivos = pares.length;
        console.log(`🔗 ${pares.length} archivo(s) movidos reconocidos: ${JSON.stringify(reenlazados)}`);
      }
      await reenlazar.guardarPool();
    } catch (err) {
      fallos.record('reconocer archivos movidos', err);
    }

    if (cacheSucia) await saveCache();

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

    // Lo que el usuario ha cambiado a mano en las etiquetas, encima de todo lo
    // derivado (ver services/etiquetasManuales.js). Sin esto, renombrar o
    // borrar una etiqueta se deshacia en la siguiente sincronizacion.
    allFiles = etiquetasManuales.aplicar(allFiles);

    // Aplicar favoritos (a todo: un reenlazado puede haber movido alguno).
    mediaFiles = favoritesManager.applyFavoritesToFiles(soloIds ? conservados.concat(allFiles) : allFiles);

    // Limpieza de huérfanos. Lo desaparecido hace poco se protege: puede
    // estar a punto de aparecer en otro sitio.
    const protegidas = await reenlazar.refsProtegidas().catch(() => new Set());
    const todasLeidas = !soloIds && librariesScanned.size === activePaths.length;
    await favoritesManager.cleanupOrphanedFavorites(mediaFiles, librariesScanned, { protegidas });
    await sincronizarIndiceClip({ todos: mediaFiles, recorridos: allFiles, podar: todasLeidas });
    // Lo guardado en colecciones por id o por ruta pasa a mediaKey si el
    // archivo esta: asi deja de depender de la letra del disco.
    await collectionsManager.aPortable(mediaFiles)
      .catch(err => fallos.record('poner al dia las referencias de las colecciones', err));
    await collectionsManager.cleanupOrphanedFiles(mediaFiles, {
      scannedLibraryIds: librariesScanned,
      todasLasBibliotecasLeidas: todasLeidas,
      protegidas,
      ubicar: ubicarRef,
    });

    // Recalcular agregado de personas tras cada sync (memoización)
    recomputePersonsAggregate();

    // La portada de la proxima apertura se prepara ahora, con la lista recien
    // hecha. Sin await: no retrasa el aviso de sincronizacion completada.
    portada.regenerar(mediaFiles, { clipIndex, humano: contextoHumanoPortada() });

    // Copias exactas (el mismo archivo en dos discos). Sin await: la primera
    // pasada sobre un disco de backup lee durante minutos, y cuando termina
    // avisa ella sola si algo visible ha cambiado.
    copiasExactas.actualizar(mediaFiles, { bibliotecasLeidas: librariesScanned })
      .catch(err => fallos.record('buscar copias exactas', err, {}));

    // Vigilar lo que esta conectado (y dejar de vigilar lo que no).
    armarVigilancia(paths.length > 0 ? paths : activePaths);

    // Lo tuyo que un cambio de letra dejo sin archivo vuelve a el. Sin await:
    // no retrasa el aviso de sincronizacion completada.
    recuperarHuerfanos().catch(err => fallos.record('recuperar lo que se quedo sin archivo', err, {}));

    broadcastProgress({
      type: 'sync_complete',
      status: 'Sincronización completada',
      percentage: 100,
      inicio: indexado ? indexado.inicio : undefined,
      duracionMs: indexado ? Date.now() - indexado.inicio : undefined,
      total: mediaFiles.length,
      parcial: !!soloIds,
      ...(opts.enSegundoPlano ? { enSegundoPlano: true } : {}),
      reenlazados,
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
    return {
      files: mediaFiles,
      stats: totalStats,
      reenlazados,
      porBiblioteca: Object.fromEntries(objetivo.map(p => [p.id, {
        status: p.status, fileCount: p.fileCount, lastError: p.lastError || null, sugerencia: p.sugerencia || null,
      }])),
    };
  } catch (error) {
    fallos.record('sincronizar las bibliotecas', error);
    broadcastProgress({ type: 'sync_error', status: 'Error', error: error.message, ...(opts.enSegundoPlano ? { enSegundoPlano: true } : {}) });
    return { files: mediaFiles, stats: totalStats, porBiblioteca: {}, error: error.message };
  } finally {
    indexado = null;
    if (cacheSucia) await saveCache().catch(() => {});
  }
}

/**
 * Mantiene el indice de busqueda visual (CLIP/SigLIP-2) a la par de la
 * biblioteca, en los dos sentidos.
 *
 * Poda: quita las entradas que apuntan a archivos que ya no existen. No es
 * solo disco: `searchNearest` coge los N mejores del indice ENTERO y los
 * huerfanos se descartan DESPUES; con el indice sucio se pedian 50 resultados
 * y llegaban 19. Solo si TODAS las bibliotecas activas se han podido leer: con
 * un disco desconectado la ausencia no prueba nada.
 *
 * Relleno: el indice se guarda por el id de ruta (md5 de la ruta absoluta),
 * asi que un disco que cambia de letra o se desvincula y vuelve se quedaba sin
 * busqueda visual, aunque sus huellas siguen en los `_pensadero.json` de su
 * carpeta (el 22/09/2026: 5.811 de 9.738 huellas apuntaban a rutas D: que ya
 * no existian asi). Un escaneo normal no las rehace porque el archivo consta
 * como hecho. Aqui se recuperan de los catalogos, sin tocar la GPU.
 */
const _sinHuellaVisual = new Set(); // ids ya mirados sin huella, esta vida del proceso
async function sincronizarIndiceClip({ todos, recorridos, podar }) {
  try {
    if (!clipIndex.isLoaded()) await clipIndex.load();
    let cambios = 0;
    if (podar && clipIndex.size() > 0) {
      const antes = clipIndex.size();
      const quitados = clipIndex.pruneOrphans(todos.map(f => f.id));
      if (quitados > 0) {
        cambios += quitados;
        console.log(`🧹 Indice visual podado: ${quitados} entradas huerfanas (${antes} -> ${clipIndex.size()})`);
      }
    } else if (clipIndex.size() > 0) {
      // Aunque no se hayan leido todas las bibliotecas, lo que Pensadero ya
      // no conoce de NINGUNA forma (ni en la lista ni en la cache, que recuerda
      // tambien lo de los discos desconectados) sobra: son rutas viejas, como
      // las 5.811 huellas de D: del 23/09/2026 que ocupaban el indice sin
      // poder aparecer nunca. Si ese archivo vuelve, su huella se recupera de
      // su catalogo (mas abajo).
      const conocidos = todos.map(f => f.id);
      for (const e of fileCache.values()) if (e && e.fileData && e.fileData.id) conocidos.push(e.fileData.id);
      const antes = clipIndex.size();
      const quitados = clipIndex.pruneOrphans(conocidos);
      if (quitados > 0) {
        cambios += quitados;
        console.log(`🧹 Indice visual: ${quitados} huellas de archivos que ya no se conocen (${antes} -> ${clipIndex.size()})`);
      }
    }
    let recuperadas = 0;
    let conMomentos = 0;
    for (const f of recorridos || []) {
      if (!f || !f.id || !f.has_catalog || _sinHuellaVisual.has(f.id)) continue;
      // Un video con huella pero sin sus momentos en el indice tambien se mira:
      // los momentos viven en el catalogo igual que la huella principal.
      const faltaPrincipal = !clipIndex.has(f.id);
      const faltanMomentos = f.type === 'video' && !faltaPrincipal && clipIndex.numMomentos(f.id) === 0;
      if (!faltaPrincipal && !faltanMomentos) continue;
      const entrada = await catalogReader.entradaDe(f.fullPath, f.name).catch(() => null);
      if (faltaPrincipal) {
        if (entrada && entrada.clip_embedding_b64 && clipIndex.upsert(f.id, entrada.clip_embedding_b64)) recuperadas++;
        else { _sinHuellaVisual.add(f.id); continue; }
      }
      if (entrada && Array.isArray(entrada.clip_momentos) && entrada.clip_momentos.length > 0) {
        if (clipIndex.setMomentos(f.id, entrada.clip_momentos)) conMomentos++;
      } else if (!faltaPrincipal) {
        _sinHuellaVisual.add(f.id); // tiene huella y aun no tiene momentos: no volver a leerlo
      }
    }
    if (recuperadas > 0) console.log(`🔎 Indice visual: ${recuperadas} huellas recuperadas de los catalogos`);
    if (conMomentos > 0) console.log(`🎞️ Indice visual: momentos de ${conMomentos} videos recuperados de los catalogos`);
    if (cambios + recuperadas + conMomentos > 0) await clipIndex.save();
  } catch (err) {
    // Que falle no puede tumbar el sync: el indice es regenerable.
    fallos.record('poner al dia el indice de busqueda visual', err);
  }
}

// === GUARD DE CONCURRENCIA DE SYNC ===
// Nunca corren dos syncs a la vez. Si llega una petición mientras uno está en
// curso, se apunta y se hace UNA re-pasada al terminar (coalescing), uniendo lo
// pedido: varias rutas sueltas se hacen juntas y "todo" las cubre a todas. Sin
// esto, el vigilante lanzaria un escaneo por cada evento, con writes
// concurrentes sobre scan_paths.json y media_cache.json.
let _syncInFlight = null;
let _syncPendiente = null; // null | 'todo' | Set<libraryId>
// La re-pasada pendiente solo va en segundo plano si TODO lo pedido lo iba.
let _syncPendienteSilencioso = true;

function unirPeticion(a, b) {
  if (a === 'todo' || b === 'todo') return 'todo';
  if (!a) return b;
  if (!b) return a;
  return new Set([...a, ...b]);
}

/**
 * @param {{soloIds?: Iterable<string>, enSegundoPlano?: boolean}} [opts] - sin
 *   soloIds, todas las bibliotecas; enSegundoPlano, sin pantalla de progreso
 */
async function syncFiles(opts = {}) {
  const ids = opts && opts.soloIds ? new Set(opts.soloIds) : null;
  const pide = ids && ids.size > 0 ? ids : 'todo';
  const silencioso = !!(opts && opts.enSegundoPlano);
  if (_syncInFlight) {
    if (!_syncPendiente) _syncPendienteSilencioso = silencioso;
    else _syncPendienteSilencioso = _syncPendienteSilencioso && silencioso;
    _syncPendiente = unirPeticion(_syncPendiente, pide);
    return _syncInFlight;
  }
  _syncInFlight = (async () => {
    let resultado = null;
    let actual = pide;
    let enSegundoPlano = silencioso;
    while (actual) {
      _syncPendiente = null;
      resultado = await performSync(actual === 'todo' ? { enSegundoPlano } : { soloIds: actual, enSegundoPlano });
      actual = _syncPendiente;
      enSegundoPlano = _syncPendienteSilencioso;
    }
    return resultado;
  })();
  try {
    return await _syncInFlight;
  } finally {
    _syncInFlight = null;
  }
}

// === VIGILANTE DE DISCOS ===
// Antes se vigilaba CONTENT_DIR, que en este PC ni existe: ninguna biblioteca
// estaba vigilada y lo copiado solo aparecia al reiniciar o sincronizar a mano.
// Ahora se vigila cada biblioteca conectada con el vigilante nativo de Windows
// (fs.watch recursivo: un solo handle por disco, sin recorrer el arbol como
// hacia chokidar), y un cambio sincroniza SOLO esa biblioteca.
const vigilantes = new Map(); // libraryId -> { ruta, watcher }
const _resyncPendientes = new Set();
let _resyncTimer = null;
// Espera a que la copia pare un momento: copiar 500 archivos no son 500 sincronizaciones.
const RESYNC_DEBOUNCE_MS = 4000;

function scheduleResync(libraryId) {
  _resyncPendientes.add(libraryId || '*');
  if (_resyncTimer) clearTimeout(_resyncTimer);
  _resyncTimer = setTimeout(() => {
    _resyncTimer = null;
    const ids = Array.from(_resyncPendientes);
    _resyncPendientes.clear();
    const opts = ids.includes('*') ? { enSegundoPlano: true } : { soloIds: ids, enSegundoPlano: true };
    syncFiles(opts).catch(err => fallos.record('sincronizar tras un cambio en disco', err));
  }, RESYNC_DEBOUNCE_MS);
}

/**
 * Un evento del vigilante: ¿merece sincronizar esa biblioteca?
 * @param {'rename'|'change'} evento - 'rename' = algo aparece, desaparece o se
 *   renombra; 'change' = cambia el contenido o un atributo
 */
function alCambiarEnDisco(libraryId, raiz, nombre, evento) {
  if (!nombre) { scheduleResync(libraryId); return; }
  const rel = String(nombre);
  const partes = rel.split(/[\\/]/).filter(Boolean);
  // .pensadero (miniaturas, proxies, papelera), carpetas ocultas, la papelera
  // de Windows y el scratch de las suites de edicion: lo escribimos nosotros o
  // no es material. Si no, cada miniatura nueva dispararia otra sincronizacion.
  if (partes.some(p => p.startsWith('.'))) return;
  if (partes.slice(0, -1).some(p => esCarpetaExcluida(p))) return;
  const base = partes[partes.length - 1] || '';
  if (esArchivoBasura(base)) return;
  if (/\.json$/i.test(base)) {
    // `_marina.json` es un catalogo editado fuera: se refresca su carpeta sin
    // recorrer nada. El resto de .json (los _pensadero.json que escribe el
    // escaneo) no son material.
    if (base.toLowerCase() === '_marina.json') {
      const dir = path.join(raiz, path.dirname(rel));
      catalogReader.invalidateCatalog(dir);
      refreshFilesInDir(dir).catch(err => fallos.record('refrescar una carpeta tras cambiar su catalogo', err, { path: dir }));
    }
    return;
  }
  // Con extension y sin ser foto, video o audio (.prproj, .txt...): no es
  // material. Sin extension suele ser una carpeta (movida, renombrada, borrada).
  if (path.extname(base) && !getFileType(base)) return;
  // Un 'change' de carpeta no dice nada que no digan ya los de su contenido, y
  // puede ser solo que alguien la ha LEIDO: Windows apunta la fecha de ultimo
  // acceso en discos pequeños, y la propia sincronizacion lee las carpetas.
  // Sin este filtro, sincronizar podria volver a disparar la sincronizacion.
  if (evento === 'change' && !path.extname(base)) return;
  scheduleResync(libraryId);
}

/** Vigila las bibliotecas activas y conectadas; suelta las demas. */
function armarVigilancia(rutas) {
  const quiero = new Map();
  for (const r of rutas || []) {
    if (r && r.isActive !== false && r.status === 'connected' && r.path) quiero.set(r.id, r.path);
  }
  for (const [id, v] of vigilantes) {
    if (quiero.get(id) === v.ruta) continue;
    try { v.watcher.close(); } catch {}
    vigilantes.delete(id);
  }
  for (const [id, ruta] of quiero) {
    if (vigilantes.has(id)) continue;
    try {
      const watcher = require('fs').watch(ruta, { recursive: true, persistent: true }, (evento, nombre) => {
        alCambiarEnDisco(id, ruta, nombre, evento);
      });
      // Desenchufar el disco cierra el vigilante con error: se suelta y la
      // proxima sincronizacion lo vuelve a armar si el disco esta.
      watcher.on('error', (err) => {
        fallos.record('vigilar una biblioteca', err, { path: ruta, silencioso: true });
        try { watcher.close(); } catch {}
        if (vigilantes.get(id) && vigilantes.get(id).watcher === watcher) vigilantes.delete(id);
      });
      vigilantes.set(id, { ruta, watcher });
    } catch (err) {
      fallos.record('vigilar una biblioteca', err, { path: ruta });
    }
  }
}

/**
 * Refresca los MediaFile en memoria que viven en `dirPath`, re-aplicando
 * el catalog. No toca el filesystem ni dispara un sync completo.
 * @param {{agregado?: boolean}} [opts] - false: no recalcular el agregado de
 *   personas (quien refresca muchas carpetas lo hace una vez al final)
 */
async function refreshFilesInDir(dirPath, { agregado = true } = {}) {
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
  // Y las etiquetas cambiadas a mano, igual que en el sync completo.
  etiquetasManuales.aplicar(touched);
  // Recalcular el agregado de personas: si el refresco cambio las caras de un
  // archivo (re-id, assign-face, promote), los conteos/bubbles del home deben
  // reflejarlo. Sin esto, el mediaFile se actualizaba pero personsAggregate no.
  if (agregado) recomputePersonsAggregate();
  broadcastProgress({ type: 'catalog_refresh', dir: dirPath });
}

/** Refresca varias carpetas (tras un escaneo) con un solo recalculo de personas. */
async function refrescarCarpetas(dirs) {
  for (const d of dirs || []) await refreshFilesInDir(d, { agregado: false });
  recomputePersonsAggregate();
}

/**
 * Cambia la ubicacion de una biblioteca (otra letra de unidad, otra carpeta)
 * llevandose lo que depende de la ruta absoluta: la cache (para no reindexar
 * ni rehacer miniaturas), el nombre de las miniaturas (llevan el id de ruta),
 * el indice visual, y favoritos, notas, colecciones y candado guardados por id
 * de ruta, y (desde el 29/09/2026) las tomas apartadas y los proxies, que se
 * renombran al id nuevo junto al video. Lo guardado por mediaKey no cambia:
 * el id de la biblioteca se conserva.
 */
async function remapearBiblioteca(libraryId, vieja, nueva) {
  const raizVieja = path.resolve(vieja);
  const raizNueva = path.resolve(nueva);
  const pares = [];
  let miniaturas = 0;
  for (const [ruta, entrada] of Array.from(fileCache)) {
    const fd = entrada.fileData || {};
    if (fd.libraryId && fd.libraryId !== libraryId) continue;
    const rel = path.relative(raizVieja, ruta);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const nuevaRuta = path.join(raizNueva, rel);
    const idViejo = fd.id || generateFileId(ruta);
    const idNuevo = generateFileId(nuevaRuta);
    const nombre = fd.name || path.basename(ruta);
    for (const legacy of [false, true]) {
      const de = pathsConfig.resolveThumbnailLocation({ fullPath: nuevaRuta, fileId: idViejo, fileName: nombre, legacy });
      const a = pathsConfig.resolveThumbnailLocation({ fullPath: nuevaRuta, fileId: idNuevo, fileName: nombre, legacy });
      if (de.thumbnailPath !== a.thumbnailPath && await fs.rename(de.thumbnailPath, a.thumbnailPath).then(() => true).catch(() => false)) miniaturas++;
    }
    const mtimeMs = new Date(entrada.mtime || fd.modifiedAt).getTime();
    const hash = crypto.createHash('md5').update(`${nuevaRuta}-${fd.size}-${mtimeMs}`).digest('hex');
    const thumb = typeof fd.thumbnail === 'string' && fd.thumbnail.startsWith('/api/thumbnails/')
      ? `/api/thumbnails/${idNuevo}` : fd.thumbnail;
    fileCache.delete(ruta);
    fileCache.set(nuevaRuta, {
      ...entrada,
      hash,
      fileData: { ...fd, id: idNuevo, fullPath: nuevaRuta, libraryId, url: pathsConfig.getStreamUrl(idNuevo), thumbnail: thumb },
    });
    pares.push({
      de: { id: idViejo, mediaKey: fd.mediaKey || null, fullPath: ruta, name: nombre },
      a: { id: idNuevo, mediaKey: fd.mediaKey || null, fullPath: nuevaRuta, name: nombre },
    });
  }
  cacheSucia = true;
  await saveCache();
  const r = await reenlazar.aplicar(pares, {
    favoritos: favoritesManager,
    colecciones: collectionsManager,
    notas: notesManager,
    ocultos: ocultosManager,
    etiquetas: etiquetasManuales,
    clipIndex,
    descartes: descartesManager,
    proxies: videoProxyService,
  });
  // Lo que habia en memoria con la ruta vieja fuera: la sincronizacion lo rehace.
  mediaFiles = mediaFiles.filter(f => !(f.fullPath && dentroDeAlguna(f.fullPath, [raizVieja])));
  console.log(`🔀 Biblioteca ${libraryId}: ${pares.length} archivos llevados de ${raizVieja} a ${raizNueva} (${miniaturas} miniaturas)`);
  return { archivos: pares.length, miniaturas, ...r };
}

// === LO TUYO QUE SE QUEDO SIN ARCHIVO ===
/**
 * Tomas apartadas, notas, ocultos, favoritos, colecciones y etiquetas a mano
 * cuyo archivo ya no se conoce porque su disco cambio de letra (o se cruzo con
 * otro disco con la misma carpeta), y videos preparados con el id viejo,
 * vuelven a su archivo si no hay duda (utils/huerfanosPorLetra.js,
 * utils/reenlazarProxies.js). No borra nada. El 29/09/2026 habia 478 tomas
 * apartadas, 30 ocultos, 2 notas y 11.117 proxies (165 GB) asi.
 *
 * Tras cada sincronizacion, pero solo si algo ha cambiado desde la ultima vez:
 * buscar cuesta ~1 s (25 variantes de letra por archivo conocido).
 */
let _huerfanosEnCurso = null;
let _huerfanosFirma = null;
function recuperarHuerfanos() {
  if (_huerfanosEnCurso) return _huerfanosEnCurso;
  _huerfanosEnCurso = (async () => {
    // Conocidos = toda la cache, tambien lo de discos desconectados: lo suyo
    // no es huerfano, esta esperando a su disco.
    const conocidos = [];
    for (const e of fileCache.values()) if (e && e.fileData && e.fileData.id) conocidos.push(e.fileData);
    await Promise.all([descartesManager.ensureLoaded(), notesManager.ensureLoaded(), ocultosManager.ensureLoaded(), videoProxyService.cargarIndice()]);
    const apuntes = [];
    const meter = (clave, id) => {
      const c = clasificar(clave);
      if (c) apuntes.push(id && !c.id ? { ...c, id } : c);
    };
    for (const id of descartesManager.list()) meter(id);
    for (const [k, v] of ocultosManager.items) meter(k, v && v.id);
    for (const k of notesManager.files.keys()) meter(k);
    for (const k of favoritesManager.favorites.keys()) meter(k);
    for (const c of collectionsManager.getAllCollections()) {
      for (const ref of c.mediaFiles || []) meter(ref);
      if (typeof c.coverImage === 'string') meter(c.coverImage);
    }
    for (const k of etiquetasManuales.claves()) meter(k);

    // Cambia si cambia algun id (un disco en otra letra da otros ids aunque
    // sean los mismos archivos) o lo apuntado.
    let suma = 0;
    for (const f of conocidos) suma = (suma + parseInt(String(f.id).slice(0, 8), 16)) >>> 0;
    const firma = `${conocidos.length}|${suma}|${apuntes.length}|${JSON.stringify(apuntes.slice(0, 5))}`;
    if (firma === _huerfanosFirma) return null;

    const rutas = await loadScanPaths().catch(() => []);
    const bibliotecas = Object.fromEntries((rutas || []).map(p => [p.id, p.path]));
    const pares = paresParaHuerfanos(conocidos, apuntes, generateFileId, bibliotecas);
    const r = pares.length === 0 ? null : await reenlazar.aplicar(pares, {
      favoritos: favoritesManager,
      colecciones: collectionsManager,
      notas: notesManager,
      ocultos: ocultosManager,
      etiquetas: etiquetasManuales,
      descartes: descartesManager,
    });
    const proxies = await videoProxyService.reenlazarPorLetra(conocidos, generateFileId);
    const hechos = r ? Object.entries(r).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`) : [];
    if (proxies > 0) hechos.push(`${proxies} videos preparados`);
    if (hechos.length > 0) console.log(`🔗 Vuelven a su archivo tras un cambio de letra: ${hechos.join(', ')}`);
    // Con cambios se vuelve a mirar la proxima vez; sin ellos, hasta que
    // cambie lo conocido o lo apuntado.
    _huerfanosFirma = hechos.length > 0 ? null : firma;
    return { pares: pares.length, ...(r || {}), proxies };
  })().finally(() => { _huerfanosEnCurso = null; });
  return _huerfanosEnCurso;
}

// === ROUTERS ===

// Lo que la aplicacion puede enseñar: todo menos lo que esta bajo candado y
// las copias exactas que sobran (ver services/copiasExactas.js). Lo reciben
// las rutas que ENTREGAN material (galeria, busquedas, recuerdos, colecciones,
// gemelas). Las que escanean, sincronizan o limpian siguen viendo el catalogo
// entero: ocultar algo no puede sacarlo del archivo.
const mediaFilesSinCandado = () => ocultosManager.visibles(mediaFiles);
const mediaFilesVisibles = () => copiasExactas.visibles(mediaFilesSinCandado());

copiasExactas.configurar({
  getArchivos: () => mediaFiles,
  cargarRutas: loadScanPaths,
  estaOculto: (f) => ocultosManager.estaOculto(f),
  // Lo que el usuario ha puesto en un archivo: la copia que lo tiene es la que
  // se queda, o esconderla lo sacaria de sus favoritos o de una coleccion.
  contextoHumano: async () => {
    await notesManager.ensureLoaded().catch(() => {});
    const enColeccion = new Set();
    for (const c of collectionsManager.getAllCollections()) {
      for (const ref of (c.mediaFiles || [])) enColeccion.add(ref);
    }
    const tieneNota = (k) => {
      const n = k && notesManager.files.get(k);
      return !!(n && String(n.note || '').trim());
    };
    return (f) => ({
      favorito: !!f.isFavorite,
      nota: tieneNota(f.mediaKey) || tieneNota(f.id),
      coleccion: enColeccion.has(f.id) || (!!f.mediaKey && enColeccion.has(f.mediaKey)),
    });
  },
  trabajo: (f) => ({
    descripcion: !!(f.visual_description && String(f.visual_description).trim()),
    caras: (Array.isArray(f.faces) && f.faces.length > 0) || (Array.isArray(f.face_boxes) && f.face_boxes.length > 0),
    visual: clipIndex.has(f.id),
  }),
  // Cambia lo que se ve: la galeria se recarga sola, como tras un re-id.
  alCambiar: () => broadcastProgress({ type: 'catalog_refresh', motivo: 'copias' }),
});

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
  getMediaFiles: mediaFilesVisibles,
  // Para reconocer lo guardado en una coleccion aunque este oculto o sea una
  // copia escondida (el frontend no lo pinta, pero sigue en la coleccion).
  getTodos: () => mediaFiles,
});
app.use('/api', organizationRoutes);

// Copias exactas: el mismo archivo en dos sitios. Ven el catalogo entero
// (conectado) porque son justo quienes deciden que copia se enseña.
app.use('/api', createCopiasRoutes({ getMediaFiles: () => mediaFiles }));

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
  // La ficha de un archivo concreto abre tambien una copia escondida (se
  // llega a ella desde Copias exactas); lo que esta bajo candado, no.
  getMediaFilesAbribles: () => copiasExactas.visibles(mediaFilesSinCandado(), { soloCandado: true }),
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
  // Marcar o desmarcar un disco como copia de seguridad cambia que copias se ven.
  alCambiarRutas: () => copiasExactas.recalcular(),
  // UNA sola forma de leer y guardar las rutas, y de sincronizarlas: la misma
  // que la sincronizacion completa (sincronizar una ruta es syncFiles con su id).
  loadScanPaths,
  saveScanPaths,
  syncFiles,
  remapearBiblioteca,
  broadcastProgress,
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
  // Tras un escaneo se refrescan solo las carpetas escritas, no todos los discos.
  refreshDirs: refrescarCarpetas,
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

/**
 * Lo que has marcado tu, para que la portada lo prefiera al elegir recuerdos.
 * Sincrono a proposito: se llama justo antes de preparar la portada, que es
 * fuego y olvido al terminar una sincronizacion. Mismo criterio que el
 * `contextoHumano` de las copias exactas, pero sin esperar a las notas: si
 * todavia no estan cargadas, esta portada sale sin ellas y la siguiente ya no.
 */
function contextoHumanoPortada() {
  const enColeccion = new Set();
  try {
    for (const c of collectionsManager.getAllCollections()) {
      for (const ref of (c.mediaFiles || [])) enColeccion.add(ref);
    }
  } catch { /* colecciones aun sin cargar */ }
  const notas = (notesManager && notesManager.files instanceof Map) ? notesManager.files : null;
  const tieneNota = (k) => {
    const n = k && notas && notas.get(k);
    return !!(n && String(n.note || '').trim());
  };
  return (f) => ({
    favorito: !!f.isFavorite,
    nota: tieneNota(f.mediaKey) || tieneNota(f.id),
    coleccion: enColeccion.has(f.id) || (!!f.mediaKey && enColeccion.has(f.mediaKey)),
  });
}

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
      p = await portada.regenerar(mediaFiles, { clipIndex, humano: contextoHumanoPortada() });
    }
    res.json({ success: true, data: portada.servir(p, f => ocultosManager.estaOculto(f) || copiasExactas.estaEscondida(f)) });
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
// Proxies: solo de lo que se ve (una copia exacta escondida no necesita el suyo).
app.use('/api', createProxiesRoutes({ getMediaFiles: mediaFilesVisibles }));

// === MOMENTOS DE LOS VIDEOS (varias huellas por clip para la busqueda visual) ===
app.use('/api', createMomentosRoutes({ getMediaFiles: () => mediaFiles }));

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
    // Lo visible Y lo que la cache recuerda de discos desconectados: si no, las
    // miniaturas de reserva de un disco desenchufado se borraban y habia que
    // rehacerlas al volver (el mismo fallo que vaciaba la cache).
    const validIds = new Set(
      mediaFiles.map(f => f && f.id && f.id.substring(0, 8).toLowerCase()).filter(Boolean)
    );
    for (const e of fileCache.values()) {
      if (e && e.fileData && e.fileData.id) validIds.add(e.fileData.id.substring(0, 8).toLowerCase());
    }

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

/**
 * Borra los temporales a medio escribir que deja un corte (cerrar la ventana
 * del .bat mientras se guardaba): `media_cache.json.<pid>.<n>.tmp` y
 * similares. Nadie los lee nunca, pero se iban acumulando (el 23/09/2026 habia
 * uno de 1 MB y otro de 160 KB). Solo los de hace mas de 10 minutos.
 */
async function limpiarTemporalesHuerfanos() {
  const hace = Date.now() - 10 * 60 * 1000;
  for (const dir of [__dirname, DEFAULT_DATA_DIR]) {
    let nombres = [];
    try { nombres = await fs.readdir(dir); } catch { continue; }
    for (const n of nombres) {
      if (!/\.tmp$/i.test(n)) continue;
      const ruta = path.join(dir, n);
      try {
        const st = await fs.stat(ruta);
        if (st.isFile() && st.mtimeMs < hace) await fs.unlink(ruta);
      } catch { /* en uso o ya no esta: se queda */ }
    }
  }
}

async function initialize() {
  await ensureDirectories();
  await limpiarTemporalesHuerfanos();
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
  if (loadResult.noExiste) {
    // El archivo no existe todavía: dejamos la ruta configurada para futuros
    // saveToDisk(), sin warnings ruidosos.
    peopleRegistry.setRegistryPath(PERSONS_REGISTRY_PATH, PERSONS_AVATARS_BASE);
    console.log(`👥 Registry vacío. Se creará en ${PERSONS_REGISTRY_PATH} al guardar la primera persona.`);
  }
  // Si estaba dañado o no se pudo leer, loadRegistry ya lo ha apuntado en las
  // incidencias (/api/health) y no deja guardar encima de lo que no leyo.
  // Spaces: mismo patron. Comparten avatarsBase con personas.
  try {
    await fs.mkdir(path.dirname(SPACES_REGISTRY_PATH), { recursive: true });
    await fs.mkdir(path.join(PERSONS_AVATARS_BASE, 'spaces'), { recursive: true });
  } catch (err) {
    console.warn(`⚠️ No se pudo preparar carpeta de spaces: ${err.message}`);
  }
  const spacesLoadResult = spacesRegistry.loadRegistry(SPACES_REGISTRY_PATH, PERSONS_AVATARS_BASE);
  if (spacesLoadResult.noExiste) {
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
      // El vigilante de discos lo arma cada sincronizacion (armarVigilancia).
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
        // Antes se vaciaba el registro en memoria y se soltaba su ruta: lo
        // que se guardara despues se descartaba. Ahora se conserva lo que hay
        // en memoria y el siguiente guardado vuelve a escribir el archivo.
        console.warn('⚠️ people_registry.json ha desaparecido del disco: se conserva en memoria y se volverá a escribir al guardar.');
      });
  } catch (err) {
    console.warn('⚠️ No se pudo vigilar people_registry.json:', err.message);
  }
}

process.on('uncaughtException', (error) => console.error('Error no capturado:', error));
process.on('unhandledRejection', (error) => console.error('Promesa rechazada:', error));

initialize();
