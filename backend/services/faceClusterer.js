/**
 * Face Clusterer — Pensadero
 *
 * Descubre personas frecuentes en la biblioteca que NO estan registradas:
 * recorre todos los _pensadero.json, toma las detecciones sin person_id
 * (caras no identificadas) y las agrupa por similitud coseno usando un
 * greedy clustering online.
 *
 * Resultado: lista de clusters ordenados por face_count. El usuario puede
 * "promover" un cluster a persona del registry con un click — el centroid
 * del cluster pasa a ser el embeddings.json de la nueva persona, sin
 * necesidad de re-entrenamiento.
 *
 * Diseño:
 *  - Greedy online: O(N x K) donde K es numero de clusters. Para 50K caras
 *    y K~100, son segundos en CPU puro (solo producto escalar).
 *  - Solo procesa entries con identity.detections (scans nuevos post-2026-05-19).
 *  - Filtra clusters pequeños (< minClusterSize) para reducir ruido.
 *  - Cache en memoria con TTL: re-ejecutar es rapido, pero evitamos repetir
 *    si el usuario reabre la vista.
 */

const fs = require('fs').promises;
const path = require('path');
const { getInstance: getFaceService, decodeEmbedding, encodeEmbedding } = require('./faceService');
const peopleRegistry = require('../peopleRegistry');

const PENSADERO_CATALOG_FILENAME = '_pensadero.json';
const GENDER_MAP = { 0: 'mujer', 1: 'hombre' };

// Umbrales por defecto
const DEFAULT_CLUSTER_THRESHOLD = parseFloat(process.env.FACE_CLUSTER_THRESHOLD || '0.55');
const DEFAULT_MIN_CLUSTER_SIZE = parseInt(process.env.FACE_CLUSTER_MIN_SIZE || '3', 10);
const MAX_SAMPLES_PER_CLUSTER = 9;
const CACHE_TTL_MS = 5 * 60 * 1000;

function ageBucket(age) {
  if (typeof age !== 'number' || !isFinite(age)) return null;
  if (age < 16) return 'niño';
  if (age < 30) return 'joven';
  if (age < 60) return 'adulto';
  return 'senior';
}

const activeJobs = new Map();
let _cache = null; // { computedAt, clusters }

function makeJobId() {
  return `cluster_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

/**
 * Producto escalar entre dos Float32Array de 512 elementos.
 * Asume ambos L2-normalizados (caso InsightFace) → equivale a cosine.
 */
function dot512(a, b) {
  let s = 0;
  for (let i = 0; i < 512; i++) s += a[i] * b[i];
  return s;
}

/**
 * Re-normaliza L2 in-place sobre un Float32Array.
 */
function l2normalize(arr) {
  let norm = 0;
  for (let i = 0; i < 512; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return arr;
  for (let i = 0; i < 512; i++) arr[i] /= norm;
  return arr;
}

/**
 * Decide si una deteccion ya esta "identificada" por el registry actual.
 * Re-corre identifyFaces para que el clustering solo incluya las que de
 * verdad quedarian como desconocidas tras un re-identify completo.
 */
function isUnknown(detection, faceSvc) {
  if (faceSvc.embeddingsCache.size === 0) return true;
  const [identified] = faceSvc.identifyFaces([detection]);
  return !identified.person_id;
}

/**
 * Procesa todos los catalogos y devuelve los clusters de caras desconocidas.
 *
 * @param {object} opts
 *   - rootDirs: string[]
 *   - threshold: numero (default env)
 *   - minClusterSize: int (default 3)
 *   - broadcastProgress: fn
 *   - jobId: string
 */
async function clusterAll(opts = {}) {
  const {
    rootDirs = [],
    threshold = DEFAULT_CLUSTER_THRESHOLD,
    minClusterSize = DEFAULT_MIN_CLUSTER_SIZE,
    broadcastProgress = () => {},
    jobId = makeJobId(),
  } = opts;

  const faceSvc = getFaceService();
  const job = {
    jobId,
    status: 'running',
    total: 0,
    processed: 0,
    unknown: 0,
    clustersCount: 0,
    cancelRequested: false,
    startedAt: Date.now(),
  };
  activeJobs.set(jobId, job);

  broadcastProgress({ type: 'cluster_start', jobId, status: 'Cargando embeddings...' });

  // Cargar el cache de personas entrenadas para distinguir conocidas
  await faceSvc.init().catch(() => {});
  await faceSvc.loadAllEmbeddings(peopleRegistry.getState().avatarsBase).catch(() => {});

  // Localizar catalogos
  const catalogPaths = [];
  for (const root of rootDirs) {
    const found = await findCatalogs(root);
    catalogPaths.push(...found);
  }

  if (catalogPaths.length === 0) {
    job.status = 'done';
    broadcastProgress({ type: 'cluster_done', jobId, clustersCount: 0, status: 'Sin catalogos para procesar' });
    setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
    return { clusters: [], stats: job };
  }

  // Estado del clustering. Cada cluster:
  //   { centroid: Float32Array(512), count, samples: [{...}], scoreSum, ageCounts, genderCounts }
  const clusters = [];

  for (const catalogPath of catalogPaths) {
    if (job.cancelRequested) {
      job.status = 'cancelled';
      break;
    }
    let catalog;
    try {
      const raw = await fs.readFile(catalogPath, 'utf-8');
      catalog = JSON.parse(raw);
    } catch {
      continue;
    }
    const photos = catalog.photos || catalog.clips || {};
    const folder = path.dirname(catalogPath);

    for (const basename of Object.keys(photos)) {
      if (job.cancelRequested) break;
      const entry = photos[basename];
      const detections = entry?.identity?.detections;
      if (!Array.isArray(detections) || detections.length === 0) continue;

      for (let faceIdx = 0; faceIdx < detections.length; faceIdx++) {
        const det = detections[faceIdx];
        job.total++;

        // Solo agrupar caras que ahora mismo no se identifican con nadie
        if (!isUnknown(det, faceSvc)) continue;
        job.unknown++;

        const emb = decodeEmbedding(det.embedding_b64);
        if (!emb || emb.length !== 512) continue;

        // Buscar el cluster mas cercano
        let bestIdx = -1;
        let bestSim = -1;
        for (let i = 0; i < clusters.length; i++) {
          const sim = dot512(emb, clusters[i].centroid);
          if (sim > bestSim) {
            bestSim = sim;
            bestIdx = i;
          }
        }

        const sample = {
          folder,
          basename,
          face_index: faceIdx,
          bbox: det.bbox,
          det_score: det.det_score || 0,
        };

        if (bestIdx >= 0 && bestSim >= threshold) {
          // Fusionar: actualizar centroid como media corriente, re-L2-normalizar
          const c = clusters[bestIdx];
          const n = c.count;
          for (let i = 0; i < 512; i++) {
            c.centroid[i] = (c.centroid[i] * n + emb[i]) / (n + 1);
          }
          l2normalize(c.centroid);
          c.count++;
          c.scoreSum += sample.det_score;
          if (c.samples.length < MAX_SAMPLES_PER_CLUSTER) {
            c.samples.push(sample);
          } else if (sample.det_score > c.samples[c.samples.length - 1].det_score) {
            // Sustituir el peor sample por uno mejor
            c.samples.push(sample);
            c.samples.sort((a, b) => b.det_score - a.det_score);
            c.samples.length = MAX_SAMPLES_PER_CLUSTER;
          }
          const ab = ageBucket(det.age);
          if (ab) c.ageCounts[ab] = (c.ageCounts[ab] || 0) + 1;
          if (det.gender != null && GENDER_MAP[det.gender]) {
            const g = GENDER_MAP[det.gender];
            c.genderCounts[g] = (c.genderCounts[g] || 0) + 1;
          }
        } else {
          // Cluster nuevo
          const centroid = new Float32Array(emb);
          const ageCounts = {};
          const genderCounts = {};
          const ab = ageBucket(det.age);
          if (ab) ageCounts[ab] = 1;
          if (det.gender != null && GENDER_MAP[det.gender]) {
            genderCounts[GENDER_MAP[det.gender]] = 1;
          }
          clusters.push({
            centroid,
            count: 1,
            scoreSum: sample.det_score,
            samples: [sample],
            ageCounts,
            genderCounts,
          });
        }
      }

      job.processed++;
      if (job.processed % 50 === 0) {
        broadcastProgress({
          type: 'cluster_progress',
          jobId,
          processed: job.processed,
          unknown: job.unknown,
          clusters: clusters.length,
        });
      }
    }
  }

  // Filtrar clusters pequeños y enriquecer con IDs estables + ranking
  const usable = clusters
    .filter(c => c.count >= minClusterSize)
    .sort((a, b) => b.count - a.count)
    .map((c, idx) => {
      // Demografia: tomar la moda
      const dominantAge = Object.entries(c.ageCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const dominantGender = Object.entries(c.genderCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      return {
        cluster_id: `c${idx}_${c.count}`,
        face_count: c.count,
        avg_score: c.count > 0 ? c.scoreSum / c.count : 0,
        dominant_age: dominantAge,
        dominant_gender: dominantGender,
        samples: c.samples,
        centroid_b64: encodeEmbedding(c.centroid),
      };
    });

  job.clustersCount = usable.length;
  job.status = job.cancelRequested ? 'cancelled' : 'done';
  job.finishedAt = Date.now();

  // Cachear (solo si no fue cancelado)
  if (!job.cancelRequested) {
    _cache = { computedAt: Date.now(), clusters: usable };
  }

  broadcastProgress({
    type: 'cluster_done',
    jobId,
    total: job.total,
    unknown: job.unknown,
    clustersCount: usable.length,
    status: `${usable.length} ${usable.length === 1 ? 'cluster encontrado' : 'clusters encontrados'} (${job.unknown} caras desconocidas)`,
  });

  setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
  return { clusters: usable, stats: { ...job } };
}

function getCached() {
  if (!_cache) return null;
  if (Date.now() - _cache.computedAt > CACHE_TTL_MS) return null;
  return _cache;
}

function invalidateCache() {
  _cache = null;
}

function getCluster(clusterId) {
  if (!_cache) return null;
  return _cache.clusters.find(c => c.cluster_id === clusterId) || null;
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

module.exports = { clusterAll, getCached, invalidateCache, getCluster, getJobStatus, cancelJob };
