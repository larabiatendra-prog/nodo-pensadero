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

/**
 * Clave de sesion de un archivo. Prioridad:
 *  1) displayName (nombre de presentacion por carpeta) -> la CARPETA es la sesion;
 *     se quita el sufijo "_NNN" para que todos sus archivos compartan clave.
 *     Funciona con cualquier nombre de carpeta, lleve o no patron de fecha.
 *  2) fallback: patron "Prefijo - YYMMDD" en el nombre fisico (libreria sin rename).
 */
export function getFileSessionKey(file: { name: string; displayName?: string | null }): string | null {
  const dn = file.displayName && file.displayName.trim();
  if (dn) return stripFolderIndex(dn);
  return getSessionKey(file.name);
}

/** String del que derivar etiqueta/fecha: displayName (sin "_NNN") si existe, si no el nombre fisico. */
export function getSessionLabelSource(file: { name: string; displayName?: string | null }): string {
  const dn = file.displayName && file.displayName.trim();
  return dn ? stripFolderIndex(dn) : file.name;
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
