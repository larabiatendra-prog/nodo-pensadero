/**
 * La fecha de un archivo — Pensadero
 *
 * UN solo sitio donde se decide de cuando es un archivo. Hasta el 20/09/2026
 * habia tres calculos distintos (el servidor leia el nombre de una forma, la
 * galeria de otra, y los filtros por año/mes miraban un campo que 639 archivos
 * no tenian, asi que desaparecian al filtrar aunque Estadisticas los contara).
 *
 * Orden de prioridad, de la señal mas intencional a la mas cruda:
 *
 *  1. El NOMBRE (el de presentacion o el fisico): "190907_Bioritme",
 *     "IMG_20190907_120000", "IMG-20190907-WA0001", "... 06_03_2025".
 *     Si alguien escribio ahi la fecha, esa manda. Medido: de 424 archivos con
 *     fecha en el nombre y metadatos, los 419 que se contradicen llevan
 *     metadatos POSTERIORES: son exports y renders, y el nombre dice el dia que
 *     cuentan, no el dia en que se renderizaron.
 *
 *  2. La CARPETA, o el ancestro que tenga fecha: "240816_Cumpleaños Fer". Es la
 *     unidad de significado del archivo y gana a la camara a proposito: un
 *     proyecto fechado el 7 de septiembre puede tener rodaje de agosto, y la
 *     carpeta es lo que el usuario decidio.
 *
 *  3. La CAMARA: EXIF DateTimeOriginal (foto) o creation_time (video). La lleva
 *     el 89 % del archivo y es la unica verdad cuando ni el nombre ni la carpeta
 *     dicen nada: son las 448 fotos de movil con nombre "0118BA41-21DA-...".
 *
 *  4. El DISCO. Ojo: es la fecha de COPIA, no la de captura. Hoy acierta casi
 *     siempre porque Daniel vuelca el material el mismo dia, pero una tarjeta
 *     de 2015 volcada hoy apareceria como de hoy. Ultimo recurso.
 *
 * Ademas del dia se resuelve la HORA cuando la camara la sabe: es lo que
 * permite ordenar cronologicamente dentro de un mismo dia material de dos
 * camaras distintas, que por nombre salia en dos bloques.
 */

const HOY = () => new Date();
const ANIO_MIN = 1900;

/** ¿Dia valido? Nada del futuro (mas alla de mañana) ni anterior a 1900. */
function valido(y, m, d) {
  if (!(y >= ANIO_MIN) || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const f = new Date(y, m - 1, d);
  if (f.getFullYear() !== y || f.getMonth() !== m - 1 || f.getDate() !== d) return false;
  return f.getTime() <= HOY().getTime() + 36 * 3600 * 1000;
}

const aDia = (y, m, d) => y * 10000 + m * 100 + d;

/**
 * Fecha escrita en un texto (nombre de archivo o de carpeta), o 0.
 *
 * Formatos que se leen, en este orden:
 *   - AAAAMMDD y AAAA-MM-DD (movil, WhatsApp, capturas): IMG_20190907_120000,
 *     IMG-20190907-WA0001, "Captura 2025-03-06 15-40-25".
 *   - DD-MM-AAAA: "... 06_03_2025 15_34_54".
 *   - AAMMDD al principio o tras un guion, que es la convencion del archivo:
 *     "240816_Cumpleaños", "EDEM_Bootcamp - 240617". NO se acepta en cualquier
 *     posicion: "Clip_123456" no es el 12 de mayo de 2034.
 */
function deTexto(texto) {
  const s = String(texto || '');

  // AAAAMMDD con o sin separadores.
  let m = s.match(/(?:^|[^\d])(19|20)(\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})(?!\d)/);
  if (m) {
    const y = parseInt(m[1] + m[2], 10);
    const mes = parseInt(m[3], 10);
    const dia = parseInt(m[4], 10);
    if (valido(y, mes, dia)) return aDia(y, mes, dia);
  }

  // DD-MM-AAAA.
  m = s.match(/(?:^|[^\d])(\d{2})[-_.](\d{2})[-_.](19|20)(\d{2})(?!\d)/);
  if (m) {
    const y = parseInt(m[3] + m[4], 10);
    const mes = parseInt(m[2], 10);
    const dia = parseInt(m[1], 10);
    if (valido(y, mes, dia)) return aDia(y, mes, dia);
  }

  // AAMMDD al principio o tras un guion.
  m = s.match(/(?:^|-\s*)(\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const yy = parseInt(m[1], 10);
    const y = yy > 50 ? 1900 + yy : 2000 + yy;
    const mes = parseInt(m[2], 10);
    const dia = parseInt(m[3], 10);
    if (valido(y, mes, dia)) return aDia(y, mes, dia);
  }

  return 0;
}

/**
 * Lo que dice la camara: { dia, hora } o null.
 *
 * EXIF DateTimeOriginal es hora de pared sin zona, y exif-reader la entrega
 * como si fuera UTC: su dia y su hora se leen en UTC tal cual. El
 * creation_time de un video si es UTC de verdad, asi que se pasa a hora local.
 */
function deCamara(file) {
  const t = (file && file.technical) || {};
  if (t.capture_time) {
    const d = new Date(t.capture_time);
    if (!isNaN(d.getTime()) && valido(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) {
      const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
      return { dia: aDia(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), hora: local.getTime(), minuto: local.getHours() * 60 + local.getMinutes() };
    }
  }
  if (t.creation_time) {
    const d = new Date(t.creation_time);
    if (!isNaN(d.getTime()) && valido(d.getFullYear(), d.getMonth() + 1, d.getDate())) {
      return { dia: aDia(d.getFullYear(), d.getMonth() + 1, d.getDate()), hora: d.getTime(), minuto: d.getHours() * 60 + d.getMinutes() };
    }
  }
  return null;
}

/** Fecha escrita en la carpeta del archivo o en algun ancestro. */
function deCarpeta(fullPath) {
  const segs = String(fullPath || '').split(/[\\/]/).filter(Boolean);
  // Del contenedor hacia arriba; el ultimo segmento es el archivo.
  for (let i = segs.length - 2; i >= 0; i--) {
    const d = deTexto(segs[i]);
    if (d) return d;
  }
  return 0;
}

/** Fecha del propio archivo en disco (cuando se copio). */
function deDisco(file) {
  for (const bruto of [file && file.createdAt, file && file.modifiedAt]) {
    if (!bruto) continue;
    const d = bruto instanceof Date ? bruto : new Date(bruto);
    if (!isNaN(d.getTime())) return { dia: aDia(d.getFullYear(), d.getMonth() + 1, d.getDate()), hora: d.getTime(), minuto: d.getHours() * 60 + d.getMinutes() };
  }
  return null;
}

/**
 * Resuelve la fecha de un archivo.
 * @returns {{dia:number, hora:number|null, minuto:number|null, fuente:'nombre'|'carpeta'|'camara'|'disco'|'ninguna'}}
 */
function resolver(file) {
  const camara = deCamara(file);

  const porNombre = deTexto((file && file.displayName && String(file.displayName).trim()) || (file && file.name) || '');
  // La HORA es siempre la de la camara, aunque su dia sea otro: el material de
  // "190907_Bioritme" se rodo en agosto, y su hora del dia es lo unico que
  // permite intercalar dos camaras dentro de la jornada. Como solo ordena
  // DENTRO de un mismo dia, un instante de otra fecha no descoloca nada.
  const hora = camara ? camara.hora : null;
  const minuto = camara ? camara.minuto : null;
  if (porNombre) return { dia: porNombre, hora, minuto, fuente: 'nombre' };

  const porCarpeta = deCarpeta(file && file.fullPath);
  if (porCarpeta) return { dia: porCarpeta, hora, minuto, fuente: 'carpeta' };

  if (camara) return { dia: camara.dia, hora: camara.hora, minuto: camara.minuto, fuente: 'camara' };

  const disco = deDisco(file);
  if (disco) return { dia: disco.dia, hora: disco.hora, minuto: disco.minuto, fuente: 'disco' };

  return { dia: 0, hora: null, minuto: null, fuente: 'ninguna' };
}

/**
 * Pone la fecha resuelta en cada archivo del catalogo:
 *   - `fechaDia`    AAAAMMDD, lo que ordena y agrupa.
 *   - `fechaHora`   instante de la captura en ms (informativo).
 *   - `fechaMinuto` minutos desde medianoche: ordena dentro del dia.
 *   - `fechaFuente` de donde salio, que la interfaz usa para saber si un
 *                   material esta sin fechar de verdad.
 *   - `extractedDate` se rellena con ese dia (medianoche local) para que los
 *     filtros por año y mes, que miran este campo, no dejen fuera a nadie.
 */
function aplicar(files) {
  if (!Array.isArray(files)) return files;
  for (const f of files) {
    if (!f) continue;
    const r = resolver(f);
    f.fechaDia = r.dia || null;
    f.fechaHora = r.hora || null;
    // Minutos desde medianoche: es lo que ordena dentro de un mismo dia.
    f.fechaMinuto = (typeof r.minuto === 'number') ? r.minuto : null;
    f.fechaFuente = r.fuente;
    if (r.dia) {
      f.extractedDate = new Date(Math.floor(r.dia / 10000), (Math.floor(r.dia / 100) % 100) - 1, r.dia % 100);
    }
  }
  return files;
}

module.exports = { aplicar, resolver, deTexto, deCamara, deCarpeta, valido };
