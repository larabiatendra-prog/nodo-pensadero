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
 * Momentos de un video (clip_momentos.json, y `entry.clip_momentos` en el
 * sidecar): ademas de su huella principal (el fotograma del medio), un video
 * guarda la de otros instantes del clip. Con una sola, una imagen de otro
 * momento del video lo encontraba en el top 50 solo 7 de cada 12 veces
 * (medido 23/09/2026). Van comprimidos a int8 con su escala (772 bytes en vez
 * de 3 KB): con miles de videos y varios momentos cada uno, en float32 serian
 * cientos de MB en memoria y en disco. La perdida es despreciable para el
 * coseno (del orden de 0,001). Cada archivo puntua por su huella mas parecida.
 *
 * API:
 *   await load()                              — carga desde disco
 *   save({ ya })                              — persiste (como mucho cada minuto)
 *   upsert(fileId, Float32Array|string)       — añade/actualiza
 *   remove(fileId)
 *   has(fileId), size(), get(fileId)
 *   setMomentos(fileId, [{t, e}]), getMomentos(fileId), numMomentos(fileId)
 *   searchNearest(query, topN, fileIdFilter?) — top-N por cosine similarity
 *
 * Embeddings se asumen L2-normalizados (vienen asi de clip_extractor.py),
 * por lo que cosine similarity = dot product. O(N x EMBEDDING_DIM) por busqueda.
 */

const fs = require('fs').promises;
const path = require('path');
const fallos = require('./utils/failureReason');
const { EMBEDDING_DIM } = require('./services/clipService');

const INDEX_FILE = path.join(__dirname, 'clip_index.json');
const INDEX_TMP = path.join(__dirname, 'clip_index.tmp');
const MOMENTOS_FILE = path.join(__dirname, 'clip_momentos.json');
const MOMENTOS_TMP = path.join(__dirname, 'clip_momentos.tmp');
// Tag persistido en clip_index.json. Si cambia el modelo, el load() detecta
// dim distinta y descarta automaticamente. El nombre exacto se puede sobreescribir
// con CLIP_MODEL_TAG por si se prueba otra variante (siglip2-large, etc.).
const MODEL_TAG = process.env.CLIP_MODEL_TAG || 'google/siglip2-base-patch16-naflex';

// El indice se reescribe ENTERO (123 MB el 23/09/2026). Antes se guardaba en
// cada volcado del escaneo, cada 10 archivos: unos 12 GB de escritura por cada
// 1.000 archivos. Ahora como mucho una vez por minuto; lo que no llegue a
// guardarse antes de un corte sigue en los _pensadero.json, y la siguiente
// sincronizacion lo recupera de ahi (server.js, sincronizarIndiceClip).
const GUARDAR_CADA_MS = 60 * 1000;

// Map<fileId, Float32Array(EMBEDDING_DIM)>
let _index = new Map();
// Map<fileId, Array<{ t: number|null, escala: number, q: Int8Array }>>
let _momentos = new Map();
let _loaded = false;
let _saveQueue = Promise.resolve();
let _isDirty = false;
let _momentosDirty = false;
let _ultimoGuardado = 0;
let _temporizador = null;

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

// ── Huella compacta (int8 + escala) ───────────────────────────────────────

/** Float32Array(768) -> base64 de [escala float32][768 x int8]. */
function comprimirHuella(arr) {
  if (!arr || arr.length !== EMBEDDING_DIM) return null;
  const f = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  let max = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) { const a = Math.abs(f[i]); if (a > max) max = a; }
  const escala = max > 0 ? max / 127 : 1;
  const buf = Buffer.alloc(4 + EMBEDDING_DIM);
  buf.writeFloatLE(escala, 0);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    buf.writeInt8(Math.max(-127, Math.min(127, Math.round(f[i] / escala))), 4 + i);
  }
  return buf.toString('base64');
}

/** base64 compacto -> { escala, q: Int8Array } o null. */
function descomprimirHuella(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 4 + EMBEDDING_DIM) return null;
  const escala = buf.readFloatLE(0);
  if (!Number.isFinite(escala) || escala <= 0) return null;
  const q = new Int8Array(buf.buffer.slice(buf.byteOffset + 4, buf.byteOffset + 4 + EMBEDDING_DIM));
  return { escala, q };
}

function _momentoACompacto(m) {
  const buf = Buffer.alloc(4 + EMBEDDING_DIM);
  buf.writeFloatLE(m.escala, 0);
  Buffer.from(m.q.buffer, m.q.byteOffset, m.q.byteLength).copy(buf, 4);
  return { t: m.t, e: buf.toString('base64') };
}

// ── Carga y guardado ──────────────────────────────────────────────────────

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
  await _cargarMomentos();
  _loaded = true;
}

async function _cargarMomentos() {
  _momentos = new Map();
  try {
    const parsed = JSON.parse(await fs.readFile(MOMENTOS_FILE, 'utf-8'));
    if (parsed && parsed.model && parsed.model !== MODEL_TAG) {
      // Otro modelo: sus huellas no se pueden comparar con las de este.
      console.warn(`⚠️ Momentos de video de otro modelo (${parsed.model}): se descartan y se recuperan de los catalogos.`);
      _momentosDirty = true;
      return;
    }
    let n = 0;
    for (const [fileId, lista] of Object.entries((parsed && parsed.entries) || {})) {
      if (setMomentos(fileId, lista, { marcar: false })) n += numMomentos(fileId);
    }
    if (n > 0) console.log(`🎞️ Momentos de video cargados: ${n} de ${_momentos.size} videos`);
  } catch (err) {
    // Regenerable desde los catalogos: que no este no es un fallo.
    if (err.code !== 'ENOENT') fallos.record('leer los momentos de video del indice visual', err, { path: MOMENTOS_FILE });
  }
}

async function _escribir(archivo, tmp, datos) {
  await fs.writeFile(tmp, JSON.stringify(datos), 'utf-8');
  await fs.rename(tmp, archivo);
}

async function _performSave() {
  _ultimoGuardado = Date.now();
  if (_isDirty) {
    try {
      const entries = {};
      for (const [fileId, arr] of _index.entries()) {
        entries[fileId] = _encodeB64(arr);
      }
      _isDirty = false;
      await _escribir(INDEX_FILE, INDEX_TMP, {
        version: 1,
        embedding_dim: EMBEDDING_DIM,
        model: MODEL_TAG,
        updated_at: new Date().toISOString(),
        entries,
      });
    } catch (err) {
      _isDirty = true;
      // Sin indice no hay busqueda visual, aunque los embeddings sigan en los
      // sidecar. Merece aviso, no un console.error que nadie lee.
      fallos.record('guardar el indice de busqueda visual (CLIP)', err, { path: INDEX_FILE });
      try { await fs.unlink(INDEX_TMP).catch(() => {}); } catch {}
    }
  }
  if (_momentosDirty) {
    try {
      const entries = {};
      for (const [fileId, lista] of _momentos.entries()) {
        entries[fileId] = lista.map(_momentoACompacto);
      }
      _momentosDirty = false;
      await _escribir(MOMENTOS_FILE, MOMENTOS_TMP, {
        version: 1,
        embedding_dim: EMBEDDING_DIM,
        model: MODEL_TAG,
        updated_at: new Date().toISOString(),
        entries,
      });
    } catch (err) {
      _momentosDirty = true;
      fallos.record('guardar los momentos de video del indice visual', err, { path: MOMENTOS_FILE });
      try { await fs.unlink(MOMENTOS_TMP).catch(() => {}); } catch {}
    }
  }
}

function _encolarGuardado() {
  _saveQueue = _saveQueue.then(() => _performSave());
  return _saveQueue;
}

/**
 * Guarda si hay cambios, como mucho una vez por minuto: si se pide antes, la
 * escritura queda programada. `ya: true` guarda en el acto (final de un
 * trabajo, herramientas). Varias llamadas seguidas se serializan.
 */
function save({ ya = false } = {}) {
  if (!_isDirty && !_momentosDirty) return _saveQueue;
  const espera = ya ? 0 : Math.max(0, _ultimoGuardado + GUARDAR_CADA_MS - Date.now());
  if (espera === 0) {
    if (_temporizador) { clearTimeout(_temporizador); _temporizador = null; }
    return _encolarGuardado();
  }
  if (!_temporizador) {
    _temporizador = setTimeout(() => { _temporizador = null; _encolarGuardado(); }, espera);
  }
  return _saveQueue;
}

// ── Huella principal ──────────────────────────────────────────────────────

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
  if (_momentos.delete(fileId)) _momentosDirty = true;
  return had;
}

function has(fileId) { return _index.has(fileId); }
function get(fileId) { return _index.get(fileId) || null; }
function size() { return _index.size; }

// ── Momentos de un video ──────────────────────────────────────────────────

/**
 * Pone los momentos de un video (sustituye los que tuviera).
 * @param {string} fileId
 * @param {Array<{t?: number, e?: string, emb?: Float32Array}>} lista - `e` es
 *   la huella compacta (la del sidecar); `emb`, una huella recien calculada.
 * @returns {boolean} si ha quedado alguno
 */
function setMomentos(fileId, lista, { marcar = true } = {}) {
  if (!fileId) return false;
  const buenos = [];
  for (const m of Array.isArray(lista) ? lista : []) {
    if (!m) continue;
    const d = m.emb ? descomprimirHuella(comprimirHuella(m.emb)) : descomprimirHuella(m.e);
    if (!d) continue;
    buenos.push({ t: Number.isFinite(m.t) ? m.t : null, escala: d.escala, q: d.q });
  }
  if (buenos.length === 0) {
    if (_momentos.delete(fileId) && marcar) _momentosDirty = true;
    return false;
  }
  _momentos.set(fileId, buenos);
  if (marcar) _momentosDirty = true;
  return true;
}

/** Los momentos de un video en su forma compacta ([{t, e}]), o []. */
function getMomentos(fileId) {
  const lista = _momentos.get(fileId);
  return lista ? lista.map(_momentoACompacto) : [];
}

function numMomentos(fileId) {
  const lista = _momentos.get(fileId);
  return lista ? lista.length : 0;
}

/** Cuantos videos tienen momentos y cuantos momentos hay en total. */
function resumenMomentos() {
  let momentos = 0;
  for (const lista of _momentos.values()) momentos += lista.length;
  return { videos: _momentos.size, momentos };
}

// ── Busqueda ──────────────────────────────────────────────────────────────

/**
 * Busqueda top-N por similitud coseno (asume embeddings L2-normalizados).
 *
 * @param {Float32Array} query - embedding objetivo
 * @param {number} topN - tope de resultados
 * @param {Function|null} fileIdFilter - (fileId) => bool. Si false, salta
 * @returns {Array<{fileId, similarity}>} ordenado desc
 */
function searchNearest(query, topN = 50, fileIdFilter = null) {
  return searchNearestAny([query], topN, fileIdFilter);
}

/**
 * Como searchNearest, pero con VARIAS consultas a la vez (los fotogramas de
 * un video arrastrado): cada archivo puntua por la combinacion consulta-huella
 * que mas se parece, contando los momentos de los videos. Asi un clip se
 * encuentra aunque solo coincida con uno de sus instantes.
 *
 * @param {Float32Array[]} queries
 * @param {number} topN
 * @param {Function|null} fileIdFilter - (fileId) => bool. Si false, salta.
 *   Filtrar AQUI y no despues importa: el top-N se cogia del indice entero y
 *   luego se tiraban las huellas de archivos que ya no estan o no se ven; el
 *   23/09/2026, de 50 pedidos solo 25 eran contenido distinto.
 * @returns {Array<{fileId, similarity}>} ordenado desc
 */
function searchNearestAny(queries, topN = 50, fileIdFilter = null) {
  const qs = (Array.isArray(queries) ? queries : [])
    .filter(q => q && q.length === EMBEDDING_DIM)
    .map(q => (q instanceof Float32Array ? q : Float32Array.from(q)));
  if (qs.length === 0) return [];
  const results = [];
  for (const [fileId, emb] of _index.entries()) {
    if (fileIdFilter && !fileIdFilter(fileId)) continue;
    const momentos = _momentos.get(fileId);
    let mejor = -Infinity;
    for (const q of qs) {
      let dot = 0;
      for (let i = 0; i < EMBEDDING_DIM; i++) dot += q[i] * emb[i];
      if (dot > mejor) mejor = dot;
      if (momentos) {
        for (const m of momentos) {
          const d = m.q;
          let s = 0;
          for (let i = 0; i < EMBEDDING_DIM; i++) s += q[i] * d[i];
          s *= m.escala;
          if (s > mejor) mejor = s;
        }
      }
    }
    results.push({ fileId, similarity: mejor });
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
  for (const fileId of _momentos.keys()) {
    if (!set.has(fileId)) { _momentos.delete(fileId); _momentosDirty = true; }
  }
  return removed;
}

function isLoaded() { return _loaded; }
function isDirty() { return _isDirty || _momentosDirty; }

module.exports = {
  load,
  save,
  upsert,
  remove,
  has,
  get,
  size,
  setMomentos,
  getMomentos,
  numMomentos,
  resumenMomentos,
  comprimirHuella,
  searchNearest,
  searchNearestAny,
  pruneOrphans,
  isLoaded,
  isDirty,
  // Exponer para tests
  _encodeB64,
  _decodeB64,
  descomprimirHuella,
};
