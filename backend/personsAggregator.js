/**
 * Persons Aggregator — Pensadero
 *
 * Calcula el agregado de personas a partir de los `MediaFile` en memoria.
 * El resultado es la lista que devuelve `GET /api/persons`.
 *
 * Reglas:
 *  - `count` = nº de MediaFile distintos donde aparece ese `person_id`
 *    (presencia única por archivo, no nº de detecciones).
 *  - Solo se devuelven personas con `count > 0`.
 *  - Personas en MediaFile pero ausentes del registry → aparecen igualmente
 *    con `display_name = person_id` y `avatar_url = null`.
 *  - Orden: count desc; desempate display_name ASC (locale-aware, es).
 *  - El aggregator NO hace I/O por request: la existencia del avatar la
 *    chequea peopleRegistry.getAvatarUrl con fs.existsSync una sola vez aquí.
 */

const peopleRegistry = require('./peopleRegistry');

/**
 * Recalcula la agregación de personas.
 *
 * @param {Array<object>} mediaFiles - Lista de MediaFile (con `faces[]` ya normalizadas).
 * @returns {Array<{person_id: string, display_name: string, count: number, avatar_url: string|null}>}
 */
function recomputePersons(mediaFiles) {
  if (!Array.isArray(mediaFiles) || mediaFiles.length === 0) return [];

  // person_id → Set<fileId> para contar presencia única por archivo
  const presence = new Map();

  for (const file of mediaFiles) {
    if (!file || !Array.isArray(file.faces) || file.faces.length === 0) continue;

    // Set local de person_ids del archivo (un clip con 3 detecciones del
    // mismo person_id cuenta 1).
    const seenInFile = new Set();
    for (const face of file.faces) {
      if (!face || typeof face !== 'object') continue;
      const pid = face.person_id;
      if (!pid || typeof pid !== 'string' || !pid.trim()) continue;
      seenInFile.add(pid.trim());
    }

    for (const pid of seenInFile) {
      if (!presence.has(pid)) presence.set(pid, new Set());
      presence.get(pid).add(file.id || file.fullPath || file.name);
    }
  }

  const result = [];
  for (const [personId, fileSet] of presence.entries()) {
    if (fileSet.size === 0) continue;
    result.push({
      person_id: personId,
      display_name: peopleRegistry.getDisplayName(personId),
      count: fileSet.size,
      avatar_url: peopleRegistry.getAvatarUrl(personId),
    });
  }

  // Orden: count desc, display_name ASC (locale-aware español).
  // Riesgo aceptado: el orden es sensible al locale del proceso para
  // caracteres no-ASCII; usamos 'es' explícito para hacerlo determinista.
  result.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.display_name.localeCompare(b.display_name, 'es', { sensitivity: 'base' });
  });

  return result;
}

module.exports = {
  recomputePersons,
};
