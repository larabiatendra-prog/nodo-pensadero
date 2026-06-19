/**
 * People Framing — Pensadero
 *
 * Decide `people_framing` (cuanta gente hay en el plano, en buckets) combinando
 * el conteo REAL de InsightFace con el bucket del VLM. Coste cero: reusa el
 * face_count que ya calculamos.
 *
 * Buckets (interesa la escala, no el numero exacto):
 *   ninguno | individual | pareja | grupo_pequeno | grupo_grande | multitud
 *
 * Por que HIBRIDO con max() y no solo el conteo:
 *  - InsightFace SUBCUENTA: no ve caras de espaldas, muy lejanas o de perfil
 *    extremo. Una "multitud de espaldas" da face_count bajo.
 *  - El VLM SUBESTIMA distinto: cuenta mal pero capta "hay mucha gente".
 *  - Ninguno de los dos SOBRECUENTA (InsightFace filtra por det_score; el VLM
 *    rara vez infla). Por eso el combinador correcto es el MAXIMO: nunca
 *    reportar menos gente de la que la evidencia mas fuerte sugiere.
 */

// Limites superiores (inclusive) de cada bucket por nº de caras. Tunables.
const COUNT_BUCKETS = [
  { max: 0, bucket: 'ninguno' },
  { max: 1, bucket: 'individual' },
  { max: 2, bucket: 'pareja' },
  { max: 6, bucket: 'grupo_pequeno' },
  { max: 15, bucket: 'grupo_grande' },
  { max: Infinity, bucket: 'multitud' },
];

// Orden de menor a mayor "cantidad de gente". Para combinar por maximo.
const ORDER = ['ninguno', 'individual', 'pareja', 'grupo_pequeno', 'grupo_grande', 'multitud'];

function bucketForCount(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
  for (const b of COUNT_BUCKETS) {
    if (n <= b.max) return b.bucket;
  }
  return 'multitud';
}

function ordinal(bucket) {
  const i = ORDER.indexOf(bucket);
  return i < 0 ? -1 : i;
}

/**
 * @param {object} opts
 * @param {number|null} opts.faceCount  conteo de InsightFace (null si no hay datos)
 * @param {string|null} opts.vlmFraming people_framing que dio el VLM
 * @returns {{ people_framing: string|null, source: string }}
 */
function computePeopleFraming({ faceCount, vlmFraming }) {
  const faceBucket = bucketForCount(faceCount);
  const vlmOrd = ordinal(vlmFraming);

  // Sin conteo fiable de caras -> conservar VLM.
  if (faceBucket === null) {
    return { people_framing: vlmFraming || null, source: 'vlm' };
  }
  // Sin valor del VLM -> usar el conteo.
  if (vlmOrd < 0) {
    return { people_framing: faceBucket, source: 'face' };
  }
  // Ambos -> el maximo (ninguno de los dos sobrecuenta; ambos subcuentan).
  const faceOrd = ordinal(faceBucket);
  if (faceOrd >= vlmOrd) return { people_framing: faceBucket, source: 'face' };
  return { people_framing: vlmFraming, source: 'vlm-floor' };
}

module.exports = { computePeopleFraming, bucketForCount, ORDER, COUNT_BUCKETS };
