// Regex: captura todo hasta el YYMMDD inclusive
// Ejemplos: "EDEM_Bootcamp - 240617_Presentaciones" → key "EDEM_Bootcamp - 240617"
const DATE_REGEX = /^(.+?-\s*\d{6})/;
const SUFFIX_REGEX = /^.+?-\s*\d{6}[_\s]*(.*)/;
const DATE_EXTRACT_REGEX = /-\s*(\d{6})/;
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
  const porNombre = getSessionKey(file.name);
  if (porNombre) return porNombre;
  return getFolderSessionKey(file);
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

  const dateStr = dateMatch[1]; // "240617"
  const yy = parseInt(dateStr.substring(0, 2));
  const mm = parseInt(dateStr.substring(2, 4));
  const dd = parseInt(dateStr.substring(4, 6));
  const year = yy > 50 ? 1900 + yy : 2000 + yy;
  const dateLabel = `${dd} ${MONTHS_ES[mm - 1]} ${year}`;

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
