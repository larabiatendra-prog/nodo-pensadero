// Regex: captura todo hasta el YYMMDD inclusive
// Ejemplos: "EDEM_Bootcamp - 240617_Presentaciones" → key "EDEM_Bootcamp - 240617"
// `(?!\d)`: seis cifras justas. Sin eso "IMG-20260614-WA0010" casaba como
// "IMG-202606" (mes 26) y salia la sesion "IMG · 6 undefined 2020".
const DATE_REGEX = /^(.+?-\s*\d{6})(?!\d)/;
const SUFFIX_REGEX = /^.+?-\s*\d{6}(?!\d)[_\s]*(.*)/;
const DATE_EXTRACT_REGEX = /-\s*(\d{6})(?!\d)/;
// Formato NODO / display name: fecha al INICIO "YYMMDD_Sufijo" (sin prefijo, sep "_").
// Ejemplo: "240412_Viaje Marruecos" → fecha 240412, sufijo "Viaje Marruecos".
const LEADING_DATE_REGEX = /^(\d{6})[_\s]+(.*)$/;

const sessionKeyCache = new Map<string, string | null>();
const smartLabelCache = new Map<string, { line1: string; line2: string }>();

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const INITIATIVE_PREFIXES = /^(EDEM|MdE|Lanzadera|Angels)[_\s]*/i;

/** Elimina la extensión de un nombre de archivo */
function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

/**
 * Quita el sufijo de enumeracion "_NNN" (>=3 digitos) que folderNames añade a
 * cada archivo de una carpeta con >1 elemento. Asi todos los archivos de la
 * misma carpeta comparten una unica clave de sesion.
 */
function stripFolderIndex(name: string): string {
  return name.replace(/_\d{3,}$/, '');
}

/** Formatea "YYMMDD" -> "12 abr 2024", o null si no es fecha valida. */
function formatYYMMDD(s: string): string | null {
  const yy = parseInt(s.substring(0, 2), 10);
  const mm = parseInt(s.substring(2, 4), 10);
  const dd = parseInt(s.substring(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const year = yy > 50 ? 1900 + yy : 2000 + yy;
  return `${dd} ${MONTHS_ES[mm - 1]} ${year}`;
}

/** Carpeta cuyo nombre empieza por fecha "YYMMDD_" o "YYMMDD ". */
const FOLDER_DATE_PREFIX = /^\d{6}[_\s]/;

/** Archivo con lo minimo para resolver su sesion. */
export interface SessionFileRef {
  name: string;
  displayName?: string | null;
  mediaKey?: string | null;
  fullPath?: string | null;
  /** Fecha resuelta por el servidor (ver backend/utils/fechaArchivo.js). */
  fechaDia?: number | null;
  fechaFuente?: string | null;
}

/**
 * Clave de sesion derivada de la CARPETA contenedora, en identidad portable
 * ("<libraryId>:ruta/relativa/de/la/carpeta", sin el archivo).
 *
 * Es la clave mas robusta disponible porque no depende de como se llamen los
 * archivos: el material de camara sale como "P1248470.MP4" y no hay patron
 * alguno que extraer. La carpeta, en cambio, es la unidad atomica de
 * significado del proyecto y siempre existe.
 *
 * Portable a proposito (misma forma que folder_names.json): si cambia la letra
 * de unidad, la sesion y sus notas siguen siendo la misma.
 */
export function getFolderSessionKey(file: SessionFileRef): string | null {
  const mk = file.mediaKey && file.mediaKey.trim();
  if (!mk) return null;
  const idx = mk.lastIndexOf('/');
  // Sin '/' el archivo cuelga de la raiz de la biblioteca. Ahi la "sesion"
  // seria la biblioteca entera, que no agrupa nada util: mejor archivo suelto.
  if (idx === -1) return null;
  return mk.slice(0, idx);
}

/**
 * Texto legible del que derivar la etiqueta de una sesion de carpeta. Sale de
 * `fullPath` y no de `mediaKey` para conservar mayusculas y acentos, que
 * mediaKey normaliza a minusculas.
 *
 * Si la carpeta no lleva fecha en el nombre ("clips", "seleccion"), se
 * antepone el ancestro que si la lleve: una tarjeta que solo dijera "clips"
 * no situa el material en ningun sitio.
 */
export function getFolderLabelSource(file: SessionFileRef): string | null {
  const fp = file.fullPath;
  if (!fp) return null;
  const segs = fp.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return null;
  const carpeta = segs[segs.length - 2]; // el ultimo segmento es el archivo
  if (FOLDER_DATE_PREFIX.test(carpeta)) return carpeta;
  for (let i = segs.length - 3; i >= 0; i--) {
    if (FOLDER_DATE_PREFIX.test(segs[i])) return `${segs[i]} / ${carpeta}`;
  }
  return carpeta;
}

/** "YYMMDD" -> numero YYYYMMDD comparable, o 0 si no es fecha valida. */
function yymmddToNumber(s: string): number {
  const yy = parseInt(s.substring(0, 2), 10);
  const mm = parseInt(s.substring(2, 4), 10);
  const dd = parseInt(s.substring(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return 0;
  return (yy > 50 ? 1900 + yy : 2000 + yy) * 10000 + mm * 100 + dd;
}

/** Fecha YYMMDD al inicio del texto o tras un guion ("Prefijo - 240617"). */
function dateFromText(texto: string): number {
  const m = texto.match(/(?:^|-\s*)(\d{6})/);
  return m ? yymmddToNumber(m[1]) : 0;
}

/**
 * Fecha de un archivo para ORDENAR, como numero YYYYMMDD (mas grande = mas
 * reciente). Cadena de resolucion, de la senal mas intencional a la mas cruda:
 *
 *  1) el nombre de presentacion o el fisico, si llevan fecha;
 *  2) la CARPETA contenedora (o el ancestro con fecha). Es lo que rescata el
 *     material de camara: "P1248458.MP4" no dice nada, pero vive en
 *     "260906_La Fenix" y esa fecha es la buena;
 *  3) la fecha del propio archivo en disco.
 *
 * Sin el paso 2 todo el material de camara empataba en 0 y el orden colapsaba
 * a alfabetico por nombre, con el efecto perverso de que las pocas carpetas
 * con fecha en el nombre se colocaban DELANTE por viejas que fuesen.
 */
export function getFileSortDate(file: SessionFileRef & { createdAt?: Date | string; modifiedAt?: Date | string }): number {
  // La fecha la decide el servidor en un unico sitio (nombre > carpeta >
  // camara > disco). Lo de abajo solo actua si el archivo viene de una version
  // anterior del backend, para no quedarse sin orden.
  if (file.fechaDia) return file.fechaDia;

  const porNombre = dateFromText((file.displayName && file.displayName.trim()) || file.name || '');
  if (porNombre) return porNombre;

  const fp = file.fullPath;
  if (fp) {
    const segs = fp.split(/[\\/]/).filter(Boolean);
    // De la carpeta contenedora hacia arriba; se ignora el ultimo segmento
    // (el archivo), que ya se ha probado en el paso 1.
    for (let i = segs.length - 2; i >= 0; i--) {
      const d = dateFromText(segs[i]);
      if (d) return d;
    }
  }

  const bruto = file.createdAt || file.modifiedAt;
  if (bruto) {
    const d = bruto instanceof Date ? bruto : new Date(bruto);
    if (!isNaN(d.getTime())) {
      return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    }
  }

  return 0; // Sin fecha por ningun lado: al final.
}

/**
 * Clave de sesion de un archivo. Prioridad:
 *  1) displayName (nombre de presentacion por carpeta) -> la CARPETA es la sesion;
 *     se quita el sufijo "_NNN" para que todos sus archivos compartan clave.
 *     Dos carpetas con el MISMO displayName se funden en una sola sesion, que
 *     es como se unen una carpeta y su subcarpeta "clips".
 *  2) patron "Prefijo - YYMMDD" en el nombre fisico (bibliotecas ya nombradas
 *     asi). Va antes que la carpeta para no re-agrupar lo que hoy ya funciona.
 *  3) la carpeta contenedora, en identidad portable. Es la red de seguridad:
 *     con nombres de camara ("P1248470") los dos primeros no dan nada y sin
 *     esto el material quedaba suelto, sin poder colapsarse.
 */
export function getFileSessionKey(file: SessionFileRef): string | null {
  const dn = file.displayName && file.displayName.trim();
  if (dn) return stripFolderIndex(dn);
  // Carpeta sin fecha y sin nombre puesto por el usuario (el vertedero del
  // movil: "1", "2", "3"): cada dia es su propia sesion. Si no, 140 fotos de
  // tres semanas se colapsan en una sola tarjeta llamada "3" y esos dias
  // desaparecen de la linea del tiempo.
  if (esSuelto(file) && file.fechaDia) {
    return `${getFolderSessionKey(file) || 'sueltos'}#${file.fechaDia}`;
  }
  const porNombre = getSessionKey(file.name);
  if (porNombre) return porNombre;
  return getFolderSessionKey(file);
}

/**
 * ¿Este archivo esta suelto? Ni su nombre ni su carpeta dicen de cuando es: su
 * fecha sale de la camara o del disco. Son los que se agrupan por dia.
 */
export function esSuelto(file: SessionFileRef): boolean {
  return file.fechaFuente === 'camara' || file.fechaFuente === 'disco';
}

/** "20241127" -> "27 nov 2024". */
export function etiquetaDeDia(dia: number): string {
  const y = Math.floor(dia / 10000);
  const m = Math.floor(dia / 100) % 100;
  const d = dia % 100;
  if (m < 1 || m > 12) return String(dia);
  return `${d} ${MONTHS_ES[m - 1]} ${y}`;
}

/**
 * Etiqueta de una sesion troceada por dia: arriba la fecha y debajo de donde
 * viene, porque "3" a secas no dice nada. Si la carpeta se llama con un numero
 * se usa la de encima ("- Móvil/3" -> "Móvil").
 */
export function etiquetaDeSesionSuelta(clave: string, file: SessionFileRef): { line1: string; line2: string } {
  const dia = Number(clave.split('#').pop() || 0);
  // Debajo, de que va la carpeta (evento y subcarpeta, sin las tecnicas): antes
  // solo la carpeta, y "Dia_1\Jorge" salia como "Jorge" sin decir de que evento.
  const { nombre } = deQueVa(file);
  return { line1: dia ? etiquetaDeDia(dia) : (nombre || 'sin fecha'), line2: dia ? nombre : '' };
}

/**
 * Carpetas que crea la camara o el soporte, no el usuario: no dicen nada del
 * material ("CLIP" de Sony, "100MSDCF", "DCIM", "XDROOT", "VIDEO_TS"...) y se
 * saltan al nombrar una sesion. "clips", en plural, no entra: esa la crea el
 * usuario a proposito. Un numero suelto ("3") tampoco dice nada.
 */
const CARPETA_TECNICA = /^(private|m4root|clip|dcim|avchd|bdmv|stream|xdroot|contents|video_ts|audio_ts|mp_root|thmbnl|general|\d{3}[a-z0-9_]{5}|\d+)$/i;

export function esCarpetaTecnica(nombre: string): boolean {
  return CARPETA_TECNICA.test(nombre.trim());
}

/** "Ana_y_Pablo" -> "Ana y Pablo", sin guiones ni separadores en los bordes. */
function limpiarNombre(s: string): string {
  return s.replace(/_/g, ' ').replace(/\s+/g, ' ').replace(/^[-\s.·]+|[-\s.·]+$/g, '').trim();
}

/**
 * Fecha escrita en el nombre de una carpeta de evento, en las formas en que la
 * gente las nombra, con el texto que se enseña y el nombre sin ella:
 *   "260811_Ondara"            -> "11 ago 2026" + "Ondara" (AAMMDD_, la de Daniel)
 *   "2026-06-14_Ana_y_Pablo"   -> "14 jun 2026" + "Ana y Pablo"
 *   "2026-03_Congreso"         -> "mar 2026" + "Congreso"
 *   "FONDO_FAMILIAR_1930-1959" -> "1930-1959" + "FONDO FAMILIAR"
 *   "Boda de la nieta 2011"    -> "2011" + "Boda de la nieta"
 * Antes solo valia AAMMDD_ y el resto de carpetas de evento no contaban.
 */
export function fechaDeCarpeta(nombre: string): { fecha: string; resto: string } | null {
  const n = nombre.trim();
  let m = n.match(/^(\d{6})[_\s]+(.*)$/);
  if (m && formatYYMMDD(m[1])) return { fecha: formatYYMMDD(m[1])!, resto: limpiarNombre(m[2]) };

  m = n.match(/^((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)(.*)$/);
  if (m) {
    const mes = +m[2];
    const dia = +m[3];
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) return { fecha: `${dia} ${MONTHS_ES[mes - 1]} ${m[1]}`, resto: limpiarNombre(m[4]) };
  }

  m = n.match(/^((?:19|20)\d{2})[-_.](\d{2})(?!\d)(.*)$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return { fecha: `${MONTHS_ES[+m[2] - 1]} ${m[1]}`, resto: limpiarNombre(m[3]) };

  m = n.match(/(^|[\s_-])((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2})(?=$|[\s_-])/);
  if (m) return { fecha: `${m[2]}-${m[3]}`, resto: limpiarNombre(n.replace(m[0], m[1])) };

  m = n.match(/(^|[\s_-])((?:19|20)\d{2})(?=$|[\s_-])/);
  if (m) return { fecha: m[2], resto: limpiarNombre(n.replace(m[0], m[1])) };

  return null;
}

/**
 * Carpetas del archivo DENTRO de su biblioteca, de la raiz a la contenedora.
 * La raiz de la biblioteca y lo de encima no son el evento ("BODAS", "F:\").
 * Sin mediaKey (datos antiguos), la ruta entera.
 */
function carpetasDe(file: SessionFileRef): string[] {
  const dirs = String(file.fullPath || '').split(/[\\/]/).filter(Boolean).slice(0, -1);
  const mk = file.mediaKey && file.mediaKey.trim();
  if (mk && mk.includes(':')) {
    const n = mk.slice(mk.indexOf(':') + 1).split('/').filter(Boolean).length - 1;
    return n > 0 ? dirs.slice(-n) : [];
  }
  return dirs;
}

/** Nombre de la carpeta de la biblioteca de un archivo ("SERVIDOR_MARKETING"). */
export function nombreDeBiblioteca(file: SessionFileRef): string {
  const segs = String(file.fullPath || '').split(/[\\/]/).filter(Boolean);
  const dentro = carpetasDe(file).length;
  return segs[segs.length - 2 - dentro] || '';
}

/**
 * De que va una carpeta: el evento (la carpeta con fecha mas cercana) y,
 * debajo, la subcarpeta mas cercana que aporte algo, sin las tecnicas. Sin evento,
 * la carpeta mas cercana que no sea tecnica. `fecha` es la del evento.
 *   2026-06-14_Ana_y_Pablo\CAM_A_FX3\PRIVATE\M4ROOT\CLIP -> "Ana y Pablo / CAM A FX3"
 *   2026-03_Congreso\Dia_1\Jorge                         -> "Congreso / Jorge"
 */
function deQueVa(file: SessionFileRef): { fecha: string; nombre: string } {
  const dirs = carpetasDe(file);
  for (let i = dirs.length - 1; i >= 0; i--) {
    const ev = fechaDeCarpeta(dirs[i]);
    if (!ev) continue;
    // Una sola subcarpeta, la mas cercana con significado: es la regla de
    // siempre ("190907_Bioritme / Selects"), ahora saltando las tecnicas.
    const subs = dirs.slice(i + 1).filter(d => !esCarpetaTecnica(d)).slice(-1).map(limpiarNombre);
    return { fecha: ev.fecha, nombre: [ev.resto, ...subs].filter(Boolean).join(' / ') };
  }
  // Todo tecnico dentro ("- Móvil\3", con la biblioteca en "- Móvil"): la biblioteca.
  const propia = [...dirs].reverse().find(d => !esCarpetaTecnica(d)) || nombreDeBiblioteca(file) || dirs[dirs.length - 1] || '';
  return { fecha: '', nombre: propia.replace(/^[-\s]+/, '').trim() };
}

/**
 * Etiqueta de una sesion de CARPETA (sin nombre puesto ni patron en el nombre
 * del archivo): arriba la fecha del evento, debajo de que va. Antes salia el
 * nombre de la carpeta contenedora a secas, y con material de camara eso es
 * "CLIP" o "100MSDCF". Con carpetas AAMMDD_ queda como estaba.
 */
export function etiquetaDeCarpeta(file: SessionFileRef): { line1: string; line2: string } {
  const { fecha, nombre } = deQueVa(file);
  if (fecha) return { line1: fecha, line2: nombre };
  return { line1: nombre || file.name, line2: '' };
}

/** String del que derivar etiqueta/fecha. Sigue la misma prioridad que la clave. */
export function getSessionLabelSource(file: SessionFileRef): string {
  const dn = file.displayName && file.displayName.trim();
  if (dn) return stripFolderIndex(dn);
  if (getSessionKey(file.name)) return file.name;
  return getFolderLabelSource(file) || file.name;
}

/**
 * Devuelve la clave de sesión de un archivo.
 * Para "EDEM_Bootcamp - 240617_Presentaciones.mp4" → "EDEM_Bootcamp - 240617"
 * Para archivos sin patrón YYMMDD → null (archivo suelto)
 */
export function getSessionKey(fileName: string): string | null {
  const name = stripExtension(fileName);

  if (sessionKeyCache.has(name)) {
    return sessionKeyCache.get(name)!;
  }

  const match = name.match(DATE_REGEX);
  const key = match ? match[1].trim() : null;

  sessionKeyCache.set(name, key);
  return key;
}

/**
 * Genera la etiqueta de 2 líneas para SessionCard.
 * line1: contexto ("Bootcamp · 17 jun 2024")
 * line2: descripción/sujeto ("Presentaciones")
 */
export function parseSmartLabel(fileName: string): { line1: string; line2: string } {
  const name = stripExtension(fileName);

  if (smartLabelCache.has(name)) {
    return smartLabelCache.get(name)!;
  }

  // Formato NODO "YYMMDD_Sufijo" (fecha al inicio): line1 = fecha, line2 = sufijo.
  const lead = name.match(LEADING_DATE_REGEX);
  if (lead) {
    const dateLabel = formatYYMMDD(lead[1]);
    if (dateLabel) {
      const label = { line1: dateLabel, line2: lead[2].replace(/_/g, ' ').trim() };
      smartLabelCache.set(name, label);
      return label;
    }
  }

  const dateMatch = name.match(DATE_EXTRACT_REGEX);
  if (!dateMatch) {
    const label = { line1: name, line2: '' };
    smartLabelCache.set(name, label);
    return label;
  }

  const dateLabel = formatYYMMDD(dateMatch[1]); // "240617" -> "17 jun 2024"
  if (!dateLabel) {
    // Seis cifras que no son una fecha (mes 13...): el nombre tal cual.
    const label = { line1: name, line2: '' };
    smartLabelCache.set(name, label);
    return label;
  }

  // Prefijo antes del " - YYMMDD"
  const prefixMatch = name.match(/^(.+?)\s*-\s*\d{6}/);
  const rawPrefix = prefixMatch ? prefixMatch[1].trim() : '';
  const cleanPrefix = rawPrefix
    .replace(INITIATIVE_PREFIXES, '')
    .replace(/_/g, ' ')
    .trim();

  // Sufijo después del YYMMDD
  const suffixMatch = name.match(SUFFIX_REGEX);
  const suffix = suffixMatch ? suffixMatch[1].replace(/_/g, ' ').trim() : '';

  const line1 = cleanPrefix ? `${cleanPrefix} · ${dateLabel}` : dateLabel;

  const label = { line1, line2: suffix };
  smartLabelCache.set(name, label);
  return label;
}
