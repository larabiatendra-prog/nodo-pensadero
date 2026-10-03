/**
 * Convierte un nombre legible (con espacios, acentos, mayusculas) en un
 * person_id valido para el backend: alfanumerico ASCII + underscores. El
 * backend valida con /^[a-zA-Z0-9_\-]+$/, asi que respetamos ese formato.
 *
 * Ejemplos:
 *   "Jose Carlos"      -> "jose_carlos"
 *   "Ester Garcia"     -> "ester_garcia"
 *   "Maria Jose Lopez" -> "maria_jose_lopez"
 *
 * Devuelve null si el resultado queda vacio (e.g. nombre solo con simbolos
 * no alfanumericos como "???").
 */
export function slugifyPersonId(name: string): string | null {
  if (!name) return null;
  // ̀-ͯ es el rango Unicode de combining diacritical marks.
  // NFD descompone caracteres acentuados en base + marca; luego strip.
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || null;
}

/**
 * Fotos y videos con al menos una cara encontrada, tenga nombre o no. Es lo
 * que se cuenta como "archivos con caras": contar caras con nombre daba 0
 * hasta nombrar a alguien (111 caras encontradas y la pantalla decia 0), y
 * contar detecciones lo inflaban los videos (la misma cara en cada fotograma).
 */
export function archivosConCaras(files: ReadonlyArray<{ faces?: unknown[]; face_boxes?: unknown[] }>): number {
  let n = 0;
  for (const f of files) if ((f.face_boxes?.length || 0) > 0 || (f.faces?.length || 0) > 0) n++;
  return n;
}
