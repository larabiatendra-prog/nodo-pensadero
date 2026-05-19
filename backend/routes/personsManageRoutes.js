/**
 * Persons Management Routes — Pensadero
 *
 * CRUD del registry de personas + gestión de fotos de referencia.
 *
 * Rutas:
 *  - GET    /api/persons/registry            — lista completa de personas registradas
 *  - POST   /api/persons/registry            — crea/actualiza una persona
 *  - DELETE /api/persons/registry/:id        — elimina una persona y sus fotos
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
const { getInstance: getFaceService, decodeEmbedding } = require('../services/faceService');
const faceReidentifier = require('../services/faceReidentifier');
const faceClusterer = require('../services/faceClusterer');
const sharp = require('sharp');
const { spawn } = require('child_process');
const os = require('os');

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

// Multer en memoria; escribimos a disco a mano para tener control del nombre.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

module.exports = function createPersonsManageRoutes(deps) {
  const { recomputePersonsAggregate, broadcastProgress, getScanPaths } = deps || {};
  const router = express.Router();

  function getPersonDir(personId) {
    const state = peopleRegistry.getState();
    if (!state.avatarsBase) return null;
    return path.join(state.avatarsBase, 'people', personId);
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
    const personId = req.params.id;
    const dir = getPersonDir(personId);
    const existed = peopleRegistry.deletePerson(personId);
    if (!existed) return res.status(404).json({ success: false, error: 'no existe' });

    // Borrar fotos (best-effort, no bloqueante)
    if (dir) {
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch (err) {
        console.warn(`[persons] no se pudo borrar ${dir}: ${err.message}`);
      }
    }
    if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();
    res.json({ success: true, deleted: true });
  });

  // GET — fotos de referencia
  router.get('/persons/registry/:id/photos', async (req, res) => {
    const dir = getPersonDir(req.params.id);
    if (!dir) return res.json({ success: true, data: [] });
    let files = [];
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      files = entries
        .filter(e => e.isFile() && ALLOWED_EXTS.has(path.extname(e.name).toLowerCase()))
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
        peopleRegistry.upsertPerson({
          person_id: personId,
          avatar_path: path.posix.join('people', personId, filename),
        });
      }

      if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();

      // Auto-train: si InsightFace está disponible, re-entrenar los
      // embeddings de la persona en background. No bloquea la respuesta.
      const faceSvc = getFaceService();
      faceSvc.init().then(ok => {
        if (!ok) return;
        return faceSvc.trainPerson(dir).then(result => {
          console.log(`[persons] auto-train ${personId}: count=${result?.count} mean_sim=${result?.mean_similarity_to_centroid?.toFixed(3)}`);
        }).catch(err => {
          console.warn(`[persons] auto-train ${personId} falló:`, err.message);
        });
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
    const dir = getPersonDir(personId);
    if (!dir) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });
    if (!fs.existsSync(dir)) return res.status(404).json({ success: false, error: 'sin fotos para esta persona' });
    const faceSvc = getFaceService();
    const ok = await faceSvc.init();
    if (!ok) return res.status(503).json({ success: false, error: faceSvc.getStatus().lastError || 'face service no disponible' });
    try {
      const result = await faceSvc.trainPerson(dir);
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET — estado del servicio de reconocimiento facial
  router.get('/persons/face-service/status', (req, res) => {
    const faceSvc = getFaceService();
    res.json({ success: true, data: faceSvc.getStatus() });
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
    return {
      cluster_id: c.cluster_id,
      face_count: c.face_count,
      avg_score: c.avg_score,
      dominant_age: c.dominant_age,
      dominant_gender: c.dominant_gender,
      sample_count: c.samples.length,
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

  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg']);

  // Extrae un frame representativo (~30% de duracion) de un video a un temp jpg.
  // Replica la logica de scanOrchestrator.extractRepresentativeFrame para que el
  // bbox guardado por el scan coincida con el frame recortado aqui.
  async function extractVideoFrame(videoPath) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pensadero-clusterframe-'));
    const outPath = path.join(tmpDir, 'rep.jpg');
    // Probar primero con duration via ffprobe simple, sino fallback a 5s
    const seekSec = await new Promise(resolve => {
      const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath]);
      let buf = '';
      ff.stdout.on('data', d => { buf += d.toString(); });
      ff.on('close', () => {
        const dur = parseFloat(buf.trim());
        resolve(isFinite(dur) && dur > 1 ? dur * 0.3 : 5);
      });
      ff.on('error', () => resolve(5));
    });
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
    const img = sharp(srcPath);
    const meta = await img.metadata();
    if (!meta.width || !meta.height) throw new Error('imagen sin dimensiones');
    const [x1, y1, x2, y2] = bbox;
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);
    const padX = w * 0.3;
    const padY = h * 0.3;
    let left = Math.max(0, Math.floor(x1 - padX));
    let top = Math.max(0, Math.floor(y1 - padY));
    let width = Math.min(meta.width - left, Math.ceil(w + padX * 2));
    let height = Math.min(meta.height - top, Math.ceil(h + padY * 2));
    if (width < 4 || height < 4) throw new Error('crop demasiado pequeño');
    return img.extract({ left, top, width, height }).resize(size, size, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
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
    const ext = path.extname(sample.basename).toLowerCase();
    let cropSrc = srcPath;
    let tmpToCleanup = null;
    try {
      if (VIDEO_EXTS.has(ext)) {
        const framePath = await extractVideoFrame(srcPath);
        if (!framePath) return res.status(500).json({ success: false, error: 'no se pudo extraer frame del video' });
        cropSrc = framePath;
        tmpToCleanup = framePath;
      }
      const buf = await cropFaceFromImage(cropSrc, sample.bbox, 200);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(buf);
    } catch (err) {
      console.warn('[cluster-thumb]', err.message);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      if (tmpToCleanup) {
        try { await fsp.unlink(tmpToCleanup); } catch {}
        try { await fsp.rmdir(path.dirname(tmpToCleanup)); } catch {}
      }
    }
  });

  // POST — promote: convertir el cluster en una persona del registry
  router.post('/persons/clusters/:cluster_id/promote', async (req, res) => {
    const cluster = faceClusterer.getCluster(req.params.cluster_id);
    if (!cluster) return res.status(404).json({ success: false, error: 'cluster no encontrado (cache expirado?)' });
    const { person_id, display_name, aliases } = req.body || {};
    if (!person_id || typeof person_id !== 'string') {
      return res.status(400).json({ success: false, error: 'person_id requerido' });
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(person_id)) {
      return res.status(400).json({ success: false, error: 'person_id alfanumerico (a-z, 0-9, _, -)' });
    }

    const state = peopleRegistry.getState();
    if (!state.avatarsBase) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });

    // Validar que el person_id no choque con uno existente. Si choca, salir
    // por seguridad — no queremos sobreescribir embeddings.json del usuario.
    if (state.personIds.includes(person_id)) {
      return res.status(409).json({ success: false, error: `person_id "${person_id}" ya existe` });
    }

    const personDir = path.join(state.avatarsBase, 'people', person_id);
    await fsp.mkdir(personDir, { recursive: true });

    // 1) Crear embeddings.json directamente desde el centroid del cluster.
    //    Formato compatible con faceService.loadAllEmbeddings.
    const centroid = decodeEmbedding(cluster.centroid_b64);
    if (!centroid) return res.status(500).json({ success: false, error: 'centroid no decodificable' });
    const embJson = {
      person_id,
      version: 1,
      count: cluster.face_count,
      photos_used: [],
      mean_similarity_to_centroid: cluster.avg_score,
      min_similarity_to_centroid: null,
      centroid: Array.from(centroid),
      trained_at: new Date().toISOString(),
      source: 'cluster_promote',
      cluster_face_count: cluster.face_count,
    };
    try {
      await fsp.writeFile(path.join(personDir, 'embeddings.json'), JSON.stringify(embJson), 'utf-8');
    } catch (err) {
      return res.status(500).json({ success: false, error: `no se pudo escribir embeddings.json: ${err.message}` });
    }

    // 2) Recortar el sample con mejor score como avatar visual
    let avatarRelPath = null;
    const bestSample = cluster.samples[0]; // ya ordenados desc por score
    if (bestSample) {
      const srcPath = path.join(bestSample.folder, bestSample.basename);
      const ext = path.extname(bestSample.basename).toLowerCase();
      let cropSrc = srcPath;
      let tmpToCleanup = null;
      try {
        if (VIDEO_EXTS.has(ext)) {
          const framePath = await extractVideoFrame(srcPath);
          if (framePath) { cropSrc = framePath; tmpToCleanup = framePath; }
        }
        const buf = await cropFaceFromImage(cropSrc, bestSample.bbox, 400);
        const avatarPath = path.join(personDir, 'avatar.jpg');
        await fsp.writeFile(avatarPath, buf);
        avatarRelPath = path.posix.join('people', person_id, 'avatar.jpg');
      } catch (err) {
        console.warn('[cluster-promote] no se pudo generar avatar:', err.message);
      } finally {
        if (tmpToCleanup) {
          try { await fsp.unlink(tmpToCleanup); } catch {}
          try { await fsp.rmdir(path.dirname(tmpToCleanup)); } catch {}
        }
      }
    }

    // 3) Crear entrada en el registry
    try {
      peopleRegistry.upsertPerson({
        person_id,
        display_name: (display_name || '').trim() || person_id,
        aliases: Array.isArray(aliases) ? aliases : [],
        avatar_path: avatarRelPath || undefined,
      });
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

    // 5) Invalidar cache de clusters (el cluster promovido ya no es desconocido)
    faceClusterer.invalidateCache();

    if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();

    res.json({
      success: true,
      data: {
        person_id,
        display_name: display_name || person_id,
        face_count: cluster.face_count,
        avatar_path: avatarRelPath,
      },
    });
  });

  // DELETE — borrar una foto concreta
  router.delete('/persons/registry/:id/photos/:filename', async (req, res) => {
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
      peopleRegistry.upsertPerson({ person_id: req.params.id, avatar_path: '' });
    }
    if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();

    // Re-train con las fotos restantes (en background, no bloqueante)
    const faceSvc = getFaceService();
    faceSvc.init().then(ok => {
      if (!ok) return;
      return faceSvc.trainPerson(dir).catch(() => {});
    });

    res.json({ success: true, deleted: true });
  });

  // POST — marcar foto como avatar principal
  router.post('/persons/registry/:id/avatar', (req, res) => {
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ success: false, error: 'filename requerido' });
    const safe = path.basename(filename);
    if (safe !== filename) return res.status(400).json({ success: false, error: 'filename inválido' });

    const dir = getPersonDir(req.params.id);
    if (!dir) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });
    if (!fs.existsSync(path.join(dir, safe))) {
      return res.status(404).json({ success: false, error: 'la foto no existe' });
    }
    peopleRegistry.upsertPerson({
      person_id: req.params.id,
      avatar_path: path.posix.join('people', req.params.id, safe),
    });
    if (typeof recomputePersonsAggregate === 'function') recomputePersonsAggregate();
    res.json({ success: true });
  });

  return router;
};
