/**
 * Shot Type — Pensadero
 *
 * Decide el `shot_type` (tipo de plano) combinando dos fuentes segun el caso,
 * SIN coste extra: reusa el bbox de cara que InsightFace ya calculo y el
 * shot_type que el VLM ya produjo.
 *
 * Por que hibrido (validado sobre 2 corpus distintos, EDEM y Lanzadera):
 *  - El VLM es CIEGO al tamaño de la persona en el cuadro: llama "plano_medio"
 *    tanto a un primer plano como a un plano entero. Falla la "escalera de
 *    cuerpo" (general -> americano -> medio -> primer_plano).
 *  - Pero el VLM SI acierta la escala de escena sin personas (general vs
 *    detalle) y distingue grupo/multitud (conjunto).
 *
 * Reparto:
 *  - Hay cara detectada  -> shot_type por RATIO alto_cara/alto_frame (geometrico,
 *    arregla lo que el VLM falla).
 *  - No hay cara         -> se conserva el shot_type del VLM (bueno en escena).
 *  - VLM dijo plano_detalle -> manda el VLM: "detalle" es semantico (una mano,
 *    un ojo, una textura), la ratio no lo puede saber.
 *
 * Umbrales PROVISIONALES (calibrar en NODO con InsightFace real; con Haar en el
 * Dell las ratios eran ruidosas). Expuestos para ajuste facil.
 */

// ratio = alto_bbox_cara / alto_frame. Buckets de mayor a menor cercania.
// medio_corto y americano se funden de momento (frontera estrecha y ruidosa);
// se separan al calibrar si InsightFace da ratios limpias.
const SHOT_THRESHOLDS = [
  { min: 0.40, shot: 'primer_plano' },
  { min: 0.18, shot: 'plano_medio' },
  { min: 0.10, shot: 'plano_americano' },
  { min: 0.045, shot: 'plano_conjunto' },
  { min: 0.0, shot: 'plano_general' },
];

// Margen relativo a una frontera dentro del cual la decision es dudosa.
const BOUNDARY_REL_MARGIN = 0.12;

/**
 * Ratio (alto_cara/alto_frame) de la cara MAS GRANDE entre las detecciones.
 * Cada deteccion trae img_h (alto de la imagen donde se detecto). Devuelve null
 * si no hay detecciones validas.
 */
function largestFaceRatio(detections) {
  if (!Array.isArray(detections) || detections.length === 0) return null;
  let best = null;
  for (const d of detections) {
    const bbox = d && d.bbox;
    const imgH = d && d.img_h;
    if (!Array.isArray(bbox) || bbox.length < 4 || !imgH) continue;
    const faceH = bbox[3] - bbox[1];
    if (!(faceH > 0)) continue;
    const ratio = faceH / imgH;
    if (best === null || ratio > best) best = ratio;
  }
  return best;
}

function bucketForRatio(ratio) {
  for (const t of SHOT_THRESHOLDS) {
    if (ratio >= t.min) return t.shot;
  }
  return 'plano_general';
}

/** 'media' si la ratio cae cerca de una frontera; 'alta' si no. */
function ratioConfidence(ratio) {
  for (const t of SHOT_THRESHOLDS) {
    if (t.min <= 0) continue;
    const rel = Math.abs(ratio - t.min) / t.min;
    if (rel < BOUNDARY_REL_MARGIN) return 'media';
  }
  return 'alta';
}

/**
 * Calcula el shot_type final.
 * @param {object} opts
 * @param {Array}  opts.detections  detecciones InsightFace [{bbox, img_h, ...}]
 * @param {string} opts.vlmShotType shot_type que dio el VLM (puede ser null)
 * @returns {{ shot_type: string|null, source: string, confidence: string, ratio: number|null }}
 */
function computeShotType({ detections, vlmShotType }) {
  // 1) "detalle" es semantico: lo decide el VLM, manda sobre la geometria.
  if (vlmShotType === 'plano_detalle') {
    return { shot_type: 'plano_detalle', source: 'vlm-detalle', confidence: 'media', ratio: null };
  }

  // 2) Hay cara -> ratio manda (arregla la escalera de cuerpo).
  const ratio = largestFaceRatio(detections);
  if (ratio !== null) {
    return {
      shot_type: bucketForRatio(ratio),
      source: 'face',
      confidence: ratioConfidence(ratio),
      ratio: Math.round(ratio * 1000) / 1000,
    };
  }

  // 3) Sin cara -> se conserva el VLM (bueno en escena: general/conjunto).
  return { shot_type: vlmShotType || null, source: 'vlm', confidence: 'media', ratio: null };
}

module.exports = { computeShotType, largestFaceRatio, bucketForRatio, SHOT_THRESHOLDS };
