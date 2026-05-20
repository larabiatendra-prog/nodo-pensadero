/**
 * CLIP Index — Pensadero NODO
 *
 * Indice central en memoria de embeddings CLIP por fileId. Sirve para:
 *  - Image search (subir foto, encontrar similares)
 *  - Place recognition (matchear contra centroides de espacios)
 *  - Text-to-image (cuando se active el text encoder)
 *
 * Storage:
 *  - Dual con sidecar: el embedding se guarda tambien en _pensadero.json
 *    (`entry.clip_embedding_b64`) para portabilidad. El indice central es
 *    cache regenerable desde sidecars.
 *  - Formato: JSON con embeddings en base64. Tamaño ~3 KB por foto.
 *    Para 50K fotos: ~150 MB. Migrar a binario si crece mas.
 *
 * API:
 *   await load()                              — carga desde disco
 *   await save()                              — persiste a disco
 *   upsert(fileId, Float32Array|string)       — añade/actualiza
 *   remove(fileId)
 *   has(fileId), size(), get(fileId)
 *   searchNearest(query, topN, fileIdFilter?) — top-N por cosine similarity
 *
 * Embeddings se asumen L2-normalizados (vienen asi de clip_extractor.py),
 * por lo que cosine similarity = dot product. O(N x EMBEDDING_DIM) por busqueda.
 */

const fs = require('fs').promises;
const path = require('path');
const { EMBEDDING_DIM } = require('./services/clipService');

const INDEX_FILE = path.join(__dirname, 'clip_index.json');
const INDEX_TMP = path.join(__dirname, 'clip_index.tmp');
const MODEL_TAG = 'M-CLIP/XLM-Roberta-Large-Vit-B-32';

// Map<fileId, Float32Array(EMBEDDING_DIM)>
let _index = new Map();
let _loaded = false;
let _saveQueue = Promise.resolve();
let _isDirty = false;

function _decodeB64(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== EMBEDDING_DIM * 4) return null;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function _encodeB64(arr) {
  if (!arr || arr.length !== EMBEDDING_DIM) return null;
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

async function load() {
  try {
    const raw = await fs.readFile(INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.entries && typeof parsed.entries === 'object') {
      _index = new Map();
      let discarded = 0;
      for (const [fileId, b64] of Object.entries(parsed.entries)) {
        const arr = _decodeB64(b64);
        if (arr) _index.set(fileId, arr);
        else discarded++;
      }
      const persistedModel = parsed.model || '?';
      if (discarded > 0) {
        console.warn(`⚠️ CLIP index: descartados ${discarded} embeddings con dim incorrecta (modelo persistido: ${persistedModel}, actual: ${EMBEDDING_DIM}D). Re-escanea con Zap para regenerar.`);
        _isDirty = true; // forzar save tras la limpieza
      }
      console.log(`📚 CLIP index cargado: ${_index.size} embeddings (${EMBEDDING_DIM}D)`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[clipIndex] no se pudo leer:', err.message);
    }
    _index = new Map();
  }
  _loaded = true;
}

async function _performSave() {
  try {
    const entries = {};
    for (const [fileId, arr] of _index.entries()) {
      entries[fileId] = _encodeB64(arr);
    }
    const data = {
      version: 1,
      embedding_dim: EMBEDDING_DIM,
      model: MODEL_TAG,
      updated_at: new Date().toISOString(),
      entries,
    };
    await fs.writeFile(INDEX_TMP, JSON.stringify(data), 'utf-8');
    await fs.rename(INDEX_TMP, INDEX_FILE);
    _isDirty = false;
  } catch (err) {
    console.error('[clipIndex] error guardando:', err.message);
    try { await fs.unlink(INDEX_TMP).catch(() => {}); } catch {}
  }
}

/**
 * Encola una operacion de save. Multiples llamadas seguidas se serializan;
 * solo se persiste si hay cambios pendientes.
 */
function save() {
  if (!_isDirty) return _saveQueue;
  _saveQueue = _saveQueue.then(() => _performSave());
  return _saveQueue;
}

function upsert(fileId, embedding) {
  if (!fileId) return false;
  let arr = embedding;
  if (typeof embedding === 'string') arr = _decodeB64(embedding);
  if (!arr || arr.length !== EMBEDDING_DIM) return false;
  if (!(arr instanceof Float32Array)) arr = Float32Array.from(arr);
  _index.set(fileId, arr);
  _isDirty = true;
  return true;
}

function remove(fileId) {
  const had = _index.delete(fileId);
  if (had) _isDirty = true;
  return had;
}

function has(fileId) { return _index.has(fileId); }
function get(fileId) { return _index.get(fileId) || null; }
function size() { return _index.size; }

/**
 * Busqueda top-N por similitud coseno (asume embeddings L2-normalizados).
 *
 * @param {Float32Array} query - embedding objetivo
 * @param {number} topN - tope de resultados
 * @param {Function|null} fileIdFilter - (fileId) => bool. Si false, salta
 * @returns {Array<{fileId, similarity}>} ordenado desc
 */
function searchNearest(query, topN = 50, fileIdFilter = null) {
  if (!query || query.length !== EMBEDDING_DIM) return [];
  const q = query instanceof Float32Array ? query : Float32Array.from(query);
  const results = [];
  for (const [fileId, emb] of _index.entries()) {
    if (fileIdFilter && !fileIdFilter(fileId)) continue;
    let dot = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) dot += q[i] * emb[i];
    results.push({ fileId, similarity: dot });
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topN);
}

/**
 * Quita del indice los fileIds que no esten en `existingIds`. Util para
 * sincronizar tras un sync de archivos.
 */
function pruneOrphans(existingIds) {
  if (!Array.isArray(existingIds)) return 0;
  const set = new Set(existingIds);
  let removed = 0;
  for (const fileId of _index.keys()) {
    if (!set.has(fileId)) {
      _index.delete(fileId);
      removed++;
    }
  }
  if (removed > 0) _isDirty = true;
  return removed;
}

function isLoaded() { return _loaded; }
function isDirty() { return _isDirty; }

module.exports = {
  load,
  save,
  upsert,
  remove,
  has,
  get,
  size,
  searchNearest,
  pruneOrphans,
  isLoaded,
  isDirty,
  // Exponer para tests
  _encodeB64,
  _decodeB64,
};
