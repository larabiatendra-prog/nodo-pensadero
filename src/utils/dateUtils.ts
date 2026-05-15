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