/**
 * Copias exactas — rutas
 *
 * El mismo archivo en dos sitios (un disco y su backup conectados a la vez).
 * Criterio y filosofia en `services/copiasExactas.js`. Nada de esto borra ni
 * mueve archivos: solo decide que copia se enseña.
 *
 * Endpoints:
 *   GET    /api/copias/resumen   → cuantas hay pendientes (el aviso de la home)
 *   GET    /api/copias           → { resumen, total, grupos, pares } para revisarlas
 *                                   ?solo=pendientes|todas&desde=0&limite=60
 *   POST   /api/copias/limpiar   → cada pendiente se queda con su propuesta
 *   POST   /api/copias/decidir   → body { huella, quedan: [fileId] }
 *   POST   /api/copias/olvidar   → body { huellas: [...], lote? } vuelven a pendiente
 *                                   (con `lote`, solo lo que decidio esa limpieza)
 *   POST   /api/copias/buscar    → vuelve a buscar sin esperar a una sincronizacion
 */

const express = require('express');
const copias = require('../services/copiasExactas');
const fallos = require('../utils/failureReason');

module.exports = function createCopiasRoutes(deps = {}) {
  const router = express.Router();
  const { getMediaFiles } = deps;

  const fallar = (res, operacion, err) => {
    const causa = fallos.record(operacion, err, {});
    res.status(err.status || 500).json({ success: false, error: err.status ? err.message : causa.reason });
  };

  router.get('/copias/resumen', (req, res) => {
    res.json({ success: true, data: copias.resumen() });
  });

  router.get('/copias', async (req, res) => {
    try {
      const solo = req.query.solo === 'todas' ? 'todas' : 'pendientes';
      const desde = parseInt(req.query.desde, 10) || 0;
      const limite = parseInt(req.query.limite, 10) || 60;
      const lista = await copias.listar({ solo, desde, limite });
      res.json({ success: true, data: { resumen: copias.resumen(), ...lista } });
    } catch (err) {
      fallar(res, 'listar las copias exactas', err);
    }
  });

  router.post('/copias/limpiar', async (req, res) => {
    try {
      const r = await copias.limpiar();
      res.json({ success: true, data: { ...r, resumen: copias.resumen() } });
    } catch (err) {
      fallar(res, 'limpiar las copias exactas', err);
    }
  });

  router.post('/copias/decidir', async (req, res) => {
    try {
      const { huella, quedan } = req.body || {};
      if (typeof huella !== 'string' || !Array.isArray(quedan)) {
        return res.status(400).json({ success: false, error: 'Hace falta huella y quedan: [...]' });
      }
      const resumen = await copias.decidir(huella, quedan);
      res.json({ success: true, data: { resumen } });
    } catch (err) {
      fallar(res, 'decidir una copia exacta', err);
    }
  });

  router.post('/copias/olvidar', async (req, res) => {
    try {
      const { huellas, lote } = req.body || {};
      if (!Array.isArray(huellas)) {
        return res.status(400).json({ success: false, error: 'huellas debe ser un array' });
      }
      const r = await copias.olvidar(huellas, { lote: typeof lote === 'string' ? lote : null });
      res.json({ success: true, data: r });
    } catch (err) {
      fallar(res, 'deshacer decisiones de copias', err);
    }
  });

  router.post('/copias/buscar', (req, res) => {
    const files = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
    // No se espera: la primera pasada sobre un disco grande lee durante
    // minutos. El progreso se ve en /copias/resumen.
    copias.actualizar(files).catch(err => fallos.record('buscar copias exactas', err, {}));
    res.json({ success: true, data: copias.resumen() });
  });

  return router;
};
