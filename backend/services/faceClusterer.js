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
const fsSync = require('fs');
const path = require('path');
const { getInstance: getFaceService, decodeEmbedding, encodeEmbedding } = require('./faceService');
const peopleRegistry = require('../peopleRegistry');

const PENSADERO_CATALOG_FILENAME = '_pensadero.json';
const GENDER_MAP = { 0: 'mujer', 1: 'hombre' };

// Umbrales por defecto
const DEFAULT_CLUSTER_THRESHOLD = parseFloat(process.env.FACE_CLUSTER_THRESHOLD || '0.55');
const DEFAULT_MIN_CLUSTER_SIZE = parseInt(process.env.FACE_CLUSTER_MIN_SIZE || '3', 10);
const MAX_SAMPLES_PER_CLUSTER = 9;
// TTL del cache: 24h. Se persiste a disco para sobrevivir reinicios. El usuario
// puede forzar recompute con "Re-clusterizar" en la UI cuando añada fotos.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_DISK_PATH = path.join(__dirname, '..', 'data', 'clusters_cache.json');

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

// ──────────────────────────────────────────────────────────────────────────
// Persistencia del cache a disco. Permite que "Descubrir caras" no recompute
// 2000+ clusters tras cada reinicio del backend. El cluster cache es de
// solo-lectura para el resto del sistema; el unico lugar que lo actualiza es
// este modulo.
// ──────────────────────────────────────────────────────────────────────────

function saveCacheToDisk() {
  if (!_cache) return;
  // Async, fire-and-forget. Si falla la escritura, el cache en memoria sigue
  // valido para esta sesion — solo perdemos persistencia entre reinicios.
  fs.mkdir(path.dirname(CACHE_DISK_PATH), { recursive: true })
    .then(() => fs.writeFile(CACHE_DISK_PATH, JSON.stringify(_cache), 'utf-8'))
    .catch(err => console.warn(`[faceClusterer] no se pudo guardar cache a disco: ${err.message}`));
}

function deleteDiskCache() {
  fs.unlink(CACHE_DISK_PATH).catch(() => {});
}

// Carga sincrona al inicializar el modulo. Sincrona para evitar race con
// peticiones tempranas tras el arranque.
function loadCacheFromDiskSync() {
  try {
    const raw = fsSync.readFileSync(CACHE_DISK_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.clusters) || typeof parsed.computedAt !== 'number') {
      console.warn('[faceClusterer] cache de disco con formato invalido, ignorando');
      return;
    }
    // Validar TTL al cargar — si esta caducado, no lo usamos
    if (Date.now() - parsed.computedAt > CACHE_TTL_MS) {
      console.log(`[faceClusterer] cache de disco caducado (${Math.round((Date.now() - parsed.computedAt) / (60 * 60 * 1000))}h), descartando`);
      return;
    }
    // Retrocompatibilidad: cache viejo (anterior a 2026-05-21) no tiene
    // cluster.faces poblado, lo que rompe el promote→actualizar-catalogos.
    // Si detectamos cache sin faces, descartamos y forzamos recompute.
    const hasFacesField = parsed.clusters.length === 0 || parsed.clusters.every(c => Array.isArray(c.faces));
    if (!hasFacesField) {
      console.log('[faceClusterer] cache de disco con formato anterior (sin faces[]), descartando para recomputar');
      return;
    }
    _cache = parsed;
    const ageMin = Math.round((Date.now() - parsed.computedAt) / 60000);
    console.log(`[faceClusterer] cache cargado de disco: ${parsed.clusters.length} clusters (computado hace ${ageMin} min)`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[faceClusterer] error cargando cache de disco: ${err.message}`);
    }
  }
}

loadCacheFromDiskSync();

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
          // Anotar la cara en la lista completa (sin bbox/score, para que el
          // promote pueda escribir person_id en todos los catalogos afectados,
          // no solo en las 9 samples). Lite: ~50 bytes/cara.
          c.faces.push({ folder, basename, face_index: faceIdx });
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
            faces: [{ folder, basename, face_index: faceIdx }],
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
        faces: c.faces, // lista lite con TODAS las caras del cluster
        centroid_b64: encodeEmbedding(c.centroid),
      };
    });

  job.clustersCount = usable.length;
  job.status = job.cancelRequested ? 'cancelled' : 'done';
  job.finishedAt = Date.now();

  // Cachear (solo si no fue cancelado)
  if (!job.cancelRequested) {
    _cache = { computedAt: Date.now(), clusters: usable };
    saveCacheToDisk();
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
  deleteDiskCache();
}

/**
 * Elimina un solo cluster del cache (e.g. tras ser promovido a persona) sin
 * invalidar el resto. Critico para permitir promover/fusionar varios clusters
 * en la misma sesion sin tener que re-clusterizar entre operaciones.
 */
function removeClusterFromCache(clusterId) {
  if (!_cache) return false;
  const before = _cache.clusters.length;
  _cache.clusters = _cache.clusters.filter(c => c.cluster_id !== clusterId);
  const changed = _cache.clusters.length < before;
  if (changed) saveCacheToDisk();
  return changed;
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

/**
 * Fusiona N clusters del cache en uno solo. El centroide resultante es la media
 * ponderada por face_count de los centroides originales (re-L2-normalizada). Los
 * samples se combinan y se ordenan por det_score (top MAX_SAMPLES_PER_CLUSTER).
 * Los clusters originales se eliminan del cache; el merged se inserta al inicio.
 *
 * Devuelve el cluster merged o null si:
 *  - no hay cache, o
 *  - clusterIds < 2, o
 *  - algun id no existe en el cache, o
 *  - algun centroid no se pudo decodificar.
 */
function mergeClusters(clusterIds) {
  if (!_cache) return null;
  if (!Array.isArray(clusterIds) || clusterIds.length < 2) return null;

  const uniqueIds = Array.from(new Set(clusterIds));
  const sources = uniqueIds.map(id => _cache.clusters.find(c => c.cluster_id === id));
  if (sources.some(c => !c)) return null;

  const merged = new Float32Array(512);
  let totalCount = 0;
  let weightedScoreSum = 0;
  const allSamples = [];
  const allFaces = [];

  for (const c of sources) {
    const cen = decodeEmbedding(c.centroid_b64);
    if (!cen || cen.length !== 512) return null;
    const w = c.face_count;
    for (let i = 0; i < 512; i++) merged[i] += cen[i] * w;
    totalCount += w;
    weightedScoreSum += (c.avg_score || 0) * w;
    for (const s of (c.samples || [])) allSamples.push(s);
    for (const f of (c.faces || [])) allFaces.push(f);
  }

  if (totalCount === 0) return null;
  for (let i = 0; i < 512; i++) merged[i] /= totalCount;
  l2normalize(merged);

  allSamples.sort((a, b) => (b.det_score || 0) - (a.det_score || 0));
  const samples = allSamples.slice(0, MAX_SAMPLES_PER_CLUSTER);

  // Demografia: del cluster mas grande (proxy razonable sin tener counts originales)
  const biggest = sources.slice().sort((a, b) => b.face_count - a.face_count)[0];

  const mergedId = `merged_${Date.now().toString(36)}_${sources.length}`;
  const mergedCluster = {
    cluster_id: mergedId,
    face_count: totalCount,
    avg_score: weightedScoreSum / totalCount,
    dominant_age: biggest.dominant_age,
    dominant_gender: biggest.dominant_gender,
    samples,
    faces: allFaces,
    centroid_b64: encodeEmbedding(merged),
  };

  _cache.clusters = [mergedCluster, ..._cache.clusters.filter(c => !uniqueIds.includes(c.cluster_id))];
  saveCacheToDisk();
  return mergedCluster;
}

/**
 * Calcula grupos de clusters parecidos entre si usando Union-Find sobre todos
 * los pares de centroides con cosine similarity >= threshold. Sirve para
 * sugerir al usuario "estos clusters podrian ser la misma persona".
 *
 * El threshold por defecto (0.42) es mas permisivo que el del clustering
 * inicial (0.55): aqui queremos sugerir candidatos para fusion, no decidir.
 *
 * Devuelve { groups: [{group_id, cluster_ids, max_similarity}], ungrouped: [cluster_ids] }
 * Los grupos solo incluyen >= 2 clusters; los aislados van a ungrouped.
 * Los grupos vienen ordenados por max_similarity desc.
 */
function computeSimilarityGroups(threshold = 0.42) {
  if (!_cache) return null;
  const cs = _cache.clusters;
  const N = cs.length;
  if (N === 0) return { groups: [], ungrouped: [] };

  const centroids = cs.map(c => decodeEmbedding(c.centroid_b64));
  if (centroids.some(c => !c || c.length !== 512)) return null;

  // Union-Find
  const parent = Array.from({ length: N }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Una sola pasada O(N^2): union + acumulamos pares por encima del umbral
  const pairs = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const sim = dot512(centroids[i], centroids[j]);
      if (sim >= threshold) {
        pairs.push({ i, j, sim });
        union(i, j);
      }
    }
  }

  // Agrupar por raiz
  const byRoot = new Map();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(i);
  }

  // Calcular max_similarity por grupo (entre pares que pasaron el umbral)
  const groupMaxSim = new Map();
  for (const { i, sim } of pairs) {
    const r = find(i);
    if (sim > (groupMaxSim.get(r) || 0)) groupMaxSim.set(r, sim);
  }

  const groups = [];
  let idx = 0;
  for (const [root, indices] of byRoot) {
    if (indices.length < 2) continue;
    groups.push({
      group_id: `simg${idx++}`,
      cluster_ids: indices.map(i => cs[i].cluster_id),
      max_similarity: groupMaxSim.get(root) || 0,
    });
  }
  groups.sort((a, b) => b.max_similarity - a.max_similarity);

  const groupedIds = new Set(groups.flatMap(g => g.cluster_ids));
  const ungrouped = cs.filter(c => !groupedIds.has(c.cluster_id)).map(c => c.cluster_id);

  return { groups, ungrouped };
}

/**
 * Crea un cluster "ad-hoc" a partir de una cara concreta del archivo (folder +
 * basename + face_index). Recorre todos los catalogos de las rutas activas
 * buscando caras desconocidas con cosine similarity >= threshold respecto al
 * embedding semilla. Inserta el cluster en _cache para que el flujo normal de
 * sample thumbnails / promote funcione sin cambios extra.
 *
 * Devuelve el cluster creado, o null si no se encontro ninguna cara similar
 * (incluyendo la propia semilla) o si el seed no tenia embedding.
 */
async function seedClusterFromFace({ folder, basename, face_index, threshold, rootDirs }) {
  if (!folder || !basename || typeof face_index !== 'number') return null;
  const t = (typeof threshold === 'number' && threshold > 0 && threshold < 1)
    ? threshold
    : DEFAULT_CLUSTER_THRESHOLD;

  // Leer embedding semilla
  const seedCatalogPath = path.join(folder, PENSADERO_CATALOG_FILENAME);
  let seedCatalog;
  try {
    const raw = await fs.readFile(seedCatalogPath, 'utf-8');
    seedCatalog = JSON.parse(raw);
  } catch {
    return null;
  }
  const seedPhotos = seedCatalog.photos || seedCatalog.clips || {};
  const seedEntry = seedPhotos[basename];
  const seedDet = seedEntry?.identity?.detections?.[face_index];
  if (!seedDet || !seedDet.embedding_b64) return null;
  const seedEmb = decodeEmbedding(seedDet.embedding_b64);
  if (!seedEmb || seedEmb.length !== 512) return null;

  const faceSvc = getFaceService();
  // Cargar embeddings del registry antes del isUnknown check para que las
  // caras que ya esten identificadas se filtren bien.
  try { await faceSvc.loadAllEmbeddings(peopleRegistry.getState().avatarsBase); } catch {}

  // Recolectar lista de _pensadero.json
  const allCatalogs = [];
  for (const root of rootDirs || []) {
    const found = await findCatalogs(root);
    allCatalogs.push(...found);
  }
  if (!allCatalogs.length) return null;

  // Acumuladores del cluster ad-hoc
  const samples = [];
  const facesList = [];
  const sumEmb = new Float32Array(512);
  let count = 0;
  let scoreSum = 0;
  const ageCounts = {};
  const genderCounts = {};

  for (const catalogPath of allCatalogs) {
    let catalog;
    try {
      const raw = await fs.readFile(catalogPath, 'utf-8');
      catalog = JSON.parse(raw);
    } catch { continue; }
    const photos = catalog.photos || catalog.clips || {};
    const catFolder = path.dirname(catalogPath);

    for (const bname of Object.keys(photos)) {
      const entry = photos[bname];
      const dets = entry?.identity?.detections;
      if (!Array.isArray(dets) || dets.length === 0) continue;

      for (let fIdx = 0; fIdx < dets.length; fIdx++) {
        const det = dets[fIdx];
        // Solo agrupamos caras que estan ahora mismo sin identificar
        if (!isUnknown(det, faceSvc)) continue;
        const emb = decodeEmbedding(det.embedding_b64);
        if (!emb || emb.length !== 512) continue;
        const sim = dot512(seedEmb, emb);
        if (sim < t) continue;

        const score = det.det_score || 0;
        const sampleEntry = {
          folder: catFolder,
          basename: bname,
          face_index: fIdx,
          bbox: det.bbox,
          det_score: score,
        };
        facesList.push({ folder: catFolder, basename: bname, face_index: fIdx });
        count++;
        scoreSum += score;
        for (let i = 0; i < 512; i++) sumEmb[i] += emb[i];

        if (samples.length < MAX_SAMPLES_PER_CLUSTER) {
          samples.push(sampleEntry);
        } else if (score > samples[samples.length - 1].det_score) {
          samples.push(sampleEntry);
          samples.sort((a, b) => b.det_score - a.det_score);
          samples.length = MAX_SAMPLES_PER_CLUSTER;
        }
        const ab = ageBucket(det.age);
        if (ab) ageCounts[ab] = (ageCounts[ab] || 0) + 1;
        if (det.gender != null && GENDER_MAP[det.gender]) {
          const g = GENDER_MAP[det.gender];
          genderCounts[g] = (genderCounts[g] || 0) + 1;
        }
      }
    }
  }

  if (count === 0) return null;

  // Centroide: media L2-normalizada de todos los embeddings encontrados
  for (let i = 0; i < 512; i++) sumEmb[i] /= count;
  l2normalize(sumEmb);

  // Ordenar samples por score (los mejores primero, para que samples[0] sea avatar)
  samples.sort((a, b) => b.det_score - a.det_score);

  const dominantAge = Object.entries(ageCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const dominantGender = Object.entries(genderCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const id = `seed_${Date.now().toString(36)}_${count}`;
  const cluster = {
    cluster_id: id,
    face_count: count,
    avg_score: count > 0 ? scoreSum / count : 0,
    dominant_age: dominantAge,
    dominant_gender: dominantGender,
    samples,
    faces: facesList,
    centroid_b64: encodeEmbedding(sumEmb),
  };

  // Inyectar en cache para que sample/promote funcionen
  if (!_cache) {
    _cache = { computedAt: Date.now(), clusters: [cluster] };
  } else {
    _cache.clusters = [cluster, ..._cache.clusters];
  }
  saveCacheToDisk();

  return cluster;
}

module.exports = { clusterAll, getCached, invalidateCache, removeClusterFromCache, getCluster, getJobStatus, cancelJob, mergeClusters, computeSimilarityGroups, seedClusterFromFace };
