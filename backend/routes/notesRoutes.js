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
    // legacyKey: la clave anterior del mismo archivo (id md5). El frontend la
    // manda mientras conviven las dos identidades, para que al guardar se
    // retire el duplicado y la nota quede solo bajo la mediaKey.
    const { scope, key, note, legacyKey } = req.body || {};
    if (scope !== 'file' && scope !== 'session') {
      return res.status(400).json({ success: false, error: "scope debe ser 'file' o 'session'" });
    }
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success: false, error: 'key requerida' });
    }
    try {
      const result = await notesManager.setNote(scope, key, note, legacyKey);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
