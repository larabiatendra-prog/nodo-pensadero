/**
 * People Registry — Pensadero
 *
 * Gestiona el registry externo de personas (`people_registry.json`) que
 * mapea `person_id → { display_name, avatar_path, aliases }`.
 *
 * El archivo es opcional. Si la variable de entorno `PERSONS_REGISTRY` no
 * está definida o el archivo no existe / no parsea, el módulo opera vacío
 * (sin warnings ruidosos por request).
 *
 * Esquema esperado:
 *   {
 *     "version": 1,
 *     "people": [
 *       { "person_id": "ester", "display_name": "Ester García",
 *         "avatar_path": "people/ester/avatar.jpg", "aliases": ["Ester"] }
 *     ]
 *   }
 *
 * Reglas de validación de `avatar_path`:
 *  - Siempre relativo (sin `/`, `\` ni letra de unidad `X:` al inicio).
 *  - `path.normalize` y luego `path.resolve(base, p)`. El resultado debe
 *    seguir dentro de `base` (anti-traversal `..`).
 *  - Si la imagen no existe en disco → `avatar_url = null`.
 */

const fs = require('fs');
const path = require('path');

// Estado del módulo. Se rellena con `loadRegistry()`.
let registryPath = null;       // Ruta absoluta al `people_registry.json`
let avatarsBase = null;         // Carpeta base para los `avatar_path` relativos
let peopleById = new Map();     // person_id → entrada original del JSON
let warnedOnce = false;         // evita spam si el JSON está roto

/**
 * Carga el registry desde `filePath`. Si `filePath` es vacío/null, deja el
 * estado vacío (sin display_names ni avatares).
 *
 * @param {string|null} filePath - Ruta absoluta a `people_registry.json`.
 * @param {string|null} [avatarsBaseOverride] - Carpeta base para los avatares.
 *   Si se omite, se deriva de `dirname(filePath)`.
 * @returns {{ ok: boolean, count: number, error: string|null }}
 */
function loadRegistry(filePath, avatarsBaseOverride = null) {
  // Reset
  registryPath = null;
  avatarsBase = null;
  peopleById = new Map();

  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: true, count: 0, error: null };
  }

  registryPath = path.normalize(filePath);

  // Carpeta base: parámetro explícito > dirname del registry
  if (avatarsBaseOverride && typeof avatarsBaseOverride === 'string' && avatarsBaseOverride.trim()) {
    avatarsBase = path.normalize(avatarsBaseOverride);
  } else {
    avatarsBase = path.dirname(registryPath);
  }

  let raw;
  try {
    raw = fs.readFileSync(registryPath, 'utf-8');
  } catch (err) {
    if (!warnedOnce) {
      console.warn(`⚠️ people_registry.json no accesible (${registryPath}): ${err.message}`);
      warnedOnce = true;
    }
    return { ok: false, count: 0, error: err.message };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!warnedOnce) {
      console.warn(`⚠️ people_registry.json no parsea: ${err.message}`);
      warnedOnce = true;
    }
    return { ok: false, count: 0, error: err.message };
  }

  if (!parsed || !Array.isArray(parsed.people)) {
    if (!warnedOnce) {
      console.warn('⚠️ people_registry.json sin array `people`. Operando como vacío.');
      warnedOnce = true;
    }
    return { ok: false, count: 0, error: 'sin array people' };
  }

  for (const person of parsed.people) {
    if (!person || typeof person !== 'object') continue;
    const personId = (typeof person.person_id === 'string' && person.person_id.trim())
      ? person.person_id.trim()
      : null;
    if (!personId) continue;
    peopleById.set(personId, person);
  }

  warnedOnce = false; // recarga exitosa: permitir warnings futuros
  console.log(`👥 People registry cargado: ${peopleById.size} personas (${registryPath})`);
  return { ok: true, count: peopleById.size, error: null };
}

/**
 * Devuelve `display_name` para un `person_id`. Fallback al propio id si no
 * existe en registry o no tiene `display_name` válido.
 */
function getDisplayName(personId) {
  if (!personId) return personId;
  const entry = peopleById.get(personId);
  if (entry && typeof entry.display_name === 'string' && entry.display_name.trim()) {
    return entry.display_name.trim();
  }
  return personId;
}

/**
 * Devuelve los aliases de un `person_id` (siempre array, vacío si no hay).
 */
function getAliases(personId) {
  if (!personId) return [];
  const entry = peopleById.get(personId);
  if (!entry || !Array.isArray(entry.aliases)) return [];
  return entry.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim());
}

/**
 * Valida una ruta relativa de avatar contra la base. Devuelve la ruta
 * absoluta resuelta o null si no pasa las reglas (absoluta, traversal,
 * fuera de base).
 *
 * @param {string} p - `avatar_path` relativo del registry.
 * @param {string} base - Carpeta base absoluta.
 * @returns {string|null}
 */
function validateAvatarPath(p, base) {
  if (!p || typeof p !== 'string' || !base) return null;
  const trimmed = p.trim();
  if (!trimmed) return null;

  // Rechazar absolutos: empieza por `/`, `\` o letra de unidad `X:`
  if (/^[/\\]/.test(trimmed)) return null;
  if (/^[a-zA-Z]:/.test(trimmed)) return null;

  const normalized = path.normalize(trimmed);
  // Tras normalize, rechazar si sigue siendo absoluto o si empieza por `..`
  if (path.isAbsolute(normalized)) return null;
  // path.normalize en Windows usa `\`, tener en cuenta ambos separadores
  const segments = normalized.split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return null;
  if (segments[0] === '..') return null;

  const resolved = path.resolve(base, normalized);
  const baseResolved = path.resolve(base);

  // Anti-traversal estricto: el resolved debe estar bajo baseResolved.
  // Comparar con un separador final para evitar que `/foo` pase como prefijo de `/foobar`.
  const baseWithSep = baseResolved.endsWith(path.sep) ? baseResolved : baseResolved + path.sep;
  if (resolved !== baseResolved && !resolved.startsWith(baseWithSep)) {
    return null;
  }

  return resolved;
}

/**
 * Devuelve la URL pública del avatar de un `person_id` si:
 *  - existe entrada en el registry,
 *  - tiene `avatar_path` válido (relativo, sin traversal),
 *  - y el archivo existe en disco.
 *
 * Caso contrario, devuelve null.
 */
function getAvatarUrl(personId) {
  if (!personId || !avatarsBase) return null;
  const entry = peopleById.get(personId);
  if (!entry || !entry.avatar_path) return null;

  const resolved = validateAvatarPath(entry.avatar_path, avatarsBase);
  if (!resolved) return null;

  // Comprobación síncrona: el aggregator se calcula offline (no por request),
  // así que es seguro usar fs.existsSync aquí.
  if (!fs.existsSync(resolved)) return null;

  // URL pública usa la ruta relativa, normalizada con `/` para HTTP
  const relForUrl = path.normalize(entry.avatar_path).split(path.sep).join('/');
  return `/persons-avatars/${relForUrl}`;
}

/**
 * Acceso de solo lectura al estado interno (útil para tests/debug).
 */
function getState() {
  return {
    registryPath,
    avatarsBase,
    count: peopleById.size,
    personIds: Array.from(peopleById.keys()),
  };
}

/**
 * Itera todas las entradas del registry. Para uso del aggregator.
 */
function entries() {
  return Array.from(peopleById.entries());
}

module.exports = {
  loadRegistry,
  getDisplayName,
  getAliases,
  getAvatarUrl,
  validateAvatarPath,
  getState,
  entries,
};
