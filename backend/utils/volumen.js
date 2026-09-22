/**
 * Que disco es este — Pensadero
 *
 * Una biblioteca se guardaba solo por su ruta, y la ruta lleva la letra de
 * unidad, que Windows reparte segun el orden en que se enchufan los discos.
 * Paso de verdad (20-22/09/2026): la biblioteca `D:\(1) WORKS` apunto un dia
 * a un disco de 20.163 archivos y otro dia a otro de 11.949, con la misma
 * identidad, y cuando el primero volvio como E: se añadio como biblioteca
 * nueva. Favoritos, notas y colecciones de un disco quedaban colgando del otro.
 *
 * El numero de serie del volumen (lo que Node devuelve en `stat.dev` en
 * Windows) es del disco, no de la letra: sobrevive a cambiar de letra y cambia
 * si en esa letra hay otro disco. No escribe nada en los discos del usuario,
 * asi que funciona tambien con los de solo lectura. Solo cambia al formatear.
 */

const fs = require('fs').promises;
const path = require('path');

/** Numero de serie del volumen donde vive `ruta`, o null si no se sabe. */
async function serialDe(ruta) {
  if (!ruta) return null;
  try {
    const st = await fs.stat(ruta);
    // 0 = el sistema no da serie (algunas unidades de red o virtuales): no
    // sirve para distinguir discos, y usarlo daria falsos "otro disco".
    return typeof st.dev === 'number' && st.dev > 0 ? st.dev : null;
  } catch {
    return null;
  }
}

/** "D:" de "D:\\(1) WORKS", o '' si la ruta no empieza por una letra de unidad. */
function unidadDe(ruta) {
  const m = /^([a-z]):/i.exec(String(ruta || ''));
  return m ? `${m[1].toUpperCase()}:` : '';
}

/**
 * Serie de cada letra de unidad montada ahora mismo. Se pregunta una vez por
 * pasada: con varios discos desconectados se buscan todos contra la misma foto.
 * @returns {Promise<Map<string, number>>} "E:" -> serie
 */
async function seriesDeUnidades() {
  const mapa = new Map();
  // A: y B: son disqueteras historicas; preguntar por ellas puede tardar.
  const letras = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  await Promise.all(letras.map(async (l) => {
    const serie = await serialDe(`${l}:\\`);
    if (serie) mapa.set(`${l}:`, serie);
  }));
  return mapa;
}

/**
 * Busca en que letra esta ahora el disco con serie `serie`, con la misma
 * carpeta que tenia la biblioteca. Devuelve la ruta nueva o null.
 * @param {number} serie
 * @param {string} rutaVieja - p. ej. "D:\\(1) WORKS"
 * @param {Map<string, number>} [unidades] - de seriesDeUnidades(), para no repetir
 */
async function buscarDisco(serie, rutaVieja, unidades) {
  if (!serie || !rutaVieja) return null;
  const vieja = unidadDe(rutaVieja);
  if (!vieja) return null;
  const resto = rutaVieja.slice(2); // "\\(1) WORKS" (o "\\" si era la raiz)
  const mapa = unidades || await seriesDeUnidades();
  for (const [letra, s] of mapa) {
    if (s !== serie || letra === vieja) continue;
    const candidata = path.join(`${letra}\\`, resto);
    const st = await fs.stat(candidata).catch(() => null);
    if (st && st.isDirectory()) return candidata;
  }
  return null;
}

module.exports = { serialDe, unidadDe, seriesDeUnidades, buscarDisco };
