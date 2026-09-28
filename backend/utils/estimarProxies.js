/**
 * Cuanto tardaria y cuanto ocuparia preparar una lista de videos.
 *
 * Con lo que tarda ESTE equipo (videoProxyService.medirVelocidad) y el tope y
 * el sitio libre de cada disco. Imita al lote y a donde escribe cada proxy
 * (videoProxyService.ubicacionConSitio + getPlayable):
 *  - junto al archivo si a su disco le quedan al menos `minLibreGB` libres;
 *  - si no, en la carpeta de Pensadero (el disco del sistema, `raizSistema`),
 *    si ahi los hay. Sin esto, un disco casi lleno salia como "no se prepara"
 *    cuando en realidad sus proxies iban al del sistema;
 *  - el tope se mira en el disco DONDE se escribe; al llegar, el lote deja de
 *    preparar el disco del archivo (con "liberar" no para: borra lo menos visto).
 * Puro, sin disco ni ffmpeg, para poder probarlo.
 */

const GB = 1073741824;

/**
 * @param {Array<{raiz: string, duration?: number}>} videos  en el orden del lote
 * @param {{segPorSegundo: number, arranqueSeg: number} | null} velocidad
 * @param {Record<string, {topeBytes: number, ocupadoBytes: number, libreGB: number|null, minLibreGB: number, alLlegar?: string}>} presupuestos
 * @param {{bytesPorSegundo: number, raizSistema?: string}} opts
 */
function estimarLote(videos, velocidad, presupuestos, opts) {
  const { bytesPorSegundo, raizSistema } = opts;
  // Lo que no tiene duracion (sin escanear) cuenta como la media de los demas.
  const conDuracion = videos.filter(v => v.duration > 0);
  const durMedia = conDuracion.length
    ? conDuracion.reduce((a, v) => a + v.duration, 0) / conDuracion.length
    : 0;

  const discos = new Map();
  const disco = (raiz) => {
    let d = discos.get(raiz);
    if (!d) {
      const p = presupuestos[raiz] || {};
      const conTope = p.topeBytes > 0 && p.alLlegar !== 'liberar';
      d = {
        raiz,
        // Lo que se puede escribir aqui antes del tope y antes de quedarse corto de sitio.
        porTope: conTope ? Math.max(0, p.topeBytes - (p.ocupadoBytes || 0)) : Infinity,
        porSitio: typeof p.libreGB === 'number' ? Math.max(0, (p.libreGB - (p.minLibreGB || 0)) * GB) : Infinity,
        topeGB: p.topeBytes > 0 ? p.topeBytes / GB : 0,
        escrito: 0,
        // De sus videos: cuantos se preparan, cuantos no, cuanto ocupan y cuantos van al sistema.
        n: 0, fuera: 0, bytes: 0, alSistema: 0, parado: null,
      };
      discos.set(raiz, d);
    }
    return d;
  };

  let n = 0, fuera = 0, bytes = 0, segundos = 0, sinMedir = 0;
  for (const v of videos) {
    const d = disco(v.raiz);
    const tieneDuracion = v.duration > 0;
    const dur = tieneDuracion ? v.duration : durMedia;
    const b = dur * bytesPorSegundo;
    if (d.parado) { d.fuera++; fuera++; continue; }

    let destino = d.escrito + b <= d.porSitio ? d : null;
    if (!destino && raizSistema && raizSistema !== v.raiz) {
      const s = disco(raizSistema);
      if (s.escrito + b <= s.porSitio) destino = s;
    }
    if (!destino) { d.parado = 'sitio'; d.fuera++; fuera++; continue; }
    if (destino.escrito + b > destino.porTope) {
      d.parado = destino === d ? 'tope' : 'tope-sistema';
      d.fuera++;
      fuera++;
      continue;
    }

    destino.escrito += b;
    if (destino !== d) d.alSistema++;
    if (!tieneDuracion) sinMedir++;
    d.n++;
    d.bytes += b;
    n++;
    bytes += b;
    if (velocidad) segundos += dur * velocidad.segPorSegundo + velocidad.arranqueSeg;
  }

  const sistema = raizSistema ? discos.get(raizSistema) : null;
  return {
    total: videos.length,
    /** Los que se prepararian. */
    n,
    /** Los que se quedarian sin preparar por el tope o el sitio. */
    fuera,
    bytes: Math.round(bytes),
    /** De los que se prepararian, cuantos se han estimado sin conocer su duracion. */
    sinMedir,
    segundos: velocidad ? Math.round(segundos) : null,
    raizSistema: raizSistema || null,
    // Solo los discos con videos propios (el del sistema puede estar solo de destino).
    discos: [...discos.values()].filter(d => d.n + d.fuera > 0).map(d => ({
      raiz: d.raiz, n: d.n, fuera: d.fuera, bytes: Math.round(d.bytes), alSistema: d.alSistema,
      limite: d.fuera > 0 ? d.parado : null,
      // El tope que para: el suyo, o el del sistema si sus proxies iban alli.
      topeGB: d.parado === 'tope-sistema' && sistema ? sistema.topeGB : d.topeGB,
    })),
  };
}

module.exports = { estimarLote };
