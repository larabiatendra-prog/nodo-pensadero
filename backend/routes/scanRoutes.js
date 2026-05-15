/**
 * Scan Routes — Pensadero
 *
 * Endpoints para lanzar y consultar escaneos visuales (generación local
 * de `_pensadero.json` usando VLM via Ollama).
 *
 * Rutas:
 *  - GET  /api/scan/health   — VLM disponible?
 *  - POST /api/scan/start    — body: { path, force? } → arranca un job en background
 *  - GET  /api/scan/jobs     — lista de jobs recientes
 *  - GET  /api/scan/status/:jobId  — estado de un job concreto
 *  - POST /api/scan/cancel/:jobId  — cancela un job en curso
 */

const express = require('express');
const router = express.Router();

const { getInstance: getScanner } = require('../visualScanService');
const scanOrchestrator = require('../services/scanOrchestrator');

module.exports = function createScanRoutes(deps) {
  const { broadcastProgress, syncFiles } = deps || {};

  // === HEALTH ===
  router.get('/scan/health', async (req, res) => {
    try {
      const health = await getScanner().healthCheck();
      res.json({ success: true, data: health });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // === START SCAN ===
  // body: { path: string, force?: boolean }
  // Devuelve inmediatamente con el jobId. El trabajo corre en background y
  // emite progreso por WebSocket (events 'scan_start','scan_progress','scan_done').
  router.post('/scan/start', async (req, res) => {
    const { path: folderPath, force = false } = req.body || {};
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ success: false, error: 'path requerido' });
    }

    // Comprobar primero que el VLM está disponible — fallar rápido si no.
    try {
      const health = await getScanner().healthCheck();
      if (!health.ollamaRunning) {
        return res.status(503).json({
          success: false,
          error: 'Ollama no disponible. Comprueba que el servicio está corriendo.',
        });
      }
      if (!health.modelAvailable) {
        return res.status(503).json({
          success: false,
          error: `Modelo ${health.model} no encontrado. Ejecuta: ollama pull ${health.model}`,
        });
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }

    // Generar jobId antes de arrancar para devolverlo en la respuesta HTTP.
    const jobId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Disparar en background. NO esperamos a que termine — devolvemos ya.
    // Errores se loguean; el cliente se entera por WebSocket o /scan/status.
    setImmediate(() => {
      scanOrchestrator.scanFolder(folderPath, {
        force,
        broadcastProgress: broadcastProgress || (() => {}),
        jobId,
      }).then(async (result) => {
        // Tras escanear, refrescar la lista de mediaFiles en memoria para que
        // el frontend vea la metadata sin tener que pulsar "sincronizar".
        if (typeof syncFiles === 'function' && result.written > 0) {
          try { await syncFiles(); } catch (e) { console.warn('[scan] post-sync falló:', e.message); }
        }
      }).catch(err => {
        console.error('[scan] error fatal:', err);
      });
    });

    res.json({ success: true, jobId, status: 'started' });
  });

  // === JOBS LIST ===
  router.get('/scan/jobs', (req, res) => {
    res.json({ success: true, data: scanOrchestrator.listJobs() });
  });

  // === JOB STATUS ===
  router.get('/scan/status/:jobId', (req, res) => {
    const status = scanOrchestrator.getJobStatus(req.params.jobId);
    if (!status) return res.status(404).json({ success: false, error: 'jobId desconocido' });
    res.json({ success: true, data: status });
  });

  // === CANCEL ===
  router.post('/scan/cancel/:jobId', (req, res) => {
    const ok = scanOrchestrator.cancelJob(req.params.jobId);
    if (!ok) return res.status(404).json({ success: false, error: 'job no cancelable (no existe o ya terminó)' });
    res.json({ success: true, cancelled: true });
  });

  return router;
};
