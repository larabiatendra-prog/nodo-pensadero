// Regex: captura todo hasta el YYMMDD inclusive
// Ejemplos: "EDEM_Bootcamp - 240617_Presentaciones" → key "EDEM_Bootcamp - 240617"
const DATE_REGEX = /^(.+?-\s*\d{6})/;
const SUFFIX_REGEX = /^.+?-\s*\d{6}[_\s]*(.*)/;
const DATE_EXTRACT_REGEX = /-\s*(\d{6})/;

const sessionKeyCache = new Map<string, string | null>();
const smartLabelCache = new Map<string, { line1: string; line2: string }>();

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const INITIATIVE_PREFIXES = /^(EDEM|MdE|Lanzadera|Angels)[_\s]*/i;

/** Elimina la extensión de un nombre de archivo */
function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
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
