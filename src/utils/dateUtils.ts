/**
 * 'AAAA-MM-DD' del dia LOCAL de una fecha. No usar toISOString para esto: da
 * el dia en UTC, y en España la medianoche local es el dia anterior en UTC
 * (el filtro "desde el 7" dejaba fuera el 7).
 */
export const aTextoDiaLocal = (d: Date): string => {
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
};

/**
 * Medianoche LOCAL de un 'AAAA-MM-DD' (el valor de un <input type="date">).
 * `new Date('2026-09-07')` es medianoche UTC, las 02:00 del 7 en España: un
 * archivo del dia 7 (medianoche local) quedaba antes y fuera del rango.
 */
export const deTextoDiaLocal = (s: string): Date | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

/** El ultimo instante de ese dia local: para que "hasta el 10" incluya el 10 entero. */
export const finDelDia = (d: Date): Date => {
  const f = new Date(d);
  f.setHours(23, 59, 59, 999);
  return f;
};

/**
 * Convierte una fecha (string o Date) a objeto Date
 */
export const ensureDate = (date: string | Date): Date => {
  if (date instanceof Date) {
    return date;
  }
  return new Date(date);
};

/**
 * Formatea una fecha para mostrar en español
 */
export const formatDate = (date: string | Date, options?: Intl.DateTimeFormatOptions): string => {
  const dateObj = ensureDate(date);
  return dateObj.toLocaleDateString('es-ES', options);
};

/**
 * Formatea una fecha con opciones por defecto más legibles
 */
export const formatDateReadable = (date: string | Date): string => {
  return formatDate(date, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
};

/**
 * Formatea una fecha con hora completa
 */
export const formatDateTimeReadable = (date: string | Date): string => {
  return formatDate(date, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};