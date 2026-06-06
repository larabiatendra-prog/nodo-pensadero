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

module.exports = { computeFaceCount, rebuildFaces, inferDemographics, ageBucket, GENDER_MAP };
