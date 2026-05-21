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
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sharp = require('sharp');

// Replica server.js generateFileId — md5 del filePath. Se usa para indexar
// el clipIndex por fileId (mismo identificador que ve el frontend).
function fileIdFor(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}
const { getInstance: getScanner } = require('../visualScanService');
const { getInstance: getFaceService, encodeEmbedding } = require('./faceService');
const { getInstance: getClipService } = require('./clipService');
const clipIndex = require('../clipIndex');
const colorAnalyzer = require('../colorAnalyzer');
const { enrichPalette } = require('../colorNamer');
const peopleRegistry = require('../peopleRegistry');
const spacesRegistry = require('../spacesRegistry');
const catalogReader = require('../catalogReader');
const folderContext = require('./folderContext');

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
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg']);
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
 * Extrae un frame representativo de un vídeo (~30% del total) y lo escribe
 * a un archivo temporal JPG. Devuelve la ruta del archivo o null si falla.
 * Se usa para pasar el frame a InsightFace y detectar caras.
 */
async function extractRepresentativeFrame(videoPath, durationSec) {
  const seek = (typeof durationSec === 'number' && durationSec > 1) ? durationSec * 0.3 : 0;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pensadero-frame-'));
  const outPath = path.join(tmpDir, 'rep.jpg');
  const args = [
    '-y',
    '-ss', String(seek),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '3',
    outPath,
  ];

  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      resolve(null);
    }, 30_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      // Devolvemos un objeto con la ruta y el seek timestamp en segundos
      // (lo necesita el visor para mostrar los bboxes solo cuando el video
      // este reproduciendo cerca del momento donde se hizo la deteccion).
      if (code === 0) resolve({ outPath, seekSec: seek });
      else resolve(null);
    });
    p.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
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
    return {
      resolution: `${meta.width}x${meta.height}`,
      aspect_ratio: aspect,
    };
  } catch {
    return {};
  }
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
 * @returns {Promise<{jobId, total, done, errors, written}>}
 */
async function scanFolder(folderPath, opts = {}) {
  const {
    force = false,
    broadcastProgress = () => {},
    jobId = makeJobId(),
  } = opts;

  const scanner = getScanner();
  const faceSvc = getFaceService();
  const clipSvc = getClipService();

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
  };
  activeJobs.set(jobId, job);

  // Avisar inicio
  broadcastProgress({
    type: 'scan_start',
    jobId,
    folder: folderPath,
    status: 'Buscando imágenes...',
    percentage: 0,
  });

  // 1) Listar imágenes
  const allImages = await collectImages(folderPath);
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
  for (const filePath of toScan) {
    if (job.cancelRequested) {
      job.status = 'cancelled';
      break;
    }
    const dir = path.dirname(filePath);
    const basename = path.basename(filePath);

    const ext = path.extname(basename).toLowerCase();
    const isVideo = isVideoExt(ext);

    try {
      let entry;
      let technical = {};
      let faceDetections = [];
      let videoFrameTime = null; // segundo del video donde se detectaron caras (solo videos)

      // Componer el contexto de la carpeta (con herencia desde la raíz del
      // scan). Si no hay `_contexto.md` en ningún nivel, devolverá string
      // vacío y el VLM usará el prompt genérico.
      const folderContextStr = await folderContext.buildContextStringForFile(
        dir,
        folderPath,
        contextCache,
      );

      if (isVideo) {
        // Para vídeo: scanVideo orquesta ffprobe + extracción de frames + VLM.
        // La detección de caras no es por archivo sino por uno de los frames
        // intermedios (compromiso: una pasada de InsightFace en ese frame).
        entry = await scanner.scanVideo(filePath, { folderContext: folderContextStr });
        // technical lo rellena scanVideo desde ffprobe; no llamamos a sharp
        // que daría error en vídeos.
        // Extraemos UN frame representativo y lo usamos para DOS cosas:
        // 1) Deteccion facial via InsightFace
        // 2) Analisis cromatico via colorAnalyzer (perceptual prominence)
        let repFramePath = null;
        try {
          const repFrame = await extractRepresentativeFrame(filePath, entry.technical?.duration);
          if (repFrame && repFrame.outPath) {
            repFramePath = repFrame.outPath;
            videoFrameTime = repFrame.seekSec;
            if (facesEnabled) {
              faceDetections = await faceSvc.detectFaces(repFramePath).catch(() => []);
            }
            // Color analysis sobre el mismo frame (sustituye al palette del VLM)
            try {
              const colorResult = await colorAnalyzer.analyzeImageColors(repFramePath);
              if (colorResult && Array.isArray(colorResult.palette) && colorResult.palette.length > 0) {
                entry.colors = entry.colors || {};
                entry.colors.palette = enrichPalette(colorResult.palette.slice(0, 3));
              }
            } catch (cErr) {
              console.warn(`[scan-video] color analysis ${basename}: ${cErr.message}`);
            }
            // CLIP embedding sobre el mismo frame (place recognition + image search)
            if (clipEnabled) {
              try {
                const clipEmb = await clipSvc.embedImage(repFramePath);
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
          console.warn(`[scan-video] extract frame ${basename}: ${err.message}`);
        } finally {
          if (repFramePath) {
            try { await fs.unlink(repFramePath); } catch {}
          }
        }
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
        entry.identity.face_count = faceDetections.length;

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
            if (match && match.person_id) {
              out.person_id = match.person_id;
              out.display_name = peopleRegistry.getDisplayName(match.person_id);
              out.confidence = match.similarity;
            }
            return out;
          })
          .filter(Boolean);

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
      });
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
      });
    }
  }

  // 5) Escribir catálogos modificados a disco
  let written = 0;
  for (const [dir, c] of catalogsByDir.entries()) {
    if (!c.dirty) continue;
    const targetFile = path.join(dir, PENSADERO_CATALOG_FILENAME);
    try {
      await fs.writeFile(targetFile, JSON.stringify(c.catalog, null, 2), 'utf-8');
      catalogReader.invalidateCatalog(dir);
      written++;
    } catch (err) {
      console.warn(`[scan] error escribiendo ${targetFile}: ${err.message}`);
    }
  }

  // 6) Persistir clipIndex si hubo cambios (CLIP embeddings nuevos)
  if (clipEnabled && clipIndex.isDirty()) {
    try {
      await clipIndex.save();
      console.log(`[scan] CLIP index guardado (${clipIndex.size()} embeddings)`);
    } catch (err) {
      console.warn('[scan] error guardando CLIP index:', err.message);
    }
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
    status: job.status === 'cancelled' ? 'Escaneo cancelado' : 'Escaneo completado',
    percentage: 100,
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
  getJobStatus,
  listJobs,
  cancelJob,
  listFoldersWithMedia,
};
