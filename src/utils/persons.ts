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
