/**
 * Scan Routes — Pensadero
 *
 * Endpoints para lanzar y consultar escaneos visuales (generación local
 * de `_pensadero.json` usando VLM via Ollama).
 *
 * Rutas:
 *  - GET   /api/scan/health        — VLM disponible?
 *  - GET   /api/scan/models        — modelos Ollama disponibles + modelo activo
 *  - PATCH /api/scan/model         — body: { model } → cambia el modelo activo en runtime
 *  - POST  /api/scan/start         — body: { path, force? } → arranca un job en background
 *  - POST  /api/scan/start-all     — body: { force? } → escanea TODAS las rutas activas en serie
 *  - POST  /api/scan/cancel-all    — aborta el bucle batch (no afecta a jobs ad-hoc)
 *  - GET   /api/scan/batch-status  — estado del batch global (running/idle/processed)
 *  - GET   /api/scan/jobs          — lista de jobs recientes
 *  - GET   /api/scan/status/:jobId — estado de un job concreto
 *  - POST  /api/scan/cancel/:jobId — cancela un job en curso
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();

const { getInstance: getScanner } = require('../visualScanService');
const { getInstance: getClipService } = require('../services/clipService');
const scanOrchestrator = require('../services/scanOrchestrator');
const folderContext = require('../services/folderContext');

module.exports = function createScanRoutes(deps) {
  const { broadcastProgress, syncFiles, loadScanPaths } = deps || {};

  // Estado del bucle batch "start-all". Solo uno activo a la vez.
  // Cuando aborted=true, el bucle no avanza a la siguiente ruta tras
  // terminar/cancelar la actual.
  const batchState = {
    running: false,
    aborted: false,
    total: 0,
    processed: 0,
    currentPathId: null,
    currentJobId: null,
    force: false,
    startedAt: null,
  };

  function resetBatch() {
    batchState.running = false;
    batchState.aborted = false;
    batchState.total = 0;
    batchState.processed = 0;
    batchState.currentPathId = null;
    batchState.currentJobId = null;
    batchState.force = false;
    batchState.startedAt = null;
  }

  // === HEALTH ===
  router.get('/scan/health', async (req, res) => {
    try {
      const health = await getScanner().healthCheck();
      res.json({ success: true, data: health });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // === CLIP HEALTH — diagnostico del daemon SigLIP-2 ===
  // GET  /api/clip/health         → estado actual sin tocar nada
  // POST /api/clip/warmup         → fuerza warmup (util como "test rapido"
  //                                 antes de lanzar un scan masivo)
  router.get('/clip/health', (req, res) => {
    res.json({ success: true, data: getClipService().getStatus() });
  });

  router.post('/clip/warmup', async (req, res) => {
    try {
      const r = await getClipService().warmup();
      res.json({ success: r.ok, data: r });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // === MODELS — lista modelos disponibles para describir fotos ===
  // Filtra los VLM (modelos con capacidad de vision) — los de solo texto
  // o embedders no sirven para el scan. Con ?all=1 devuelve la lista sin
  // filtrar (debugging).
  router.get('/scan/models', async (req, res) => {
    try {
      const scanner = getScanner();
      const showAll = req.query.all === '1' || req.query.all === 'true';
      const models = showAll
        ? await scanner.listModels()
        : await scanner.listVisionModels();
      res.json({ success: true, data: { models, current: scanner.model, filtered: !showAll } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // === SET MODEL — cambia el modelo VLM activo en runtime ===
  router.patch('/scan/model', (req, res) => {
    const { model } = req.body || {};
    if (!model || typeof model !== 'string') {
      return res.status(400).json({ success: false, error: 'model requerido' });
    }
    getScanner().setModel(model);
    res.json({ success: true, data: { model } });
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

  // === START ALL — escanea todas las rutas activas en serie ===
  // body: { force?: boolean }
  // Comprueba VLM y dispara un bucle async en background que procesa
  // las rutas activas una tras otra. Cada ruta emite sus propios eventos
  // WS (scan_start/progress/done). Se emite ademas batch_start/batch_done
  // para que la UI muestre un indicador global.
  router.post('/scan/start-all', async (req, res) => {
    if (batchState.running) {
      return res.status(409).json({ success: false, error: 'Ya hay un escaneo masivo en curso' });
    }
    if (typeof loadScanPaths !== 'function') {
      return res.status(500).json({ success: false, error: 'loadScanPaths no inyectado' });
    }

    const force = !!(req.body && req.body.force);

    // Validar VLM antes de empezar
    try {
      const health = await getScanner().healthCheck();
      if (!health.ollamaRunning) {
        return res.status(503).json({ success: false, error: 'Ollama no disponible' });
      }
      if (!health.modelAvailable) {
        return res.status(503).json({ success: false, error: `Modelo ${health.model} no encontrado. Ejecuta: ollama pull ${health.model}` });
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }

    const allPaths = await loadScanPaths();
    const activePaths = (Array.isArray(allPaths) ? allPaths : []).filter(p => p && p.isActive !== false);
    if (activePaths.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay rutas activas para escanear' });
    }

    // Pre-generar jobIds para devolverlos en el response (la UI puede
    // pre-poblar su mapa jobId→pathId antes de que lleguen los eventos WS).
    const jobIds = activePaths.map(() => `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

    batchState.running = true;
    batchState.aborted = false;
    batchState.total = activePaths.length;
    batchState.processed = 0;
    batchState.force = force;
    batchState.startedAt = new Date().toISOString();

    // Notificar arranque del batch
    if (typeof broadcastProgress === 'function') {
      broadcastProgress({
        type: 'batch_scan_start',
        total: activePaths.length,
        force,
        items: activePaths.map((p, i) => ({ pathId: p.id, path: p.path, jobId: jobIds[i] })),
      });
    }

    setImmediate(async () => {
      // try/finally garantiza que SIEMPRE emitimos batch_scan_done y reseteamos
      // el state. Si un error inesperado revienta el bucle, la UI no se queda
      // con el indicador "Escaneando" colgado.
      try {
        for (let i = 0; i < activePaths.length; i++) {
          if (batchState.aborted) break;
          const p = activePaths[i];
          batchState.currentPathId = p.id;
          batchState.currentJobId = jobIds[i];

          if (typeof broadcastProgress === 'function') {
            try {
              broadcastProgress({
                type: 'batch_scan_progress',
                index: i,
                total: activePaths.length,
                pathId: p.id,
                path: p.path,
                jobId: jobIds[i],
              });
            } catch (e) { console.warn('[scan-all] broadcast progress falló:', e.message); }
          }

          try {
            await scanOrchestrator.scanFolder(p.path, {
              force,
              broadcastProgress: broadcastProgress || (() => {}),
              jobId: jobIds[i],
            });
          } catch (err) {
            console.error(`[scan-all] error en ruta ${p.path}:`, err.message);
          }
          batchState.processed = i + 1;
        }

        // Refrescar mediaFiles si hubo cambios (best-effort)
        if (typeof syncFiles === 'function') {
          try { await syncFiles(); } catch (e) { console.warn('[scan-all] post-sync falló:', e.message); }
        }
      } catch (fatal) {
        console.error('[scan-all] error fatal:', fatal);
      } finally {
        if (typeof broadcastProgress === 'function') {
          try {
            broadcastProgress({
              type: 'batch_scan_done',
              total: activePaths.length,
              processed: batchState.processed,
              aborted: batchState.aborted,
            });
          } catch (e) { console.warn('[scan-all] broadcast done falló:', e.message); }
        }
        resetBatch();
      }
    });

    res.json({ success: true, jobIds, count: activePaths.length, force });
  });

  // === CANCEL ALL — aborta el bucle batch ===
  // Cancela el job en curso (si lo hay) y marca aborted=true para que el
  // bucle no avance a la siguiente ruta.
  router.post('/scan/cancel-all', (req, res) => {
    if (!batchState.running) {
      return res.status(404).json({ success: false, error: 'No hay escaneo masivo en curso' });
    }
    batchState.aborted = true;
    let cancelledCurrent = false;
    if (batchState.currentJobId) {
      cancelledCurrent = scanOrchestrator.cancelJob(batchState.currentJobId);
    }
    res.json({ success: true, aborted: true, cancelledCurrent });
  });

  // === BATCH STATUS ===
  router.get('/scan/batch-status', (req, res) => {
    res.json({ success: true, data: { ...batchState } });
  });

  // === INVENTORY ===
  // GET /api/scan/inventory?path=...
  // Devuelve la lista de subcarpetas (con material escaneable) bajo `path`
  // y, por cada una, su estado de `_contexto.md`. Alimenta el modal de
  // contexto en el frontend antes de lanzar un scan.
  router.get('/scan/inventory', async (req, res) => {
    const folderPath = req.query.path;
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ success: false, error: 'path requerido' });
    }
    try {
      const st = await fs.stat(folderPath).catch(() => null);
      if (!st || !st.isDirectory()) {
        return res.status(404).json({ success: false, error: `Ruta no encontrada o no es directorio: ${folderPath}` });
      }
      const folders = await scanOrchestrator.listFoldersWithMedia(folderPath);
      const enriched = await Promise.all(folders.map(async (f) => {
        const ctx = await folderContext.readFolderContext(f.dir);
        return {
          ...f,
          hasContext: ctx.exists,
          context: ctx.exists ? { meta: ctx.meta, body: ctx.body } : null,
        };
      }));
      // Estado de la raíz también — interesa saber si tiene _contexto.md
      // aunque no contenga medios directos (sólo subcarpetas)
      const rootCtx = await folderContext.readFolderContext(folderPath);
      res.json({
        success: true,
        data: {
          root: folderPath,
          rootContext: rootCtx.exists ? { meta: rootCtx.meta, body: rootCtx.body } : null,
          folders: enriched,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // === SAVE CONTEXT ===
  // POST /api/scan/context
  // body: { folderPath: string, context: { tipo?, lugar?, fecha?, personas?, priorizar?, ignorar?, notas?, ... } }
  // Si `context` viene vacío o todos los campos están vacíos, elimina el
  // archivo si existía (útil para "saltar" sin ensuciar el árbol).
  router.post('/scan/context', async (req, res) => {
    const { folderPath, context } = req.body || {};
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ success: false, error: 'folderPath requerido' });
    }
    const st = await fs.stat(folderPath).catch(() => null);
    if (!st || !st.isDirectory()) {
      return res.status(404).json({ success: false, error: `Carpeta no encontrada: ${folderPath}` });
    }

    const isEmpty = !context || (typeof context === 'object' && Object.values(context).every(v => {
      if (v == null) return true;
      if (typeof v === 'string') return v.trim() === '';
      if (Array.isArray(v)) return v.length === 0;
      return false;
    }));

    if (isEmpty) {
      const fp = path.join(folderPath, folderContext.CONTEXT_FILENAME);
      try {
        await fs.unlink(fp);
        return res.json({ success: true, deleted: true });
      } catch (err) {
        // Si no existía, devolver ok igualmente
        if (err.code === 'ENOENT') return res.json({ success: true, deleted: false });
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    try {
      const written = await folderContext.writeFolderContext(folderPath, context);
      res.json({ success: true, data: written });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
