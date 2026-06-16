/**
 * Notes Routes — Pensadero
 *
 * Notas humanas libres por archivo y por sesion colapsada. Persisten en
 * `notes_persistent.json` (ver notesManager.js). No tocan el disco de las
 * bibliotecas ni renombran nada, asi que no hay rutas de filesystem que
 * validar: las keys son ids/strings opacos del propio frontend.
 *
 *  - GET  /api/notes            -> { files: {id: nota}, sessions: {key: nota} }
 *  - POST /api/notes            -> body { scope, key, note }; note vacio borra
 */

const express = require('express');
const router = express.Router();
const notesManager = require('../notesManager');

module.exports = function createNotesRoutes() {
  // === LISTAR TODAS LAS NOTAS ===
  router.get('/notes', async (req, res) => {
    try {
      const data = await notesManager.getAll();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // === GUARDAR / BORRAR UNA NOTA ===
  // body: { scope: 'file'|'session', key: string, note: string }
  // note vacio o ausente => borra la nota de esa key.
  router.post('/notes', async (req, res) => {
    const { scope, key, note } = req.body || {};
    if (scope !== 'file' && scope !== 'session') {
      return res.status(400).json({ success: false, error: "scope debe ser 'file' o 'session'" });
    }
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success: false, error: 'key requerida' });
    }
    try {
      const result = await notesManager.setNote(scope, key, note);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
