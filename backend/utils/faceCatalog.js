/**
 * faceCatalog — helpers compartidos para mantener coherente el bloque
 * `identity` de los _pensadero.json entre TODOS los escritores (scan,
 * re-identify, promote, assign-face).
 *
 * Antes cada escritor reimplementaba estos calculos a su manera, lo que
 * provocaba que el mismo campo (`face_count`) cambiase de significado segun
 * que ruta lo tocara por ultima vez. Aqui se define UNA sola vez.
 */

const GENDER_MAP = { 0: 'mujer', 1: 'hombre' };

function ageBucket(age) {
  if (typeof age !== 'number' || !isFinite(age)) return null;
  if (age < 16) return 'niño';
  if (age < 30) return 'joven';
  if (age < 60) return 'adulto';
  return 'senior';
}

/**
 * Definicion CANONICA de `face_count`, derivada de las detecciones.
 *
 *  - Foto (sin frame_time): numero de caras detectadas.
 *  - Video (detecciones con frame_time): maximo de caras en un MISMO frame.
 *    La misma persona en 3 frames distintos no son 3 personas; el conteo
 *    "personas a la vez" es el unico estable cuando se re-identifica.
 *
 * Se calcula igual en scan y en los mutadores, asi que el valor ya no
 * depende de quien escribio el ultimo.
 */
function computeFaceCount(detections) {
  if (!Array.isArray(detections) || detections.length === 0) return 0;
  const hasFrameTime = detections.some(d => d && typeof d.frame_time === 'number');
  if (!hasFrameTime) return detections.length;
  const byFrame = new Map();
  for (const d of detections) {
    const k = (d && typeof d.frame_time === 'number') ? d.frame_time : -1;
    byFrame.set(k, (byFrame.get(k) || 0) + 1);
  }
  return Math.max(...byFrame.values());
}

/**
 * Reconstruye `identity.faces[]` desde las detecciones: una entrada por
 * person_id, quedandose con la de mayor confidence. Incluye las caras
 * asignadas a mano (que identifyFaces no recupera) porque parte de las
 * detecciones ya persistidas.
 *
 * @param {Array} detections - entry.identity.detections
 * @param {(id: string) => string} getDisplayName - resolver de nombre
 * @returns {Array<{person_id, display_name, confidence}>}
 */
function rebuildFaces(detections, getDisplayName) {
  const byId = new Map();
  if (!Array.isArray(detections)) return [];
  for (const d of detections) {
    if (!d || !d.person_id) continue;
    const prev = byId.get(d.person_id);
    if (!prev || (d.confidence || 0) > (prev.confidence || 0)) {
      byId.set(d.person_id, {
        person_id: d.person_id,
        display_name: d.display_name
          || (typeof getDisplayName === 'function' ? getDisplayName(d.person_id) : null)
          || d.person_id,
        confidence: d.confidence || 0,
      });
    }
  }
  return Array.from(byId.values());
}

/**
 * Infiere demografia (age_ranges, genders) desde TODAS las detecciones.
 * Devuelve `{ age_ranges?, genders? }` solo con las claves que tengan datos.
 */
function inferDemographics(detections) {
  const ageRanges = new Set();
  const genders = new Set();
  if (Array.isArray(detections)) {
    for (const d of detections) {
      const a = ageBucket(d && d.age);
      if (a) ageRanges.add(a);
      if (d && d.gender != null && GENDER_MAP[d.gender]) genders.add(GENDER_MAP[d.gender]);
    }
  }
  const out = {};
  if (ageRanges.size > 0) out.age_ranges = Array.from(ageRanges);
  if (genders.size > 0) out.genders = Array.from(genders);
  return out;
}

/**
 * Fusiona la identidad PREVIA de una entry con la recien escaneada, para que un
 * re-escaneo con force no borre el trabajo humano.
 *
 * El escaneo sustituye la entry entera (`photos[basename] = entry`), asi que
 * antes de esto un re-escaneo —el boton "volver a escanear" de la tarjeta usa
 * force siempre— se llevaba por delante las caras asignadas a mano, y si las
 * caras no estaban disponibles en ese momento, TODOS los embeddings del
 * archivo, que no se recuperan sin volver a correr InsightFace.
 *
 * Regla: lo que el escaneo NO ha vuelto a derivar, no lo tira.
 *
 *  1. Sin detecciones nuevas (caras caidas o desactivadas): se conserva el
 *     bloque facial anterior tal cual. No hemos aprendido nada nuevo de caras;
 *     tirar lo que habia seria perder informacion a cambio de nada.
 *  2. Con detecciones nuevas: cada deteccion vieja `assigned_manually` se
 *     re-ancla a la nueva cara que corresponda, emparejando por coseno de los
 *     embeddings (mismo archivo + detector determinista ⇒ practicamente 1.0).
 *     Si esa cara ya no se detecta, la deteccion vieja se conserva en la lista
 *     en vez de desaparecer: es una afirmacion del usuario, no un calculo.
 *
 * Las etiquetas AUTOMATICAS no se conservan a proposito: se recalculan sobre
 * los embeddings frescos, que es justo para lo que sirve re-escanear. Las del
 * promote forzado van marcadas `assigned_manually`, asi que entran en la regla 2.
 *
 * No toca `spaces` (lo que traiga el escaneo nuevo manda): tiene su propio
 * re-identificador y no guarda decisiones humanas.
 *
 * @param {object|null} prevIdentity - `identity` de la entry que ya estaba
 * @param {object|null} nextIdentity - `identity` recien calculada
 * @param {object} opts
 *   - decodeEmbedding: fn(b64) → Float32Array(512)|null (se inyecta para que
 *     este modulo siga sin dependencias)
 *   - getDisplayName: fn(person_id) → string
 *   - anchorThreshold: coseno minimo para dar por la MISMA cara (default 0.9)
 * @returns {{ identity: object, stats: { reancladas: number, conservadas: number, bloquePrevio: boolean } }}
 */
function mergeIdentityOnRescan(prevIdentity, nextIdentity, opts = {}) {
  const { decodeEmbedding, getDisplayName, anchorThreshold = 0.9 } = opts;
  const out = { ...(nextIdentity || {}) };
  const stats = { reancladas: 0, conservadas: 0, bloquePrevio: false };

  const prevDets = prevIdentity && Array.isArray(prevIdentity.detections)
    ? prevIdentity.detections : null;
  if (!prevDets) return { identity: out, stats };

  // Caso 1: el escaneo no ha producido bloque de caras. Conservar el previo.
  if (!Array.isArray(out.detections)) {
    out.detections = prevDets.map(d => ({ ...d }));
    out.faces = Array.isArray(prevIdentity.faces)
      ? prevIdentity.faces.map(f => ({ ...f }))
      : rebuildFaces(prevDets, getDisplayName);
    out.face_count = typeof prevIdentity.face_count === 'number'
      ? prevIdentity.face_count : computeFaceCount(prevDets);
    if (typeof prevIdentity.detection_frame_time === 'number') {
      out.detection_frame_time = prevIdentity.detection_frame_time;
    }
    stats.bloquePrevio = true;
    return { identity: out, stats };
  }

  // Caso 2: hay detecciones nuevas. Arrastrar solo lo asignado a mano.
  const manuales = prevDets.filter(d => d && d.assigned_manually && d.person_id);
  if (manuales.length === 0) return { identity: out, stats };

  // Copia propia: este helper NO muta lo que le pasan. El resto del modulo es
  // puro y el llamador reasigna el resultado, asi que devolver alias seria un
  // filo innecesario.
  const dets = out.detections.map(d => ({ ...d }));
  out.detections = dets;
  const usadas = new Set();
  const decode = typeof decodeEmbedding === 'function' ? decodeEmbedding : () => null;

  for (const vieja of manuales) {
    const embVieja = decode(vieja.embedding_b64);
    let mejorIdx = -1;
    let mejorSim = -1;
    if (embVieja && embVieja.length === 512) {
      for (let i = 0; i < dets.length; i++) {
        if (usadas.has(i)) continue;
        const e = decode(dets[i] && dets[i].embedding_b64);
        if (!e || e.length !== 512) continue;
        let dot = 0;
        for (let k = 0; k < 512; k++) dot += embVieja[k] * e[k];
        if (dot > mejorSim) { mejorSim = dot; mejorIdx = i; }
      }
    }

    if (mejorIdx >= 0 && mejorSim >= anchorThreshold) {
      const d = dets[mejorIdx];
      usadas.add(mejorIdx);
      d.person_id = vieja.person_id;
      d.display_name = vieja.display_name
        || (typeof getDisplayName === 'function' ? getDisplayName(vieja.person_id) : vieja.person_id);
      d.confidence = typeof vieja.confidence === 'number' ? vieja.confidence : 1.0;
      d.assigned_manually = true;
      stats.reancladas++;
    } else {
      // Esa cara ya no se detecta. Conservar la deteccion vieja entera: lleva
      // su bbox, su embedding y su frame_time, asi que sigue siendo coherente.
      dets.push({ ...vieja });
      stats.conservadas++;
    }
  }

  out.faces = rebuildFaces(dets, getDisplayName);
  out.face_count = computeFaceCount(dets);
  return { identity: out, stats };
}

module.exports = {
  computeFaceCount,
  rebuildFaces,
  inferDemographics,
  mergeIdentityOnRescan,
  ageBucket,
  GENDER_MAP,
};
