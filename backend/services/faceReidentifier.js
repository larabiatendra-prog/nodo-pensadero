/**
 * Face Reidentifier — Pensadero
 *
 * Re-identifica todas las caras ya detectadas en los _pensadero.json sin
 * necesidad de volver a correr InsightFace sobre las imagenes. Util cuando
 * se añade una persona nueva al registry: las fotos que ya tenian su cara
 * detectada (sin matchear) pasan a estar correctamente asociadas.
 *
 * Requiere que las entries del catalogo tengan `identity.detections` con los
 * embeddings persistidos (base64). Entries antiguas sin ese campo se cuentan
 * en `skippedNoDetections` y solo se actualizan haciendo re-scan con force=true.
 *
 * Diseño:
 *  - Job en background con jobId, status, progreso por WebSocket.
 *  - Idempotente: re-correr no rompe nada, solo recalcula matches.
 *  - Serie y rapido: matching es solo producto escalar; el cuello de botella
 *    es I/O de los catalogos.
 *  - Cancelable.
 */

const fs = require('fs').promises;
const path = require('path');
const { getInstance: getFaceService } = require('./faceService');
const peopleRegistry = require('../peopleRegistry');
const catalogReader = require('../catalogReader');

const PENSADERO_CATALOG_FILENAME = '_pensadero.json';
const GENDER_MAP = { 0: 'mujer', 1: 'hombre' };

function ageBucket(age) {
  if (typeof age !== 'number' || !isFinite(age)) return null;
  if (age < 16) return 'niño';
  if (age < 30) return 'joven';
  if (age < 60) return 'adulto';
  return 'senior';
}

const activeJobs = new Map();

function makeJobId() {
  return `reid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Recorre recursivamente `rootDir` y devuelve todos los archivos _pensadero.json.
 */
async function findCatalogs(rootDir) {
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name.startsWith('$')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile() && ent.name === PENSADERO_CATALOG_FILENAME) {
        results.push(full);
      }
    }
  }
  await walk(rootDir);
  return results;
}

/**
 * Re-identifica una entry concreta del catalogo usando sus detections.
 * Devuelve { changed, hadDetections } indicando si la entry se modifico.
 */
function reidentifyEntry(entry, faceSvc) {
  if (!entry || !entry.identity) return { changed: false, hadDetections: false };
  const detections = entry.identity.detections;
  if (!Array.isArray(detections) || detections.length === 0) {
    return { changed: false, hadDetections: false };
  }

  // Snapshot de los person_id actuales antes de mutar — para detectar cambio
  const prevPersonIds = detections.map(d => d.person_id || null);

  // identifyFaces acepta `embedding_b64` (lo decodifica internamente).
  const identified = faceSvc.identifyFaces(detections);
  const named = identified
    .filter(f => f.person_id)
    .map(f => ({
      person_id: f.person_id,
      display_name: peopleRegistry.getDisplayName(f.person_id),
      confidence: f.similarity,
    }));
  const byId = new Map();
  for (const f of named) {
    const prev = byId.get(f.person_id);
    if (!prev || f.confidence > prev.confidence) byId.set(f.person_id, f);
  }
  const newFaces = Array.from(byId.values());

  // Actualizar tambien el person_id por detección (uno-a-uno con cada cara
  // fisica) para que el visor pueda etiquetar cada bbox.
  for (let i = 0; i < detections.length; i++) {
    const det = detections[i];
    const match = identified[i];
    if (match && match.person_id) {
      det.person_id = match.person_id;
      det.display_name = peopleRegistry.getDisplayName(match.person_id);
      det.confidence = match.similarity;
    } else {
      delete det.person_id;
      delete det.display_name;
      delete det.confidence;
    }
  }

  // Demografia inferida de TODAS las detecciones
  const ageRanges = new Set();
  const genders = new Set();
  for (const f of detections) {
    const a = ageBucket(f.age);
    if (a) ageRanges.add(a);
    if (f.gender != null && GENDER_MAP[f.gender]) genders.add(GENDER_MAP[f.gender]);
  }

  // Cambio real: bien el set agregado faces[] cambia, bien alguna detection
  // tiene person_id distinto del previo (caso: una segunda aparicion de la
  // misma persona pasa a estar etiquetada aunque no añada un nombre nuevo)
  const prevFaces = Array.isArray(entry.identity.faces) ? entry.identity.faces : [];
  const sameFaces = prevFaces.length === newFaces.length &&
    prevFaces.every(p => newFaces.find(n => n.person_id === p.person_id && Math.abs((n.confidence || 0) - (p.confidence || 0)) < 1e-4));
  const detectionsChanged = detections.some((det, i) => (det.person_id || null) !== prevPersonIds[i]);

  entry.identity.faces = newFaces;
  entry.identity.face_count = detections.length;
  entry.demographics = entry.demographics || {};
  if (ageRanges.size > 0) entry.demographics.age_ranges = Array.from(ageRanges);
  if (genders.size > 0) entry.demographics.genders = Array.from(genders);

  return { changed: !sameFaces || detectionsChanged, hadDetections: true };
}

/**
 * Re-identifica todos los catalogos bajo `rootDirs`.
 *
 * @param {object} opts
 *   - rootDirs: string[] de rutas raiz a recorrer
 *   - broadcastProgress: fn(data) para WebSocket
 *   - jobId: string opcional
 */
async function reidentifyAll(opts = {}) {
  const {
    rootDirs = [],
    broadcastProgress = () => {},
    jobId = makeJobId(),
  } = opts;

  const faceSvc = getFaceService();
  const job = {
    jobId,
    status: 'running',
    total: 0,
    done: 0,
    changed: 0,
    skippedNoDetections: 0,
    catalogsWritten: 0,
    cancelRequested: false,
    startedAt: Date.now(),
  };
  activeJobs.set(jobId, job);

  broadcastProgress({ type: 'reidentify_start', jobId, status: 'Cargando embeddings...' });

  // Asegurar daemon Python e indice de personas entrenadas en memoria
  const ok = await faceSvc.init();
  if (!ok) {
    job.status = 'error';
    job.errorMessage = faceSvc.getStatus().lastError || 'face service no disponible';
    broadcastProgress({ type: 'reidentify_error', jobId, error: job.errorMessage });
    setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
    return job;
  }
  await faceSvc.loadAllEmbeddings(peopleRegistry.getState().avatarsBase);
  if (faceSvc.embeddingsCache.size === 0) {
    job.status = 'done';
    job.errorMessage = 'No hay personas entrenadas. Sube fotos de referencia y vuelve a intentar.';
    broadcastProgress({ type: 'reidentify_done', jobId, total: 0, done: 0, changed: 0, skippedNoDetections: 0, status: job.errorMessage });
    setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
    return job;
  }

  // Localizar todos los _pensadero.json bajo las rutas configuradas
  const catalogPaths = [];
  for (const root of rootDirs) {
    const found = await findCatalogs(root);
    catalogPaths.push(...found);
  }

  if (catalogPaths.length === 0) {
    job.status = 'done';
    broadcastProgress({ type: 'reidentify_done', jobId, total: 0, done: 0, changed: 0, skippedNoDetections: 0, status: 'Sin catalogos para procesar' });
    setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
    return job;
  }

  // Pre-pasada para contar entries totales
  let totalEntries = 0;
  const parsed = [];
  for (const cp of catalogPaths) {
    try {
      const raw = await fs.readFile(cp, 'utf-8');
      const catalog = JSON.parse(raw);
      const photos = catalog.photos || catalog.clips || {};
      const count = Object.keys(photos).length;
      totalEntries += count;
      parsed.push({ catalogPath: cp, catalog, photosKey: catalog.photos ? 'photos' : (catalog.clips ? 'clips' : 'photos') });
    } catch (err) {
      console.warn(`[reidentify] no se pudo leer ${cp}: ${err.message}`);
    }
  }

  job.total = totalEntries;
  broadcastProgress({
    type: 'reidentify_progress',
    jobId,
    total: job.total,
    done: 0,
    changed: 0,
    skippedNoDetections: 0,
    status: `Re-identificando ${job.total} entradas en ${parsed.length} carpetas...`,
    percentage: 0,
  });

  // Procesar carpeta por carpeta
  for (const { catalogPath, catalog, photosKey } of parsed) {
    if (job.cancelRequested) {
      job.status = 'cancelled';
      break;
    }
    const photos = catalog[photosKey] || {};
    let dirty = false;
    for (const basename of Object.keys(photos)) {
      if (job.cancelRequested) break;
      const entry = photos[basename];
      const { changed, hadDetections } = reidentifyEntry(entry, faceSvc);
      if (!hadDetections) job.skippedNoDetections++;
      if (changed) {
        dirty = true;
        job.changed++;
      }
      job.done++;
      if (job.done % 25 === 0 || job.done === job.total) {
        broadcastProgress({
          type: 'reidentify_progress',
          jobId,
          total: job.total,
          done: job.done,
          changed: job.changed,
          skippedNoDetections: job.skippedNoDetections,
          file: basename,
          percentage: Math.round((job.done / job.total) * 100),
        });
      }
    }

    if (dirty) {
      catalog.processed = new Date().toISOString();
      try {
        await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2), 'utf-8');
        catalogReader.invalidateCatalog(path.dirname(catalogPath));
        job.catalogsWritten++;
      } catch (err) {
        console.warn(`[reidentify] error escribiendo ${catalogPath}: ${err.message}`);
      }
    }
  }

  job.status = job.cancelRequested ? 'cancelled' : 'done';
  job.finishedAt = Date.now();
  broadcastProgress({
    type: 'reidentify_done',
    jobId,
    total: job.total,
    done: job.done,
    changed: job.changed,
    skippedNoDetections: job.skippedNoDetections,
    catalogsWritten: job.catalogsWritten,
    status: job.status === 'cancelled' ? 'Re-identificacion cancelada' : 'Re-identificacion completada',
    percentage: 100,
  });

  setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
  return job;
}

function getJobStatus(jobId) {
  return activeJobs.get(jobId) || null;
}

function cancelJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  job.cancelRequested = true;
  return true;
}

module.exports = { reidentifyAll, getJobStatus, cancelJob };
