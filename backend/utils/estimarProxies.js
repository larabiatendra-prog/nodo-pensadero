/**
 * Cuanto tardaria y cuanto ocuparia preparar una lista de videos.
 *
 * Con lo que tarda ESTE equipo (videoProxyService.medirVelocidad) y el tope y
 * el sitio libre de cada disco. Imita al lote: en cuanto un video no cabe en
 * su disco, ese disco se da por lleno y lo que queda de el no se prepara (ni
 * cuenta en el tiempo). Puro, sin disco ni ffmpeg, para poder probarlo.
 */

const GB = 1073741824;

/**
 * @param {Array<{raiz: string, duration?: number}>} videos  en el orden del lote
 * @param {{segPorSegundo: number, arranqueSeg: number} | null} velocidad
 * @param {Record<string, {topeBytes: number, ocupadoBytes: number, libreGB: number|null, minLibreGB: number}>} presupuestos
 * @param {{bytesPorSegundo: number}} opts
 */
function estimarLote(videos, velocidad, presupuestos, opts) {
  const bytesPorSegundo = opts.bytesPorSegundo;
  // Lo que no tiene duracion (sin escanear) cuenta como la media de los demas.
  const conDuracion = videos.filter(v => v.duration > 0);
  const durMedia = conDuracion.length
    ? conDuracion.reduce((a, v) => a + v.duration, 0) / conDuracion.length
    : 0;

  const discos = new Map();
  let n = 0, fuera = 0, bytes = 0, segundos = 0, sinMedir = 0;
  for (const v of videos) {
    let d = discos.get(v.raiz);
    if (!d) {
      const p = presupuestos[v.raiz] || {};
      const porTope = p.topeBytes > 0 ? Math.max(0, p.topeBytes - (p.ocupadoBytes || 0)) : Infinity;
      const porSitio = typeof p.libreGB === 'number'
        ? Math.max(0, (p.libreGB - (p.minLibreGB || 0)) * GB)
        : Infinity;
      d = {
        raiz: v.raiz, n: 0, fuera: 0, bytes: 0,
        disponible: Math.min(porTope, porSitio),
        // Que lo para antes: el tope o quedarse sin sitio.
        limite: porTope === Infinity && porSitio === Infinity ? null : (porTope <= porSitio ? 'tope' : 'sitio'),
        topeGB: p.topeBytes > 0 ? p.topeBytes / GB : 0,
        lleno: false,
      };
      discos.set(v.raiz, d);
    }
    const tieneDuracion = v.duration > 0;
    const dur = tieneDuracion ? v.duration : durMedia;
    const b = dur * bytesPorSegundo;
    if (d.lleno || d.bytes + b > d.disponible) {
      d.lleno = true;
      d.fuera++;
      fuera++;
      continue;
    }
    if (!tieneDuracion) sinMedir++;
    d.n++;
    d.bytes += b;
    n++;
    bytes += b;
    if (velocidad) segundos += dur * velocidad.segPorSegundo + velocidad.arranqueSeg;
  }

  return {
    total: videos.length,
    /** Los que se prepararian. */
    n,
    /** Los que se quedarian sin preparar por el tope o el sitio de su disco. */
    fuera,
    bytes: Math.round(bytes),
    /** De los que se prepararian, cuantos se han estimado sin conocer su duracion. */
    sinMedir,
    segundos: velocidad ? Math.round(segundos) : null,
    discos: [...discos.values()].map(d => ({
      raiz: d.raiz, n: d.n, fuera: d.fuera, bytes: Math.round(d.bytes),
      limite: d.fuera > 0 ? d.limite : null, topeGB: d.topeGB,
    })),
  };
}

module.exports = { estimarLote };
