/**
 * Time of Day — Pensadero
 *
 * Decide `time_of_day` a partir de la HORA REAL DE CAPTURA (metadata), no de la
 * luz que adivina el VLM (que falla: un interior de noche parece de dia). Coste
 * casi cero: el timestamp ya viene en metadata que leemos igualmente (ffprobe
 * para video, EXIF de sharp para foto).
 *
 * Matiz de zona horaria IMPORTANTE:
 *  - EXIF DateTimeOriginal (foto) es hora LOCAL de pared, sin TZ. exif-reader la
 *    devuelve como Date marcada en UTC -> getUTCHours() recupera la hora del
 *    reloj tal cual. NO aplicar offset. Confianza alta.
 *  - creation_time (video) suele ser UTC real -> hay que sumar el offset local
 *    para obtener la hora de pared. El offset exacto depende de verano/invierno;
 *    usamos uno configurable (CAPTURE_TZ_OFFSET_HOURS, default +1 Madrid). Error
 *    de ~1h posible cerca de fronteras -> confianza media.
 *
 * Si no hay timestamp valido, se conserva el time_of_day del VLM.
 */

const TZ_OFFSET = parseInt(process.env.CAPTURE_TZ_OFFSET_HOURS || '1', 10);

// Hora local (0-23) -> bucket. Tunable.
function bucketForHour(h) {
  if (typeof h !== 'number' || !isFinite(h)) return null;
  const hour = ((Math.floor(h) % 24) + 24) % 24;
  if (hour <= 5) return 'noche';
  if (hour <= 7) return 'amanecer';
  if (hour <= 11) return 'manana';
  if (hour <= 14) return 'mediodia';
  if (hour <= 18) return 'tarde';
  if (hour <= 20) return 'atardecer';
  return 'noche';
}

/**
 * @param {object} opts
 * @param {string|null} opts.captureTimeISO  timestamp de captura (ISO) o null
 * @param {boolean} opts.isVideo  true si viene de creation_time (UTC, aplica TZ);
 *                                 false si viene de EXIF (hora local de pared)
 * @param {string|null} opts.vlmTimeOfDay  valor del VLM (fallback)
 * @returns {{ time_of_day: string|null, source: string, confidence: string }}
 */
function computeTimeOfDay({ captureTimeISO, isVideo, vlmTimeOfDay }) {
  if (captureTimeISO) {
    const d = new Date(captureTimeISO);
    if (!isNaN(d.getTime())) {
      // getUTCHours() devuelve la hora "tal cual" esta escrita en el ISO.
      let hour = d.getUTCHours();
      if (isVideo) hour = ((hour + TZ_OFFSET) % 24 + 24) % 24; // UTC -> local
      const bucket = bucketForHour(hour);
      if (bucket) {
        // Foto = hora local exacta (alta). Video = UTC+offset aproximado (media).
        return { time_of_day: bucket, source: isVideo ? 'meta-video' : 'meta-exif',
                 confidence: isVideo ? 'media' : 'alta' };
      }
    }
  }
  return { time_of_day: vlmTimeOfDay || null, source: 'vlm', confidence: 'media' };
}

module.exports = { computeTimeOfDay, bucketForHour };
