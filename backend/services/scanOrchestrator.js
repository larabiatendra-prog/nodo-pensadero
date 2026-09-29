/**
 * Scan Orchestrator — Pensadero
 *
 * Procesa por lotes las fotos de una carpeta, llamando al VLM (qwen2.5vl
 * via Ollama) para generar metadata visual, y escribe/actualiza el
 * `_pensadero.json` correspondiente en la carpeta.
 *
 * Diseño:
 *  - Idempotente: si una foto ya tiene entry en `_pensadero.json` y no se
 *    pide rescan, se salta.
 *  - Serie, no paralelo: un VLM call cada vez para no saturar GPU.
 *  - Progreso por WebSocket via broadcastProgress (per-file).
 *  - Errores por archivo no abortan el batch: se loguean y se sigue.
 *  - Tras procesar la carpeta, recarga el catalog cache y dispara un sync
 *    parcial para que el frontend vea la metadata sin recargar manualmente.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// Replica server.js generateFileId — md5 del filePath. Se usa para indexar
// el clipIndex por fileId (mismo identificador que ve el frontend).
function fileIdFor(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}
const { getInstance: getScanner } = require('../visualScanService');
const { getInstance: getFaceService, encodeEmbedding, decodeEmbedding } = require('./faceService');
const { getInstance: getClipService } = require('./clipService');
const { getInstance: getCameraMotionService } = require('./cameraMotionService');
const videoProxyService = require('./videoProxyService');
const scanState = require('./scanState');
const clipIndex = require('../clipIndex');
const { esCarpetaExcluida } = require('../utils/carpetasExcluidas');
const colorAnalyzer = require('../colorAnalyzer');
const { enrichPalette } = require('../colorNamer');
const peopleRegistry = require('../peopleRegistry');
const spacesRegistry = require('../spacesRegistry');
const catalogReader = require('../catalogReader');
const folderContext = require('./folderContext');
const { atomicWriteFile, withFileLock, normalizeLockKey } = require('../utils/jsonStore');
const { computeFaceCount, mergeIdentityOnRescan } = require('../utils/faceCatalog');
const fallos = require('../utils/failureReason');
const { computeShotType } = require('../utils/shotType');
const { computePeopleFraming } = require('../utils/peopleFraming');
const { computeTimeOfDay } = require('../utils/timeOfDay');
const { computeLighting } = require('../utils/lighting');
const escaneoConfig = require('./escaneoConfig');
const { reaprovechables, entradaCopiada } = require('../utils/reaprovecharCopias');

/** Trabajos que dejan huella en la entrada (los proxies no: viven aparte). */
const TRABAJOS = ['descripcion', 'caras', 'busquedaVisual', 'movimiento'];

/**
 * ¿Se le hizo a esta entrada el trabajo `cap`? Las entradas anteriores a los
 * interruptores no llevan `escaneo`: se escanearon con todo encendido, asi que
 * cuentan como hechas. Tratarlas como pendientes relanzaria miles de archivos.
 */
function trabajoHecho(entry, cap) {
  if (!entry) return false;
  if (entry.escaneo && typeof entry.escaneo[cap] === 'boolean') return entry.escaneo[cap];
  return true;
}

/**
 * Lo que le falta a una entrada ya catalogada, de entre lo que este escaneo
 * puede hacer (`vivos`: encendido y con su servicio levantado).
 */
function trabajosPendientes(entry, vivos, esVideo) {
  return TRABAJOS.filter(cap => {
    if (!vivos[cap]) return false;
    if (cap === 'movimiento' && !esVideo) return false;
    return !trabajoHecho(entry, cap);
  });
}

/** Copia profunda de una entrada JSON (las entradas son JSON puro). */
function clonarEntrada(entry) {
  return JSON.parse(JSON.stringify(entry));
}

/**
 * Base de la entrada cuando la descripcion no se hace en esta pasada: la que
 * ya habia (para completarla sin perder nada) o un esqueleto con lo que
 * ffprobe sabe del video.
 */
function entradaSinDescripcion(previa, probe) {
  if (previa) return clonarEntrada(previa);
  const entry = {
    schema_version: 2,
    technical: {},
    identity: { faces: [], face_count: 0, spaces: [] },
    colors: {},
  };
  if (probe) {
    entry.technical = {
      duration: probe.duration || null,
      resolution: probe.width && probe.height ? `${probe.width}x${probe.height}` : null,
      fps: probe.fps || null,
      codec: probe.codec || null,
      creation_time: probe.creation_time || null,
    };
  }
  return entry;
}

/**
 * Antes de volcar: lo que esta pasada NO ha rehecho se hereda de la entrada
 * que hay en disco, y se apunta en `entry.escaneo` que tiene hecho cada
 * trabajo. Sin la herencia, re-describir una carpeta con la busqueda visual
 * apagada tiraria sus embeddings; sin la marca, un archivo escaneado sin caras
 * nunca volveria a la cola cuando las caras se encienden.
 */
function heredarYMarcar(entry, previa, hecho, esVideo) {
  if (previa) {
    if (!hecho.busquedaVisual) {
      if (previa.clip_embedding_b64 && !entry.clip_embedding_b64) entry.clip_embedding_b64 = previa.clip_embedding_b64;
      // Los momentos de un video (huellas de otros instantes, ver clipIndex):
      // re-describir sin busqueda visual no los tira.
      if (Array.isArray(previa.clip_momentos) && !entry.clip_momentos) entry.clip_momentos = previa.clip_momentos;
      const espacios = previa.identity && previa.identity.spaces;
      if (Array.isArray(espacios) && espacios.length > 0) {
        entry.identity = entry.identity || {};
        if (!Array.isArray(entry.identity.spaces) || entry.identity.spaces.length === 0) {
          entry.identity.spaces = espacios;
        }
      }
    }
    if (!hecho.caras) {
      // El bloque de caras lo conserva mergeIdentityOnRescan (caso "sin
      // detecciones nuevas"). Aqui va lo que se deriva de ellas.
      if (previa.demographics && !entry.demographics) entry.demographics = previa.demographics;
      const pc = previa.composition;
      if (pc && pc.shot_type_face_ratio != null && entry.composition) {
        for (const k of ['shot_type', 'shot_type_source', 'shot_type_confidence', 'shot_type_face_ratio', 'people_framing', 'people_framing_source']) {
          if (pc[k] !== undefined) entry.composition[k] = pc[k];
        }
      }
    }
    if (!hecho.movimiento && previa.composition && previa.composition.motion_debug) {
      entry.composition = entry.composition || {};
      entry.composition.camera_movement = previa.composition.camera_movement;
      if (typeof previa.composition.scene_changes === 'boolean') entry.composition.scene_changes = previa.composition.scene_changes;
      entry.composition.motion_debug = previa.composition.motion_debug;
    }
  }
  const marca = {};
  for (const cap of TRABAJOS) {
    if (cap === 'movimiento' && !esVideo) continue;
    marca[cap] = hecho[cap] ? true : trabajoHecho(previa, cap);
  }
  entry.escaneo = marca;
  return entry;
}
const exifReader = require('exif-reader');

// Mapeo InsightFace gender (0=female, 1=male) → vocabulario español de Pensadero
const GENDER_MAP = { 0: 'mujer', 1: 'hombre' };
// Mapeo edad (años) → rango. Usa los mismos buckets que el VLM.
function ageBucket(age) {
  if (typeof age !== 'number' || !isFinite(age)) return null;
  if (age < 16) return 'niño';
  if (age < 30) return 'joven';
  if (age < 60) return 'adulto';
  return 'senior';
}

const PENSADERO_CATALOG_FILENAME = '_pensadero.json';
// Cada cuantos archivos se vuelca el catalogo a disco durante el escaneo. El
// coste de un corte (crash, apagon, cierre de ventana) es como mucho este
// numero de archivos redescritos. Antes solo se escribia al terminar el bucle
// entero y una caida a mitad se llevaba por delante horas de VLM.
const FLUSH_EVERY = parseInt(process.env.SCAN_FLUSH_EVERY, 10) || 10;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif', '.tif', '.tiff', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg', '.mts', '.m2ts', '.wmv', '.flv', '.3gp', '.ts', '.ogv', '.vob', '.dv']);
const SCANNABLE_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);

function isVideoExt(ext) { return VIDEO_EXTS.has(ext.toLowerCase()); }

/** ¿El escaneo con IA mira este archivo? (audio, exports raros... no). */
function esEscaneable(nombre) {
  return SCANNABLE_EXTS.has(path.extname(String(nombre || '')).toLowerCase());
}

/**
 * ¿A este archivo le falta algun trabajo de los encendidos en `caps`? Mismo
 * criterio que el filtro de scanFolder, pero sobre un MediaFile ya en memoria
 * (su `escaneo` lo copia catalogReader). Lo usa Rutas para decir que queda de
 * verdad: antes contaba solo descripciones, asi que con las caras encendidas
 * despues el boton de escanear salia apagado, y los audios (que no se escanean
 * nunca) salian como "faltan" para siempre.
 */
function archivoPendiente(file, caps) {
  const nombre = file && (file.name || file.fullPath);
  if (!nombre || !esEscaneable(nombre)) return false;
  const esVideo = isVideoExt(path.extname(nombre));
  const entrada = file.has_catalog ? { escaneo: file.escaneo } : null;
  return TRABAJOS.some(cap => {
    if (!caps || !caps[cap]) return false;
    if (cap === 'movimiento' && !esVideo) return false;
    return !trabajoHecho(entrada, cap);
  });
}

// Jobs en curso: jobId → { status, total, done, errors, cancelRequested }
const activeJobs = new Map();

function makeJobId() {
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Aparta un jobId ANTES de que el escaneo arranque. La ruta HTTP comprueba
 * solapes y reserva en el mismo tic, sin await de por medio: si no, dos
 * clics seguidos pasaban los dos el guard y lanzaban dos escaneos.
 */
function reservarJob(jobId, folderPath) {
  const job = {
    jobId, folderPath, status: 'running', fase: 'reservado',
    total: 0, done: 0, errors: 0, cancelRequested: false, startedAt: Date.now(),
  };
  activeJobs.set(jobId, job);
  return job;
}

/**
 * Recorre `folderPath` (recursivo) y devuelve la lista de imágenes encontradas.
 */
async function collectImages(folderPath) {
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      // Saltar carpetas ocultas y de sistema
      if (ent.name.startsWith('.') || ent.name.startsWith('$')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Previews de render, auto-saves y caches de las suites de edicion:
        // describir con el VLM un preview de Premiere es quemar ~9 s de GPU
        // en un archivo que el propio Premiere regenera solo.
        if (esCarpetaExcluida(ent.name)) continue;
        await walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (SCANNABLE_EXTS.has(ext)) results.push(full);
      }
    }
  }
  await walk(folderPath);
  return results;
}

/**
 * Recorre `folderPath` y devuelve, por cada subcarpeta que contenga medios
 * escaneables, `{ dir, relPath, mediaCount, imageCount, videoCount }`.
 * Pensado para el endpoint de inventario que alimenta el modal de
 * contexto en el frontend.
 */
async function listFoldersWithMedia(folderPath) {
  const counts = new Map(); // dir → { images, videos }
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let images = 0;
    let videos = 0;
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name.startsWith('$')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Mismo criterio que collectImages: el inventario debe contar lo que
        // el escaneo va a mirar, no lo que hay en el disco.
        if (esCarpetaExcluida(ent.name)) continue;
        await walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (IMAGE_EXTS.has(ext)) images++;
        else if (VIDEO_EXTS.has(ext)) videos++;
      }
    }
    if (images + videos > 0) counts.set(dir, { images, videos });
  }
  await walk(folderPath);

  const root = path.resolve(folderPath);
  return Array.from(counts.entries())
    .map(([dir, { images, videos }]) => ({
      dir,
      relPath: path.relative(root, dir) || '.',
      mediaCount: images + videos,
      imageCount: images,
      videoCount: videos,
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Lee el _pensadero.json (o _marina.json) de una carpeta si existe.
 * Devuelve { catalog, source } o { catalog: null, source: null }.
 */
async function readExistingCatalog(folderPath) {
  for (const fname of [PENSADERO_CATALOG_FILENAME, '_marina.json']) {
    const fp = path.join(folderPath, fname);
    try {
      const raw = await fs.readFile(fp, 'utf-8');
      const catalog = JSON.parse(raw);
      return { catalog, source: fname };
    } catch {
      // no existe, probar siguiente
    }
  }
  return { catalog: null, source: null };
}

/**
 * Genera técnica básica (resolution, aspect_ratio) usando sharp para no
 * depender solo de lo que diga el VLM.
 */
async function extractTechnical(filePath) {
  try {
    const meta = await sharp(filePath).metadata();
    if (!meta.width || !meta.height) return {};
    const ratio = meta.width / meta.height;
    let aspect;
    if (Math.abs(ratio - 16 / 9) < 0.02) aspect = '16:9';
    else if (Math.abs(ratio - 4 / 3) < 0.02) aspect = '4:3';
    else if (Math.abs(ratio - 1) < 0.02) aspect = '1:1';
    else if (Math.abs(ratio - 9 / 16) < 0.02) aspect = '9:16';
    else aspect = 'other';
    const out = {
      resolution: `${meta.width}x${meta.height}`,
      aspect_ratio: aspect,
    };
    // capture_time desde EXIF (hora LOCAL de pared). La usa time_of_day. Coste
    // casi cero: el buffer exif ya viene en meta. Tolerante a fallos de parseo.
    if (meta.exif) {
      try {
        const ex = exifReader(meta.exif);
        const d = ex?.Photo?.DateTimeOriginal || ex?.Image?.DateTime;
        if (d instanceof Date && !isNaN(d.getTime())) out.capture_time = d.toISOString();
      } catch { /* exif ilegible: se omite */ }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Escanea UN único archivo (desde el boton de la tarjeta del grid). Reutiliza
 * todo el pipeline de scanFolder (VLM + caras + color + CLIP + escritura del
 * catalogo) pero acotado a ese archivo. force:true porque el escaneo de un
 * archivo concreto es una accion explicita: siempre re-escanea aunque ya tenga
 * entry. La carpeta padre es donde vive su _pensadero.json.
 *
 * @param {string} filePath  Ruta absoluta del archivo
 * @param {object} opts  (broadcastProgress, jobId)
 * @returns {Promise<{jobId, total, done, errors, written}>}
 */
async function scanSingleFile(filePath, opts = {}) {
  const folderPath = path.dirname(filePath);
  return scanFolder(folderPath, {
    ...opts,
    singleFile: filePath,
    force: true,
  });
}

/**
 * Procesa una carpeta: lista imágenes, escanea cada una (saltando las que ya
 * estén catalogadas si !force), y actualiza/escribe el _pensadero.json.
 *
 * @param {string} folderPath  Ruta absoluta de la carpeta a escanear
 * @param {object} opts
 *   - force: boolean — escanear también las que ya tienen entry (default false)
 *   - broadcastProgress: fn(data) — para WebSocket
 *   - getMediaFiles, syncFiles: opcional, para refrescar memoria post-scan
 *   - jobId: string — id de tracking
 *   - singleFile: string — si se pasa, escanea solo ese archivo
 *   - forzarDesde: ISO — con force, no rehace lo escaneado desde esa fecha
 *     (reanudar un re-escaneo cortado no repite lo ya hecho)
 * @returns {Promise<{jobId, total, done, errors, written, carpetas}>}
 */
async function scanFolder(folderPath, opts = {}) {
  const jobId = opts.jobId || makeJobId();
  const broadcastProgress = opts.broadcastProgress || (() => {});
  // El job existe desde el primer momento, no tras cargar los modelos:
  // levantar caras, CLIP y movimiento tarda decenas de segundos en frio, y en
  // ese rato el escaneo era invisible para el guard de solapes (se podia
  // lanzar otro sobre la misma carpeta) y "Detener" decia que no habia nada.
  const job = activeJobs.get(jobId) || {};
  Object.assign(job, {
    jobId,
    folderPath,
    status: 'running',
    fase: 'preparando',
    total: 0,
    done: 0,
    errors: 0,
    // Volcados que no se pudieron escribir. Se cuentan aparte de `errors`
    // (fallos por archivo) porque significan otra cosa muy distinta: el
    // trabajo se ha hecho y se esta PERDIENDO. Sale en scan_done con su causa.
    escriturasFallidas: 0,
    // Marca del registro de fallos al empezar, para poder contar solo los
    // de ESTE job al cerrarlo.
    marcaFallos: fallos.mark(),
    cancelRequested: !!job.cancelRequested,
    startedAt: Date.now(),
    // Ventana movil de duraciones por archivo para estimar tiempo restante.
    // Movil (no acumulada) porque fotos y videos tardan muy distinto y el
    // cold-start del VLM en el primer archivo dispararia una media acumulada.
    recentMs: [],
    lastTickAt: Date.now(),
  });
  activeJobs.set(jobId, job);
  try {
    return await escanearCarpeta(folderPath, { ...opts, jobId, broadcastProgress }, job);
  } catch (err) {
    // Un fallo fuera del bucle por archivo (listar, leer catalogos...) dejaba
    // el job en 'running' para siempre: bloqueaba el escaneo desde la tarjeta
    // hasta reiniciar y la pantalla se quedaba escaneando.
    job.status = 'error';
    const exp = fallos.record('escanear la carpeta', err, { path: folderPath });
    broadcastProgress({
      type: 'scan_done',
      jobId,
      carpeta: folderPath,
      estado: 'error',
      status: `El escaneo se ha parado: ${exp.reason}`,
      causaPrincipal: { reason: exp.reason, hint: exp.hint, code: exp.code },
      total: job.total,
      done: job.done,
      errors: job.errors,
      percentage: 100,
    });
    throw err;
  } finally {
    if (!job.finishedAt) job.finishedAt = Date.now();
    // Conservar el job ~5 min para queries de status, luego liberar.
    setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
  }
}

async function escanearCarpeta(folderPath, opts, job) {
  const {
    force = false,
    broadcastProgress,
    jobId,
    // singleFile: ruta absoluta. Si se pasa, escanea SOLO ese archivo (no
    // recorre el arbol). Lo usa scanSingleFile para el escaneo desde la tarjeta.
    singleFile = null,
    // Que trabajos se hacen (ver escaneoConfig). Sin nada, todos: es lo de
    // siempre para quien llame sin saber de interruptores.
    capacidades = null,
    forzarDesde = null,
  } = opts;
  const caps = escaneoConfig.normalizar(capacidades);

  // Campos comunes de los frames de este escaneo. unArchivo: el escaneo desde
  // la tarjeta tiene su propio aviso y no debe abrir la pantalla completa.
  const inicioEscaneo = Date.now();
  const comunes = { jobId, inicio: inicioEscaneo, force, carpeta: folderPath, unArchivo: !!singleFile, capacidades: caps };

  // Levantar caras, CLIP y movimiento puede tardar decenas de segundos en
  // frio; sin este aviso parecia que el escaneo no habia arrancado.
  broadcastProgress({ type: 'scan_start', ...comunes, fase: 'preparando', status: 'Cargando modelos...' });

  const scanner = getScanner();
  const faceSvc = getFaceService();
  const clipSvc = getClipService();
  const motionSvc = getCameraMotionService();

  // Cargar embeddings del registry en el cache del faceService antes del
  // batch. Si falla (sin Python/InsightFace), seguimos sin reconocimiento.
  // Apagado = ni se arranca: levantar InsightFace o SigLIP-2 ya ocupa VRAM.
  let facesEnabled = false;
  if (caps.caras) try {
    await faceSvc.init();
    if (faceSvc.getStatus().ready) {
      await faceSvc.loadAllEmbeddings(peopleRegistry.getState().avatarsBase);
      facesEnabled = true;
    }
  } catch (err) {
    console.warn('[scan] face service no disponible:', err.message);
    facesEnabled = false;
  }

  // CLIP / SigLIP-2: arranque + warmup explicito ANTES de procesar archivos.
  // El warmup envia un embed_text con texto minimo para forzar la carga del
  // modelo y detectar fallos de inmediato (OOM CUDA, modelo no descargado,
  // dependencias rotas) en vez de descubrirlo a las 12h cuando el indice
  // sigue vacio. Si warmup falla, seguimos SIN embeddings — el resto del
  // scan (descripcion VLM, caras) funciona igual y el aviso queda visible.
  let clipEnabled = false;
  if (caps.busquedaVisual) try {
    const warm = await clipSvc.warmup();
    if (warm.ok) {
      if (!clipIndex.isLoaded()) await clipIndex.load();
      clipEnabled = true;
      console.log('[scan] CLIP/SigLIP-2 listo y validado');
    } else {
      console.warn('[scan] ⚠️ CLIP/SigLIP-2 no disponible:', warm.error);
      console.warn('[scan] El scan continua SIN embeddings. La busqueda por imagen/texto no funcionara hasta arreglarlo.');
    }
  } catch (err) {
    console.warn('[scan] CLIP service no disponible:', err.message);
    clipEnabled = false;
  }

  // Camera motion (optical-flow CPU): detecta el movimiento de camara en video,
  // que el VLM hace mal. Corre en CPU en paralelo a la GPU. Si no esta
  // disponible (sin Python), seguimos con el camera_movement del VLM.
  let motionEnabled = false;
  if (caps.movimiento) try {
    if (await motionSvc.init()) {
      motionEnabled = true;
      console.log('[scan] camera motion (optical-flow) listo');
    } else {
      console.warn('[scan] camera motion no disponible:', motionSvc.lastError);
    }
  } catch (err) {
    console.warn('[scan] camera motion no disponible:', err.message);
    motionEnabled = false;
  }

  // "Detener" mientras cargaban los modelos: se para aqui, antes de tocar nada.
  if (job.cancelRequested) {
    job.status = 'cancelled';
    broadcastProgress({ type: 'scan_done', ...comunes, estado: 'cancelled', total: 0, done: 0, errors: 0, written: 0, status: 'Escaneo cancelado', percentage: 100 });
    return { jobId, total: 0, done: 0, errors: 0, written: 0, carpetas: [] };
  }
  job.fase = 'escaneando';

  // Calcula campos de tiempo para el payload de progreso. Se llama UNA vez por
  // archivo procesado (exito o error): cada llamada registra el delta desde el
  // archivo anterior en la ventana movil. avgMsPerFile = media de la ventana;
  // etaMs = ese ritmo aplicado a lo que queda.
  const RECENT_WINDOW = 8;
  const timingFields = () => {
    const now = Date.now();
    const delta = now - job.lastTickAt;
    job.lastTickAt = now;
    job.recentMs.push(delta);
    if (job.recentMs.length > RECENT_WINDOW) job.recentMs.shift();
    const avgMsPerFile = job.recentMs.reduce((a, b) => a + b, 0) / job.recentMs.length;
    const remaining = Math.max(0, job.total - job.done);
    return {
      elapsedMs: now - job.startedAt,
      avgMsPerFile: Math.round(avgMsPerFile),
      etaMs: Math.max(0, Math.round(avgMsPerFile * remaining)),
    };
  };

  // Capacidades realmente disponibles para ESTE escaneo. Van en el evento
  // porque si caras o CLIP no levantan, el escaneo corre igual y termina
  // "con exito" dejando un catalogo mudo: sin caras o sin busqueda visual.
  // Antes solo se sabia por un console.warn que nadie leia.
  const capabilities = { faces: facesEnabled, clip: clipEnabled, motion: motionEnabled };
  // Degradado es lo que se PIDIO y no ha levantado. Lo apagado a proposito no
  // es un fallo y no se avisa como tal.
  const pedidoPorServicio = { faces: caps.caras, clip: caps.busquedaVisual, motion: caps.movimiento };
  const degraded = Object.entries(capabilities).filter(([k, ok]) => pedidoPorServicio[k] && !ok).map(([k]) => k);
  // Lo que este escaneo puede hacer de verdad: encendido y con servicio vivo.
  const vivos = {
    descripcion: caps.descripcion,
    caras: facesEnabled,
    busquedaVisual: clipEnabled,
    movimiento: motionEnabled,
  };
  const apagadas = escaneoConfig.IDS.filter(id => !caps[id]);
  job.capacidades = caps;
  if (apagadas.length > 0) console.log(`[scan] apagado a proposito: ${apagadas.join(', ')}`);
  if (degraded.length > 0) {
    console.warn(`[scan] DEGRADADO — sin: ${degraded.join(', ')}. El catalogo saldra incompleto en esos campos.`);
  }

  // Avisar inicio
  broadcastProgress({
    type: 'scan_start',
    ...comunes,
    fase: 'buscando',
    folder: folderPath,
    status: 'Buscando imágenes...',
    percentage: 0,
    capabilities,
    degraded,
    apagadas,
  });

  // 1) Listar imágenes. Si es escaneo de un único archivo, no recorremos el
  // arbol entero: usamos directamente ese path (la carpeta padre es folderPath).
  const allImages = singleFile ? [singleFile] : await collectImages(folderPath);
  if (allImages.length === 0) {
    job.status = 'done';
    broadcastProgress({
      type: 'scan_done',
      jobId,
      total: 0,
      done: 0,
      errors: 0,
      status: 'Sin imágenes que escanear',
    });
    return { jobId, total: 0, done: 0, errors: 0, written: 0, carpetas: [] };
  }

  // 2) Cargar catálogos existentes por carpeta (cache local del job)
  // dir → { catalog, source, pending }
  //   catalog: copia leida al EMPEZAR el job. Solo sirve para decidir que
  //     archivos saltar (paso 3) y como base si el fichero no existe en disco.
  //   pending: basename → entry recien escaneada, aun sin volcar. El volcado
  //     las aplica sobre lo que haya EN DISCO en ese momento (ver flushCatalogs).
  const catalogsByDir = new Map();
  for (const img of allImages) {
    const dir = path.dirname(img);
    if (!catalogsByDir.has(dir)) {
      const existing = await readExistingCatalog(dir);
      catalogsByDir.set(dir, {
        catalog: existing.catalog || {
          version: 1,
          batch: 'pensadero-auto',
          processed: new Date().toISOString(),
          photos: {},
        },
        source: existing.source || PENSADERO_CATALOG_FILENAME,
        pending: new Map(),
      });
    }
  }

  // Volcado de los catálogos con entradas pendientes. Se llama DURANTE el bucle
  // (cada FLUSH_EVERY archivos y al cambiar de carpeta), no solo al terminar: lo
  // ya descrito tiene que estar en disco aunque el proceso muera a mitad.
  const writtenDirs = new Set();
  async function flushCatalogs() {
    for (const [dir, c] of catalogsByDir.entries()) {
      if (c.pending.size === 0) continue;
      const targetFile = path.join(dir, PENSADERO_CATALOG_FILENAME);
      // Lock por path: serializa esta escritura con un re-id/promote de fondo
      // sobre la misma carpeta, para que no se intercalen dos escrituras del
      // mismo _pensadero.json.
      await withFileLock(normalizeLockKey(targetFile), async () => {
        // RELEER dentro del lock, y aplicar SOLO las entradas de este job.
        //
        // Antes se volcaba `c.catalog`, la copia cargada al empezar el job —
        // que en un escaneo largo tiene horas. El lock evitaba que dos
        // escrituras se intercalaran, pero no que la nuestra estuviera obsoleta:
        // todo lo que hubieran escrito mientras tanto el re-id, assign-face,
        // promote o el borrado de una persona sobre ESTA carpeta desaparecia en
        // el siguiente volcado, sin ruido. Etiquetar caras con un escaneo en
        // marcha era tirar el trabajo a la basura.
        //
        // Ahora el ciclo leer -> mutar -> escribir vive entero dentro del lock,
        // que es la misma disciplina que ya siguen el re-id, el promote y el
        // assign-face. Las entradas ajenas se respetan; solo se pisan las que
        // este job ha escaneado.
        let base = null;
        try {
          base = JSON.parse(await fs.readFile(targetFile, 'utf-8'));
        } catch (err) {
          if (err.code !== 'ENOENT') {
            console.warn(`[scan] no se pudo releer ${targetFile} (${err.message}); se parte de la copia en memoria`);
          }
        }
        // Sin fichero en disco (primer escaneo, o venia de `_marina.json`):
        // la copia inicial es la base correcta.
        if (!base || typeof base !== 'object') base = c.catalog;
        if (!base.photos) base.photos = {};

        for (const [basename, entry] of c.pending) {
          // La entry anterior se toma de lo REELEIDO, no de la copia en memoria:
          // asi una cara asignada a mano mientras corria el escaneo tambien
          // entra en la fusion de identidad, en vez de perderse.
          const prevEntry = base.photos[basename]
            || (base.clips && base.clips[basename])
            || null;
          const rutaEntrada = path.join(dir, basename);
          const plan = planes.get(rutaEntrada);
          if (plan) {
            heredarYMarcar(entry, prevEntry, plan, isVideoExt(path.extname(basename).toLowerCase()));
          }
          if (prevEntry && prevEntry.identity) {
            const merged = mergeIdentityOnRescan(prevEntry.identity, entry.identity, {
              decodeEmbedding,
              getDisplayName: peopleRegistry.getDisplayName,
            });
            entry.identity = merged.identity;
            const { reancladas, conservadas, bloquePrevio } = merged.stats;
            if (bloquePrevio) {
              console.warn(`[scan] ${basename}: sin caras nuevas, se conserva el bloque facial anterior (${entry.identity.detections.length} detecciones)`);
            } else if (reancladas > 0 || conservadas > 0) {
              console.log(`[scan] ${basename}: identidad manual preservada (${reancladas} re-ancladas, ${conservadas} sin re-detectar)`);
            }
          }
          // Cuando se hizo: reanudar un re-escaneo cortado salta lo que ya se
          // hizo en esa misma tanda (ver `forzarDesde`).
          entry.escaneado_en = new Date().toISOString();
          // Clave canonica `photos` para las nuevas; si habia `clips`, se
          // mantiene (no romper legacy).
          base.photos[basename] = entry;
        }
        base.processed = new Date().toISOString();

        try {
          // Escritura atomica (tmp + rename): el _pensadero.json es la fuente de
          // verdad y guarda embeddings NO regenerables. Un crash a media
          // escritura no lo trunca.
          //
          // backup: el rename atomico protege del truncado, no de escribir
          // contenido valido pero equivocado. Este fichero guarda embeddings e
          // identidad manual que no se recuperan solos, y era el unico de los
          // no regenerables sin .bak (registry y embeddings.json ya lo tenian).
          // Ojo: es UN .bak rotatorio, asi que durante un escaneo largo acaba
          // siendo "el estado del volcado anterior", no el de antes de empezar.
          await atomicWriteFile(targetFile, JSON.stringify(base, null, 2), { backup: true });
          catalogReader.invalidateCatalog(dir);
          c.catalog = base;     // la copia en memoria queda al dia
          c.pending.clear();
          writtenDirs.add(dir);
        } catch (err) {
          // No se limpia `pending`: se reintenta en el proximo volcado.
          // Y se APUNTA con su causa: un escaneo que no puede escribir esta
          // quemando GPU para nada, y antes eso solo salia por console.warn.
          fallos.record('escribir el catalogo', err, { path: targetFile });
          job.escriturasFallidas++;
        }
      });
    }
    // El indice CLIP viaja con el catalogo. Si se queda sin guardar, los
    // embeddings siguen en el sidecar pero la busqueda visual no los ve hasta
    // regenerar el indice.
    if (clipEnabled && clipIndex.isDirty()) {
      try {
        await clipIndex.save();
      } catch (err) {
        console.warn('[scan] error guardando CLIP index:', err.message);
      }
    }
  }

  // 3) Filtrar las que ya están catalogadas (si !force)
  // Ademas de lo nuevo, entra lo ya catalogado al que le falta algun trabajo
  // encendido (se escaneo con las caras apagadas y ahora estan encendidas).
  // Para esos se hace SOLO lo que falta: no se vuelve a describir nada.
  const toScan = [];
  const planes = new Map(); // ruta -> { descripcion, caras, busquedaVisual, movimiento, frames }
  const previas = new Map(); // ruta -> entrada al empezar el job (o null)
  let completando = 0;
  for (const img of allImages) {
    const dir = path.dirname(img);
    const basename = path.basename(img);
    const c = catalogsByDir.get(dir);
    // Soportar tanto `photos` (default nuevo) como `clips` (legacy)
    const existingEntries = (c.catalog && (c.catalog.photos || c.catalog.clips)) || {};
    const previa = existingEntries[basename] || null;
    const esVideo = isVideoExt(path.extname(basename).toLowerCase());
    // Reanudar un re-escaneo que se corto: lo escaneado en esa misma tanda no
    // se repite. Antes la reanudacion volvia a forzar TODO desde el principio.
    const forzar = force && !(forzarDesde && previa
      && typeof previa.escaneado_en === 'string' && previa.escaneado_en >= forzarDesde);
    let hacer;
    if (!forzar && previa) {
      const faltan = trabajosPendientes(previa, vivos, esVideo);
      if (faltan.length === 0) continue;
      hacer = Object.fromEntries(TRABAJOS.map(cap => [cap, faltan.includes(cap)]));
      completando++;
    } else {
      hacer = { ...vivos, movimiento: vivos.movimiento && esVideo };
      // Nada que hacerle a un archivo nuevo: no se crea una entrada vacia.
      if (!TRABAJOS.some(cap => hacer[cap])) continue;
    }
    hacer.frames = esVideo && (hacer.descripcion || hacer.caras || hacer.busquedaVisual);
    planes.set(img, hacer);
    previas.set(img, previa);
    toScan.push(img);
  }
  if (completando > 0) {
    console.log(`[scan] ${completando} archivo(s) ya catalogados vuelven para completar trabajos encendidos`);
  }

  // 3b) Copias exactas ya escaneadas en otro sitio (un disco de backup junto
  // al original): se copia su entrada en vez de volver a pasarlas por la
  // grafica. Archivo a archivo y por contenido (utils/reaprovecharCopias.js):
  // un backup no tiene por que tener lo mismo que el original. Con `force` no:
  // re-escanear es rehacer.
  let reaprovechados = 0;
  if (!force && !singleFile && toScan.length > 0 && typeof opts.copiasDe === 'function') {
    const catalogosCopia = new Map(); // dir -> photos de su catalogo (o null)
    const entradaDe = async (ruta) => {
      const dir = path.dirname(ruta);
      if (!catalogosCopia.has(dir)) {
        const { catalog } = await readExistingCatalog(dir);
        catalogosCopia.set(dir, (catalog && (catalog.photos || catalog.clips)) || null);
      }
      const fotos = catalogosCopia.get(dir);
      return (fotos && fotos[path.basename(ruta)]) || null;
    };
    try {
      const copiables = await reaprovechables(
        toScan.map(ruta => ({ ruta, plan: planes.get(ruta) })),
        { copiasDe: opts.copiasDe, entradaDe, hecho: trabajoHecho },
      );
      if (copiables.size > 0 && !clipIndex.isLoaded()) await clipIndex.load();
      for (const [ruta, { entrada, de }] of copiables) {
        catalogsByDir.get(path.dirname(ruta)).pending.set(path.basename(ruta), entradaCopiada(entrada, de));
        planes.delete(ruta);
        // La busqueda visual va por el id de ESTE archivo: su huella (y sus
        // momentos, si es video) entra en el indice como si se hubiera escaneado.
        if (entrada.clip_embedding_b64) clipIndex.upsert(fileIdFor(ruta), entrada.clip_embedding_b64);
        if (Array.isArray(entrada.clip_momentos) && entrada.clip_momentos.length > 0) clipIndex.setMomentos(fileIdFor(ruta), entrada.clip_momentos);
        reaprovechados++;
      }
      if (reaprovechados > 0) {
        for (let i = toScan.length - 1; i >= 0; i--) if (copiables.has(toScan[i])) toScan.splice(i, 1);
        console.log(`[scan] ${reaprovechados} archivo(s) copiados de su copia exacta ya escaneada, sin grafica`);
        await flushCatalogs();
        if (clipIndex.isDirty()) await clipIndex.save().catch(err => fallos.record('guardar el indice visual', err, {}));
      }
    } catch (err) {
      // Si falla, se escanea todo como siempre: se repite trabajo, no se pierde.
      fallos.record('reaprovechar el escaneo de las copias exactas', err, { path: folderPath });
    }
  }
  job.reaprovechados = reaprovechados;

  // Cache de `_contexto.md` por directorio (raíz + cada subcarpeta).
  // Se rellena perezosamente la primera vez que un archivo de ese dir se
  // escanea — así, si hay 200 fotos en una misma carpeta, sólo leemos el
  // archivo una vez.
  const contextCache = new Map();

  job.total = toScan.length;
  broadcastProgress({
    type: 'scan_progress',
    ...comunes,
    fase: 'describiendo',
    hechos: 0,
    yaHechos: allImages.length - toScan.length,
    total: job.total,
    done: 0,
    status: `Escaneando ${job.total} imágenes...`,
    percentage: 0,
  });

  if (job.total === 0) {
    job.status = 'done';
    broadcastProgress({
      type: 'scan_done',
      jobId,
      total: allImages.length,
      done: 0,
      errors: 0,
      status: reaprovechados > 0
        ? `${reaprovechados} copiados de su copia exacta ya escaneada, sin gráfica`
        : `Todas las imágenes ya estaban escaneadas (${allImages.length})`,
      already: allImages.length,
      reaprovechados,
    });
    // Lo copiado se ha escrito: quien llama refresca esas carpetas.
    return { jobId, total: allImages.length, done: 0, errors: 0, written: writtenDirs.size, carpetas: Array.from(writtenDirs), reaprovechados };
  }

  // 4) Escanear en serie
  // Reiniciar el reloj de la ventana movil aqui: listar/filtrar imagenes puede
  // tardar en arboles grandes y no debe contar como tiempo del primer archivo.
  job.lastTickAt = Date.now();
  // La carpeta es la unidad atómica de significado: al terminar una, su
  // catálogo baja a disco antes de empezar la siguiente.
  let lastDir = null;

  // Adelanto de la fase CPU del siguiente video (ffprobe + sacar los frames)
  // mientras la GPU describe el actual. Profundidad 1 a proposito: una sola
  // llamada al VLM en vuelo —la VRAM no da para dos— y como mucho dos juegos
  // de frames temporales vivos a la vez. Sin esto la GPU se pasaba la mitad
  // del tiempo esperando al disco: medido el 15/09/2026, 51% de ocupacion y
  // 9,1 s por archivo, con ~3 s de ffmpeg por delante de cada descripcion.
  let adelanto = null; // { filePath, promesa } | null

  // La promesa NUNCA rechaza: el fallo se guarda y se relanza cuando le llega
  // el turno a ESE archivo, para que el error quede contado donde toca y no
  // reviente el lote desde fuera del try.
  const pedirAdelanto = (ruta) => {
    if (!ruta || !isVideoExt(path.extname(ruta).toLowerCase())) return null;
    const planSiguiente = planes.get(ruta);
    if (planSiguiente && !planSiguiente.frames) return null;
    return {
      filePath: ruta,
      promesa: scanner.prepararVideo(ruta).then(
        (prep) => ({ prep }),
        (error) => ({ error }),
      ),
    };
  };

  /** Tira una preparacion que ya no va a usar nadie, con sus temporales. */
  const soltarAdelanto = async (pendiente) => {
    if (!pendiente) return;
    const r = await pendiente.promesa.catch(() => null);
    if (r && r.prep && typeof r.prep.cleanup === 'function') await r.prep.cleanup();
  };

  for (let idx = 0; idx < toScan.length; idx++) {
    const filePath = toScan[idx];
    if (job.cancelRequested) {
      job.status = 'cancelled';
      break;
    }
    const dir = path.dirname(filePath);
    const basename = path.basename(filePath);

    if (lastDir !== null && dir !== lastDir) {
      await flushCatalogs();
    }
    lastDir = dir;

    const ext = path.extname(basename).toLowerCase();
    const isVideo = isVideoExt(ext);

    // Recoger el adelanto si es de este archivo; si no (primer video del
    // lote, o venia una foto), prepararlo ahora.
    const hacer = planes.get(filePath) || { ...vivos, frames: isVideo };
    const previaJob = previas.get(filePath) || null;
    let preparadoPromesa = null;
    let preparadoTomado = false;
    if (isVideo && hacer.frames) {
      if (adelanto && adelanto.filePath === filePath) {
        preparadoPromesa = adelanto.promesa;
      } else {
        await soltarAdelanto(adelanto);
        preparadoPromesa = pedirAdelanto(filePath).promesa;
      }
    } else {
      await soltarAdelanto(adelanto);
    }
    // Y ya en marcha el siguiente, ANTES de bloquear en la GPU. Ese es todo
    // el truco: el disco trabaja para el archivo N+1 mientras la GPU esta
    // con el N.
    adelanto = pedirAdelanto(toScan[idx + 1]);

    try {
      let entry;
      let technical = {};
      let faceDetections = [];
      let videoFrameTime = null; // segundo del frame con mas caras (default del visor)
      let sceneBrightness = null; // brillo medio (0-1) de colorAnalyzer, para lighting

      // Componer el contexto de la carpeta (con herencia desde la raíz del
      // scan). Si no hay `_contexto.md` en ningún nivel, devolverá string
      // vacío y el VLM usará el prompt genérico.
      const folderContextStr = await folderContext.buildContextStringForFile(
        dir,
        folderPath,
        contextCache,
      );

      if (isVideo) {
        // Para vídeo: scanVideo extrae N frames UNA vez, los manda al VLM en una
        // sola llamada multi-imagen (descripcion temporal: movimiento de camara,
        // acciones, cambios de escena) y nos los DEVUELVE para reutilizarlos.
        // Asi evitamos extraer frames por separado para cada cosa.
        // Optical-flow de camara en CPU, EN PARALELO a la llamada VLM (GPU). Se
        // lanza antes del await de scanVideo para solapar ambos y no sumar tiempo
        // de pared. Se resuelve mas abajo, tras la GPU.
        const motionPromise = hacer.movimiento
          ? motionSvc.analyze(filePath).catch(() => null)
          : null;

        let videoResult = { entry: null, frames: [], cleanup: null, escalaFrames: 1, probe: null };
        if (hacer.frames) {
          // Normalmente ya esta resuelto: los frames se sacaron mientras la GPU
          // describia el archivo anterior.
          const preparado = await preparadoPromesa;
          if (preparado.error) throw preparado.error;
          preparadoTomado = true; // a partir de aqui limpia quien use los frames
          if (hacer.descripcion) {
            videoResult = await scanner.describirVideoPreparado(
              preparado.prep,
              { folderContext: folderContextStr },
            );
          } else {
            // Caras o busqueda visual sin descripcion: los mismos frames, sin VLM.
            const pr = preparado.prep;
            videoResult = { entry: null, frames: pr.frames, cleanup: pr.cleanup, escalaFrames: pr.escalaFrames, probe: pr.probe };
          }
        }
        entry = videoResult.entry || entradaSinDescripcion(previaJob, videoResult.probe);
        const videoFrames = Array.isArray(videoResult.frames) ? videoResult.frames : []; // [{ path, timestamp }]

        // camera_movement: el optical-flow (medicion real de dx/dy/escala) manda
        // sobre el VLM, que es ciego al zoom lento y a paneos sutiles. Si el
        // flujo no esta disponible o sale con baja confianza, se conserva lo del
        // VLM. scene_changes (cortes) tambien lo aporta el flujo, mas fiable.
        if (motionPromise) {
          const motion = await motionPromise;
          if (motion && !entry.composition) entry.composition = {};
          if (motion && entry.composition) {
            if (motion.confidence !== 'baja' && motion.movement) {
              entry.composition.camera_movement = motion.movement;
            }
            if (typeof motion.scene_changes === 'boolean') {
              entry.composition.scene_changes = motion.scene_changes;
            }
            // Metricas crudas para depurar/auditar (no las consume el frontend aun)
            entry.composition.motion_debug = {
              movements: motion.movements,
              zoom: motion.zoom,
              pan_x: motion.pan_x,
              pan_y: motion.pan_y,
              jitter: motion.jitter,
              cuts: motion.cuts,
              confidence: motion.confidence,
            };
          }
        }
        try {
          // 1) Deteccion facial en CADA frame (mejor cobertura que un solo frame:
          //    captura personas que solo aparecen en un tramo del clip). Cada
          //    deteccion se etiqueta con el timestamp de su frame (_frameTime)
          //    para que el visor dibuje el bbox solo cuando el video pasa por ahi.
          if (hacer.caras && videoFrames.length > 0) {
            // Los frames se extraen reducidos; el detector devuelve la bbox en ese
            // espacio. Se devuelve al del fotograma original, que es donde la
            // esperan el recorte de avatar y el overlay del visor.
            const escala = (typeof videoResult.escalaFrames === 'number' && videoResult.escalaFrames > 0)
              ? videoResult.escalaFrames
              : 1;
            let maxCount = -1;
            for (const fr of videoFrames) {
              const dets = await faceSvc.detectFaces(fr.path).catch(() => []);
              for (const d of dets) {
                if (escala !== 1 && Array.isArray(d.bbox)) {
                  d.bbox = d.bbox.map(v => Math.round(v * escala));
                }
                d._frameTime = fr.timestamp;
                faceDetections.push(d);
              }
              // detection_frame_time = frame con MAS caras (default del boton
              // "saltar a las caras"). face_count = max en un solo frame (no la
              // suma: la misma persona en 3 frames no son 3 personas).
              if (dets.length > maxCount) { maxCount = dets.length; videoFrameTime = fr.timestamp; }
            }
          }

          // 2) Color + CLIP sobre el frame CENTRAL (uno representa bien el clip;
          //    no hace falta repetir el analisis cromatico en todos).
          const midFrame = videoFrames[Math.floor(videoFrames.length / 2)];
          if (midFrame) {
            try {
              const colorResult = await colorAnalyzer.analyzeImageColors(midFrame.path);
              if (colorResult && Array.isArray(colorResult.palette) && colorResult.palette.length > 0) {
                entry.colors = entry.colors || {};
                entry.colors.palette = enrichPalette(colorResult.palette.slice(0, 3));
                if (typeof colorResult.brightness === 'number') sceneBrightness = colorResult.brightness;
              }
            } catch (cErr) {
              console.warn(`[scan-video] color analysis ${basename}: ${cErr.message}`);
            }
            if (hacer.busquedaVisual) {
              try {
                const clipEmb = await clipSvc.embedImage(midFrame.path);
                if (clipEmb) {
                  entry.clip_embedding_b64 = clipSvc.encodeEmbedding(clipEmb);
                  clipIndex.upsert(fileIdFor(filePath), clipEmb);
                  // Momentos: la huella de los OTROS fotogramas que ya se han
                  // sacado para describir el clip. Casi gratis (la GPU tarda
                  // milisegundos) y con ellos una imagen de otro instante del
                  // video lo encuentra (ver services/momentosVideo.js).
                  const momentos = [];
                  for (const fr of videoFrames) {
                    if (fr === midFrame) continue;
                    const emb = await clipSvc.embedImage(fr.path).catch(() => null);
                    if (emb) momentos.push({ t: Math.round(fr.timestamp * 100) / 100, e: clipIndex.comprimirHuella(emb) });
                  }
                  if (momentos.length > 0) {
                    entry.clip_momentos = momentos;
                    clipIndex.setMomentos(fileIdFor(filePath), momentos);
                  }
                  // Place recognition: matchear contra centroides de espacios
                  const match = spacesRegistry.identifySpace(clipEmb);
                  entry.identity = entry.identity || {};
                  entry.identity.spaces = [];
                  if (match) {
                    entry.identity.spaces.push({
                      space_id: match.space_id,
                      display_name: spacesRegistry.getDisplayName(match.space_id),
                      confidence: match.similarity,
                    });
                  }
                }
              } catch (eErr) {
                console.warn(`[scan-video] CLIP embedding ${basename}: ${eErr.message}`);
              }
            }
          }
        } catch (err) {
          console.warn(`[scan-video] proceso frames ${basename}: ${err.message}`);
        } finally {
          // Borrar los frames temporales extraidos por scanVideo.
          if (typeof videoResult.cleanup === 'function') {
            await videoResult.cleanup();
          }
        }

        // Pre-calentar el proxy de reproduccion (fire-and-forget, cola con
        // concurrencia limitada): si el formato no es web-nativo (.m2ts, .mov
        // 10-bit, etc.), al abrirlo en el front ya estara listo para reproducir.
        if (caps.proxies) {
          videoProxyService.prewarm({ id: fileIdFor(filePath), fullPath: filePath, name: basename });
        }
      } else {
        [entry, technical, faceDetections] = await Promise.all([
          hacer.descripcion
            ? scanner.scanImage(filePath, { folderContext: folderContextStr })
            : Promise.resolve(entradaSinDescripcion(previaJob, null)),
          extractTechnical(filePath),
          hacer.caras ? faceSvc.detectFaces(filePath).catch(() => []) : Promise.resolve([]),
        ]);
        // Mezclar technical de sharp con lo que diga el VLM (sharp manda)
        entry.technical = { ...(entry.technical || {}), ...technical };
        // En FOTOS el camera_movement no aplica (el prompt lo pide solo para
        // video pero modelos pequenos a veces lo rellenan igualmente).
        if (entry.composition) entry.composition.camera_movement = null;
        // Palette algoritmica sobre la foto original (mas precisa perceptualmente
        // que la heuristica del VLM, que a veces decia "rojo" para hex marrones).
        try {
          const colorResult = await colorAnalyzer.analyzeImageColors(filePath);
          if (colorResult && Array.isArray(colorResult.palette) && colorResult.palette.length > 0) {
            entry.colors = entry.colors || {};
            entry.colors.palette = enrichPalette(colorResult.palette.slice(0, 3));
            if (typeof colorResult.brightness === 'number') sceneBrightness = colorResult.brightness;
          }
        } catch (cErr) {
          console.warn(`[scan-photo] color analysis ${basename}: ${cErr.message}`);
        }
        // CLIP embedding (place recognition + image search + text-to-image futuro)
        if (hacer.busquedaVisual) {
          try {
            const clipEmb = await clipSvc.embedImage(filePath);
            if (clipEmb) {
              entry.clip_embedding_b64 = clipSvc.encodeEmbedding(clipEmb);
              clipIndex.upsert(fileIdFor(filePath), clipEmb);
              // Place recognition: matchear contra centroides de espacios
              const match = spacesRegistry.identifySpace(clipEmb);
              entry.identity = entry.identity || {};
              entry.identity.spaces = [];
              if (match) {
                entry.identity.spaces.push({
                  space_id: match.space_id,
                  display_name: spacesRegistry.getDisplayName(match.space_id),
                  confidence: match.similarity,
                });
              }
            }
          } catch (eErr) {
            console.warn(`[scan-photo] CLIP embedding ${basename}: ${eErr.message}`);
          }
        }
      }

      // Identidad: si tenemos detección de caras, sobrescribir lo que dijo
      // el VLM con datos reales de InsightFace.
      if (hacer.caras) {
        const identified = faceSvc.identifyFaces(faceDetections);
        const named = identified
          .filter(f => f.person_id)
          .map(f => {
            const displayName = peopleRegistry.getDisplayName(f.person_id);
            return {
              person_id: f.person_id,
              display_name: displayName,
              confidence: f.similarity,
            };
          });
        // De-duplicar por person_id quedándonos con la mejor confianza
        const byId = new Map();
        for (const f of named) {
          const prev = byId.get(f.person_id);
          if (!prev || f.confidence > prev.confidence) byId.set(f.person_id, f);
        }
        entry.identity = entry.identity || {};
        entry.identity.faces = Array.from(byId.values());

        // Persistir TODAS las detecciones (con embeddings base64) para que la
        // re-identificación retroactiva pueda recalcular matches al añadir
        // personas nuevas sin re-detectar las caras desde la imagen.
        // Incluimos person_id/display_name por detección — uno-a-uno con la
        // cara fisica — para que el visor pueda dibujar el nombre sobre el bbox.
        entry.identity.detections = faceDetections
          .map((f, idx) => {
            const b64 = encodeEmbedding(f.embedding);
            if (!b64) return null;
            const match = identified[idx];
            const out = {
              bbox: f.bbox,
              embedding_b64: b64,
              det_score: f.det_score,
              age: f.age ?? null,
              gender: f.gender ?? null,
            };
            // frame_time: segundo del clip donde se detecto esta cara (solo
            // video multi-frame). El visor lo usa para mostrar el bbox solo
            // cuando el reproductor pasa por ese momento.
            if (typeof f._frameTime === 'number') out.frame_time = f._frameTime;
            if (match && match.person_id) {
              out.person_id = match.person_id;
              out.display_name = peopleRegistry.getDisplayName(match.person_id);
              out.confidence = match.similarity;
            }
            return out;
          })
          .filter(Boolean);

        // face_count canonico: se deriva de las detecciones ya persistidas
        // (con frame_time), igual que en re-id/promote/assign. Para video es el
        // maximo de caras en un mismo frame; para foto, el numero de caras. Asi
        // el significado del campo no depende de quien lo escriba el ultimo.
        entry.identity.face_count = computeFaceCount(entry.identity.detections);

        // En videos: persistir el segundo donde se hizo la detección. El visor
        // usa esto para mostrar los bboxes solo cuando el reproductor pasa cerca
        // de ese momento (los bboxes no son validos en otros frames).
        if (isVideo && typeof videoFrameTime === 'number') {
          entry.identity.detection_frame_time = videoFrameTime;
        }

        // Inferir demographics globales: tomar moda de gender/age de TODAS
        // las caras detectadas (no sólo las identificadas) para enriquecer
        // la búsqueda ("personas mayores", "grupo de mujeres").
        const ageRanges = new Set();
        const genders = new Set();
        for (const f of faceDetections) {
          const a = ageBucket(f.age);
          if (a) ageRanges.add(a);
          if (f.gender != null && GENDER_MAP[f.gender]) genders.add(GENDER_MAP[f.gender]);
        }
        // entry.demographics ya no lo aporta el VLM (schema v2). Lo construimos
        // aqui exclusivamente a partir de las detecciones de InsightFace.
        if (ageRanges.size > 0 || genders.size > 0) {
          entry.demographics = entry.demographics || {};
          if (ageRanges.size > 0) entry.demographics.age_ranges = Array.from(ageRanges);
          if (genders.size > 0) entry.demographics.genders = Array.from(genders);
        }
      }

      // shot_type final (coste cero, reusa datos ya calculados): si hay caras
      // detectadas, la ratio alto_cara/alto_frame manda — arregla la ceguera
      // del VLM al TAMAÑO de la persona (llama "plano_medio" a todo). Si no hay
      // caras, se conserva el shot_type del VLM (bueno en escena: general/
      // conjunto). plano_detalle siempre lo decide el VLM (es semantico).
      // Solo si hay algo nuevo con que afinar: sin caras ni descripcion nuevas,
      // recalcular pisaria un plano medido por caras con el del VLM.
      if (entry.composition && (hacer.caras || hacer.descripcion)) {
        const st = computeShotType({
          detections: faceDetections,
          vlmShotType: entry.composition.shot_type,
        });
        entry.composition.shot_type = st.shot_type;
        entry.composition.shot_type_source = st.source;
        entry.composition.shot_type_confidence = st.confidence;
        if (st.ratio != null) entry.composition.shot_type_face_ratio = st.ratio;

        // people_framing (coste cero): el conteo real de InsightFace afina el
        // bucket del VLM. Se combinan por maximo (ambos subcuentan, ninguno
        // sobrecuenta): asi una "multitud de espaldas" que InsightFace no ve
        // pero el VLM si, no se reporta como menos gente de la que hay.
        const pf = computePeopleFraming({
          faceCount: entry.identity ? entry.identity.face_count : null,
          vlmFraming: entry.composition.people_framing,
        });
        entry.composition.people_framing = pf.people_framing;
        entry.composition.people_framing_source = pf.source;
      }

      // time_of_day (coste ~cero): la hora REAL de captura (metadata) manda
      // sobre la luz que adivina el VLM (un interior de noche parece de dia).
      // video = creation_time (UTC+offset), foto = EXIF (hora local de pared).
      // Sin timestamp valido, se conserva el VLM.
      {
        entry.atmosphere = entry.atmosphere || {};
        const captureISO = isVideo
          ? (entry.technical && entry.technical.creation_time)
          : (entry.technical && entry.technical.capture_time);
        const tod = computeTimeOfDay({
          captureTimeISO: captureISO || null,
          isVideo,
          vlmTimeOfDay: entry.atmosphere.time_of_day,
        });
        entry.atmosphere.time_of_day = tod.time_of_day;
        entry.atmosphere.time_of_day_source = tod.source;

        // lighting (coste cero, conservador): unico override seguro es
        // oscuro + capturado de noche -> nocturna. El resto lo deja al VLM.
        const lt = computeLighting({
          brightness: sceneBrightness,
          timeOfDay: entry.atmosphere.time_of_day,
          vlmLighting: entry.atmosphere.lighting,
        });
        entry.atmosphere.lighting = lt.lighting;
        if (lt.source !== 'vlm') entry.atmosphere.lighting_source = lt.source;
      }

      // Encolar, no escribir. La fusion de identidad y el volcado ocurren en
      // flushCatalogs, DENTRO del lock del fichero y contra lo que haya en
      // disco en ese momento — asi el escaneo no pisa lo que hayan escrito
      // entretanto el re-id, assign-face o un promote sobre esta carpeta.
      catalogsByDir.get(dir).pending.set(basename, entry);
      job.done++;

      broadcastProgress({
        type: 'scan_progress',
        ...comunes,
        fase: 'describiendo',
        hechos: job.done + job.errors,
        errores: job.errors,
        archivo: basename,
        total: job.total,
        done: job.done,
        errors: job.errors,
        file: basename,
        percentage: Math.round((job.done / job.total) * 100),
        ...timingFields(),
      });

      if (job.done % FLUSH_EVERY === 0) {
        await flushCatalogs();
        // Deja constancia de que el escaneo avanza. Si el proceso muere, esto
        // es lo que permite distinguir al arrancar entre "iba bien, reanuda" y
        // "se atasca siempre aqui, no insistas".
        await scanState.anotarAvance(job.done);
        // Huella de memoria en el log: si el RSS sube sin techo a lo largo de
        // una tanda larga, aqui se ve. Es la instrumentacion que faltaba para
        // diagnosticar una caida silenciosa a mitad de escaneo.
        const mem = process.memoryUsage();
        console.log(`[scan] ${job.done}/${job.total} — rss ${Math.round(mem.rss / 1048576)} MB, heap ${Math.round(mem.heapUsed / 1048576)}/${Math.round(mem.heapTotal / 1048576)} MB`);
      }
    } catch (err) {
      console.warn(`[scan] ${basename}: ${err.message}`);
      // Al registro de fallos (agregado por causa): que salga en /api/health y
      // no solo en una linea de consola que nadie lee.
      fallos.record('escanear un archivo', err, { path: filePath, silencioso: true });
      job.errors++;
      broadcastProgress({
        type: 'scan_error',
        ...comunes,
        fase: 'describiendo',
        hechos: job.done + job.errors,
        errores: job.errors,
        archivo: basename,
        total: job.total,
        file: basename,
        error: err.message,
        done: job.done,
        errors: job.errors,
        ...timingFields(),
      });
    } finally {
      // Si el archivo se fue por un error antes de llegar a usar su
      // preparacion, sus frames temporales siguen en disco.
      if (preparadoPromesa && !preparadoTomado) {
        const r = await preparadoPromesa.catch(() => null);
        if (r && r.prep && typeof r.prep.cleanup === 'function') await r.prep.cleanup();
      }
    }
  }

  // Un adelanto sin dueño (cancelacion, o el lote se acabo) dejaria sus
  // frames en el temporal del sistema.
  await soltarAdelanto(adelanto);
  adelanto = null;

  // 5) Volcado final: lo que quede sucio desde el ultimo flush del bucle.
  //    El grueso ya se escribio incrementalmente mientras se escaneaba.
  broadcastProgress({
    type: 'scan_progress', ...comunes, fase: 'guardando',
    hechos: job.done + job.errors, total: job.total, errores: job.errors, percentage: 100,
  });
  await flushCatalogs();
  const written = writtenDirs.size;
  if (clipEnabled) {
    console.log(`[scan] CLIP index guardado (${clipIndex.size()} embeddings)`);
  }

  // 7) Cierre
  // Fallos ocurridos DURANTE este job, con su causa ya traducida.
  const incidencias = fallos.summary({ since: job.marcaFallos });
  // Un escaneo que no ha podido guardar NO esta "completado": ha tirado el
  // trabajo. Se dice con esas palabras y con el motivo, porque el 09/09/2026
  // se perdieron 9.378 volcados por un disco lleno y el resumen decia
  // "Escaneo completado".
  const noGuardado = job.escriturasFallidas > 0;
  job.status = job.cancelRequested ? 'cancelled' : (noGuardado ? 'done_con_fallos' : 'done');
  job.finishedAt = Date.now();

  let estadoTexto;
  if (job.status === 'cancelled') {
    estadoTexto = 'Escaneo cancelado';
  } else if (noGuardado) {
    const causa = incidencias.principal;
    estadoTexto = `Escaneo TERMINADO SIN GUARDAR: ${job.escriturasFallidas} volcado(s) fallaron`
      + (causa ? `. ${causa.reason}` : '');
  } else if (degraded.length > 0) {
    estadoTexto = `Escaneo completado SIN ${degraded.join(', ')}`;
  } else {
    estadoTexto = 'Escaneo completado';
  }
  if (noGuardado) {
    console.error(`[scan] ${estadoTexto}`);
    if (incidencias.principal && incidencias.principal.hint) {
      console.error(`[scan] ${incidencias.principal.hint}`);
    }
  }

  broadcastProgress({
    type: 'scan_done',
    ...comunes,
    duracionMs: Date.now() - inicioEscaneo,
    estado: job.status,
    hechos: job.done + job.errors,
    errores: job.errors,
    total: job.total,
    done: job.done,
    errors: job.errors,
    written,
    // Se repiten en el cierre para que el resumen no cante "completado" a secas
    // cuando en realidad ha ido sin caras o sin embeddings.
    capabilities,
    degraded,
    // Lo que no se ha podido guardar y POR QUE. La UI ya no depende de que
    // alguien lea el log.
    escriturasFallidas: job.escriturasFallidas,
    incidencias: incidencias.items,
    causaPrincipal: incidencias.principal
      ? { reason: incidencias.principal.reason, hint: incidencias.principal.hint, code: incidencias.principal.code }
      : null,
    status: estadoTexto,
    // Copiados de su copia exacta ya escaneada (sin grafica): no cuentan en total.
    reaprovechados: job.reaprovechados || 0,
    percentage: 100,
    elapsedMs: job.finishedAt - job.startedAt,
    // Media real del job completo (no la ventana movil): tiempo total / archivos
    // procesados. Para el resumen final interesa la media global, no la reciente.
    avgMsPerFile: job.done > 0 ? Math.round((job.finishedAt - job.startedAt) / job.done) : 0,
  });

  // El valor de retorno tambien lleva los fallos: quien llama por HTTP (no por
  // WebSocket) tiene que poder decir "no pude" igual que la UI.
  return {
    jobId,
    total: job.total,
    done: job.done,
    errors: job.errors,
    written,
    // Carpetas cuyo catalogo se ha escrito: quien llama puede refrescar solo
    // esas en vez de resincronizar todos los discos.
    carpetas: Array.from(writtenDirs),
    reaprovechados: job.reaprovechados || 0,
    escriturasFallidas: job.escriturasFallidas,
    causa: incidencias.principal
      ? { reason: incidencias.principal.reason, hint: incidencias.principal.hint, code: incidencias.principal.code }
      : null,
  };
}

function getJobStatus(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return null;
  return {
    jobId: job.jobId,
    folderPath: job.folderPath,
    status: job.status,
    total: job.total,
    done: job.done,
    errors: job.errors,
    reaprovechados: job.reaprovechados || 0,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
  };
}

function listJobs() {
  return Array.from(activeJobs.values()).map(j => ({
    jobId: j.jobId,
    folderPath: j.folderPath,
    status: j.status,
    total: j.total,
    done: j.done,
    errors: j.errors,
    reaprovechados: j.reaprovechados || 0,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt || null,
  }));
}

function cancelJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return false;
  if (job.status !== 'running') return false;
  job.cancelRequested = true;
  return true;
}

module.exports = {
  scanFolder,
  scanSingleFile,
  getJobStatus,
  listJobs,
  cancelJob,
  reservarJob,
  listFoldersWithMedia,
  esEscaneable,
  archivoPendiente,
};
