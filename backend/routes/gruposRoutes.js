/**
 * Grupos de personas — rutas
 *
 *   GET    /api/grupos          la lista (solo con personas que siguen existiendo)
 *   POST   /api/grupos          { nombre, miembros[] }
 *   PATCH  /api/grupos/:id      { nombre?, miembros?, minimo?, modo? }
 *   DELETE /api/grupos/:id      borra el grupo, no a las personas
 *
 * Ver backend/services/grupos.js para que es un grupo y como se busca.
 */

const express = require('express');
const grupos = require('../services/grupos');
const peopleRegistry = require('../peopleRegistry');
const fallos = require('../utils/failureReason');

module.exports = function createGruposRoutes() {
  const router = express.Router();

  /** Quita de la respuesta a quien ya no esta en el registro (borrado a mano, etc.). */
  function vigentes(lista) {
    const ids = new Set(peopleRegistry.getState().personIds || []);
    // Sin registro cargado no se sabe quien existe: mejor no esconder a nadie.
    if (ids.size === 0) return lista;
    return lista.map(g => ({ ...g, miembros: g.miembros.filter(m => ids.has(m)) }));
  }

  function responderError(res, err, que) {
    if (err instanceof grupos.ErrorGrupo) {
      return res.status(err.estado).json({ success: false, error: err.message });
    }
    const causa = fallos.record(que, err, {});
    return res.status(500).json({ success: false, error: causa.reason });
  }

  router.get('/grupos', (req, res) => {
    res.json({ success: true, data: vigentes(grupos.listar()) });
  });

  router.post('/grupos', async (req, res) => {
    try {
      const { nombre, miembros, minimo, modo } = req.body || {};
      const grupo = await grupos.crear({ nombre, miembros, minimo, modo });
      res.json({ success: true, data: grupo });
    } catch (err) {
      responderError(res, err, 'crear un grupo de personas');
    }
  });

  router.patch('/grupos/:id', async (req, res) => {
    try {
      const { nombre, miembros, minimo, modo } = req.body || {};
      const grupo = await grupos.actualizar(req.params.id, { nombre, miembros, minimo, modo });
      res.json({ success: true, data: grupo });
    } catch (err) {
      responderError(res, err, 'cambiar un grupo de personas');
    }
  });

  router.delete('/grupos/:id', async (req, res) => {
    try {
      await grupos.borrar(req.params.id);
      res.json({ success: true });
    } catch (err) {
      responderError(res, err, 'borrar un grupo de personas');
    }
  });

  return router;
};
