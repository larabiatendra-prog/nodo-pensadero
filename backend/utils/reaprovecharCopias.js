/**
 * Reaprovechar el escaneo de una copia exacta — Pensadero
 *
 * Un disco de copia de seguridad conectado junto al original tiene miles de
 * archivos iguales byte a byte (services/copiasExactas.js los reconoce por su
 * contenido). Escanearlo era volver a pasar por la grafica lo que ya estaba
 * descrito en el otro disco: horas de trabajo repetido. Caso real (29/09/2026):
 * un disco de 6 TB al 0 % con copias de otro de 10 TB descrito al 99 %.
 *
 * Aqui se decide, sin tocar nada, que archivos pueden copiar la entrada de
 * catalogo de una copia suya ya escaneada: descripcion, etiquetas, caras,
 * colores, huella visual... es el mismo contenido, asi que es el mismo
 * resultado, en segundos y sin grafica. Archivo a archivo: un backup no tiene
 * por que tener lo mismo que el original (ni al reves), y lo que solo esta en
 * un disco se escanea normal. Solo vale si la copia tiene hecho TODO lo que
 * este escaneo iba a hacer; si le falta algo, se escanea normal (mejor
 * repetir que dejar un hueco).
 */

const TRABAJOS = ['descripcion', 'caras', 'busquedaVisual', 'movimiento'];

/** ¿Tiene la entrada una descripcion de verdad? (v2: what; v1: description) */
function tieneDescripcion(e) {
  return !!e && ((typeof e.description_what === 'string' && e.description_what.trim() !== '')
    || (typeof e.description === 'string' && e.description.trim() !== ''));
}

/** ¿La entrada de la copia tiene hecho todo lo que pide `plan`? */
function cubre(entrada, plan, hecho) {
  if (!entrada || !plan) return false;
  let algo = false;
  for (const cap of TRABAJOS) {
    if (!plan[cap]) continue;
    algo = true;
    if (!hecho(entrada, cap)) return false;
  }
  if (plan.descripcion && !tieneDescripcion(entrada)) return false;
  return algo;
}

/**
 * @param {Array<{ruta: string, plan: object}>} candidatos - lo que el escaneo iba a procesar
 * @param {object} deps
 * @param {(ruta: string) => string[]} deps.copiasDe - rutas de sus copias exactas conocidas
 * @param {(ruta: string) => Promise<object|null>} deps.entradaDe - su entrada de catalogo
 * @param {(entrada: object, cap: string) => boolean} deps.hecho - ¿esta hecho ese trabajo?
 * @returns {Promise<Map<string, {entrada: object, de: string}>>} ruta -> entrada a copiar y de donde
 */
async function reaprovechables(candidatos, { copiasDe, entradaDe, hecho }) {
  const r = new Map();
  for (const { ruta, plan } of candidatos || []) {
    for (const otra of copiasDe(ruta) || []) {
      if (!otra || otra.toLowerCase() === String(ruta).toLowerCase()) continue;
      const entrada = await entradaDe(otra);
      if (cubre(entrada, plan, hecho)) {
        r.set(ruta, { entrada, de: otra });
        break;
      }
    }
  }
  return r;
}

/** La entrada que se escribe: la de la copia, con de donde viene. */
function entradaCopiada(entrada, de) {
  const e = JSON.parse(JSON.stringify(entrada));
  delete e.escaneado_en;
  e.reaprovechado_de = { ruta: de, en: new Date().toISOString() };
  return e;
}

module.exports = { reaprovechables, entradaCopiada, cubre, tieneDescripcion };
