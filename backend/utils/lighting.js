/**
 * Lighting — Pensadero
 *
 * Ajuste CONSERVADOR de `lighting` con señales algoritmicas gratis. A diferencia
 * de shot_type/movement/people_framing/time_of_day, aqui el VLM NO es claramente
 * malo (ve el contexto de la escena) y las estadisticas de imagen son
 * ambiguas: brillo bajo puede ser noche O interior tenue; calido puede ser hora
 * dorada O luz de tungsteno. Por eso aqui NO se sustituye al VLM en general.
 *
 * Unico override seguro: cruzar DOS señales independientes que se refuerzan —
 * escena oscura (brillo) + hora real de captura de noche (metadata, time_of_day)
 * -> "nocturna". Ninguna de las dos sola basta; juntas son fiables. Cualquier
 * otro caso conserva el lighting del VLM.
 *
 * El resto de valores (luz_dorada, contraluz, neon, interior, mixta) los sigue
 * decidiendo el VLM: requieren contexto espacial/semantico que el brillo medio y
 * la paleta no capturan sin alto riesgo de falso positivo.
 */

const DARK_THRESHOLD = parseFloat(process.env.LIGHTING_DARK_THRESHOLD || '0.22');

/**
 * @param {object} opts
 * @param {number|null} opts.brightness  brillo medio 0-1 (colorAnalyzer) o null
 * @param {string|null} opts.timeOfDay   time_of_day ya resuelto (idealmente de metadata)
 * @param {string|null} opts.vlmLighting lighting del VLM (fallback / valor por defecto)
 * @returns {{ lighting: string|null, source: string }}
 */
function computeLighting({ brightness, timeOfDay, vlmLighting }) {
  if (typeof brightness === 'number' && brightness < DARK_THRESHOLD && timeOfDay === 'noche') {
    // Oscuro + capturado de noche = nocturna con alta certeza.
    return { lighting: 'nocturna', source: vlmLighting === 'nocturna' ? 'vlm' : 'stats+time' };
  }
  return { lighting: vlmLighting || null, source: 'vlm' };
}

module.exports = { computeLighting };
