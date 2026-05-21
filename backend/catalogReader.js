/**
 * Catalog Reader — Pensadero
 *
 * Lee y mergea metadatos enriquecidos generados por Marina Video Batch.
 *
 * Soporta dos formatos:
 *  Precedencia (específico gana sobre general):
 *   1. sidecar `<archivo.ext>.json`
 *   2. sidecar `<archivo>.json`
 *   3. entrada en catálogo `_marina.json`/`_pensadero.json`
 *
 *  Catálogo por carpeta: `_marina.json` o `_pensadero.json` con
 *     estructura `{ clips | photos | audios: { <basename>: {...} } }`. El
 *     orden de búsqueda es `_marina.json` primero, luego `_pensadero.json`.
 *     La clave de envoltorio depende del tipo de media; el primer match gana.
 *  2. Sidecar individual por archivo: `<archivo.ext>.json` o `<archivo>.json`
 *     junto al archivo. Mismo schema (puede ser un clip directo sin envoltorio
 *     `{clips: {...}}`, en cuyo caso se trata como tal).
 *
 * Para cada `MediaFile`, el lookup es:
 *   1. catálogo por carpeta (`_marina.json` → `_pensadero.json`)
 *   2. sidecar `<archivo.ext>.json`
 *   3. sidecar `<archivo>.json`
 *
 * Primer match gana, sin merge entre fuentes.
 *
 * Schema canónico de `face` y `space` (compat con dos versiones del pipeline):
 *   face: person_id := face.person_id ?? face.id
 *         display_name := registry.display_name ?? face.display_name ?? face.name ?? person_id
 *   space: igual con space_id / display_name.
 *
 * Estrategia de cache:
 *  - Caché en memoria por carpeta. Map: dirPath → { mtime, catalog, source }.
 *  - Recargar cuando cambie el `mtime` del JSON.
 *  - Mergeo al vuelo (no se persiste en `media_cache.json`).
 */

const path = require('path');
const fs = require('fs').promises;
const peopleRegistry = require('./peopleRegistry');

// Nombres de catálogo por carpeta (orden de prioridad).
const CATALOG_FILENAMES = ['_marina.json', '_pensadero.json'];
// Mantengo esta constante exportada por compat con código legacy del server.
const CATALOG_FILENAME = '_marina.json';

// Map<dirPath, { mtime: number, catalog: object|null, source: string|null }>
const catalogCache = new Map();

// Map<filePath_sin_ext_o_con_ext, { mtime, clip }>  para sidecars individuales.
// Clave = ruta absoluta del JSON sidecar concreto leído.
const sidecarCache = new Map();

/**
 * Devuelve el catalog parseado para una carpeta, o null si no existe.
 * Busca `_marina.json` y luego `_pensadero.json`. Cachea por dirPath.
 */
async function getCatalogForDir(dirPath) {
  // Intentar cada nombre de catálogo en orden
  for (const filename of CATALOG_FILENAMES) {
    const catalogPath = path.join(dirPath, filename);

    let stats;
    try {
      stats = await fs.stat(catalogPath);
    } catch {
      continue; // Probar el siguiente nombre
    }

    const mtime = stats.mtime.getTime();
    const cached = catalogCache.get(dirPath);
    if (cached && cached.source === catalogPath && cached.mtime === mtime) {
      return cached.catalog;
    }

    try {
      const raw = await fs.readFile(catalogPath, 'utf-8');
      const parsed = JSON.parse(raw);
      catalogCache.set(dirPath, { mtime, catalog: parsed, source: catalogPath });
      return parsed;
    } catch (err) {
      console.warn(`⚠️ Error leyendo ${catalogPath}: ${err.message}`);
      catalogCache.set(dirPath, { mtime, catalog: null, source: catalogPath });
      return null;
    }
  }

  // Ningún catálogo en esta carpeta — invalidar cache si la había
  if (catalogCache.has(dirPath)) {
    catalogCache.delete(dirPath);
  }
  return null;
}

/**
 * Busca un sidecar individual para `filePath`. Prueba `<archivo.ext>.json`
 * primero y luego `<archivo>.json` (sin la extensión original). Devuelve
 * el objeto parseado o null si ninguno existe.
 *
 * Si el sidecar tiene envoltorio `{clips: {<basename>: {...}}}`, devuelve
 * el clip directamente (extraído por basename del archivo o el primero).
 * Si tiene un clip directo (sin envoltorio), lo devuelve tal cual.
 */
async function getSidecarForFile(filePath) {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const basenameNoExt = basename.replace(/\.[^/.]+$/, '');

  const candidates = [
    path.join(dir, `${basename}.json`),       // <archivo.ext>.json
    path.join(dir, `${basenameNoExt}.json`),  // <archivo>.json
  ];

  for (const sidecarPath of candidates) {
    let stats;
    try {
      stats = await fs.stat(sidecarPath);
    } catch {
      continue;
    }

    const mtime = stats.mtime.getTime();
    const cached = sidecarCache.get(sidecarPath);
    if (cached && cached.mtime === mtime) {
      return cached.clip;
    }

    try {
      const raw = await fs.readFile(sidecarPath, 'utf-8');
      const parsed = JSON.parse(raw);

      // Detectar envoltorio `{clips: {...}}` vs clip directo
      let clip;
      if (parsed && typeof parsed === 'object' && parsed.clips && typeof parsed.clips === 'object') {
        // Envoltorio tipo catálogo. Buscar por basename, si no encontrar, primer clip.
        clip = parsed.clips[basename];
        if (!clip) {
          const keys = Object.keys(parsed.clips);
          if (keys.length > 0) clip = parsed.clips[keys[0]];
        }
        // Adjuntar batch/processed del envoltorio para preservar info en el merge.
        if (clip) {
          clip = { ...clip, __wrapper_batch: parsed.batch, __wrapper_processed: parsed.processed };
        }
      } else {
        // Clip directo
        clip = parsed;
      }

      sidecarCache.set(sidecarPath, { mtime, clip });
      return clip;
    } catch (err) {
      console.warn(`⚠️ Error leyendo ${sidecarPath}: ${err.message}`);
      sidecarCache.set(sidecarPath, { mtime, clip: null });
      return null;
    }
  }

  return null;
}

/**
 * Invalida la entrada de cache para una carpeta concreta (catálogo).
 */
function invalidateCatalog(dirPath) {
  catalogCache.delete(dirPath);
}

/**
 * Invalida la entrada de cache para un sidecar individual concreto.
 */
function invalidateSidecar(sidecarPath) {
  sidecarCache.delete(sidecarPath);
}

/**
 * Limpia todo el cache de catalogs y sidecars.
 */
function clearCatalogCache() {
  catalogCache.clear();
  sidecarCache.clear();
}

/**
 * Aplana cualquier valor textual de un campo del clip a un array de strings
 * limpios, listos para añadir como tags. Acepta strings, arrays, objetos
 * con `.name`/`.id`, y arrays mixtos.
 */
function toTagStrings(value) {
  if (!value) return [];
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (!item) continue;
      if (typeof item === 'string') {
        if (item.trim()) out.push(item.trim());
      } else if (typeof item === 'object') {
        if (typeof item.name === 'string' && item.name.trim()) out.push(item.name.trim());
        else if (typeof item.id === 'string' && item.id.trim()) out.push(item.id.trim());
      }
    }
    return out;
  }
  if (typeof value === 'object') {
    if (typeof value.name === 'string' && value.name.trim()) return [value.name.trim()];
    if (typeof value.id === 'string' && value.id.trim()) return [value.id.trim()];
  }
  return [];
}

/**
 * Normaliza un face a `{ person_id, display_name, confidence }`.
 * Compat con dos versiones del pipeline:
 *   - person_id: face.person_id ?? face.id
 *   - display_name: registry.display_name ?? face.display_name ?? face.name ?? person_id
 *
 * Devuelve null si no se puede determinar un person_id.
 */
function normalizeFace(face) {
  if (!face || typeof face !== 'object') return null;
  const personId = (typeof face.person_id === 'string' && face.person_id.trim())
    ? face.person_id.trim()
    : (typeof face.id === 'string' && face.id.trim() ? face.id.trim() : null);
  if (!personId) return null;

  // Resolver display_name: registry primero, luego face.display_name/name, fallback al id
  const fromRegistry = peopleRegistry.getDisplayName(personId);
  let displayName;
  // Si registry devuelve algo distinto del personId, vale ese. Si no, fallback al face.
  if (fromRegistry && fromRegistry !== personId) {
    displayName = fromRegistry;
  } else if (typeof face.display_name === 'string' && face.display_name.trim()) {
    displayName = face.display_name.trim();
  } else if (typeof face.name === 'string' && face.name.trim()) {
    displayName = face.name.trim();
  } else {
    displayName = personId;
  }

  const confidence = typeof face.confidence === 'number' ? face.confidence : null;

  const out = { person_id: personId, display_name: displayName };
  if (confidence !== null) out.confidence = confidence;
  return out;
}

/**
 * Normaliza un space a `{ space_id, display_name, confidence }`.
 *   - space_id: space.space_id ?? space.id
 *   - display_name: space.display_name ?? space.name ?? space_id
 *
 * Devuelve null si no se puede determinar un space_id.
 */
function normalizeSpace(space) {
  if (!space || typeof space !== 'object') return null;
  const spaceId = (typeof space.space_id === 'string' && space.space_id.trim())
    ? space.space_id.trim()
    : (typeof space.id === 'string' && space.id.trim() ? space.id.trim() : null);
  if (!spaceId) return null;

  let displayName;
  if (typeof space.display_name === 'string' && space.display_name.trim()) {
    displayName = space.display_name.trim();
  } else if (typeof space.name === 'string' && space.name.trim()) {
    displayName = space.name.trim();
  } else {
    displayName = spaceId;
  }

  const confidence = typeof space.confidence === 'number' ? space.confidence : null;

  const out = { space_id: spaceId, display_name: displayName };
  if (confidence !== null) out.confidence = confidence;
  return out;
}

/**
 * Mergea los datos del clip sobre el fileData base.
 * Devuelve un OBJETO NUEVO; no muta el original.
 *
 * @param {object} fileData - MediaFile base
 * @param {object} clip - entrada del clip (con o sin envoltorio)
 * @param {object|null} catalog - catalog completo (para batch/processed) — opcional
 */
function mergeClipIntoFile(fileData, clip, catalog) {
  if (!clip) return fileData;

  const result = { ...fileData };

  // visual_description: schema v2 separa what + mood. Compat con v1 (description plana).
  if (typeof clip.description_what === 'string' && clip.description_what.trim()) {
    const what = clip.description_what.trim();
    const mood = (typeof clip.description_mood === 'string') ? clip.description_mood.trim() : '';
    result.visual_description = mood ? `${what} ${mood}` : what;
    result.description_what = what;
    if (mood) result.description_mood = mood;
  } else if (typeof clip.description === 'string' && clip.description.trim()) {
    result.visual_description = clip.description.trim();
  }

  // Tags adicionales para Stage 1 (matching literal): objects + actions +
  // expressions + composition + atmosphere + nombres de colores.
  // IMPORTANTE: las personas (faces[].name) NO entran en tags.
  const newTags = [];
  if (clip.semantics) {
    newTags.push(...toTagStrings(clip.semantics.objects));
    newTags.push(...toTagStrings(clip.semantics.actions));
    newTags.push(...toTagStrings(clip.semantics.expressions));
  }
  if (clip.composition) {
    for (const key of ['shot_type','camera_angle','camera_movement','people_framing']) {
      const v = clip.composition[key];
      if (typeof v === 'string' && v.trim()) newTags.push(v.trim());
    }
  }
  if (clip.atmosphere) {
    for (const key of ['mood','lighting','space_type','time_of_day','style']) {
      const v = clip.atmosphere[key];
      if (typeof v === 'string' && v.trim()) newTags.push(v.trim());
    }
  }
  // Compat schema v1: demographics venia del VLM. En v2 viene de InsightFace
  // (se guarda igual) — seguimos volcandolo a tags para Stage 1.
  if (clip.demographics) {
    newTags.push(...toTagStrings(clip.demographics.age_ranges));
    newTags.push(...toTagStrings(clip.demographics.genders));
    if (typeof clip.demographics.attire === 'string' && clip.demographics.attire.trim()) {
      newTags.push(clip.demographics.attire.trim());
    }
  }
  // Nombres de color de la paleta (v2) — permite buscar "azul" / "ocre" sin
  // necesitar la rueda de colores aun
  if (clip.colors && Array.isArray(clip.colors.palette)) {
    for (const p of clip.colors.palette) {
      if (p && typeof p.name === 'string' && p.name.trim()) newTags.push(p.name.trim());
    }
  }

  const baseTags = Array.isArray(fileData.tags) ? fileData.tags : [];
  const merged = [...baseTags, ...newTags].filter(t => typeof t === 'string' && t.trim().length > 0);
  result.tags = [...new Set(merged)];

  // OCR text — concatenado con espacios; ruidoso, mejor no como tags.
  if (clip.semantics && Array.isArray(clip.semantics.text) && clip.semantics.text.length > 0) {
    const cleaned = clip.semantics.text
      .filter(t => typeof t === 'string' && t.trim())
      .map(t => t.trim());
    if (cleaned.length > 0) {
      result.ocr_text = cleaned.join(' ');
    }
  }

  // Dominant colors — schema v2 (clip.colors.palette) o legacy (clip.semantics.dominant_colors)
  if (clip.colors && Array.isArray(clip.colors.palette) && clip.colors.palette.length > 0) {
    result.colors = {
      palette: clip.colors.palette
        .filter(p => p && typeof p === 'object' && typeof p.hex === 'string')
        .map(p => ({ hex: p.hex, name: typeof p.name === 'string' ? p.name : '' })),
    };
    // Compat para componentes que esperaban dominant_colors (array de strings)
    const names = result.colors.palette.map(p => p.name || p.hex).filter(Boolean);
    if (names.length > 0) {
      result.dominant_colors = names;
      if (!result.dominant_color) result.dominant_color = names[0];
    }
  } else if (clip.semantics && Array.isArray(clip.semantics.dominant_colors) && clip.semantics.dominant_colors.length > 0) {
    const colors = clip.semantics.dominant_colors
      .filter(c => c !== null && c !== undefined)
      .map(c => (typeof c === 'string' ? c : (c.name || c.hex || String(c))))
      .filter(c => c && c.trim());
    if (colors.length > 0) {
      result.dominant_colors = colors;
      if (!result.dominant_color) result.dominant_color = colors[0];
    }
  }

  // Atmosphere (schema v2): exponer objeto completo al frontend
  if (clip.atmosphere && typeof clip.atmosphere === 'object') {
    result.atmosphere = clip.atmosphere;
  }

  // Identity — normalizar al schema canónico
  if (clip.identity) {
    if (Array.isArray(clip.identity.faces)) {
      result.faces = clip.identity.faces
        .map(normalizeFace)
        .filter(Boolean);
    }
    if (Array.isArray(clip.identity.spaces)) {
      result.spaces = clip.identity.spaces
        .map(normalizeSpace)
        .filter(Boolean);
    }
    // face_boxes: bbox por cada cara detectada para que el visor pueda
    // dibujar rectangulos + etiquetas. Strip de embeddings (no los necesita
    // el cliente y serian ~3KB extra por cara en el payload).
    if (Array.isArray(clip.identity.detections) && clip.identity.detections.length > 0) {
      // Mantener face_index = posicion original en identity.detections[] para
      // que el frontend pueda enviarlo de vuelta (e.g. seed-from-face). El
      // filter posterior elimina detecciones sin bbox, asi que el indice del
      // face_box NO coincide con su posicion en este array sin face_index.
      result.face_boxes = clip.identity.detections
        .map((d, i) => ({ d, originalIndex: i }))
        .filter(({ d }) => d && Array.isArray(d.bbox) && d.bbox.length === 4)
        .map(({ d, originalIndex }) => {
          const personId = (typeof d.person_id === 'string' && d.person_id.trim()) ? d.person_id.trim() : null;
          const displayName = personId
            ? (peopleRegistry.getDisplayName(personId) || d.display_name || personId)
            : null;
          return {
            bbox: d.bbox,
            person_id: personId,
            display_name: displayName,
            det_score: typeof d.det_score === 'number' ? d.det_score : null,
            confidence: typeof d.confidence === 'number' ? d.confidence : null,
            age: typeof d.age === 'number' ? d.age : null,
            gender: typeof d.gender === 'number' ? d.gender : null,
            face_index: originalIndex,
          };
        });
    }
    // Segundo del video donde se hizo la deteccion facial. Solo presente en
    // videos. El visor lo usa para mostrar los bboxes solo cuando el
    // currentTime esta cerca de ese momento.
    if (typeof clip.identity.detection_frame_time === 'number') {
      result.detection_frame_time = clip.identity.detection_frame_time;
    }
  }

  // Demographics / composition / technical (objetos completos)
  if (clip.demographics && typeof clip.demographics === 'object') {
    result.demographics = clip.demographics;
  }
  if (clip.composition && typeof clip.composition === 'object') {
    result.composition = clip.composition;
  }
  if (clip.technical && typeof clip.technical === 'object') {
    result.technical = clip.technical;
    // Sobreescribir duration/resolution/fps si vienen
    if (typeof clip.technical.duration === 'number') {
      result.duration = clip.technical.duration;
    }
    if (typeof clip.technical.resolution === 'string') {
      result.resolution = clip.technical.resolution;
    }
    if (typeof clip.technical.fps === 'number') {
      result.fps = clip.technical.fps;
    }
  }

  // Flags
  result.has_catalog = true;

  // Resolver batch/processed: del catálogo > del envoltorio del sidecar > nada
  const batch = (catalog && typeof catalog.batch === 'string') ? catalog.batch : clip.__wrapper_batch;
  const processed = (catalog && typeof catalog.processed === 'string') ? catalog.processed : clip.__wrapper_processed;
  if (typeof batch === 'string') result.catalog_batch = batch;
  if (typeof processed === 'string') result.catalog_processed = processed;

  return result;
}

/**
 * Aplica metadatos sobre el fileData. Precedencia (lo específico gana,
 * permitiendo a un sidecar corregir el catálogo común de la carpeta):
 *   1. sidecar `<archivo.ext>.json`
 *   2. sidecar `<archivo>.json`
 *   3. entrada en catálogo `_marina.json`/`_pensadero.json`
 * Primer match gana, sin merge entre fuentes.
 *
 * @param {object} fileData - MediaFile con `fullPath` y `name` poblados
 */
async function applyCatalog(fileData) {
  if (!fileData || !fileData.fullPath) return fileData;

  const dir = path.dirname(fileData.fullPath);
  const basename = fileData.name || path.basename(fileData.fullPath);

  // 1/2) Sidecar individual primero (.ext.json → .json). Lo específico gana.
  const sidecarClip = await getSidecarForFile(fileData.fullPath);
  if (sidecarClip) {
    return mergeClipIntoFile(fileData, sidecarClip, null);
  }

  // 3) Catálogo por carpeta como fallback general.
  // Soporta tanto `clips` (vídeo) como `photos` (foto) como `audios`. El primero
  // que exista gana; no se mergean. Permite que el mismo formato `_marina.json`
  // sirva para distintos tipos de media sin duplicar el contrato.
  const catalog = await getCatalogForDir(dir);
  if (catalog) {
    const entries = (catalog.clips && typeof catalog.clips === 'object') ? catalog.clips
                  : (catalog.photos && typeof catalog.photos === 'object') ? catalog.photos
                  : (catalog.audios && typeof catalog.audios === 'object') ? catalog.audios
                  : null;
    if (entries) {
      const clip = entries[basename];
      if (clip) {
        return mergeClipIntoFile(fileData, clip, catalog);
      }
    }
  }

  return fileData;
}

module.exports = {
  CATALOG_FILENAME,
  CATALOG_FILENAMES,
  getCatalogForDir,
  getSidecarForFile,
  invalidateCatalog,
  invalidateSidecar,
  clearCatalogCache,
  applyCatalog,
  mergeClipIntoFile,
  normalizeFace,
  normalizeSpace,
};
