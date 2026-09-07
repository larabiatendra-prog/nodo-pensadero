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
const { getInstance: getFaceService, encodeEmbedding } = require('./faceService');
const { getInstance: getClipService } = require('./clipService');
const { getInstance: getCameraMotionService } = require('./cameraMotionService');
const videoProxyService = require('./videoProxyService');
const clipIndex = require('../clipIndex');
const colorAnalyzer = require('../colorAnalyzer');
const { enrichPalette } = require('../colorNamer');
const peopleRegistry = require('../peopleRegistry');
const spacesRegistry = require('../spacesRegistry');
const catalogReader = require('../catalogReader');
const folderContext = require('./folderContext');
const { atomicWriteFile, withFileLock, normalizeLockKey } = require('../utils/jsonStore');
const { computeFaceCount } = require('../utils/faceCatalog');
const { computeShotType } = require('../utils/shotType');
const { computePeopleFraming } = require('../utils/peopleFraming');
const { computeTimeOfDay } = require('../utils/timeOfDay');
const { computeLighting } = require('../utils/lighting');
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

// Jobs en curso: jobId → { status, total, done, errors, cancelRequested }
const activeJobs = new Map();

function makeJobId() {
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
 * @returns {Promise<{jobId, total, done, errors, written}>}
 */
async function scanFolder(folderPath, opts = {}) {
  const {
    force = false,
    broadcastProgress = () => {},
    jobId = makeJobId(),
    // singleFile: ruta absoluta. Si se pasa, escanea SOLO ese archivo (no
    // recorre el arbol). Lo usa scanSingleFile para el escaneo desde la tarjeta.
    singleFile = null,
  } = opts;

  const scanner = getScanner();
  const faceSvc = getFaceService();
  const clipSvc = getClipService();
  const motionSvc = getCameraMotionService();

  // Cargar embeddings del registry en el cache del faceService antes del
  // batch. Si falla (sin Python/InsightFace), seguimos sin reconocimiento.
  let facesEnabled = false;
  try {
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
  try {
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
  try {
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

  // Estado inicial del job
  const job = {
    jobId,
    folderPath,
    status: 'running',
    total: 0,
    done: 0,
    errors: 0,
    cancelRequested: false,
    startedAt: Date.now(),
    // Ventana movil de duraciones por archivo para estimar tiempo restante.
    // Movil (no acumulada) porque fotos y videos tardan muy distinto y el
    // cold-start del VLM en el primer archivo dispararia una media acumulada.
    recentMs: [],
    lastTickAt: Date.now(),
  };
  activeJobs.set(jobId, job);

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
  const degraded = Object.entries(capabilities).filter(([, ok]) => !ok).map(([k]) => k);
  if (degraded.length > 0) {
    console.warn(`[scan] DEGRADADO — sin: ${degraded.join(', ')}. El catalogo saldra incompleto en esos campos.`);
  }

  // Avisar inicio
  broadcastProgress({
    type: 'scan_start',
    jobId,
    folder: folderPath,
    status: 'Buscando imágenes...',
    percentage: 0,
    capabilities,
    degraded,
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
    return { jobId, total: 0, done: 0, errors: 0, written: 0 };
  }

  // 2) Cargar catálogos existentes por carpeta (cache local del job)
  const catalogsByDir = new Map(); // dir → { catalog, source, dirty }
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
        dirty: false,
      });
    }
  }

  // Volcado de los catálogos sucios. Se llama DURANTE el bucle (cada
  // FLUSH_EVERY archivos y al cambiar de carpeta), no solo al terminar: lo ya
  // descrito tiene que estar en disco aunque el proceso muera a mitad.
  const writtenDirs = new Set();
  async function flushCatalogs() {
    for (const [dir, c] of catalogsByDir.entries()) {
      if (!c.dirty) continue;
      const targetFile = path.join(dir, PENSADERO_CATALOG_FILENAME);
      // Lock por path: serializa esta escritura con un re-id/promote de fondo
      // sobre la misma carpeta, para que no se intercalen dos escrituras del
      // mismo _pensadero.json.
      await withFileLock(normalizeLockKey(targetFile), async () => {
        try {
          // Escritura atomica (tmp + rename): el _pensadero.json es la fuente de
          // verdad y guarda embeddings NO regenerables. Un crash a media
          // escritura no lo trunca.
          await atomicWriteFile(targetFile, JSON.stringify(c.catalog, null, 2));
          catalogReader.invalidateCatalog(dir);
          c.dirty = false;
          writtenDirs.add(dir);
        } catch (err) {
          console.warn(`[scan] error escribiendo ${targetFile}: ${err.message}`);
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
  const toScan = [];
  for (const img of allImages) {
    const dir = path.dirname(img);
    const basename = path.basename(img);
    const c = catalogsByDir.get(dir);
    // Soportar tanto `photos` (default nuevo) como `clips` (legacy)
    const existingEntries = (c.catalog && (c.catalog.photos || c.catalog.clips)) || {};
    if (!force && existingEntries[basename]) {
      continue;
    }
    toScan.push(img);
  }

  // Cache de `_contexto.md` por directorio (raíz + cada subcarpeta).
  // Se rellena perezosamente la primera vez que un archivo de ese dir se
  // escanea — así, si hay 200 fotos en una misma carpeta, sólo leemos el
  // archivo una vez.
  const contextCache = new Map();

  job.total = toScan.length;
  broadcastProgress({
    type: 'scan_progress',
    jobId,
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
      status: `Todas las imágenes ya estaban escaneadas (${allImages.length})`,
      already: allImages.length,
    });
    return { jobId, total: allImages.length, done: 0, errors: 0, written: 0 };
  }

  // 4) Escanear en serie
  // Reiniciar el reloj de la ventana movil aqui: listar/filtrar imagenes puede
  // tardar en arboles grandes y no debe contar como tiempo del primer archivo.
  job.lastTickAt = Date.now();
  // La carpeta es la unidad atómica de significado: al terminar una, su
  // catálogo baja a disco antes de empezar la siguiente.
  let lastDir = null;
  for (const filePath of toScan) {
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
        const motionPromise = motionEnabled
          ? motionSvc.analyze(filePath).catch(() => null)
          : null;

        const videoResult = await scanner.scanVideo(filePath, { folderContext: folderContextStr });
        entry = videoResult.entry;
        const videoFrames = Array.isArray(videoResult.frames) ? videoResult.frames : []; // [{ path, timestamp }]

        // camera_movement: el optical-flow (medicion real de dx/dy/escala) manda
        // sobre el VLM, que es ciego al zoom lento y a paneos sutiles. Si el
        // flujo no esta disponible o sale con baja confianza, se conserva lo del
        // VLM. scene_changes (cortes) tambien lo aporta el flujo, mas fiable.
        if (motionPromise) {
          const motion = await motionPromise;
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
          if (facesEnabled && videoFrames.length > 0) {
            let maxCount = -1;
            for (const fr of videoFrames) {
              const dets = await faceSvc.detectFaces(fr.path).catch(() => []);
              for (const d of dets) {
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
            if (clipEnabled) {
              try {
                const clipEmb = await clipSvc.embedImage(midFrame.path);
                if (clipEmb) {
                  entry.clip_embedding_b64 = clipSvc.encodeEmbedding(clipEmb);
                  clipIndex.upsert(fileIdFor(filePath), clipEmb);
                  // Place recognition: matchear contra centroides de espacios
                  const match = spacesRegistry.identifySpace(clipEmb);
                  if (match) {
                    entry.identity = entry.identity || {};
                    entry.identity.spaces = entry.identity.spaces || [];
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
        videoProxyService.prewarm({ id: fileIdFor(filePath), fullPath: filePath, name: basename });
      } else {
        [entry, technical, faceDetections] = await Promise.all([
          scanner.scanImage(filePath, { folderContext: folderContextStr }),
          extractTechnical(filePath),
          facesEnabled ? faceSvc.detectFaces(filePath).catch(() => []) : Promise.resolve([]),
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
        if (clipEnabled) {
          try {
            const clipEmb = await clipSvc.embedImage(filePath);
            if (clipEmb) {
              entry.clip_embedding_b64 = clipSvc.encodeEmbedding(clipEmb);
              clipIndex.upsert(fileIdFor(filePath), clipEmb);
              // Place recognition: matchear contra centroides de espacios
              const match = spacesRegistry.identifySpace(clipEmb);
              if (match) {
                entry.identity = entry.identity || {};
                entry.identity.spaces = entry.identity.spaces || [];
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
      if (facesEnabled) {
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
      if (entry.composition) {
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

      const c = catalogsByDir.get(dir);
      // Usar siempre `photos` como clave canónica para nuevas entradas
      if (!c.catalog.photos) c.catalog.photos = {};
      // Si había `clips`, mantenerlo (no romper legacy), pero las nuevas
      // van a `photos`.
      c.catalog.photos[basename] = entry;
      c.catalog.processed = new Date().toISOString();
      c.dirty = true;
      job.done++;

      broadcastProgress({
        type: 'scan_progress',
        jobId,
        total: job.total,
        done: job.done,
        errors: job.errors,
        file: basename,
        percentage: Math.round((job.done / job.total) * 100),
        ...timingFields(),
      });

      if (job.done % FLUSH_EVERY === 0) {
        await flushCatalogs();
        // Huella de memoria en el log: si el RSS sube sin techo a lo largo de
        // una tanda larga, aqui se ve. Es la instrumentacion que faltaba para
        // diagnosticar una caida silenciosa a mitad de escaneo.
        const mem = process.memoryUsage();
        console.log(`[scan] ${job.done}/${job.total} — rss ${Math.round(mem.rss / 1048576)} MB, heap ${Math.round(mem.heapUsed / 1048576)}/${Math.round(mem.heapTotal / 1048576)} MB`);
      }
    } catch (err) {
      console.warn(`[scan] ${basename}: ${err.message}`);
      job.errors++;
      broadcastProgress({
        type: 'scan_error',
        jobId,
        file: basename,
        error: err.message,
        done: job.done,
        errors: job.errors,
        ...timingFields(),
      });
    }
  }

  // 5) Volcado final: lo que quede sucio desde el ultimo flush del bucle.
  //    El grueso ya se escribio incrementalmente mientras se escaneaba.
  await flushCatalogs();
  const written = writtenDirs.size;
  if (clipEnabled) {
    console.log(`[scan] CLIP index guardado (${clipIndex.size()} embeddings)`);
  }

  // 7) Cierre
  job.status = job.cancelRequested ? 'cancelled' : 'done';
  job.finishedAt = Date.now();
  broadcastProgress({
    type: 'scan_done',
    jobId,
    total: job.total,
    done: job.done,
    errors: job.errors,
    written,
    // Se repiten en el cierre para que el resumen no cante "completado" a secas
    // cuando en realidad ha ido sin caras o sin embeddings.
    capabilities,
    degraded,
    status: job.status === 'cancelled'
      ? 'Escaneo cancelado'
      : (degraded.length > 0 ? `Escaneo completado SIN ${degraded.join(', ')}` : 'Escaneo completado'),
    percentage: 100,
    elapsedMs: job.finishedAt - job.startedAt,
    // Media real del job completo (no la ventana movil): tiempo total / archivos
    // procesados. Para el resumen final interesa la media global, no la reciente.
    avgMsPerFile: job.done > 0 ? Math.round((job.finishedAt - job.startedAt) / job.done) : 0,
  });

  // Conservar el job ~5 min para queries de status, luego liberar
  setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);

  return { jobId, total: job.total, done: job.done, errors: job.errors, written };
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
  listFoldersWithMedia,
};
