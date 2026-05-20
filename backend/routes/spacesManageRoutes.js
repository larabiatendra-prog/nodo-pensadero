/**
 * Spaces Management Routes — Pensadero NODO
 *
 * CRUD del registry de espacios + gestion de fotos de referencia + training
 * del centroide CLIP.
 *
 * Endpoints:
 *  - GET    /api/spaces/registry           — lista
 *  - POST   /api/spaces/registry           — upsert
 *  - DELETE /api/spaces/registry/:id       — borrar
 *  - GET    /api/spaces/registry/:id/photos
 *  - POST   /api/spaces/registry/:id/photos (multipart photo)
 *  - DELETE /api/spaces/registry/:id/photos/:filename
 *  - POST   /api/spaces/registry/:id/cover (body filename) — marca cover
 *  - POST   /api/spaces/registry/:id/train — calcula centroide CLIP
 *  - GET    /api/spaces/clip-service/status
 *
 * Fotos viven en <avatarsBase>/spaces/<space_id>/<n>.<ext>
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const multer = require('multer');
const spacesRegistry = require('../spacesRegistry');
const { getInstance: getClipService } = require('../services/clipService');

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

module.exports = function createSpacesManageRoutes(deps) {
  const router = express.Router();

  function getSpaceDir(spaceId) {
    const state = spacesRegistry.getState();
    if (!state.avatarsBase) return null;
    return path.join(state.avatarsBase, 'spaces', spaceId);
  }

  router.get('/spaces/registry', (req, res) => {
    res.json({ success: true, data: spacesRegistry.listAll() });
  });

  router.post('/spaces/registry', (req, res) => {
    try {
      const entry = spacesRegistry.upsertSpace(req.body || {});
      res.json({ success: true, data: entry });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.delete('/spaces/registry/:id', async (req, res) => {
    const id = req.params.id;
    const dir = getSpaceDir(id);
    const existed = spacesRegistry.deleteSpace(id);
    if (!existed) return res.status(404).json({ success: false, error: 'no existe' });
    if (dir) {
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch (err) {
        console.warn(`[spaces] no se pudo borrar ${dir}: ${err.message}`);
      }
    }
    res.json({ success: true, deleted: true });
  });

  router.get('/spaces/registry/:id/photos', async (req, res) => {
    const dir = getSpaceDir(req.params.id);
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
    const data = files.map(name => ({
      filename: name,
      url: `/spaces-covers/spaces/${encodeURIComponent(req.params.id)}/${encodeURIComponent(name)}`,
    }));
    res.json({ success: true, data });
  });

  router.post('/spaces/registry/:id/photos', upload.single('photo'), async (req, res) => {
    try {
      const id = req.params.id;
      if (!req.file) return res.status(400).json({ success: false, error: 'falta archivo (field "photo")' });

      const originalName = req.file.originalname || 'photo.jpg';
      const ext = path.extname(originalName).toLowerCase() || '.jpg';
      if (!ALLOWED_EXTS.has(ext)) {
        return res.status(400).json({ success: false, error: `extension no soportada: ${ext}` });
      }

      // Crear entry si no existe
      const state = spacesRegistry.getState();
      if (!state.spaceIds.includes(id)) {
        spacesRegistry.upsertSpace({ space_id: id, display_name: id });
      }

      const dir = getSpaceDir(id);
      if (!dir) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });
      await fsp.mkdir(dir, { recursive: true });

      const filename = `photo_${Date.now()}${ext}`;
      const filePath = path.join(dir, filename);
      await fsp.writeFile(filePath, req.file.buffer);

      // Si no hay cover, esta foto pasa a serlo
      const all = spacesRegistry.listAll();
      const me = all.find(s => s.space_id === id);
      if (me && !me.cover_image_path) {
        spacesRegistry.upsertSpace({
          space_id: id,
          cover_image_path: path.posix.join('spaces', id, filename),
        });
      }

      // Auto-train: si CLIP esta disponible, recalcular centroide en background
      const clipSvc = getClipService();
      clipSvc.init().then(ok => {
        if (!ok) return;
        return _trainSpaceFromDir(id, dir, clipSvc).catch(err => {
          console.warn(`[spaces] auto-train ${id}: ${err.message}`);
        });
      });

      res.json({
        success: true,
        data: {
          filename,
          url: `/spaces-covers/spaces/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`,
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/spaces/registry/:id/photos/:filename', async (req, res) => {
    const dir = getSpaceDir(req.params.id);
    if (!dir) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });
    const safe = path.basename(req.params.filename);
    if (safe !== req.params.filename) return res.status(400).json({ success: false, error: 'filename invalido' });
    const filePath = path.join(dir, safe);
    try {
      await fsp.unlink(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ success: false, error: 'no existe' });
      return res.status(500).json({ success: false, error: err.message });
    }
    // Si era el cover, limpiarlo del registry
    const all = spacesRegistry.listAll();
    const me = all.find(s => s.space_id === req.params.id);
    if (me && me.cover_image_path && me.cover_image_path.endsWith(safe)) {
      spacesRegistry.upsertSpace({ space_id: req.params.id, cover_image_path: '' });
    }
    // Re-train background
    const clipSvc = getClipService();
    clipSvc.init().then(ok => {
      if (!ok) return;
      return _trainSpaceFromDir(req.params.id, dir, clipSvc).catch(() => {});
    });
    res.json({ success: true, deleted: true });
  });

  router.post('/spaces/registry/:id/cover', (req, res) => {
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ success: false, error: 'filename requerido' });
    const safe = path.basename(filename);
    if (safe !== filename) return res.status(400).json({ success: false, error: 'filename invalido' });
    const dir = getSpaceDir(req.params.id);
    if (!dir) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });
    if (!fs.existsSync(path.join(dir, safe))) {
      return res.status(404).json({ success: false, error: 'la foto no existe' });
    }
    spacesRegistry.upsertSpace({
      space_id: req.params.id,
      cover_image_path: path.posix.join('spaces', req.params.id, safe),
    });
    res.json({ success: true });
  });

  router.post('/spaces/registry/:id/train', async (req, res) => {
    const id = req.params.id;
    const dir = getSpaceDir(id);
    if (!dir) return res.status(500).json({ success: false, error: 'avatarsBase no configurado' });
    if (!fs.existsSync(dir)) return res.status(404).json({ success: false, error: 'sin fotos para este espacio' });
    const clipSvc = getClipService();
    const ok = await clipSvc.init();
    if (!ok) {
      return res.status(503).json({ success: false, error: clipSvc.getStatus().lastError || 'clip service no disponible' });
    }
    try {
      const result = await _trainSpaceFromDir(id, dir, clipSvc);
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/spaces/clip-service/status', (req, res) => {
    const clipSvc = getClipService();
    const st = clipSvc.getStatus();
    if (!st.ready && !st.unavailable) {
      // Disparar init en background — pol de status devolvera ready=true cuando este listo
      clipSvc.init().catch(() => {});
    }
    res.json({ success: true, data: { ...st, trainedSpaces: spacesRegistry.getState().trainedCount } });
  });

  return router;
};

/**
 * Calcula el centroide de un space a partir de todas las fotos en su carpeta.
 * Internamente llama clipSvc.embedImage para cada una, promedia los embeddings
 * y L2-normaliza. Persiste el centroide en el registry.
 */
async function _trainSpaceFromDir(spaceId, dir, clipSvc) {
  const EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
  let files = [];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    files = entries
      .filter(e => e.isFile() && EXTS.has(path.extname(e.name).toLowerCase()))
      .map(e => path.join(dir, e.name));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    spacesRegistry.clearCentroid(spaceId);
    return { space_id: spaceId, count: 0, ok: false, error: 'sin fotos' };
  }

  const embeddings = [];
  const used = [];
  const skipped = [];
  for (const f of files) {
    try {
      const emb = await clipSvc.embedImage(f);
      if (emb && emb.length === 512) {
        embeddings.push(emb);
        used.push(path.basename(f));
      } else {
        skipped.push({ file: path.basename(f), reason: 'embedding nulo' });
      }
    } catch (err) {
      skipped.push({ file: path.basename(f), reason: err.message });
    }
  }

  if (embeddings.length === 0) {
    spacesRegistry.clearCentroid(spaceId);
    return { space_id: spaceId, count: 0, ok: false, error: 'no se pudo procesar ninguna foto', skipped };
  }

  // Promediar y L2-normalizar
  const centroid = new Float32Array(512);
  for (const e of embeddings) {
    for (let i = 0; i < 512; i++) centroid[i] += e[i];
  }
  for (let i = 0; i < 512; i++) centroid[i] /= embeddings.length;
  let norm = 0;
  for (let i = 0; i < 512; i++) norm += centroid[i] * centroid[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < 512; i++) centroid[i] /= norm;
  }

  spacesRegistry.setCentroid(spaceId, centroid, embeddings.length);
  return {
    space_id: spaceId,
    ok: true,
    count: embeddings.length,
    photos_used: used,
    skipped,
  };
}
