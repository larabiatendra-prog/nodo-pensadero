/**
 * XML para Premiere (y DaVinci): el formato de Final Cut 7 (`xmeml`), que
 * Premiere importa de siempre.
 *
 * Puro: recibe los clips ya medidos (y ya filtrados por candado) y devuelve
 * el texto. Lo que se escribe imita la forma en que el propio Premiere
 * exporta un clip maestro (clip > media > track > clipitem > file), que es la
 * que mejor se lee de vuelta.
 *
 * Un clip: { nombre, ruta, tipo ('video'|'image'|'audio'), duracionS, fps,
 *   ancho, alto, audio (bool), canales, frecuencia, dia (AAAAMMDD), minuto,
 *   carpeta, personas [], descripcion, nota, favorito }
 */

const SEGUNDOS_FOTO = 5;
const FPS_POR_DEFECTO = 25;
// Las cadencias de video que van a 1000/1001 (NTSC).
const NTSC = [23.976, 29.97, 47.952, 59.94, 119.88];
// Etiqueta de color de Premiere para los favoritos.
const ETIQUETA_FAVORITO = 'Mango';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function rateDe(fps) {
  const f = Number(fps) > 0 ? Number(fps) : FPS_POR_DEFECTO;
  const n = NTSC.find(x => Math.abs(f - x) < 0.01);
  if (n) {
    const timebase = Math.round(n);
    return { timebase, ntsc: true, real: timebase * 1000 / 1001 };
  }
  const timebase = Math.max(1, Math.round(f));
  return { timebase, ntsc: false, real: timebase };
}

const fotogramas = (segundos, rate) => Math.max(1, Math.round((Number(segundos) || 0) * rate.real));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Caracteres de control que XML no admite.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/**
 * Ruta de Windows -> pathurl de Premiere: "file://localhost/C%3a/Videos/a%20b.mp4".
 * Cada tramo va escapado (tildes, espacios, &, #, %). Una ruta de red
 * (\\servidor\carpeta) queda "file://servidor/carpeta/...".
 */
function pathurl(ruta) {
  const r = String(ruta || '');
  const red = /^\\\\([^\\]+)\\(.*)$/.exec(r);
  if (red) {
    return `file://${red[1]}/` + red[2].split(/[\\/]/).map(encodeURIComponent).join('/');
  }
  const tramos = r.split(/[\\/]/).filter((t, i) => t !== '' || i === 0);
  return 'file://localhost/' + tramos.map(t => encodeURIComponent(t).replace(/%3A/g, '%3a')).join('/');
}

function nombreDeDia(dia) {
  const s = String(dia || '');
  if (!/^\d{8}$/.test(s)) return 'Sin fecha';
  const mes = MESES[parseInt(s.slice(4, 6), 10) - 1];
  if (!mes) return 'Sin fecha';
  return `${parseInt(s.slice(6, 8), 10)} ${mes} ${s.slice(0, 4)}`;
}

const porFecha = (a, b) =>
  (Number(a.dia) || 99999999) - (Number(b.dia) || 99999999)
  || (Number(a.minuto) || 0) - (Number(b.minuto) || 0)
  || String(a.nombre).localeCompare(String(b.nombre), 'es', { numeric: true });

/**
 * Reparte los clips en bandejas. Devuelve [{ nombre, clips }]; una bandeja
 * sin nombre significa "sin sub-bandejas". Por persona, un clip con dos
 * personas sale en las dos (es lo que se espera de una bandeja por persona).
 */
function agrupar(clips, ordenar) {
  const mapa = new Map();
  const meter = (clave, nombre, clip) => {
    if (!mapa.has(clave)) mapa.set(clave, { nombre, clips: [] });
    mapa.get(clave).clips.push(clip);
  };
  for (const c of clips) {
    if (ordenar === 'dia') {
      meter(/^\d{8}$/.test(String(c.dia)) ? String(c.dia) : '99999999', nombreDeDia(c.dia), c);
    } else if (ordenar === 'persona') {
      const personas = Array.from(new Set((c.personas || []).filter(Boolean)));
      if (personas.length === 0) meter('￿', 'Sin nadie', c);
      for (const p of personas) meter(p.toLocaleLowerCase('es'), p, c);
    } else if (ordenar === 'carpeta') {
      const carpeta = String(c.carpeta || '').trim() || 'Sin carpeta';
      meter(carpeta.toLocaleLowerCase('es'), carpeta, c);
    } else {
      meter('', '', c);
    }
  }
  const bandejas = Array.from(mapa.entries())
    .sort(([a], [b]) => a.localeCompare(b, 'es', { numeric: true }))
    .map(([, v]) => ({ nombre: v.nombre, clips: v.clips.slice().sort(porFecha) }));
  return bandejas;
}

const rateXml = (r) => `<rate><timebase>${r.timebase}</timebase><ntsc>${r.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;

/** Lo que se sabe del clip, para las columnas y los marcadores de Premiere. */
function textosDe(c) {
  const personas = Array.from(new Set((c.personas || []).filter(Boolean)));
  return {
    descripcion: String(c.descripcion || '').trim(),
    nota: String(c.nota || '').trim(),
    personas: personas.join(', '),
  };
}

/**
 * construirXml({ nombre, ordenar, marcadores, secuencia }, clips) -> string
 * `clips` en el orden en que se quieren en la secuencia.
 */
function construirXml(opciones, clips) {
  const o = opciones || {};
  const nombre = String(o.nombre || 'Pensadero').trim() || 'Pensadero';
  const ordenar = ['dia', 'persona', 'carpeta', 'todo'].includes(o.ordenar) ? o.ordenar : 'dia';
  const conMarcadores = o.marcadores !== false;
  const lista = (clips || []).filter(c => c && c.ruta);

  let siguiente = 0;
  const nuevoId = (prefijo) => `${prefijo}-${++siguiente}`;

  // Un <file> por archivo: se define entero la primera vez y despues se cita.
  const archivos = new Map(); // clip -> { id, definido, master }
  const fileDe = (c) => {
    if (!archivos.has(c)) archivos.set(c, { id: nuevoId('file'), definido: false, master: null });
    return archivos.get(c);
  };

  const rateClip = (c) => rateDe(c.tipo === 'video' ? c.fps : FPS_POR_DEFECTO);
  const durClip = (c) => (c.tipo === 'image' ? SEGUNDOS_FOTO : c.duracionS);

  function fileXml(c) {
    const f = fileDe(c);
    if (f.definido) return `<file id="${f.id}"/>`;
    f.definido = true;
    const r = rateClip(c);
    const media = [];
    if (c.tipo !== 'audio') {
      media.push('<video><samplecharacteristics>' + rateXml(r)
        + (c.ancho ? `<width>${Math.round(c.ancho)}</width>` : '')
        + (c.alto ? `<height>${Math.round(c.alto)}</height>` : '')
        + '<anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>'
        + '</samplecharacteristics></video>');
    }
    if (c.tipo === 'audio' || (c.tipo === 'video' && c.audio)) {
      media.push('<audio><samplecharacteristics><depth>16</depth>'
        + `<samplerate>${Math.round(c.frecuencia || 48000)}</samplerate></samplecharacteristics>`
        + `<channelcount>${Math.max(1, Math.round(c.canales || 2))}</channelcount></audio>`);
    }
    return `<file id="${f.id}"><name>${esc(c.nombre)}</name><pathurl>${esc(pathurl(c.ruta))}</pathurl>`
      + rateXml(r) + `<duration>${fotogramas(durClip(c), r)}</duration>`
      + `<media>${media.join('')}</media></file>`;
  }

  function clipXml(c) {
    const r = rateClip(c);
    const dur = fotogramas(durClip(c), r);
    const master = nuevoId('masterclip');
    const f = fileDe(c);
    if (!f.master) f.master = master;
    const t = textosDe(c);
    const pistas = [];
    if (c.tipo !== 'audio') {
      pistas.push(`<video><track><clipitem id="${nuevoId('clipitem')}"><masterclipid>${master}</masterclipid>`
        + `<name>${esc(c.nombre)}</name>${rateXml(r)}<alphatype>none</alphatype>`
        + '<pixelaspectratio>square</pixelaspectratio><anamorphic>FALSE</anamorphic>'
        + `${fileXml(c)}</clipitem></track></video>`);
    }
    if (c.tipo === 'audio' || (c.tipo === 'video' && c.audio)) {
      pistas.push(`<audio><track><clipitem id="${nuevoId('clipitem')}"><masterclipid>${master}</masterclipid>`
        + `<name>${esc(c.nombre)}</name>${rateXml(r)}${fileXml(c)}`
        + '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>'
        + '</clipitem></track></audio>');
    }
    let xml = `<clip id="${master}" explodedTracks="true"><masterclipid>${master}</masterclipid>`
      + `<ismasterclip>TRUE</ismasterclip><duration>${dur}</duration>${rateXml(r)}`
      + `<name>${esc(c.nombre)}</name><media>${pistas.join('')}</media>`
      // Descripcion -> «Descripción»; personas -> «Nota de registro»; nota -> «Comentario».
      + '<logginginfo>'
      + `<description>${esc(t.descripcion)}</description><scene></scene><shottake></shottake>`
      + `<lognote>${esc(t.personas)}</lognote><good>${c.favorito ? 'TRUE' : 'FALSE'}</good>`
      + '</logginginfo>'
      + (t.nota ? `<comments><mastercomment1>${esc(t.nota)}</mastercomment1></comments>` : '')
      + (c.favorito ? `<labels><label2>${ETIQUETA_FAVORITO}</label2></labels>` : '');
    if (conMarcadores) {
      if (t.nota) xml += `<marker><name>Nota</name><comment>${esc(t.nota)}</comment><in>0</in><out>-1</out></marker>`;
      if (t.descripcion) {
        const titulo = t.personas || 'Pensadero';
        xml += `<marker><name>${esc(titulo)}</name><comment>${esc(t.descripcion)}</comment><in>0</in><out>-1</out></marker>`;
      }
    }
    return xml + '</clip>';
  }

  const bandejas = agrupar(lista, ordenar);
  const hijos = [];
  for (const b of bandejas) {
    const clipsXml = b.clips.map(clipXml).join('');
    hijos.push(b.nombre ? `<bin><name>${esc(b.nombre)}</name><children>${clipsXml}</children></bin>` : clipsXml);
  }

  if (o.secuencia && lista.length > 0) hijos.push(secuenciaXml(nombre, lista));

  function secuenciaXml(titulo, orden) {
    const fmt = formatoSecuencia(orden);
    const r = rateDe(fmt.fps);
    let t = 0;
    const video = [];
    const audio = [];
    for (const c of orden) {
      const f = fileDe(c);
      const dur = fotogramas(durClip(c), r);
      const base = `<masterclipid>${f.master}</masterclipid><name>${esc(c.nombre)}</name><enabled>TRUE</enabled>`
        + `<duration>${dur}</duration>${rateXml(r)}<start>${t}</start><end>${t + dur}</end><in>0</in><out>${dur}</out>`;
      if (c.tipo !== 'audio') video.push(`<clipitem id="${nuevoId('clipitem')}">${base}${fileXml(c)}</clipitem>`);
      if (c.tipo === 'audio' || (c.tipo === 'video' && c.audio)) {
        audio.push(`<clipitem id="${nuevoId('clipitem')}">${base}${fileXml(c)}`
          + '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>');
      }
      t += dur;
    }
    return `<sequence id="${nuevoId('sequence')}"><name>${esc(titulo)}</name><duration>${t}</duration>${rateXml(r)}`
      + '<media><video><format><samplecharacteristics>' + rateXml(r)
      + `<width>${fmt.ancho}</width><height>${fmt.alto}</height>`
      + '<anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>'
      + `</samplecharacteristics></format><track>${video.join('')}</track></video>`
      + '<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth>'
      + `<samplerate>48000</samplerate></samplecharacteristics></format><track>${audio.join('')}</track></audio>`
      + '</media></sequence>';
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">'
    // Todo dentro de UNA bandeja, como exporta Final Cut una bandeja. Probado en
    // Premiere 26.2 (12/10/2026): con <project> alrededor dice «el proyecto
    // parece dañado»; con las bandejas sueltas solo trae la secuencia. Los
    // clips que el proyecto ya tiene no se duplican: Premiere reutiliza los
    // suyos y se salta la sub-bandeja que quedaria vacia.
    + `<bin><name>${esc(nombre)}</name><children>${hijos.join('')}</children></bin></xmeml>\n`;
}

/**
 * Ajustes de la secuencia: el tamaño y la cadencia del video mas comun
 * (por numero de clips). Sin videos, 1920x1080 a 25.
 */
function formatoSecuencia(clips) {
  const cuenta = new Map();
  for (const c of clips) {
    if (c.tipo !== 'video' || !c.ancho || !c.alto) continue;
    const r = rateDe(c.fps);
    const k = `${Math.round(c.ancho)}x${Math.round(c.alto)}@${r.timebase}${r.ntsc ? 'n' : ''}`;
    const prev = cuenta.get(k) || { n: 0, ancho: Math.round(c.ancho), alto: Math.round(c.alto), fps: c.fps };
    prev.n++;
    cuenta.set(k, prev);
  }
  const mejor = Array.from(cuenta.values()).sort((a, b) => b.n - a.n)[0];
  return mejor || { ancho: 1920, alto: 1080, fps: FPS_POR_DEFECTO };
}

/** Cadencias distintas entre los videos (para avisar al crear la secuencia). */
function cadenciasDistintas(clips) {
  const s = new Set();
  for (const c of clips) {
    if (c.tipo !== 'video' || !(Number(c.fps) > 0)) continue;
    const r = rateDe(c.fps);
    s.add(r.ntsc ? Math.round(r.real * 100) / 100 : r.timebase);
  }
  return Array.from(s).sort((a, b) => a - b);
}

/** Nombre de archivo valido en Windows (y en el DownloadURL de Chrome, sin ':'). */
function nombreDeArchivo(nombre) {
  const base = String(nombre || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 90);
  return (base || 'Pensadero') + '.xml';
}

module.exports = {
  construirXml, agrupar, rateDe, pathurl, nombreDeDia, formatoSecuencia, cadenciasDistintas, nombreDeArchivo,
  SEGUNDOS_FOTO,
};
