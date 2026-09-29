/**
 * Proxies que se quedan sin enlazar al cambiar de letra un disco — Pensadero
 *
 * El indice de proxies (video_proxies.json) va por fileId, y el fileId es el
 * md5 de la ruta COMPLETA, letra incluida. Si el disco pasa de D: a X:, cada
 * video tiene otro fileId y su proxy (que sigue en el disco, junto al video)
 * deja de encontrarse: sale como "sin previsualizar" y el lote lo volveria a
 * preparar. Paso de verdad (29/09/2026): 11.117 proxies (165 GB) del LaCie
 * 10TB hechos cuando era D:, sin enlazar tras pasar por E: y quedarse en X:.
 *
 * Aqui se decide, sin tocar nada, que entradas del indice son de que video:
 * para un video sin entrada se prueba su misma ruta con las otras letras. Solo
 * vale si la fecha del video es la del proxy (es el mismo archivo) y, si hay
 * proxy, si esta junto a ESTE video (dos discos con la misma carpeta tienen
 * rutas iguales con otra letra: el proxy del otro disco no esta aqui) o en la
 * carpeta del sistema. Puro: md5, "existe" y la carpeta del sistema llegan de
 * fuera, para poder probarlo sin discos.
 */

const path = require('path');

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
// La fecha la da el sistema de archivos al milisegundo, pero la del catalogo
// puede venir redondeada: con 2 s basta para saber que es el mismo archivo.
const MARGEN_FECHA_MS = 2000;

/**
 * @param {Array<{id: string, fullPath: string, mtimeMs: number}>} videos
 * @param {Record<string, object>} index - fileId -> entrada
 * @param {object} deps
 * @param {(ruta: string) => string} deps.idDe - fileId de una ruta (md5)
 * @param {(ruta: string) => Promise<boolean>} deps.existe
 * @param {(fullPath: string, fileId: string) => string} deps.junto - donde va el proxy junto al video
 * @param {string} [deps.dirSistema] - carpeta de proxies del disco del sistema
 * @returns {Promise<Array<{viejo: string, nuevo: string, de: string|null, a: string|null}>>}
 *   `de`/`a`: el archivo del proxy a renombrar (null en los nativos, sin archivo)
 */
async function planReenlace(videos, index, { idDe, existe, junto, dirSistema }) {
  const vivos = new Set(videos.map(v => v.id));
  const usados = new Set();
  const plan = [];
  for (const v of videos) {
    if (!v || !v.id || !v.fullPath || index[v.id]) continue;
    const m = /^([a-z]):/i.exec(v.fullPath);
    if (!m) continue;
    const suya = m[1].toUpperCase();
    // Una letra que no encaja no descarta las demas: el mismo video pudo
    // tener entrada con dos letras (la buena y la de otro disco).
    for (const L of LETRAS) {
      if (L === suya) continue;
      const viejo = idDe(L + v.fullPath.slice(1));
      const e = index[viejo];
      if (!e || (e.status !== 'ready' && e.status !== 'native')) continue;
      // Otro archivo que esta ahora en esa ruta es su dueño, no este.
      if (vivos.has(viejo) || usados.has(viejo)) continue;
      if (!(Math.abs((e.srcMtime || 0) - (v.mtimeMs || 0)) <= MARGEN_FECHA_MS)) continue;
      let paso = null;
      if (e.status === 'native') {
        paso = { viejo, nuevo: v.id, de: null, a: null };
      } else if (await existe(junto(v.fullPath, viejo))) {
        paso = { viejo, nuevo: v.id, de: junto(v.fullPath, viejo), a: junto(v.fullPath, v.id) };
      } else if (dirSistema && e.ruta && path.dirname(e.ruta).toLowerCase() === dirSistema.toLowerCase() && await existe(e.ruta)) {
        paso = { viejo, nuevo: v.id, de: e.ruta, a: path.join(dirSistema, `${v.id}.mp4`) };
      }
      if (!paso) continue;
      plan.push(paso);
      usados.add(viejo);
      break;
    }
  }
  return plan;
}

module.exports = { planReenlace, MARGEN_FECHA_MS };
