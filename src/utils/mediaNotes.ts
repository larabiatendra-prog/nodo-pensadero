import type { MediaFile } from '../types';

/**
 * Nota humana de un archivo, buscada por su identidad PORTABLE primero.
 *
 * Conviven dos claves mientras dura la migracion:
 *  - `mediaKey` ("<libraryId>:<ruta/relativa>") — sobrevive a que la biblioteca
 *    cambie de letra de unidad. Es la buena.
 *  - `id` (md5 de la ruta absoluta) — como se guardaban las notas antes. Si la
 *    ruta cambia, esa nota queda huerfana.
 *
 * Una sola definicion para los tres sitios que leen notas (modal, tarjeta y
 * cuadricula): si cada uno improvisa su orden, la misma nota aparece en unos
 * sitios y en otros no.
 */
export function noteFor(
  notes: Record<string, string> | undefined | null,
  file: Pick<MediaFile, 'id' | 'mediaKey'> | null | undefined,
): string | undefined {
  if (!notes || !file) return undefined;
  if (file.mediaKey && notes[file.mediaKey]) return notes[file.mediaKey];
  return notes[file.id];
}

/**
 * Clave bajo la que se DEBE guardar la nota de un archivo: la portable si la
 * hay. Junto con `legacyNoteKey`, permite que el backend retire el duplicado.
 */
export function noteKeyFor(file: Pick<MediaFile, 'id' | 'mediaKey'>): string {
  return file.mediaKey || file.id;
}

/**
 * Clave anterior a retirar al guardar, o undefined si no hay que retirar nada
 * (el archivo aun no tiene identidad portable).
 */
export function legacyNoteKey(file: Pick<MediaFile, 'id' | 'mediaKey'>): string | undefined {
  return file.mediaKey && file.mediaKey !== file.id ? file.id : undefined;
}
