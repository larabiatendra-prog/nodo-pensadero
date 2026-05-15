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

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

// Multer en memoria; escribimos a disco a mano para tener control del nombre.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

module.exports = function createPersonsManageRoutes(deps) {
  const { recomputePersonsAggregate } = deps || {};
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
