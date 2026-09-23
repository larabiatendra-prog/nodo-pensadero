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
const { atomicWriteFileSync } = require('./utils/jsonStore');
const { leerRegistro } = require('./utils/registroSeguro');
const fallos = require('./utils/failureReason');

// Estado del módulo. Se rellena con `loadRegistry()`.
let registryPath = null;       // Ruta absoluta al `people_registry.json`
let avatarsBase = null;         // Carpeta base para los `avatar_path` relativos
let peopleById = new Map();     // person_id → entrada original del JSON
let warnedOnce = false;         // evita spam si el JSON está roto
// Ruta cuyo contenido refleja la memoria (se leyo bien, o se comprobo que no
// existe todavia). Una recarga fallida de esa ruta conserva la memoria.
let cargadoDe = null;
// El archivo esta ahi pero no se ha podido leer: guardar lo pisaria.
let sinLeer = false;

// Contador de cambios en los datos de personas (alta/baja/edicion/retrain).
// Lo consume faceClusterer para saber si su cache de "caras desconocidas"
// quedo obsoleto sin depender solo del TTL de 24h. Se incrementa con
// bumpDataVersion() desde aqui (upsert/delete) y desde las rutas (train).
let dataVersion = 0;
function bumpDataVersion() { dataVersion++; }
function getDataVersion() { return dataVersion; }

/**
 * Carga el registry desde `filePath`. Si `filePath` es vacío/null, deja el
 * estado vacío (sin display_names ni avatares).
 *
 * @param {string|null} filePath - Ruta absoluta a `people_registry.json`.
 * @param {string|null} [avatarsBaseOverride] - Carpeta base para los avatares.
 *   Si se omite, se deriva de `dirname(filePath)`.
 * @param {{ soloLectura?: boolean }} [opts] - soloLectura: no apartar un
 *   archivo roto ni tirar de la copia (herramientas de diagnostico).
 * @returns {{ ok: boolean, count: number, error: string|null, noExiste?: boolean, conservado?: boolean }}
 *   Si la lectura falla y ya habia un registro bueno de ese archivo en
 *   memoria, se conserva (`conservado`): nunca se sustituye por uno vacio.
 */
function loadRegistry(filePath, avatarsBaseOverride = null, { soloLectura = false } = {}) {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    registryPath = null;
    avatarsBase = null;
    peopleById = new Map();
    cargadoDe = null;
    sinLeer = false;
    return { ok: true, count: 0, error: null };
  }

  registryPath = path.normalize(filePath);

  // Carpeta base: parámetro explícito > dirname del registry
  if (avatarsBaseOverride && typeof avatarsBaseOverride === 'string' && avatarsBaseOverride.trim()) {
    avatarsBase = path.normalize(avatarsBaseOverride);
  } else {
    avatarsBase = path.dirname(registryPath);
  }

  // Lo que hay en memoria es lo ultimo bueno de ESTE archivo: una recarga que
  // falle no lo toca (ver utils/registroSeguro.js).
  const yaCargado = cargadoDe === registryPath;
  const r = leerRegistro(registryPath, 'people', { primeraVez: !yaCargado, soloLectura });

  if (r.estado === 'ok') {
    const nuevo = new Map();
    for (const person of r.datos.people) {
      if (!person || typeof person !== 'object') continue;
      const personId = (typeof person.person_id === 'string' && person.person_id.trim())
        ? person.person_id.trim()
        : null;
      if (!personId) continue;
      nuevo.set(personId, person);
    }
    peopleById = nuevo;
    cargadoDe = registryPath;
    sinLeer = false;
    warnedOnce = false; // recarga exitosa: permitir warnings futuros
    if (r.desdeCopia) {
      fallos.record('leer el registro de personas', r.error, { path: registryPath });
      console.warn(`⚠️ people_registry.json dañado${r.apartado ? ` (apartado en ${r.apartado})` : ''}: cargada la copia .bak`);
    }
    console.log(`👥 People registry cargado: ${peopleById.size} personas (${registryPath})`);
    return { ok: true, count: peopleById.size, error: null };
  }

  if (yaCargado) {
    // Recarga fallida: a medio escribir, bloqueado, borrado o editado a mano y
    // roto. Antes el registro se vaciaba aqui y el siguiente guardado
    // escribia el vacio encima: se perdian todas las personas.
    if (r.estado === 'no_existe') {
      console.warn('⚠️ people_registry.json ha desaparecido: se conserva en memoria y se volverá a escribir al guardar.');
    } else {
      fallos.record('recargar el registro de personas', r.error, { path: registryPath });
    }
    return { ok: false, count: peopleById.size, error: r.error.message, conservado: true };
  }

  // Primera lectura sin nada bueno.
  peopleById = new Map();
  if (r.estado === 'no_existe') {
    // Primer arranque: se creara al guardar la primera persona.
    cargadoDe = registryPath;
    sinLeer = false;
    return { ok: false, count: 0, error: r.error.message, noExiste: true };
  }
  if (!warnedOnce) {
    console.warn(`⚠️ people_registry.json no se ha podido cargar (${registryPath}): ${r.error.message}`);
    warnedOnce = true;
  }
  if (soloLectura) return { ok: false, count: 0, error: r.error.message };
  fallos.record('leer el registro de personas', r.error, { path: registryPath });
  // Roto y ya apartado: se puede empezar de cero sin pisar nada. Si sigue ahi
  // (no se pudo leer, o apartarlo fallo), no se escribe encima (saveToDisk).
  sinLeer = !(r.estado === 'roto' && r.apartado);
  if (!sinLeer) cargadoDe = registryPath;
  return { ok: false, count: 0, error: r.error.message };
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

// ============================================================================
// ESCRITURA — gestión del registry desde la UI de Pensadero
// ============================================================================

/**
 * Lista todas las personas del registry como array plano (con avatar_url
 * resuelto). Para servir a la UI de gestión.
 */
function listAll() {
  const out = [];
  for (const [id, entry] of peopleById.entries()) {
    out.push({
      person_id: id,
      display_name: (entry && entry.display_name) || id,
      aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
      avatar_path: (entry && entry.avatar_path) || null,
      avatar_url: getAvatarUrl(id),
    });
  }
  out.sort((a, b) => a.display_name.localeCompare(b.display_name, 'es'));
  return out;
}

/**
 * Crea o actualiza una persona. Persiste a disco.
 * @param {object} data { person_id, display_name, aliases?, avatar_path? }
 * @returns {object} entrada normalizada
 */
function upsertPerson(data) {
  if (!data || typeof data !== 'object') throw new Error('data requerido');
  const personId = (data.person_id || '').toString().trim();
  if (!personId) throw new Error('person_id requerido');
  if (!/^[a-zA-Z0-9_\-]+$/.test(personId)) {
    throw new Error('person_id debe ser alfanumérico (a-z, 0-9, _, -)');
  }

  const previo = peopleById.get(personId);   // undefined si es alta
  const existing = previo || {};
  const entry = {
    person_id: personId,
    display_name: (data.display_name || '').toString().trim() || existing.display_name || personId,
    aliases: Array.isArray(data.aliases)
      ? data.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim())
      : (existing.aliases || []),
    // undefined => conservar; '' o null => limpiar explícitamente; string no vacío => fijar
    avatar_path: data.avatar_path === undefined
      ? (existing.avatar_path || null)
      : (typeof data.avatar_path === 'string' && data.avatar_path.trim()
          ? data.avatar_path.trim()
          : null),
  };
  peopleById.set(personId, entry);
  bumpDataVersion();
  // Si no se puede persistir, se DESHACE el cambio en memoria y se lanza. Antes
  // saveToDisk() devolvia false y nadie lo miraba: la persona quedaba viva en
  // memoria, la UI decia "guardada", y al reiniciar habia desaparecido.
  if (!saveToDisk()) {
    if (previo === undefined) peopleById.delete(personId);
    else peopleById.set(personId, previo);
    bumpDataVersion();
    throw new Error(`No se ha podido guardar "${personId}" en el registro de personas. Mira /api/health (incidencias) para el motivo.`);
  }
  return entry;
}

/**
 * Elimina una persona del registry. Persiste.
 */
function deletePerson(personId) {
  if (!personId) return false;
  const previo = peopleById.get(personId);
  const existed = peopleById.delete(personId);
  if (existed) {
    bumpDataVersion();
    if (!saveToDisk()) {
      // Mismo criterio que el alta: si no se persiste, no se finge que si.
      peopleById.set(personId, previo);
      bumpDataVersion();
      throw new Error(`No se ha podido borrar "${personId}" del registro de personas. Mira /api/health (incidencias) para el motivo.`);
    }
  }
  return existed;
}

/**
 * Persiste el estado actual de peopleById a disco como JSON.
 * Si registryPath no está definido, se inicializa al default que el server
 * configure (la primera vez via loadRegistry o setRegistryPath).
 */
function saveToDisk() {
  if (!registryPath) {
    console.warn('⚠️ saveToDisk sin registryPath; descartando.');
    return false;
  }
  if (sinLeer) {
    // El archivo existe y no se pudo leer al arrancar: la memoria no lo tiene,
    // y guardar ahora lo sustituiria por lo poco que haya en memoria.
    fallos.record('guardar el registro de personas',
      new Error('No se guarda: people_registry.json no se pudo leer al arrancar y guardar ahora borraría las personas que tiene. Reinicia Pensadero.'),
      { path: registryPath });
    return false;
  }
  const data = {
    version: 1,
    people: Array.from(peopleById.values()),
  };
  // Escritura atómica (tmp + rename, crea la carpeta padre). people_registry.json
  // NO es regenerable (display names, aliases, curación manual).
  try {
    atomicWriteFileSync(registryPath, JSON.stringify(data, null, 2), { backup: true });
    return true;
  } catch (err) {
    fallos.record('guardar el registro de personas', err, { path: registryPath });
    return false;
  }
}

/**
 * Permite establecer registryPath sin recargar (útil para escribir el
 * primer registro cuando aún no existía el archivo).
 */
function setRegistryPath(filePath, avatarsBaseOverride = null) {
  if (filePath) registryPath = path.normalize(filePath);
  if (avatarsBaseOverride) avatarsBase = path.normalize(avatarsBaseOverride);
  else if (registryPath && !avatarsBase) avatarsBase = path.dirname(registryPath);
}

module.exports = {
  loadRegistry,
  setRegistryPath,
  getDisplayName,
  getAliases,
  getAvatarUrl,
  validateAvatarPath,
  getState,
  entries,
  // Version de datos (para invalidar caches dependientes del registry)
  getDataVersion,
  bumpDataVersion,
  // CRUD desde la UI
  listAll,
  upsertPerson,
  deletePerson,
  saveToDisk,
};
