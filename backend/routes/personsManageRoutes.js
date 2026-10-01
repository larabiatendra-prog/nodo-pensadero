/**
 * Persons Management Routes — Pensadero
 *
 * CRUD del registry de personas + gestión de fotos de referencia.
 *
 * Rutas:
 *  - GET    /api/persons/registry            — lista completa de personas registradas
 *  - POST   /api/persons/registry            — crea/actualiza una persona
 *  - DELETE /api/persons/registry/:id        — elimina una persona y sus fotos de referencia
 *                                              (?olvidar=1: ademas guarda su huella para
 *                                              que el descubrimiento no la vuelva a proponer)
 *  - GET    /api/persons/registry/:id/photos — lista de fotos de referencia de una persona
 *  - POST   /api/persons/registry/:id/photos — sube una foto (multipart, field 'photo')
 *  - DELETE /api/persons/registry/:id/photos/:filename — borra una foto concreta
 *  - POST   /api/persons/registry/:id/avatar — marca una foto como avatar principal
 *  - GET    /api/persons/face-service/status — estado del daemon InsightFace
 *  - POST   /api/persons/registry/:id/train  — re-entrena embeddings de una persona
 *  - POST   /api/persons/reidentify          — re-identifica retroactivamente todas las fotos
 *  - GET    /api/persons/reidentify/status/:jobId — estado del job de re-identificacion
 *  - POST   /api/persons/reidentify/cancel/:jobId — cancela un job en curso
 *  - GET    /api/persons/clusters            — clusters de caras desconocidas (cache 5min)
 *  - POST   /api/persons/clusters/refresh    — fuerza recomputo del clustering
 *  - GET    /api/persons/clusters/:id/sample/:i — crop de la cara i del cluster id
 *  - POST   /api/persons/clusters/:id/promote — convierte el cluster en persona del registry
 *
 * Las fotos viven en `<AVATARS_BASE>/people/<person_id>/<n>.<ext>` para
 * que el endpoint estático `/persons-avatars` ya las sirva sin más config.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const multer = require('multer');
const peopleRegistry = require('../peopleRegistry');
const { atomicWriteFile, withFileLock, normalizeLockKey } = require('../utils/jsonStore');
const { computeFaceCount, rebuildFaces } = require('../utils/faceCatalog');
const fallos = require('../utils/failureReason');
const { getInstance: getFaceService, decodeEmbedding } = require('../services/faceService');
const faceReidentifier = require('../services/faceReidentifier');
const faceClusterer = require('../services/faceClusterer');
const olvidados = require('../services/olvidados');
const { dentroDeBiblioteca, nombreSuelto } = require('../utils/rutaDeBiblioteca');
const grupos = require('../services/grupos');
const sharp = require('sharp');
const { spawn } = require('child_process');
const os = require('os');

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

// Guard contra path traversal: el :id se concatena con path.join al avatarsBase,
// asi que filtramos cualquier valor que no sea alfanumerico/_/- (mismo regex que upsertPerson).
function assertValidPersonId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_\-]+$/.test(id);
}

// Multer en memoria; escribimos a disco a mano para tener control del nombre.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

module.exports = function createPersonsManageRoutes(deps) {
  const { recomputePersonsAggregate, broadcastProgress, getScanPaths, syncFiles, refreshDir } = deps || {};
  const router = express.Router();

  // Las acciones sobre UNA cara (asignarla, buscar parecidas, usarla de
  // retrato) reciben su carpeta y su nombre del navegador. Solo valen carpetas
  // de tus bibliotecas (Rutas, activas o no) y un nombre suelto: antes valia
  // cualquier carpeta del disco, y asignar escribe su _pensadero.json y el
  // retrato lee el archivo que se le diga.
  async function caraDeBiblioteca(body) {
    const { folder, basename } = body || {};
    if (!nombreSuelto(basename)) return false;
    const rutas = (typeof getScanPaths === 'function') ? await getScanPaths() : [];
    const raices = (Array.isArray(rutas) ? rutas : []).map(p => p && p.path).filter(Boolean);
    return dentroDeBiblioteca(folder, raices);
  }
  const FUERA_DE_BIBLIOTECA = 'esa carpeta no es de ninguna de tus bibliotecas';

  /**
   * Tras promote, escribe el `person_id` en las detecciones de los _pensadero.json
   * que pertenecen al cluster. Asi la persona aparece de inmediato en home y en
   * la galeria, sin necesidad de "Re-identificar biblioteca" completo.
   *
   * Sin esta funcion, las caras del cluster siguen en disco como "desconocidas"
   * hasta que se haga re-id global (lento para bibliotecas grandes).
   */
  async function applyPromoteToCatalogs(clusterFaces, personId, opts = {}) {
    // force: asignar el person_id directamente sin re-verificar contra el
    // daemon. Lo usa el "attach a persona existente": el usuario afirma que el
    // cluster ES esa persona, aunque su centroide promediado no quede cerca.
    const force = !!opts.force;
    if (!Array.isArray(clusterFaces) || clusterFaces.length === 0) {
      return { catalogsWritten: 0, facesUpdated: 0 };
    }
    const faceSvc = getFaceService();
    const displayName = peopleRegistry.getDisplayName(personId) || personId;

    // Agrupar caras por catalogo (folder/_pensadero.json)
    const byFolder = new Map();
    for (const f of clusterFaces) {
      if (!f || !f.folder || !f.basename || typeof f.face_index !== 'number') continue;
      if (!byFolder.has(f.folder)) byFolder.set(f.folder, []);
      byFolder.get(f.folder).push(f);
    }

    let catalogsWritten = 0;
    let facesUpdated = 0;
    let escriturasFallidas = 0;
    let lecturasFallidas = 0;
    const marcaFallos = fallos.mark();
    const writtenFolders = [];

    for (const [folder, faces] of byFolder) {
      const catalogPath = path.join(folder, '_pensadero.json');
      // Lock por path: el ciclo leer->mutar->escribir de este catalogo no se
      // solapa con el re-id de fondo (que assign-face/promote disparan) ni con
      // otro promote sobre la misma carpeta. Sin esto se pierden asignaciones.
      await withFileLock(normalizeLockKey(catalogPath), async () => {
        let catalog;
        try {
          const raw = await fsp.readFile(catalogPath, 'utf-8');
          catalog = JSON.parse(raw);
        } catch (err) {
          fallos.record('leer el catalogo para etiquetar el cluster', err, { path: catalogPath });
          lecturasFallidas++;
          return;
        }
        const photos = catalog.photos || catalog.clips || {};

        // Agrupar refs por basename para tocar cada entry una sola vez
        const byBasename = new Map();
        for (const f of faces) {
          if (!byBasename.has(f.basename)) byBasename.set(f.basename, []);
          byBasename.get(f.basename).push(f.face_index);
        }

        let dirty = false;
        for (const [basename, faceIndices] of byBasename) {
          const entry = photos[basename];
          if (!entry || !entry.identity || !Array.isArray(entry.identity.detections)) continue;

          // Re-identificar SOLO las caras del cluster contra el faceService
          // (que ya tiene cargados los embeddings de la persona promovida).
          // Aceptamos el match solo si coincide con personId — proteccion contra
          // que el daemon devuelva otro person_id mas cercano.
          const detsRefs = faceIndices.map(idx => entry.identity.detections[idx]).filter(Boolean);
          if (detsRefs.length === 0) continue;
          const identified = force ? null : faceSvc.identifyFaces(detsRefs);

          let entryChanged = false;
          for (let i = 0; i < detsRefs.length; i++) {
            const det = detsRefs[i];
            if (force) {
              det.person_id = personId;
              det.display_name = displayName;
              det.confidence = det.confidence || 0.99;
              // assigned_manually: el usuario AFIRMA que el cluster es esta
              // persona, y por eso se fuerza pese a que el coseno no llegue al
              // umbral. Sin esta marca, el re-id que el propio promote lanza a
              // continuacion (paso 8, debounced 4s) recalculaba estas caras, no
              // encontraba match y borraba el person_id: el "adjuntar a persona
              // existente" se deshacia solo a los pocos segundos. Es la misma
              // marca que pone assign-face, y reidentifyEntry la respeta.
              det.assigned_manually = true;
              entryChanged = true;
              facesUpdated++;
            } else {
              const match = identified[i];
              if (match && match.person_id === personId) {
                det.person_id = personId;
                det.display_name = displayName;
                det.confidence = match.similarity;
                entryChanged = true;
                facesUpdated++;
              }
            }
          }

          if (entryChanged) {
            // Recalcular faces[]/face_count con la definicion canonica compartida
            entry.identity.faces = rebuildFaces(entry.identity.detections, peopleRegistry.getDisplayName);
            entry.identity.face_count = computeFaceCount(entry.identity.detections);
            dirty = true;
          }
        }

        if (dirty) {
          try {
            await atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2));
            catalogsWritten++;
            writtenFolders.push(folder);
          } catch (err) {
            fallos.record('etiquetar las caras del cluster', err, { path: catalogPath });
            escriturasFallidas++;
          }
        }
      });
    }

    // Se devuelven tambien los fallos: quien llama DEBE poder decir "no pude".
    const incidencias = fallos.summary({ since: marcaFallos });
    return {
      catalogsWritten, facesUpdated, folders: writtenFolders,
      escriturasFallidas, lecturasFallidas,
      causa: incidencias.principal
        ? { reason: incidencias.principal.reason, hint: incidencias.principal.hint, code: incidencias.principal.code }
        : null,
    };
  }

  function getPersonDir(personId) {
    const state = peopleRegistry.getState();
    if (!state.avatarsBase) return null;
    return path.join(state.avatarsBase, 'people', personId);
  }

  // Lee el embeddings.json de una persona (o null). centroid validado a 512-d.
  async function readEmbeddingsJson(personDir) {
    if (!personDir) return null;
    try {
      const data = JSON.parse(await fsp.readFile(path.join(personDir, 'embeddings.json'), 'utf-8'));
      if (Array.isArray(data.centroid) && data.centroid.length === 512) return data;
    } catch {}
    return null;
  }

  // Copia las fotos de referencia de fromDir a toDir (sin avatar.jpg/embeddings).
  // Renombra ante colision. Devuelve cuantas copio.
  async function copyReferencePhotos(fromDir, toDir) {
    let names = [];
    try { names = await fsp.readdir(fromDir); } catch { return 0; }
    await fsp.mkdir(toDir, { recursive: true });
    let copied = 0;
    for (const name of names) {
      const lower = name.toLowerCase();
      if (lower === 'avatar.jpg' || lower === 'embeddings.json') continue;
      if (!ALLOWED_EXTS.has(path.extname(name).toLowerCase())) continue;
      let dst = path.join(toDir, name);
      if (fs.existsSync(dst)) dst = path.join(toDir, `merged_${Date.now()}_${name}`);
      try { await fsp.copyFile(path.join(fromDir, name), dst); copied++; } catch {}
    }
    return copied;
  }

  // GET — lista de personas registradas
  router.get('/persons/registry', (req, res) => {
    res.json({ success: true, data: peopleRegistry.listAll() });
  });

  // POST — crear o actualizar
  router.post('/persons/registry', (req, res) => {
    try {
      const entry = peopleRegistry.upsertPerson(req.body || {});
      if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();
      res.json({ success: true, data: entry });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // DELETE — eliminar persona y todas sus fotos
  router.delete('/persons/registry/:id', async (req, res) => {
    if (!assertValidPersonId(req.params.id)) {
      return res.status(400).json({ success: false, error: 'person_id inválido' });
    }
    const personId = req.params.id;
    const dir = getPersonDir(personId);
    const olvidar = req.query.olvidar === '1';

    // Olvidar = ademas de borrarla, que el descubrimiento de caras no la vuelva
    // a proponer como "desconocida frecuente". Se guarda su huella ANTES de
    // borrar la carpeta, que es donde vive su centroide.
    let olvidada = false;
    if (olvidar) {
      let centroide = null;
      const enCache = getFaceService().embeddingsCache.get(personId);
      if (enCache && enCache.centroid) centroide = enCache.centroid;
      if (!centroide && dir) {
        try {
          const datos = JSON.parse(await fsp.readFile(path.join(dir, 'embeddings.json'), 'utf-8'));
          if (Array.isArray(datos.centroid) && datos.centroid.length === 512) centroide = datos.centroid;
        } catch { /* nunca se entreno: no hay huella que guardar */ }
      }
      if (centroide) {
        try {
          olvidada = await olvidados.agregar(centroide);
        } catch (err) {
          // Sin huella, olvidar no seria olvidar: mejor no borrar nada y decirlo.
          const causa = fallos.record('guardar la huella de una persona olvidada', err, {});
          return res.status(500).json({ success: false, error: causa.reason });
        }
      }
    }

    // deletePerson lanza si no consigue persistir el registry (y deshace el
    // cambio en memoria). Sin este try, el throw dejaba la peticion colgada.
    let existed;
    try {
      existed = peopleRegistry.deletePerson(personId);
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    if (!existed) return res.status(404).json({ success: false, error: 'no existe' });

    // Borrar fotos + embeddings (best-effort, no bloqueante)
    if (dir) {
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch (err) {
        console.warn(`[persons] no se pudo borrar ${dir}: ${err.message}`);
      }
    }

    // Evitar que la persona borrada siga matcheando: sacar su centroide del
    // cache en memoria y recargar (por si el rm del dir fallo en Windows, la
    // carga registry-driven ya ignora el dir huerfano).
    const faceSvc = getFaceService();
    faceSvc.embeddingsCache.delete(personId);
    faceSvc.loadAllEmbeddings(peopleRegistry.getState().avatarsBase).catch(() => {});

    // Las caras del borrado vuelven a ser "desconocidas": invalidar discovery.
    faceClusterer.invalidateCache();

    // Y de los grupos en los que estaba. Si falla no se deshace el borrado: la
    // lista de grupos ya esconde a quien no existe (ver gruposRoutes).
    grupos.quitarMiembro(personId).catch(err => console.warn('[persons-delete] grupos:', err.message));

    if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();

    // Barrer catalogos en background para quitar etiquetas fantasma (incluidas
    // las assigned_manually, que el re-id normal nunca limpia). Tras escribir,
    // refrescar mediaFiles para que desaparezca de home/galeria.
    setImmediate(async () => {
      try {
        const rootDirs = await getActiveRoots();
        if (rootDirs.length === 0) return;
        const r = await faceReidentifier.purgePersonFromCatalogs(personId, {
          rootDirs,
          broadcastProgress: broadcastProgress || (() => {}),
        });
        if (r.catalogsWritten > 0 && typeof syncFiles === 'function') {
          syncFiles().catch(() => {});
        }
      } catch (err) {
        console.error('[persons-delete] purge background:', err.message);
      }
    });

    res.json({ success: true, deleted: true, olvidada });
  });

  // GET/DELETE — caras olvidadas: cuantas hay y "volver a proponerlas"
  router.get('/persons/olvidadas', (req, res) => {
    res.json({ success: true, data: { total: olvidados.total() } });
  });

  router.delete('/persons/olvidadas', async (req, res) => {
    try {
      const vaciadas = await olvidados.vaciar();
      faceClusterer.invalidateCache();
      res.json({ success: true, data: { vaciadas } });
    } catch (err) {
      const causa = fallos.record('volver a proponer las caras olvidadas', err, {});
      res.status(500).json({ success: false, error: causa.reason });
    }
  });

  // GET — fotos de referencia
  router.get('/persons/registry/:id/photos', async (req, res) => {
    if (!assertValidPersonId(req.params.id)) {
      return res.status(400).json({ success: false, error: 'person_id inválido' });
    }
    const dir = getPersonDir(req.params.id);
    if (!dir) return res.json({ success: true, data: [] });
    let files = [];
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      files = entries
        .filter(e => e.isFile() && ALLOWED_EXTS.has(path.extname(e.name).toLowerCase()))
        // 'avatar.jpg' es el recorte de cara DERIVADO, no una foto de referencia.
        .filter(e => e.name.toLowerCase() !== 'avatar.jpg')
        .map(e => e.name)
        .sort();
    } catch {
      files = [];
    }
    // URLs servidas por el endpoint /persons-avatars
    const data = files.map(name => ({
      filename: name,
      url: `/persons-avatars/people/${encodeURIComponent(req.params.id)}/${encodeURIComponent(name)}`,
    }));
    res.json({ success: true, data });
  });

  // POST — subir una foto (multipart, field 'photo')
  router.post('/persons/registry/:id/photos', upload.single('photo'), async (req, res) => {
    try {
      const personId = req.params.id;
      if (!assertValidPersonId(personId)) {
        return res.status(400).json({ success: false, error: 'person_id inválido' });
      }
      if (!req.file) return res.status(400).json({ success: false, error: 'falta archivo (field "photo")' });

      // Validar extensión por nombre original
      const originalName = req.file.originalname || 'photo.jpg';
      const ext = path.extname(originalName).toLowerCase() || '.jpg';
      if (!ALLOWED_EXTS.has(ext)) {
        return res.status(400).json({ success: false, error: `extensión no soportada: ${ext}` });
      }

      // Asegurar entrada en registry (si no existe la creamos con defaults)
      const state = peopleRegistry.getState();
      if (!state.personIds.includes(personId)) {
        peopleRegistry.upsertPerson({ person_id: personId, display_name: personId });
      }

      const dir = getPersonDir(personId);
      if (!dir) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });
      await fsp.mkdir(dir, { recursive: true });

      // Nombre único: photo_<timestamp>.<ext>
      const filename = `photo_${Date.now()}${ext}`;
      const filePath = path.join(dir, filename);
      await fsp.writeFile(filePath, req.file.buffer);

      // Si la persona no tenía avatar, esta foto pasa a ser el avatar principal
      const allEntries = peopleRegistry.listAll();
      const meEntry = allEntries.find(p => p.person_id === personId);
      if (meEntry && !meEntry.avatar_path) {
        try {
          peopleRegistry.upsertPerson({
            person_id: personId,
            avatar_path: path.posix.join('people', personId, filename),
          });
        } catch (err) {
          return res.status(500).json({ success: false, error: err.message });
        }
      }

      if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();

      // Auto-train + avatar derivado en background. No bloquea la respuesta.
      const faceSvc = getFaceService();
      const rawAvatarRel = path.posix.join('people', personId, filename);
      faceSvc.init().then(async ok => {
        if (!ok) return;
        try {
          const result = await faceSvc.trainPerson(dir);
          peopleRegistry.bumpDataVersion(); // centroide nuevo → discovery stale
          console.log(`[persons] auto-train ${personId}: count=${result?.count} mean_sim=${result?.mean_similarity_to_centroid?.toFixed(3)}`);
        } catch (err) {
          console.warn(`[persons] auto-train ${personId} falló:`, err.message);
        }
        // Si el avatar sigue siendo la foto CRUDA recien subida, derivar un
        // recorte de cara limpio (mejor encuadre que object-cover de la cruda).
        try {
          const me = peopleRegistry.listAll().find(p => p.person_id === personId);
          if (me && me.avatar_path === rawAvatarRel) {
            const rel = await generateAvatarFromPhoto(personId, filename);
            if (rel) {
              peopleRegistry.upsertPerson({ person_id: personId, avatar_path: rel });
              if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();
            }
          }
        } catch (err) {
          console.warn(`[persons] avatar derivado ${personId} falló:`, err.message);
        }
      });

      res.json({
        success: true,
        data: {
          filename,
          url: `/persons-avatars/people/${encodeURIComponent(personId)}/${encodeURIComponent(filename)}`,
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST — entrenar manualmente (recalcula embeddings desde las fotos actuales)
  router.post('/persons/registry/:id/train', async (req, res) => {
    const personId = req.params.id;
    if (!assertValidPersonId(personId)) {
      return res.status(400).json({ success: false, error: 'person_id inválido' });
    }
    const dir = getPersonDir(personId);
    if (!dir) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });
    if (!fs.existsSync(dir)) return res.status(404).json({ success: false, error: 'sin fotos para esta persona' });
    const faceSvc = getFaceService();
    const ok = await faceSvc.init();
    if (!ok) return res.status(503).json({ success: false, error: faceSvc.getStatus().lastError || 'face service no disponible' });
    try {
      const result = await faceSvc.trainPerson(dir);
      // El centroide cambio: marcar discovery como stale (cluster cache).
      peopleRegistry.bumpDataVersion();
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST — asignar manualmente una cara desconocida a una persona existente.
  // Marca la deteccion en el _pensadero.json, fusiona el embedding en el
  // centroid de la persona y dispara re-identificacion global en background.
  router.post('/persons/registry/:id/assign-face', async (req, res) => {
    const personId = req.params.id;
    if (!assertValidPersonId(personId)) {
      return res.status(400).json({ success: false, error: 'person_id invalido' });
    }
    const { folder, basename, face_index } = req.body || {};
    if (!folder || !basename || typeof face_index !== 'number') {
      return res.status(400).json({ success: false, error: 'folder, basename y face_index son requeridos' });
    }
    if (!(await caraDeBiblioteca(req.body))) {
      return res.status(403).json({ success: false, error: FUERA_DE_BIBLIOTECA });
    }

    const state = peopleRegistry.getState();
    if (!state.personIds.includes(personId)) {
      return res.status(404).json({ success: false, error: 'persona no encontrada en el registry' });
    }
    const displayName = peopleRegistry.getDisplayName(personId) || personId;

    const catalogPath = path.join(folder, '_pensadero.json');
    // `det` se necesita despues del lock (para fusionar su embedding en el
    // centroid de la persona), por eso se declara fuera.
    let det;
    try {
      // Lock por path: el ciclo leer->marcar->escribir de este catalogo no se
      // solapa con el re-id de fondo que este mismo handler dispara mas abajo,
      // ni con otro assign-face/promote sobre la misma carpeta. Sin esto la
      // asignacion manual recien hecha podia perderse (lost-update).
      await withFileLock(normalizeLockKey(catalogPath), async () => {
        let catalog;
        try {
          const raw = await fsp.readFile(catalogPath, 'utf-8');
          catalog = JSON.parse(raw);
        } catch (err) {
          const e = new Error(`catalogo no encontrado: ${err.message}`); e.httpStatus = 404; throw e;
        }

        const photos = catalog.photos || catalog.clips || {};
        const entry = photos[basename];
        if (!entry) {
          const e = new Error(`entrada no encontrada: ${basename}`); e.httpStatus = 404; throw e;
        }
        const detections = entry?.identity?.detections;
        if (!Array.isArray(detections) || face_index < 0 || face_index >= detections.length) {
          const e = new Error('face_index fuera de rango o sin detecciones'); e.httpStatus = 400; throw e;
        }

        det = detections[face_index];
        if (!det.embedding_b64) {
          const e = new Error('esta deteccion no tiene embedding (re-scan necesario)'); e.httpStatus = 400; throw e;
        }

        // Marcar deteccion como asignada manualmente
        det.person_id = personId;
        det.display_name = displayName;
        det.confidence = 1.0;
        det.assigned_manually = true;

        // Recalcular identity.faces/face_count con la definicion canonica compartida
        entry.identity.faces = rebuildFaces(detections, peopleRegistry.getDisplayName);
        entry.identity.face_count = computeFaceCount(detections);

        await atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2));
      });
    } catch (err) {
      // Los errores "de negocio" (404 entry no encontrada, 400 sin embedding)
      // ya vienen con su mensaje claro. El resto es un fallo de escritura y hay
      // que traducirlo: "error escribiendo catalogo: ENOSPC: no space left on
      // device" no le dice a nadie que el disco de la biblioteca esta lleno.
      if (err.httpStatus) {
        return res.status(err.httpStatus).json({ success: false, error: err.message });
      }
      const causa = fallos.record('asignar la cara a una persona', err, { path: catalogPath });
      return res.status(500).json({
        success: false,
        error: `No se ha podido guardar la asignacion. ${causa.reason}${causa.hint ? ` ${causa.hint}` : ''}`,
        causa: { reason: causa.reason, hint: causa.hint, code: causa.code },
      });
    }

    // Refrescar YA el mediaFile en memoria de esta carpeta (+ agregado) para que
    // la asignacion aparezca AL INSTANTE en home/galeria, sin esperar al re-id de
    // fondo. Sin esto, /api/files seguia sirviendo el estado viejo (solo se veia
    // tras un sync/restart). Es el bug de "asigne la cara pero no aparece".
    if (typeof refreshDir === 'function') {
      try { await refreshDir(folder); } catch (err) { console.warn('[assign-face] refreshDir:', err.message); }
    } else if (typeof recomputePersonsAggregate === 'function') {
      recomputePersonsAggregate();
    }

    // Fusionar embedding en el centroid de la persona (media ponderada + re-L2-normalize)
    const personDir = getPersonDir(personId);
    if (personDir) {
      const embFile = path.join(personDir, 'embeddings.json');
      try {
        // Lock por path del embeddings.json: el blend (leer centroid -> mezclar
        // -> escribir) no se solapa con entrenamiento/merge/promote ni con otro
        // assign-face de la MISMA persona; sin esto dos blends concurrentes leen
        // el mismo centroid y el segundo pisa al primero (lost-update).
        await withFileLock(normalizeLockKey(embFile), async () => {
          const raw = await fsp.readFile(embFile, 'utf-8');
          const existing = JSON.parse(raw);
          if (Array.isArray(existing.centroid) && existing.centroid.length === 512) {
            const newEmb = decodeEmbedding(det.embedding_b64);
            if (newEmb && newEmb.length === 512) {
              const n = existing.count || 1;
              const blended = new Float32Array(512);
              for (let i = 0; i < 512; i++) blended[i] = (existing.centroid[i] * n + newEmb[i]) / (n + 1);
              let norm = 0;
              for (let i = 0; i < 512; i++) norm += blended[i] * blended[i];
              norm = Math.sqrt(norm);
              if (norm > 0) for (let i = 0; i < 512; i++) blended[i] /= norm;
              existing.centroid = Array.from(blended);
              existing.count = n + 1;
              existing.trained_at = new Date().toISOString();
              await atomicWriteFile(embFile, JSON.stringify(existing), { backup: true });
              // Invalidar cache en faceService para que el proximo identifyFaces use el centroid actualizado
              getFaceService().embeddingsCache.delete(personId);
            }
          }
        });
      } catch {
        // Sin embeddings.json: persona no entrenada. Se omite el blend sin error.
      }
    }

    // Invalidar cluster cache (la cara ya no es desconocida)
    faceClusterer.invalidateCache();

    // Re-id en background DEBOUNCED para asociar otras apariciones sin matchear.
    // Antes cada assign-face lanzaba un re-walk completo de la biblioteca; al
    // etiquetar varias caras seguidas se acumulaban re-ids solapados (causa
    // principal de "lento"). Ahora se coalescen en uno solo tras la rafaga.
    setImmediate(async () => {
      try {
        const rootDirs = await getActiveRoots();
        if (rootDirs.length > 0) {
          faceReidentifier.requestBackgroundReidentify({
            rootDirs,
            broadcastProgress: broadcastProgress || (() => {}),
            refreshDir,
          });
        }
      } catch (err) {
        console.error('[assign-face] error programando re-identify:', err);
      }
    });

    res.json({ success: true, person_id: personId, display_name: displayName });
  });

  // POST — FUSIONAR dos personas del registry en una. El "perdedor" (loser_id)
  // se funde en el "superviviente" (survivor_id): se mezclan los centroides
  // (ponderado por count), se copian sus fotos de referencia, se reasignan
  // todas sus caras en los catalogos al superviviente y se borra el perdedor.
  router.post('/persons/registry/merge', async (req, res) => {
    const { survivor_id, loser_id } = req.body || {};
    if (!assertValidPersonId(survivor_id) || !assertValidPersonId(loser_id)) {
      return res.status(400).json({ success: false, error: 'survivor_id y loser_id requeridos y validos' });
    }
    if (survivor_id === loser_id) {
      return res.status(400).json({ success: false, error: 'no se puede fusionar una persona consigo misma' });
    }
    const state = peopleRegistry.getState();
    if (!state.personIds.includes(survivor_id)) return res.status(404).json({ success: false, error: `"${survivor_id}" no existe` });
    if (!state.personIds.includes(loser_id)) return res.status(404).json({ success: false, error: `"${loser_id}" no existe` });

    const survivorDir = getPersonDir(survivor_id);
    const loserDir = getPersonDir(loser_id);

    // 1) Mezclar centroides (ponderado por count). Si solo uno tiene embeddings,
    //    se conserva ese. El retrain posterior (si hay fotos) lo recalcula exacto.
    const survivorEmbFile = path.join(survivorDir, 'embeddings.json');
    try {
      // Lock por path del embeddings.json del superviviente: la mezcla de
      // centroides no se solapa con un assign-face/entrenamiento sobre esa misma
      // persona (que tambien hacen read-modify-write de este fichero).
      await withFileLock(normalizeLockKey(survivorEmbFile), async () => {
        const survEmb = await readEmbeddingsJson(survivorDir);
        const loseEmb = await readEmbeddingsJson(loserDir);
        let blended = null;
        let count = 0;
        if (survEmb && loseEmb) {
          const n1 = survEmb.count || 1;
          const n2 = loseEmb.count || 1;
          blended = new Float32Array(512);
          for (let i = 0; i < 512; i++) blended[i] = (survEmb.centroid[i] * n1 + loseEmb.centroid[i] * n2) / (n1 + n2);
          let norm = 0; for (let i = 0; i < 512; i++) norm += blended[i] * blended[i]; norm = Math.sqrt(norm);
          if (norm > 0) for (let i = 0; i < 512; i++) blended[i] /= norm;
          count = n1 + n2;
        } else if (loseEmb && !survEmb) {
          blended = Float32Array.from(loseEmb.centroid);
          count = loseEmb.count || 1;
        }
        if (blended) {
          const out = {
            person_id: survivor_id, version: 1, count,
            photos_used: [], mean_similarity_to_centroid: null, min_similarity_to_centroid: null,
            centroid: Array.from(blended), trained_at: new Date().toISOString(), source: 'person_merge',
          };
          await fsp.mkdir(survivorDir, { recursive: true });
          await atomicWriteFile(survivorEmbFile, JSON.stringify(out), { backup: true });
        }
      });
    } catch (err) {
      console.warn('[person-merge] blend centroides:', err.message);
    }

    // 2) Copiar fotos de referencia del perdedor al superviviente (para retrain).
    let photosCopied = 0;
    try { photosCopied = await copyReferencePhotos(loserDir, survivorDir); } catch {}

    // 3) Borrar el perdedor del registry + su carpeta.
    try {
      peopleRegistry.deletePerson(loser_id);
    } catch (err) {
      // El centroide ya esta mezclado y las fotos copiadas: la fusion queda a
      // medias. Decirlo es mejor que devolver un exito que no lo es.
      return res.status(500).json({ success: false, error: `Fusion incompleta, el perdedor no se ha podido borrar: ${err.message}` });
    }
    if (loserDir) { try { await fsp.rm(loserDir, { recursive: true, force: true }); } catch {} }

    // 4) Sincronizar caches: quitar el perdedor, recargar, invalidar discovery.
    const faceSvc = getFaceService();
    faceSvc.embeddingsCache.delete(loser_id);
    await faceSvc.loadAllEmbeddings(state.avatarsBase).catch(() => {});
    faceClusterer.invalidateCache();
    if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();

    // 4b) En los grupos donde estaba la perdedora pasa a estar la superviviente.
    await grupos.renombrarMiembro(loser_id, survivor_id).catch(err => console.warn('[person-merge] grupos:', err.message));

    // 5) Background: reasignar caras del perdedor en catalogos + retrain + sync.
    setImmediate(async () => {
      try {
        const rootDirs = await getActiveRoots();
        if (rootDirs.length > 0) {
          await faceReidentifier.rewritePersonInCatalogs(loser_id, survivor_id, {
            rootDirs,
            broadcastProgress: broadcastProgress || (() => {}),
          });
        }
        // Retrain del superviviente si tiene fotos (recalcula centroide exacto).
        if (fs.existsSync(survivorDir)) {
          const ok = await faceSvc.init();
          if (ok) { await faceSvc.trainPerson(survivorDir).then(() => peopleRegistry.bumpDataVersion()).catch(() => {}); }
        }
        if (typeof syncFiles === 'function') syncFiles().catch(() => {});
      } catch (err) {
        console.error('[person-merge] background:', err.message);
      }
    });

    res.json({ success: true, data: { survivor_id, loser_id, photos_copied: photosCopied } });
  });

  // GET — estado del servicio de reconocimiento facial.
  // Si el daemon no esta ready y no fallo (unavailable=false), dispara init()
  // en background — el frontend hara polling y vera ready=true cuando el
  // daemon Python termine de cargar los modelos (~5-7s). Tambien recarga el
  // cache de embeddings para que trainedPersons refleje las personas con
  // embeddings.json en disco.
  router.get('/persons/face-service/status', (req, res) => {
    const faceSvc = getFaceService();
    const st = faceSvc.getStatus();
    if (!st.ready && !st.unavailable) {
      // Disparar sin esperar — la respuesta de este endpoint va con el estado actual
      faceSvc.init().then(ok => {
        if (ok) {
          faceSvc.loadAllEmbeddings(peopleRegistry.getState().avatarsBase).catch(() => {});
        }
      }).catch(() => {});
    }
    res.json({ success: true, data: st });
  });

  // POST — re-identificacion retroactiva. Recorre todos los _pensadero.json
  // bajo las rutas configuradas y recalcula los matches usando los embeddings
  // ya persistidos. No re-detecta caras; es rapido (~ms por entry).
  // Devuelve jobId; progreso por WebSocket (events reidentify_*).
  router.post('/persons/reidentify', async (req, res) => {
    try {
      let rootDirs = [];
      if (typeof getScanPaths === 'function') {
        const paths = await getScanPaths();
        rootDirs = (Array.isArray(paths) ? paths : [])
          .filter(p => p && p.isActive !== false && p.path)
          .map(p => p.path);
      }
      if (rootDirs.length === 0) {
        return res.status(400).json({ success: false, error: 'no hay rutas activas configuradas' });
      }

      const jobId = `reid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      setImmediate(() => {
        faceReidentifier.reidentifyAll({
          rootDirs,
          broadcastProgress: broadcastProgress || (() => {}),
          jobId,
          refreshDir,
        }).catch(err => {
          console.error('[reidentify] error fatal:', err);
        });
      });

      res.json({ success: true, jobId, status: 'started' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/persons/reidentify/status/:jobId', (req, res) => {
    const status = faceReidentifier.getJobStatus(req.params.jobId);
    if (!status) return res.status(404).json({ success: false, error: 'jobId desconocido' });
    res.json({ success: true, data: status });
  });

  router.post('/persons/reidentify/cancel/:jobId', (req, res) => {
    const ok = faceReidentifier.cancelJob(req.params.jobId);
    if (!ok) return res.status(404).json({ success: false, error: 'job no cancelable' });
    res.json({ success: true, cancelled: true });
  });

  // ==============================================================
  // CLUSTERING DE CARAS DESCONOCIDAS
  // ==============================================================

  async function getActiveRoots() {
    if (typeof getScanPaths !== 'function') return [];
    const paths = await getScanPaths();
    return (Array.isArray(paths) ? paths : [])
      .filter(p => p && p.isActive !== false && p.path)
      .map(p => p.path);
  }

  function publicCluster(c) {
    // No exponemos el centroide ni los embeddings — son grandes y no los necesita el frontend.
    // samples_meta: info ligera por muestra (folder + basename + score) para que
    // el frontend pueda resolver cada cara a su archivo en la biblioteca y abrirlo.
    return {
      cluster_id: c.cluster_id,
      face_count: c.face_count, // nº de CARAS (detecciones) — no de archivos
      // file_count: nº de ARCHIVOS distintos. El home cuenta archivos, no caras;
      // exponerlo evita la confusion "6 apariciones en cluster vs 2 en home".
      file_count: Array.isArray(c.faces)
        ? new Set(c.faces.map(f => `${f.folder}|${f.basename}`)).size
        : c.face_count,
      avg_score: c.avg_score,
      dominant_age: c.dominant_age,
      dominant_gender: c.dominant_gender,
      sample_count: c.samples.length,
      samples_meta: c.samples.map(s => ({
        folder: s.folder,
        basename: s.basename,
        det_score: s.det_score || 0,
      })),
    };
  }

  // GET — devuelve clusters cacheados; si no hay cache, lanza job y responde { jobId }
  router.get('/persons/clusters', async (req, res) => {
    const cached = faceClusterer.getCached();
    if (cached) {
      return res.json({
        success: true,
        data: {
          clusters: cached.clusters.map(publicCluster),
          computedAt: cached.computedAt,
          fromCache: true,
        },
      });
    }
    try {
      const rootDirs = await getActiveRoots();
      if (rootDirs.length === 0) return res.status(400).json({ success: false, error: 'no hay rutas activas configuradas' });
      const jobId = `cluster_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setImmediate(() => {
        faceClusterer.clusterAll({
          rootDirs,
          broadcastProgress: broadcastProgress || (() => {}),
          jobId,
        }).catch(err => console.error('[cluster] error fatal:', err));
      });
      res.json({ success: true, jobId, status: 'started', fromCache: false });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST — fuerza recomputo
  router.post('/persons/clusters/refresh', async (req, res) => {
    faceClusterer.invalidateCache();
    try {
      const rootDirs = await getActiveRoots();
      if (rootDirs.length === 0) return res.status(400).json({ success: false, error: 'no hay rutas activas configuradas' });
      const jobId = `cluster_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setImmediate(() => {
        faceClusterer.clusterAll({
          rootDirs,
          broadcastProgress: broadcastProgress || (() => {}),
          jobId,
        }).catch(err => console.error('[cluster] error fatal:', err));
      });
      res.json({ success: true, jobId, status: 'started' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST — crea un cluster "ad-hoc" a partir de una cara concreta (folder +
  // basename + face_index). Permite que el usuario, al ver una cara desconocida
  // en el visor, busque similares en toda la biblioteca y promueva como persona.
  router.post('/persons/clusters/seed-from-face', async (req, res) => {
    const { folder, basename, face_index, threshold } = req.body || {};
    if (!folder || !basename || typeof face_index !== 'number') {
      return res.status(400).json({ success: false, error: 'folder, basename y face_index requeridos' });
    }
    if (!(await caraDeBiblioteca(req.body))) {
      return res.status(403).json({ success: false, error: FUERA_DE_BIBLIOTECA });
    }
    try {
      const rootDirs = (typeof getScanPaths === 'function') ? await getActiveRoots() : [];
      const cluster = await faceClusterer.seedClusterFromFace({
        folder, basename, face_index, threshold,
        rootDirs,
      });
      if (!cluster) {
        return res.status(404).json({ success: false, error: 'no se encontraron caras similares (o la cara seed no tiene embedding persistido)' });
      }
      res.json({ success: true, data: publicCluster(cluster) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET — devuelve grupos de clusters similares entre si (Union-Find sobre
  // cosine sim >= threshold). Sirve para sugerir al usuario que probablemente
  // sean la misma persona y deberian fusionarse antes de promover.
  router.get('/persons/clusters/similarity', (req, res) => {
    const t = parseFloat(req.query.threshold);
    const threshold = Number.isFinite(t) ? t : undefined;
    const data = faceClusterer.computeSimilarityGroups(threshold);
    if (!data) return res.status(404).json({ success: false, error: 'no hay cache de clusters' });
    res.json({ success: true, data });
  });

  // POST — fusiona N clusters del cache en uno solo. Devuelve el cluster merged.
  // Los originales se reemplazan en cache; el merged hereda samples top-9 por
  // score y un centroide ponderado por face_count.
  router.post('/persons/clusters/merge', (req, res) => {
    const { cluster_ids } = req.body || {};
    if (!Array.isArray(cluster_ids) || cluster_ids.length < 2) {
      return res.status(400).json({ success: false, error: 'cluster_ids requeridos (minimo 2)' });
    }
    const merged = faceClusterer.mergeClusters(cluster_ids);
    if (!merged) {
      return res.status(404).json({ success: false, error: 'cluster(s) no encontrado(s) o cache expirado' });
    }
    res.json({ success: true, data: publicCluster(merged) });
  });

  const { VIDEO_EXTS } = require('../utils/formatos');

  // Extrae un frame de un video a un temp jpg para recortar una cara.
  // `frameTime` (segundo) debe ser el momento donde se detecto la cara (lo
  // persiste el scan en det.frame_time). Si no se pasa (catalogos antiguos sin
  // frame_time), cae al 30% de duracion como hacia el scan legacy.
  async function extractVideoFrame(videoPath, frameTime = null) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pensadero-clusterframe-'));
    const outPath = path.join(tmpDir, 'rep.jpg');
    let seekSec;
    if (typeof frameTime === 'number' && frameTime >= 0) {
      seekSec = frameTime;
    } else {
      // Fallback: 30% de duracion via ffprobe, o 5s si falla. Con timeout duro:
      // en un disco externo lento/desconectado, ffprobe podia colgarse sin fin
      // (no tenia clock), bloqueando el recorte de avatar indefinidamente.
      seekSec = await new Promise(resolve => {
        const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath]);
        let buf = '';
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; clearTimeout(t); resolve(v); };
        const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} done(5); }, 15_000);
        ff.stdout.on('data', d => { buf += d.toString(); });
        ff.on('close', () => {
          const dur = parseFloat(buf.trim());
          done(isFinite(dur) && dur > 1 ? dur * 0.3 : 5);
        });
        ff.on('error', () => done(5));
      });
    }
    return new Promise((resolve) => {
      const p = spawn('ffmpeg', ['-y', '-ss', String(seekSec), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outPath], { stdio: 'ignore' });
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(null); }, 30_000);
      p.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? outPath : null); });
      p.on('error', () => { clearTimeout(timer); resolve(null); });
    });
  }

  /**
   * Recorta una cara desde una imagen (path) usando bbox + padding. Devuelve
   * un Buffer JPEG redimensionado a tam max.
   */
  async function cropFaceFromImage(srcPath, bbox, size = 200) {
    // HEIC/HEIF: sharp 0.32.x no los decodifica. Transcodificar a un JPEG temp
    // (orientado) via daemon antes de recortar. El jpeg resultante ya no lleva
    // EXIF de orientacion (cv2 escribe pixeles orientados).
    const ext = path.extname(srcPath).toLowerCase();
    let workPath = srcPath;
    let tmpJpeg = null;
    if (ext === '.heic' || ext === '.heif') {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pensadero-heic-'));
      tmpJpeg = path.join(tmpDir, 'src.jpg');
      await getFaceService().convertToJpeg(srcPath, tmpJpeg);
      workPath = tmpJpeg;
    }
    try {
      const img = sharp(workPath, { failOn: 'none' });
      const meta = await img.metadata();
      if (!meta.width || !meta.height) throw new Error('imagen sin dimensiones');
      // Las bbox vienen del detector, que trabaja en espacio YA orientado por EXIF
      // (cv2 auto-rota; HEIC via exif_transpose). sharp lee pixeles crudos: hay que
      // auto-orientar con .rotate() y recortar en las dimensiones orientadas. Sin
      // esto, fotos verticales de movil daban recortes fuera de sitio o 500.
      const orientation = meta.orientation || 1;
      const swap = orientation >= 5; // 5,6,7,8 → ancho/alto intercambiados
      const oW = swap ? meta.height : meta.width;
      const oH = swap ? meta.width : meta.height;
      const [x1, y1, x2, y2] = bbox;
      const w = Math.max(1, x2 - x1);
      const h = Math.max(1, y2 - y1);
      const padX = w * 0.3;
      const padY = h * 0.3;
      let left = Math.max(0, Math.floor(x1 - padX));
      let top = Math.max(0, Math.floor(y1 - padY));
      let width = Math.min(oW - left, Math.ceil(w + padX * 2));
      let height = Math.min(oH - top, Math.ceil(h + padY * 2));
      if (width < 4 || height < 4) throw new Error('crop demasiado pequeño');
      return await img.rotate().extract({ left, top, width, height }).resize(size, size, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
    } finally {
      if (tmpJpeg) {
        try { await fsp.unlink(tmpJpeg); } catch {}
        try { await fsp.rmdir(path.dirname(tmpJpeg)); } catch {}
      }
    }
  }

  /**
   * Recorta la cara de una fuente (foto o video) a un Buffer JPEG. Centraliza
   * el manejo de video (extraer frame en frameTime) + HEIC (lo hace
   * cropFaceFromImage). Devuelve el Buffer recortado.
   */
  async function renderFaceCrop(srcPath, bbox, frameTime, size = 200) {
    const ext = path.extname(srcPath).toLowerCase();
    let cropSrc = srcPath;
    let tmpFrame = null;
    try {
      if (VIDEO_EXTS.has(ext)) {
        const framePath = await extractVideoFrame(srcPath, typeof frameTime === 'number' ? frameTime : null);
        if (!framePath) throw new Error('no se pudo extraer frame del video');
        cropSrc = framePath;
        tmpFrame = framePath;
      }
      return await cropFaceFromImage(cropSrc, bbox, size);
    } finally {
      if (tmpFrame) {
        try { await fsp.unlink(tmpFrame); } catch {}
        try { await fsp.rmdir(path.dirname(tmpFrame)); } catch {}
      }
    }
  }

  // Escribe un Buffer como people/<id>/avatar.jpg y devuelve la ruta relativa.
  async function writeAvatarFile(personId, buf) {
    const dir = getPersonDir(personId);
    if (!dir) throw new Error('avatarsBase no configurado');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'avatar.jpg'), buf);
    return path.posix.join('people', personId, 'avatar.jpg');
  }

  /**
   * Genera un avatar recortando la cara MAS GRANDE de una foto de referencia.
   * Devuelve la ruta relativa del avatar derivado, o null si no se pudo
   * (daemon caido, sin caras) — el caller cae entonces a usar la imagen cruda.
   */
  async function generateAvatarFromPhoto(personId, filename) {
    const dir = getPersonDir(personId);
    if (!dir) return null;
    const srcPath = path.join(dir, filename);
    const faceSvc = getFaceService();
    const ok = await faceSvc.init();
    if (!ok) return null;
    let faces = [];
    try { faces = await faceSvc.detectFaces(srcPath); } catch { return null; }
    if (!Array.isArray(faces) || faces.length === 0) return null;
    // Cara de mayor area (la principal de la foto de referencia)
    faces.sort((a, b) =>
      ((b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])) -
      ((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1])));
    try {
      const buf = await renderFaceCrop(srcPath, faces[0].bbox, null, 400);
      return await writeAvatarFile(personId, buf);
    } catch (err) {
      console.warn(`[avatar] no se pudo recortar avatar de ${filename}: ${err.message}`);
      return null;
    }
  }

  // GET — thumbnail recortado de una cara concreta del cluster
  router.get('/persons/clusters/:cluster_id/sample/:index', async (req, res) => {
    const cluster = faceClusterer.getCluster(req.params.cluster_id);
    if (!cluster) return res.status(404).json({ success: false, error: 'cluster no encontrado (cache expirado?)' });
    const idx = parseInt(req.params.index, 10);
    if (!isFinite(idx) || idx < 0 || idx >= cluster.samples.length) {
      return res.status(400).json({ success: false, error: 'indice fuera de rango' });
    }
    const sample = cluster.samples[idx];
    const srcPath = path.join(sample.folder, sample.basename);
    try {
      const buf = await renderFaceCrop(srcPath, sample.bbox, sample.frame_time, 200);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(buf);
    } catch (err) {
      console.warn('[cluster-thumb]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST — promote: convertir el cluster en una persona del registry
  router.post('/persons/clusters/:cluster_id/promote', async (req, res) => {
    const cluster = faceClusterer.getCluster(req.params.cluster_id);
    if (!cluster) return res.status(404).json({ success: false, error: 'cluster no encontrado (cache expirado?)' });
    const { person_id, display_name, aliases, excluded_sample_indices, avatar_sample_index, attach_to_existing } = req.body || {};
    if (!person_id || typeof person_id !== 'string') {
      return res.status(400).json({ success: false, error: 'person_id requerido' });
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(person_id)) {
      return res.status(400).json({ success: false, error: 'person_id alfanumerico (a-z, 0-9, _, -)' });
    }

    // Set de indices de samples a excluir. El centroide se recalcula desde las
    // samples no excluidas leyendo embeddings.b64 del _pensadero.json original.
    const excluded = new Set(
      Array.isArray(excluded_sample_indices)
        ? excluded_sample_indices.filter(n => Number.isInteger(n) && n >= 0 && n < cluster.samples.length)
        : []
    );
    const includedSamples = cluster.samples.filter((_, i) => !excluded.has(i));
    if (cluster.samples.length > 0 && includedSamples.length === 0) {
      return res.status(400).json({ success: false, error: 'no puede excluir todas las muestras' });
    }

    const state = peopleRegistry.getState();
    if (!state.avatarsBase) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });

    // Si el person_id ya existe: por defecto 409 (no pisar embeddings del
    // usuario). Pero si attach_to_existing===true, ATTACH: el usuario afirma que
    // este cluster ES esa persona ya registrada → mezclamos centroides y
    // etiquetamos sus caras, sin crear duplicado.
    const isAttach = state.personIds.includes(person_id);
    if (isAttach && !attach_to_existing) {
      return res.status(409).json({ success: false, error: `person_id "${person_id}" ya existe`, code: 'EXISTS' });
    }
    const existingEntry = isAttach
      ? peopleRegistry.listAll().find(p => p.person_id === person_id)
      : null;

    const personDir = path.join(state.avatarsBase, 'people', person_id);
    await fsp.mkdir(personDir, { recursive: true });

    // 1) Calcular centroide. Si no hay exclusiones, usamos el centroide del
    //    cluster (entrenado con todas las caras). Si hay exclusiones, lo
    //    recalculamos promediando solo los embeddings de las samples incluidas
    //    (leemos cada _pensadero.json y extraemos embedding_b64 por face_index).
    let centroid = null;
    let centroidSource = 'cluster_promote';
    let storedCount = cluster.face_count;
    let storedAvgScore = cluster.avg_score;

    if (excluded.size === 0) {
      centroid = decodeEmbedding(cluster.centroid_b64);
      if (!centroid) return res.status(500).json({ success: false, error: 'centroid no decodificable' });
    } else {
      const sum = new Float32Array(512);
      let used = 0;
      let scoreSum = 0;
      for (const s of includedSamples) {
        try {
          const catalogPath = path.join(s.folder, '_pensadero.json');
          const raw = await fsp.readFile(catalogPath, 'utf-8');
          const cat = JSON.parse(raw);
          const photos = cat.photos || cat.clips || {};
          const entry = photos[s.basename];
          const det = entry?.identity?.detections?.[s.face_index];
          if (!det || !det.embedding_b64) continue;
          const emb = decodeEmbedding(det.embedding_b64);
          if (!emb || emb.length !== 512) continue;
          for (let i = 0; i < 512; i++) sum[i] += emb[i];
          used++;
          scoreSum += (det.det_score || 0);
        } catch (err) {
          console.warn('[cluster-promote] no se pudo leer embedding de sample:', err.message);
        }
      }
      if (used === 0) {
        return res.status(500).json({ success: false, error: 'no se pudieron leer embeddings de las muestras incluidas' });
      }
      for (let i = 0; i < 512; i++) sum[i] /= used;
      let norm = 0;
      for (let i = 0; i < 512; i++) norm += sum[i] * sum[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < 512; i++) sum[i] /= norm;
      centroid = sum;
      centroidSource = 'cluster_promote_filtered';
      storedCount = used;
      storedAvgScore = scoreSum / used;
    }

    // ATTACH: mezclar el centroide del cluster con el de la persona existente
    // (ponderado por count) en vez de sobrescribirlo.
    if (isAttach) {
      const existing = await readEmbeddingsJson(personDir);
      if (existing) {
        const n1 = existing.count || 1;
        const n2 = storedCount || 1;
        const blended = new Float32Array(512);
        for (let i = 0; i < 512; i++) blended[i] = (existing.centroid[i] * n1 + centroid[i] * n2) / (n1 + n2);
        let norm = 0; for (let i = 0; i < 512; i++) norm += blended[i] * blended[i]; norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < 512; i++) blended[i] /= norm;
        centroid = blended;
        storedCount = n1 + n2;
        centroidSource = 'cluster_promote_attach';
      }
    }

    const embJson = {
      person_id,
      version: 1,
      count: storedCount,
      photos_used: [],
      mean_similarity_to_centroid: storedAvgScore,
      min_similarity_to_centroid: null,
      centroid: Array.from(centroid),
      trained_at: new Date().toISOString(),
      source: centroidSource,
      cluster_face_count: cluster.face_count,
      cluster_excluded_indices: Array.from(excluded).sort((a, b) => a - b),
    };
    try {
      await atomicWriteFile(path.join(personDir, 'embeddings.json'), JSON.stringify(embJson), { backup: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: `no se pudo escribir embeddings.json: ${err.message}` });
    }

    // 2) Recortar el avatar visual. Por defecto el sample de mejor score no
    //    excluido; si el usuario eligio uno concreto (avatar_sample_index) y es
    //    valido y no esta excluido, se usa ese.
    let avatarRelPath = null;
    let bestSample = includedSamples[0] || cluster.samples[0]; // ya ordenados desc por score
    if (Number.isInteger(avatar_sample_index)
        && avatar_sample_index >= 0
        && avatar_sample_index < cluster.samples.length
        && !excluded.has(avatar_sample_index)) {
      bestSample = cluster.samples[avatar_sample_index];
    }
    // En attach se conserva el avatar existente, salvo que la persona no tenga.
    const shouldSetAvatar = !isAttach || !(existingEntry && existingEntry.avatar_path);
    if (bestSample && shouldSetAvatar) {
      try {
        const buf = await renderFaceCrop(
          path.join(bestSample.folder, bestSample.basename),
          bestSample.bbox, bestSample.frame_time, 400);
        avatarRelPath = await writeAvatarFile(person_id, buf);
      } catch (err) {
        console.warn('[cluster-promote] no se pudo generar avatar:', err.message);
      }
    }

    // 3) Registry: persona nueva → crear con nombre/aliases/avatar. Attach →
    //    conservar nombre/aliases; solo fijar avatar si se genero uno nuevo.
    try {
      if (!isAttach) {
        peopleRegistry.upsertPerson({
          person_id,
          display_name: (display_name || '').trim() || person_id,
          aliases: Array.isArray(aliases) ? aliases : [],
          avatar_path: avatarRelPath || undefined,
        });
      } else if (avatarRelPath) {
        peopleRegistry.upsertPerson({ person_id, avatar_path: avatarRelPath });
      } else {
        peopleRegistry.bumpDataVersion(); // attach sin cambio de avatar
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: `upsert fallo: ${err.message}` });
    }

    // 4) Refrescar el cache de embeddings del faceService para que la nueva
    //    persona entre inmediatamente en futuros scans / reidentifies.
    try {
      const faceSvc = getFaceService();
      await faceSvc.loadAllEmbeddings(state.avatarsBase);
    } catch (err) {
      console.warn('[cluster-promote] loadAllEmbeddings:', err.message);
    }

    // 5) Escribir person_id directamente en las detecciones del _pensadero.json
    //    de cada cara del cluster. Mucho mas rapido que re-id global y suficiente:
    //    solo las caras del cluster son seguras, las demas se identificaran al
    //    proximo re-id manual o scan.
    //    En attach forzamos la asignacion (force): el usuario afirma que el
    //    cluster es esa persona, aunque el centroide promediado no quede cerca.
    let promoteUpdate = { catalogsWritten: 0, facesUpdated: 0, escriturasFallidas: 0, lecturasFallidas: 0, causa: null };
    try {
      promoteUpdate = await applyPromoteToCatalogs(cluster.faces || [], person_id, { force: isAttach });
    } catch (err) {
      promoteUpdate.causa = fallos.record('etiquetar las caras del cluster', err);
      promoteUpdate.escriturasFallidas++;
    }

    // 6) Quitar SOLO el cluster promovido del cache. Antes invalidabamos todo
    //    el cache, lo que rompia operaciones siguientes (promote/merge) en la
    //    misma sesion: el frontend conservaba la lista pero el backend ya no
    //    tenia los clusters → 404 "cluster no encontrado". Los demas clusters
    //    siguen siendo desconocidos hasta que el usuario re-clusterice.
    faceClusterer.removeClusterFromCache(cluster.cluster_id);

    // 7) Refrescar en memoria SOLO las carpetas afectadas. Antes se lanzaba un
    //    syncFiles() de biblioteca COMPLETA (~miles de archivos en discos
    //    externos): lento y, con la barra de progreso compartida, se quedaba
    //    "sincronizando sin avanzar". Los catalogos ya estan escritos en disco;
    //    refreshDir re-aplica solo esas carpetas (emite catalog_refresh, no
    //    sync_*), asi que es instantaneo y no dispara la barra global.
    if (promoteUpdate.catalogsWritten > 0 && typeof refreshDir === 'function') {
      for (const folder of (promoteUpdate.folders || [])) {
        try { await refreshDir(folder); } catch (err) { console.warn('[cluster-promote] refreshDir:', err.message); }
      }
      if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();
    } else if (promoteUpdate.catalogsWritten > 0 && typeof syncFiles === 'function') {
      syncFiles().catch(err => console.warn('[cluster-promote] post-sync:', err.message)); // fallback legacy
    } else if (typeof recomputePersonsAggregate === 'function') {
      recomputePersonsAggregate();
    }

    // 8) Propagar la persona al RESTO de la biblioteca: re-id en background
    //    (debounced + single-flight) para encontrar otras apariciones que no
    //    estaban en este cluster. El promote solo etiqueta las caras del cluster;
    //    sin esto, una persona que sale en mas videos solo apareceria en los del
    //    cluster. No bloquea la respuesta.
    setImmediate(async () => {
      try {
        const rootDirs = await getActiveRoots();
        if (rootDirs.length > 0) {
          faceReidentifier.requestBackgroundReidentify({
            rootDirs,
            broadcastProgress: broadcastProgress || (() => {}),
            refreshDir,
          });
        }
      } catch (err) {
        console.error('[cluster-promote] re-id propagacion:', err.message);
      }
    });

    // La persona existe en el registry pase lo que pase (eso ya esta escrito en
    // disco local), pero si NO se ha podido etiquetar ni una cara hay que
    // decirlo: el 09/09/2026 un promote de un cluster de 80 caras respondio
    // success con catalogs_written: 0 porque el disco de la biblioteca estaba
    // lleno, y la persona quedo creada y con cero apariciones sin un solo aviso.
    const huboFallos = promoteUpdate.escriturasFallidas > 0 || promoteUpdate.lecturasFallidas > 0;
    const nadaEtiquetado = promoteUpdate.facesUpdated === 0 && (cluster.faces || []).length > 0;
    const causa = promoteUpdate.causa;

    let aviso = null;
    if (nadaEtiquetado) {
      // La persona SI queda creada (su registry vive en disco local), asi que la
      // salida es arreglar la causa y lanzar "Re-identificar biblioteca": el
      // re-id vuelve a etiquetar desde los embeddings ya guardados, sin
      // re-detectar nada. Decirlo aqui ahorra el "y ahora que hago".
      aviso = `"${person_id}" se ha creado, pero NO se ha podido etiquetar ninguna de sus `
        + `${cluster.face_count} caras en los archivos.`
        + (causa ? ` ${causa.reason}` : '')
        + (causa && causa.hint ? ` ${causa.hint}` : '')
        + ' Cuando esto se arregle, lanza "Re-identificar biblioteca" para asignarle sus caras.';
      console.error(`[cluster-promote] ${aviso}`);
    } else if (huboFallos) {
      aviso = `Persona creada y ${promoteUpdate.facesUpdated} cara(s) etiquetadas, pero ${promoteUpdate.escriturasFallidas + promoteUpdate.lecturasFallidas} carpeta(s) fallaron`
        + (causa ? `: ${causa.reason}` : '');
      console.warn(`[cluster-promote] ${aviso}`);
    }

    res.json({
      // Si no se ha guardado NADA de lo que el usuario pidio, esto no es un exito.
      success: !nadaEtiquetado,
      error: nadaEtiquetado ? aviso : undefined,
      aviso: aviso && !nadaEtiquetado ? aviso : undefined,
      causa: causa || undefined,
      data: {
        person_id,
        display_name: isAttach ? (existingEntry?.display_name || person_id) : (display_name || person_id),
        face_count: cluster.face_count,
        avatar_path: avatarRelPath,
        attached: isAttach,
        catalogs_written: promoteUpdate.catalogsWritten,
        faces_updated: promoteUpdate.facesUpdated,
        escrituras_fallidas: promoteUpdate.escriturasFallidas,
        lecturas_fallidas: promoteUpdate.lecturasFallidas,
      },
    });
  });

  // DELETE — borrar una foto concreta
  router.delete('/persons/registry/:id/photos/:filename', async (req, res) => {
    if (!assertValidPersonId(req.params.id)) {
      return res.status(400).json({ success: false, error: 'person_id inválido' });
    }
    const dir = getPersonDir(req.params.id);
    if (!dir) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });
    // Validar que el filename no escape de su carpeta
    const safe = path.basename(req.params.filename);
    if (safe !== req.params.filename) return res.status(400).json({ success: false, error: 'filename inválido' });
    const filePath = path.join(dir, safe);
    try {
      await fsp.unlink(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ success: false, error: 'no existe' });
      return res.status(500).json({ success: false, error: err.message });
    }

    // Si esta era el avatar, limpiar avatar_path (el frontend escogerá otra)
    const all = peopleRegistry.listAll();
    const me = all.find(p => p.person_id === req.params.id);
    if (me && me.avatar_path && me.avatar_path.endsWith(safe)) {
      try {
        peopleRegistry.upsertPerson({ person_id: req.params.id, avatar_path: '' });
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
    }
    if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();

    // Re-train con las fotos restantes (en background, no bloqueante)
    const faceSvc = getFaceService();
    faceSvc.init().then(ok => {
      if (!ok) return;
      return faceSvc.trainPerson(dir).then(() => peopleRegistry.bumpDataVersion()).catch(() => {});
    });

    res.json({ success: true, deleted: true });
  });

  // POST — marcar foto como avatar principal. Recorta la cara de esa foto a un
  // avatar.jpg derivado (encuadre limpio) en vez de usar la imagen cruda con
  // CSS object-cover (que mostraba un trozo central, a menudo sin la cara).
  // Si el daemon esta caido o la foto no tiene cara, cae a la imagen cruda.
  router.post('/persons/registry/:id/avatar', async (req, res) => {
    const personId = req.params.id;
    if (!assertValidPersonId(personId)) {
      return res.status(400).json({ success: false, error: 'person_id inválido' });
    }
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ success: false, error: 'filename requerido' });
    const safe = path.basename(filename);
    if (safe !== filename) return res.status(400).json({ success: false, error: 'filename inválido' });

    const dir = getPersonDir(personId);
    if (!dir) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });
    if (!fs.existsSync(path.join(dir, safe))) {
      return res.status(404).json({ success: false, error: 'la foto no existe' });
    }

    let avatarRel = null;
    let faceCropped = false;
    try {
      avatarRel = await generateAvatarFromPhoto(personId, safe);
      faceCropped = !!avatarRel;
    } catch (err) {
      console.warn('[avatar] generateAvatarFromPhoto:', err.message);
    }
    // Fallback: imagen cruda (compat con el comportamiento anterior).
    if (!avatarRel) avatarRel = path.posix.join('people', personId, safe);

    try {
      peopleRegistry.upsertPerson({ person_id: personId, avatar_path: avatarRel });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();
    res.json({ success: true, data: { avatar_path: avatarRel, face_cropped: faceCropped } });
  });

  // POST — fijar avatar desde una DETECCION de la biblioteca (folder/basename/
  // face_index). Permite elegir como avatar cualquier aparicion visible, sin
  // tener que subir una foto de referencia.
  router.post('/persons/registry/:id/avatar-from-detection', async (req, res) => {
    const personId = req.params.id;
    if (!assertValidPersonId(personId)) {
      return res.status(400).json({ success: false, error: 'person_id inválido' });
    }
    const state = peopleRegistry.getState();
    if (!state.personIds.includes(personId)) {
      return res.status(404).json({ success: false, error: 'persona no encontrada' });
    }
    const { folder, basename, face_index } = req.body || {};
    if (!folder || !basename || typeof face_index !== 'number') {
      return res.status(400).json({ success: false, error: 'folder, basename y face_index requeridos' });
    }
    if (!(await caraDeBiblioteca(req.body))) {
      return res.status(403).json({ success: false, error: FUERA_DE_BIBLIOTECA });
    }
    let catalog;
    try {
      catalog = JSON.parse(await fsp.readFile(path.join(folder, '_pensadero.json'), 'utf-8'));
    } catch (err) {
      return res.status(404).json({ success: false, error: `catalogo no encontrado: ${err.message}` });
    }
    const photos = catalog.photos || catalog.clips || {};
    const det = photos[basename]?.identity?.detections?.[face_index];
    if (!det || !Array.isArray(det.bbox)) {
      return res.status(404).json({ success: false, error: 'deteccion no encontrada' });
    }
    try {
      const buf = await renderFaceCrop(path.join(folder, basename), det.bbox, det.frame_time, 400);
      const avatarRel = await writeAvatarFile(personId, buf);
      peopleRegistry.upsertPerson({ person_id: personId, avatar_path: avatarRel });
      if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();
      res.json({ success: true, data: { avatar_path: avatarRel } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
