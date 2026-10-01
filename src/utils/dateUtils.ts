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

/** Lo minimo de un archivo para fecharlo en pantalla. */
interface ConFecha {
  fechaDia?: number | null;
  fechaFuente?: string;
  createdAt?: Date | string;
  modifiedAt?: Date | string;
}

const AVISO_DISCO = 'Fecha del archivo en disco: puede ser la de cuando se copió';

/**
 * La fecha que se enseña de un archivo: la que resolvio el servidor
 * (nombre > carpeta > camara > disco, backend/utils/fechaArchivo.js), la misma
 * que ordena la galeria. Antes las tarjetas pintaban `createdAt`, la fecha de
 * COPIA: una boda de junio volcada en septiembre salia de septiembre. `aviso`
 * (para el title) dice cuando solo la sabe el disco, que es la menos fiable.
 */
export const fechaDeArchivo = (f: ConFecha): { texto: string; aviso?: string } => {
  const dia = f.fechaDia;
  if (dia && dia > 19000101) {
    const d = new Date(Math.floor(dia / 10000), (Math.floor(dia / 100) % 100) - 1, dia % 100);
    return { texto: d.toLocaleDateString('es-ES'), aviso: f.fechaFuente === 'disco' ? AVISO_DISCO : undefined };
  }
  // Sin fecha del servidor: la mas antigua del disco (la de copia es la nueva).
  const ts = [f.createdAt, f.modifiedAt]
    .map(x => (x ? new Date(x).getTime() : NaN))
    .filter(t => !isNaN(t));
  if (ts.length === 0) return { texto: '' };
  return { texto: new Date(Math.min(...ts)).toLocaleDateString('es-ES'), aviso: AVISO_DISCO };
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