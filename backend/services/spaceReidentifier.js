/**
 * Space Reidentifier — Pensadero NODO
 *
 * Re-aplica el matching de espacios sobre todos los `_pensadero.json` que
 * tengan `clip_embedding_b64` persistido, usando el threshold actual del
 * registry. No re-corre CLIP — solo recalcula el dot product con los
 * centroides cacheados. Util tras:
 *  - cambiar el threshold global
 *  - añadir / eliminar un espacio
 *  - re-entrenar el centroide de un espacio (anadir fotos referencia)
 *
 * Tiempo de ejecucion: O(N x K) donde N es archivos con embedding y K es
 * numero de espacios. Para 50K archivos x 5 espacios: ~1 seg.
 *
 * Patron analogo a faceReidentifier.js. Job en background con progreso por
 * WebSocket. Eventos: reidentify_space_start / _progress / _done / _error.
 */

const fs = require('fs').promises;
const path = require('path');
const spacesRegistry = require('../spacesRegistry');
const catalogReader = require('../catalogReader');
const { EMBEDDING_DIM } = require('./clipService');

const PENSADERO_CATALOG_FILENAME = '_pensadero.json';

const activeJobs = new Map();

function makeJobId() {
  return `reid_space_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

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

function _decodeEmbedding(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== EMBEDDING_DIM * 4) return null;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/**
 * Procesa una entry: si tiene clip_embedding_b64, recalcula el match
 * contra los centroides actuales. Devuelve { changed, hadEmbedding }.
 */
function reidentifyEntry(entry) {
  if (!entry || typeof entry !== 'object') return { changed: false, hadEmbedding: false };
  const b64 = entry.clip_embedding_b64;
  if (!b64) return { changed: false, hadEmbedding: false };
  const emb = _decodeEmbedding(b64);
  if (!emb) return { changed: false, hadEmbedding: false };

  const match = spacesRegistry.identifySpace(emb);
  const prevSpaces = (entry.identity && Array.isArray(entry.identity.spaces)) ? entry.identity.spaces : [];
  const prevSpaceId = prevSpaces.length > 0 ? prevSpaces[0].space_id : null;
  const prevConfidence = prevSpaces.length > 0 ? prevSpaces[0].confidence : null;

  if (match) {
    const newSpaces = [{
      space_id: match.space_id,
      display_name: spacesRegistry.getDisplayName(match.space_id),
      confidence: match.similarity,
    }];
    // Cambio real si el space_id cambia o la confidence varia significativamente
    const changed = prevSpaceId !== match.space_id ||
                    Math.abs((prevConfidence || 0) - match.similarity) > 1e-4 ||
                    prevSpaces.length !== 1;
    if (changed) {
      entry.identity = entry.identity || {};
      entry.identity.spaces = newSpaces;
    }
    return { changed, hadEmbedding: true };
  } else {
    // No match: limpiar spaces si los habia
    if (prevSpaces.length > 0) {
      entry.identity.spaces = [];
      return { changed: true, hadEmbedding: true };
    }
    return { changed: false, hadEmbedding: true };
  }
}

async function reidentifyAll(opts = {}) {
  const {
    rootDirs = [],
    broadcastProgress = () => {},
    jobId = makeJobId(),
  } = opts;

  const job = {
    jobId,
    status: 'running',
    total: 0,
    done: 0,
    changed: 0,
    skippedNoEmbedding: 0,
    catalogsWritten: 0,
    cancelRequested: false,
    startedAt: Date.now(),
  };
  activeJobs.set(jobId, job);

  broadcastProgress({ type: 'reidentify_space_start', jobId, status: 'Cargando catalogos...' });

  // No requiere CLIP daemon; solo necesita centroides cargados del registry
  if (spacesRegistry.getState().trainedCount === 0) {
    job.status = 'done';
    broadcastProgress({
      type: 'reidentify_space_done', jobId, total: 0, done: 0, changed: 0, skippedNoEmbedding: 0,
      status: 'No hay espacios entrenados. Sube fotos de referencia y reentrena.',
    });
    setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
    return job;
  }

  // Localizar todos los _pensadero.json bajo las rutas
  const catalogPaths = [];
  for (const root of rootDirs) {
    const found = await findCatalogs(root);
    catalogPaths.push(...found);
  }

  if (catalogPaths.length === 0) {
    job.status = 'done';
    broadcastProgress({ type: 'reidentify_space_done', jobId, total: 0, done: 0, changed: 0, skippedNoEmbedding: 0, status: 'Sin catalogos para procesar' });
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
      console.warn(`[reidentify-space] no se pudo leer ${cp}: ${err.message}`);
    }
  }

  job.total = totalEntries;
  broadcastProgress({
    type: 'reidentify_space_progress',
    jobId,
    total: job.total,
    done: 0,
    changed: 0,
    skippedNoEmbedding: 0,
    status: `Re-identificando ${job.total} entradas en ${parsed.length} carpetas...`,
    percentage: 0,
  });

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
      const { changed, hadEmbedding } = reidentifyEntry(entry);
      if (!hadEmbedding) job.skippedNoEmbedding++;
      if (changed) {
        dirty = true;
        job.changed++;
      }
      job.done++;
      if (job.done % 50 === 0 || job.done === job.total) {
        broadcastProgress({
          type: 'reidentify_space_progress',
          jobId,
          total: job.total,
          done: job.done,
          changed: job.changed,
          skippedNoEmbedding: job.skippedNoEmbedding,
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
        console.warn(`[reidentify-space] error escribiendo ${catalogPath}: ${err.message}`);
      }
    }
  }

  job.status = job.cancelRequested ? 'cancelled' : 'done';
  job.finishedAt = Date.now();
  broadcastProgress({
    type: 'reidentify_space_done',
    jobId,
    total: job.total,
    done: job.done,
    changed: job.changed,
    skippedNoEmbedding: job.skippedNoEmbedding,
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
