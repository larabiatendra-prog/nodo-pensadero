/**
 * Spaces Registry — Pensadero NODO
 *
 * Gestiona el registry de espacios fisicos (`spaces_registry.json`):
 *   space_id → { display_name, aliases, cover_image_path, centroid_b64,
 *                ref_photo_count, trained_at }
 *
 * El centroide CLIP/SigLIP (base64) se calcula desde fotos de
 * referencia que el usuario sube. Permite place recognition automatico
 * durante el scan: cada foto del corpus se compara con todos los centroides
 * de espacios y, si la similitud supera el threshold, se asocia al
 * entry.identity.spaces[].
 *
 * Comparte directorio base con peopleRegistry (avatarsBase env var):
 *   <avatarsBase>/people/<person_id>/...
 *   <avatarsBase>/spaces/<space_id>/...  ← aqui
 *
 * spaces_registry.json vive junto a people_registry.json por default.
 */

const fs = require('fs');
const path = require('path');
const { EMBEDDING_DIM } = require('./services/clipService');
const { atomicWriteFileSync } = require('./utils/jsonStore');
const { leerRegistro } = require('./utils/registroSeguro');
const fallos = require('./utils/failureReason');

// Threshold por defecto. 0.70 es conservador para CLIP base: la experiencia
// real con corpus de eventos corporativos (auditorios, salas, networking)
// muestra que 0.60-0.65 produce muchos falsos positivos por similitud
// "tipo de escena" (gente en interior, ventanales, acreditaciones...) en
// vez de "lugar concreto". Subir a 0.70 elimina la mayoría de FP.
const DEFAULT_THRESHOLD = parseFloat(process.env.SPACE_MATCH_THRESHOLD || '0.7');

let registryPath = null;
let avatarsBase = null;
let spaceById = new Map();
// Cache de centroides en memoria para matching rapido. Float32Array(EMBEDDING_DIM)
let centroidsCache = new Map();
let warnedOnce = false;
// Ruta cuyo contenido refleja la memoria, y si el archivo esta ahi sin poder
// leerse (entonces no se guarda encima). Ver peopleRegistry.
let cargadoDe = null;
let sinLeer = false;
// Threshold actual configurable en runtime (se persiste al JSON del registry)
let currentThreshold = DEFAULT_THRESHOLD;

function loadRegistry(filePath, avatarsBaseOverride = null) {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    registryPath = null;
    avatarsBase = null;
    spaceById = new Map();
    centroidsCache = new Map();
    cargadoDe = null;
    sinLeer = false;
    return { ok: true, count: 0, error: null };
  }

  registryPath = path.normalize(filePath);
  avatarsBase = avatarsBaseOverride
    ? path.normalize(avatarsBaseOverride)
    : path.dirname(registryPath);

  // Mismo criterio que el registro de personas (utils/registroSeguro.js): una
  // lectura que falla nunca deja el registro vacio para que se guarde asi.
  const yaCargado = cargadoDe === registryPath;
  const r = leerRegistro(registryPath, 'spaces', { primeraVez: !yaCargado });
  if (r.estado !== 'ok') {
    if (yaCargado) {
      if (r.estado !== 'no_existe') fallos.record('recargar el registro de espacios', r.error, { path: registryPath });
      return { ok: false, count: spaceById.size, error: r.error.message, conservado: true };
    }
    spaceById = new Map();
    centroidsCache = new Map();
    if (r.estado === 'no_existe') {
      cargadoDe = registryPath;
      sinLeer = false;
      return { ok: false, count: 0, error: r.error.message, noExiste: true };
    }
    if (!warnedOnce) {
      console.warn(`⚠️ spaces_registry.json no se ha podido cargar: ${r.error.message}`);
      warnedOnce = true;
    }
    fallos.record('leer el registro de espacios', r.error, { path: registryPath });
    sinLeer = !(r.estado === 'roto' && r.apartado);
    if (!sinLeer) cargadoDe = registryPath;
    return { ok: false, count: 0, error: r.error.message };
  }
  if (r.desdeCopia) {
    fallos.record('leer el registro de espacios', r.error, { path: registryPath });
    console.warn(`⚠️ spaces_registry.json dañado${r.apartado ? ` (apartado en ${r.apartado})` : ''}: cargada la copia .bak`);
  }
  const parsed = r.datos;
  spaceById = new Map();
  centroidsCache = new Map();
  cargadoDe = registryPath;
  sinLeer = false;

  // Cargar threshold global persistido (si existe). Si no, default.
  if (typeof parsed.match_threshold === 'number' && parsed.match_threshold > 0 && parsed.match_threshold <= 1) {
    currentThreshold = parsed.match_threshold;
  } else {
    currentThreshold = DEFAULT_THRESHOLD;
  }

  for (const space of parsed.spaces) {
    if (!space || typeof space !== 'object') continue;
    const id = (typeof space.space_id === 'string' && space.space_id.trim())
      ? space.space_id.trim()
      : null;
    if (!id) continue;
    spaceById.set(id, space);
    // Cachear centroide en memoria si esta presente
    if (typeof space.centroid_b64 === 'string') {
      const arr = _decodeCentroid(space.centroid_b64);
      if (arr) centroidsCache.set(id, arr);
    }
  }

  console.log(`🏢 Spaces registry cargado: ${spaceById.size} espacios, ${centroidsCache.size} con centroide`);
  warnedOnce = false;
  return { ok: true, count: spaceById.size, error: null };
}

function _decodeCentroid(b64) {
  if (typeof b64 !== 'string') return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== EMBEDDING_DIM * 4) return null;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function _encodeCentroid(arr) {
  if (!arr || arr.length !== EMBEDDING_DIM) return null;
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

function getDisplayName(spaceId) {
  if (!spaceId) return spaceId;
  const e = spaceById.get(spaceId);
  return (e && typeof e.display_name === 'string' && e.display_name.trim())
    ? e.display_name.trim()
    : spaceId;
}

function getAliases(spaceId) {
  if (!spaceId) return [];
  const e = spaceById.get(spaceId);
  if (!e || !Array.isArray(e.aliases)) return [];
  return e.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim());
}

function getCoverUrl(spaceId) {
  if (!spaceId || !avatarsBase) return null;
  const e = spaceById.get(spaceId);
  if (!e || !e.cover_image_path) return null;
  const rel = path.normalize(e.cover_image_path);
  if (path.isAbsolute(rel)) return null; // no aceptar absolutos
  const resolved = path.resolve(avatarsBase, rel);
  const baseResolved = path.resolve(avatarsBase);
  const baseWithSep = baseResolved.endsWith(path.sep) ? baseResolved : baseResolved + path.sep;
  if (resolved !== baseResolved && !resolved.startsWith(baseWithSep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return `/spaces-covers/${rel.split(path.sep).join('/')}`;
}

function getState() {
  return {
    registryPath,
    avatarsBase,
    count: spaceById.size,
    spaceIds: Array.from(spaceById.keys()),
    trainedCount: centroidsCache.size,
    threshold: currentThreshold,
    defaultThreshold: DEFAULT_THRESHOLD,
  };
}

function getMatchThreshold() { return currentThreshold; }

function setMatchThreshold(value) {
  const v = parseFloat(value);
  if (!isFinite(v) || v <= 0 || v > 1) {
    throw new Error('threshold debe ser un numero entre 0 y 1');
  }
  currentThreshold = v;
  saveToDisk();
  return currentThreshold;
}

function listAll() {
  const out = [];
  for (const [id, e] of spaceById.entries()) {
    out.push({
      space_id: id,
      display_name: (e && e.display_name) || id,
      aliases: Array.isArray(e.aliases) ? e.aliases : [],
      cover_image_path: e.cover_image_path || null,
      cover_url: getCoverUrl(id),
      ref_photo_count: typeof e.ref_photo_count === 'number' ? e.ref_photo_count : 0,
      trained: centroidsCache.has(id),
      trained_at: e.trained_at || null,
    });
  }
  out.sort((a, b) => a.display_name.localeCompare(b.display_name, 'es'));
  return out;
}

function upsertSpace(data) {
  if (!data || typeof data !== 'object') throw new Error('data requerido');
  const id = (data.space_id || '').toString().trim();
  if (!id) throw new Error('space_id requerido');
  if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
    throw new Error('space_id debe ser alfanumerico (a-z, 0-9, _, -)');
  }
  const existing = spaceById.get(id) || {};
  const entry = {
    space_id: id,
    display_name: (data.display_name || '').toString().trim() || existing.display_name || id,
    aliases: Array.isArray(data.aliases)
      ? data.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim())
      : (existing.aliases || []),
    cover_image_path: typeof data.cover_image_path === 'string' && data.cover_image_path.trim()
      ? data.cover_image_path.trim()
      : (existing.cover_image_path || null),
    centroid_b64: existing.centroid_b64 || null,
    ref_photo_count: typeof existing.ref_photo_count === 'number' ? existing.ref_photo_count : 0,
    trained_at: existing.trained_at || null,
  };
  spaceById.set(id, entry);
  saveToDisk();
  return entry;
}

function deleteSpace(spaceId) {
  if (!spaceId) return false;
  const had = spaceById.delete(spaceId);
  centroidsCache.delete(spaceId);
  if (had) saveToDisk();
  return had;
}

/**
 * Actualiza el centroide (Float32Array o array) de un space. Se llama
 * tras "entrenar" un space desde sus fotos de referencia.
 */
function setCentroid(spaceId, centroid, refPhotoCount = 0) {
  const e = spaceById.get(spaceId);
  if (!e) throw new Error('space no existe: ' + spaceId);
  const b64 = _encodeCentroid(centroid);
  if (!b64) throw new Error(`centroide invalido (debe ser ${EMBEDDING_DIM} dims)`);
  e.centroid_b64 = b64;
  e.ref_photo_count = refPhotoCount;
  e.trained_at = new Date().toISOString();
  centroidsCache.set(spaceId, _decodeCentroid(b64));
  saveToDisk();
}

function clearCentroid(spaceId) {
  const e = spaceById.get(spaceId);
  if (!e) return;
  e.centroid_b64 = null;
  e.ref_photo_count = 0;
  e.trained_at = null;
  centroidsCache.delete(spaceId);
  saveToDisk();
}

function getCentroidsCache() {
  return centroidsCache;
}

function saveToDisk() {
  if (!registryPath) {
    console.warn('⚠️ saveToDisk sin registryPath; descartando.');
    return false;
  }
  if (sinLeer) {
    fallos.record('guardar el registro de espacios',
      new Error('No se guarda: spaces_registry.json no se pudo leer al arrancar y guardar ahora borraría los espacios que tiene. Reinicia Pensadero.'),
      { path: registryPath });
    return false;
  }
  const data = {
    version: 1,
    match_threshold: currentThreshold,
    spaces: Array.from(spaceById.values()),
  };
  // Escritura atómica (tmp + rename). spaces_registry.json guarda los
  // centroid_b64, costosos de regenerar (requieren re-entrenar desde fotos):
  // con copia .bak, que es la que se usa si el archivo aparece dañado.
  try {
    atomicWriteFileSync(registryPath, JSON.stringify(data, null, 2), { backup: true });
    return true;
  } catch (err) {
    fallos.record('guardar el registro de espacios', err, { path: registryPath });
    return false;
  }
}

function setRegistryPath(filePath, avatarsBaseOverride = null) {
  if (filePath) registryPath = path.normalize(filePath);
  if (avatarsBaseOverride) avatarsBase = path.normalize(avatarsBaseOverride);
  else if (registryPath && !avatarsBase) avatarsBase = path.dirname(registryPath);
}

/**
 * Identifica el space mas cercano dado un embedding (Float32Array EMBEDDING_DIM).
 * Devuelve {space_id, similarity} o null si ninguno supera el threshold.
 * Threshold default es el currentThreshold (configurable runtime).
 */
function identifySpace(embedding, threshold = currentThreshold) {
  if (!embedding || embedding.length !== EMBEDDING_DIM) return null;
  if (centroidsCache.size === 0) return null;
  let best = null;
  let bestSim = -1;
  for (const [id, centroid] of centroidsCache.entries()) {
    let dot = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) dot += embedding[i] * centroid[i];
    if (dot > bestSim) {
      bestSim = dot;
      best = id;
    }
  }
  if (best && bestSim >= threshold) {
    return { space_id: best, similarity: bestSim };
  }
  return null;
}

module.exports = {
  loadRegistry,
  setRegistryPath,
  getDisplayName,
  getAliases,
  getCoverUrl,
  getState,
  getMatchThreshold,
  setMatchThreshold,
  listAll,
  upsertSpace,
  deleteSpace,
  setCentroid,
  clearCentroid,
  getCentroidsCache,
  saveToDisk,
  identifySpace,
};
