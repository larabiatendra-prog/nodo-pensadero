/**
 * Duplicates Routes — Pensadero
 *
 * Tomas gemelas: detectar grupos de material casi identico y apartar los que
 * sobran. Ver `services/duplicateFinder.js` para el criterio y
 * `descartesManager.js` para que significa "apartar" (spoiler: nada se borra).
 *
 * Endpoints:
 *   GET  /api/duplicates?umbral=0.96  → { grupos, stats }
 *   GET  /api/descartes               → array de fileIds apartados
 *   POST /api/descartes               → body {fileIds: [...], descartar: bool}
 */

const express = require('express');
const router = express.Router();

const duplicateFinder = require('../services/duplicateFinder');
const descartesManager = require('../descartesManager');

module.exports = function createDuplicatesRoutes(deps) {
  const { getMediaFiles } = deps || {};

  router.get('/duplicates', (req, res) => {
    try {
      const files = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
      const umbral = req.query.umbral !== undefined ? parseFloat(req.query.umbral) : undefined;
      const resultado = duplicateFinder.buscarGemelas(files, { umbral });
      if (resultado.error) {
        return res.status(503).json({ success: false, error: resultado.error, data: resultado });
      }
      res.json({ success: true, data: resultado });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/descartes', async (req, res) => {
    try {
      await descartesManager.ensureLoaded();
      res.json({ success: true, data: descartesManager.list() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/descartes', async (req, res) => {
    try {
      const { fileIds, descartar } = req.body || {};
      if (!Array.isArray(fileIds)) {
        return res.status(400).json({ success: false, error: 'fileIds debe ser un array' });
      }
      const lista = await descartesManager.set(fileIds, descartar !== false);
      res.json({ success: true, data: lista });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
