/**
 * Momentos Routes — Pensadero
 *
 * Los momentos de los videos: huellas de varios instantes de cada clip para
 * que la busqueda visual lo encuentre con una imagen de cualquier momento
 * (ver services/momentosVideo.js).
 *
 *  - GET  /api/momentos/estado   -> cuantos videos los tienen, cuantos faltan,
 *                                   cuanto tardaria y el trabajo en marcha
 *  - POST /api/momentos/empezar  -> calcula los que faltan, en segundo plano
 *  - POST /api/momentos/parar    -> para (lo hecho se queda hecho)
 */

const express = require('express');
const momentosVideo = require('../services/momentosVideo');
const scanOrchestrator = require('../services/scanOrchestrator');
const fallos = require('../utils/failureReason');

module.exports = function createMomentosRoutes(deps = {}) {
  const router = express.Router();
  const { getMediaFiles } = deps;
  const todos = () => (typeof getMediaFiles === 'function' ? getMediaFiles() : []);
  const hayEscaneo = () => scanOrchestrator.listJobs().some(j => j.status === 'running');

  router.get('/momentos/estado', (req, res) => {
    try {
      res.json({ success: true, data: { ...momentosVideo.estado(todos()), escaneoEnMarcha: hayEscaneo() } });
    } catch (err) {
      const causa = fallos.record('leer el estado de los momentos de los vídeos', err);
      res.status(500).json({ success: false, error: causa.reason });
    }
  });

  router.post('/momentos/empezar', async (req, res) => {
    try {
      await momentosVideo.empezar(todos(), { hayEscaneo });
      res.json({ success: true, data: momentosVideo.estado(todos()) });
    } catch (err) {
      if (err.status === 409 || err.status === 503) {
        return res.status(err.status).json({ success: false, error: err.message });
      }
      const causa = fallos.record('empezar a calcular los momentos de los vídeos', err);
      res.status(500).json({ success: false, error: causa.reason });
    }
  });

  router.post('/momentos/parar', (req, res) => {
    const parado = momentosVideo.parar();
    res.json({ success: true, data: { parado, ...momentosVideo.estado(todos()) } });
  });

  return router;
};
