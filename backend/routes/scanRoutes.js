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
 *  - GET   /api/scan/capacidades   — que trabajos hace un escaneo (global y por ruta)
 *  - PATCH /api/scan/capacidades   — body: { global: { caras: false, ... } }
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();

const { getInstance: getScanner } = require('../visualScanService');
const { getInstance: getClipService } = require('../services/clipService');
const scanOrchestrator = require('../services/scanOrchestrator');
const scanState = require('../services/scanState');
const folderContext = require('../services/folderContext');
const folderNames = require('../folderNames');
const pathsConfig = require('../config/paths');
const escaneoConfig = require('../services/escaneoConfig');

module.exports = function createScanRoutes(deps) {
  const { broadcastProgress, syncFiles, loadScanPaths, refreshDir, getMediaFiles } = deps || {};

  // Normaliza una ruta para comparación: absoluta, minúsculas, sin separador
  // final. En Windows el FS es case-insensitive, así que comparar en minúsculas
  // es lo correcto.
  /** Trabajos encendidos para escanear `carpeta` (global + su biblioteca). */
  async function capacidadesPara(carpeta) {
    let rutas = [];
    try { rutas = typeof loadScanPaths === 'function' ? await loadScanPaths() : []; } catch { rutas = []; }
    return escaneoConfig.paraCarpeta(carpeta, rutas);
  }

  /**
   * Sin descripciones no hace falta Ollama: un escaneo solo de caras o de
   * busqueda visual tiene que poder lanzarse con el VLM apagado. Devuelve el
   * error a enviar, o null si se puede seguir.
   */
  async function vlmSiHaceFalta(caps) {
    if (!caps.descripcion) return null;
    try {
      const health = await getScanner().healthCheck();
      if (!health.ollamaRunning) return { status: 503, error: 'Ollama no disponible. Comprueba que el servicio está corriendo, o apaga las descripciones.' };
      if (!health.modelAvailable) return { status: 503, error: `Modelo ${health.model} no encontrado. Ejecuta: ollama pull ${health.model}` };
    } catch (err) {
      return { status: 500, error: err.message };
    }
    return null;
  }

  function _normPath(p) {
    return path.resolve(String(p)).toLowerCase().replace(/[\\/]+$/, '');
  }

  // Verifica que `target` esté contenida en una biblioteca configurada
  // (CONTENT_DIR o cualquier scan_path). Sin esto, con CORS abierto y sin auth,
  // una web podría lanzar escaneos, escribir _contexto.md / _pensadero.json o
  // enumerar carpetas en CUALQUIER punto del disco. Confina la superficie a las
  // raíces que el usuario añadió.
  async function isPathAllowed(target) {
    if (!target || typeof target !== 'string') return false;
    let norm;
    try { norm = _normPath(target); } catch { return false; }

    const libs = [];
    try { const cd = pathsConfig.getContentDir(); if (cd) libs.push(cd); } catch {}
    try {
      const sp = typeof loadScanPaths === 'function' ? await loadScanPaths() : [];
      for (const p of (Array.isArray(sp) ? sp : [])) {
        if (p && p.path) libs.push(p.path);
      }
    } catch {}

    for (const lib of libs) {
      if (!lib) continue;
      const ln = _normPath(lib);
      if (norm === ln || norm.startsWith(ln + path.sep)) return true;
    }
    return false;
  }

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
  // Devuelve el catalogo curado (gemma4:12b/27b, gemma3:12b legacy) fusionado
  // con los VLM instalados. Cada entrada lleva { name, tier, label, notes,
  // installed }: los curados aparecen SIEMPRE (installed:false si faltan →
  // la UI los marca "pendiente de descarga"). Con ?all=1 devuelve la lista
  // cruda sin filtrar ni catalogo (debugging).
  router.get('/scan/models', async (req, res) => {
    try {
      const scanner = getScanner();
      const showAll = req.query.all === '1' || req.query.all === 'true';
      const models = showAll
        ? (await scanner.listModels()).map(name => ({ name, tier: 'otro', label: name, notes: '', installed: true }))
        : await scanner.listVisionCatalog();
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
    const { path: folderPath, force = false, reanudando = false } = req.body || {};
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ success: false, error: 'path requerido' });
    }

    if (!(await isPathAllowed(folderPath))) {
      return res.status(403).json({ success: false, error: 'Ruta fuera de las bibliotecas configuradas' });
    }

    // Guard de concurrencia: dos escaneos sobre carpetas solapadas hacen
    // read-modify-write del mismo _pensadero.json y se pisarían (pérdida de
    // entradas). Rechazar si hay un batch o un job activo sobre una ruta que
    // contenga o esté contenida en esta.
    if (batchState.running) {
      return res.status(409).json({ success: false, error: 'Hay un escaneo masivo en curso. Espera a que termine.' });
    }
    const reqNorm = _normPath(folderPath);
    const overlapping = (scanOrchestrator.listJobs() || []).some(j => {
      if (j.status !== 'running' || !j.folderPath) return false;
      const jn = _normPath(j.folderPath);
      return jn === reqNorm || jn.startsWith(reqNorm + path.sep) || reqNorm.startsWith(jn + path.sep);
    });
    if (overlapping) {
      return res.status(409).json({ success: false, error: 'Ya hay un escaneo en curso sobre esta carpeta (o una que la contiene).' });
    }

    // Que trabajos tocan en esta carpeta, y el VLM solo si se va a describir.
    const capacidades = await capacidadesPara(folderPath);
    if (!escaneoConfig.IDS.some(id => capacidades[id])) {
      return res.status(400).json({ success: false, error: 'Todos los trabajos del escaneo están apagados para esta ruta.' });
    }
    const sinVlm = await vlmSiHaceFalta(capacidades);
    if (sinVlm) return res.status(sinVlm.status).json({ success: false, error: sinVlm.error });

    // Generar jobId antes de arrancar para devolverlo en la respuesta HTTP.
    const jobId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Disparar en background. NO esperamos a que termine — devolvemos ya.
    // Errores se loguean; el cliente se entera por WebSocket o /scan/status.
    setImmediate(async () => {
      // Dejar constancia en disco ANTES de empezar: si el proceso muere a
      // mitad, al arrancar se sabe que habia un escaneo en curso y se retoma.
      await scanState.iniciar({ tipo: 'carpeta', carpeta: folderPath, force, reanudando: !!reanudando });
      scanOrchestrator.scanFolder(folderPath, {
        force,
        broadcastProgress: broadcastProgress || (() => {}),
        jobId,
        capacidades,
      }).then(async (result) => {
        // Tras escanear, refrescar la lista de mediaFiles en memoria para que
        // el frontend vea la metadata sin tener que pulsar "sincronizar".
        if (typeof syncFiles === 'function' && result.written > 0) {
          try { await syncFiles(); } catch (e) { console.warn('[scan] post-sync falló:', e.message); }
        }
      }).catch(err => {
        console.error('[scan] error fatal:', err);
      }).finally(() => {
        // Termino de verdad (bien o mal): ya no hay nada que reanudar.
        scanState.finalizar().catch(() => {});
      });
    });

    res.json({ success: true, jobId, status: 'started', capacidades });
  });

  // === SCAN SINGLE FILE ===
  // body: { path: string } — escanea UN archivo (boton de la tarjeta del grid).
  // Sincrono: espera a que termine y refresca la memoria, para que el frontend
  // pueda pedir la metadata actualizada de ese archivo justo despues.
  router.post('/scan/file', async (req, res) => {
    const { path: filePath } = req.body || {};
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ success: false, error: 'path requerido' });
    }

    if (!(await isPathAllowed(filePath))) {
      return res.status(403).json({ success: false, error: 'Ruta fuera de las bibliotecas configuradas' });
    }

    // Guard: no escanear un archivo si hay un job de escaneo corriendo. Dos
    // escaneos sobre la misma carpeta hacen read-modify-write del mismo
    // _pensadero.json y se pisarian (perdida de entradas). El daemon VLM ademas
    // es serial, asi que no se pierde paralelismo real.
    const running = (scanOrchestrator.listJobs() || []).some(j => j.status === 'running');
    if (running || batchState.running) {
      return res.status(409).json({
        success: false,
        error: 'Hay un escaneo en curso. Espera a que termine para escanear este archivo.',
      });
    }

    // Comprobar que el VLM está disponible — fallar rápido si no.
    try {
      const health = await getScanner().healthCheck();
      if (!health.ollamaRunning) {
        return res.status(503).json({ success: false, error: 'Ollama no disponible. Comprueba que el servicio está corriendo.' });
      }
      if (!health.modelAvailable) {
        return res.status(503).json({ success: false, error: `Modelo ${health.model} no encontrado. Ejecuta: ollama pull ${health.model}` });
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }

    try {
      const result = await scanOrchestrator.scanSingleFile(filePath, {
        broadcastProgress: broadcastProgress || (() => {}),
      });
      // Refrescar memoria para que GET /files/:id devuelva la metadata nueva.
      if (typeof syncFiles === 'function' && result.written > 0) {
        try { await syncFiles(); } catch (e) { console.warn('[scan-file] post-sync falló:', e.message); }
      }
      // Escanear y no poder guardar NO es un exito: el trabajo se ha hecho y se
      // ha tirado. Antes esto devolvia success:true con written:0 y el usuario
      // se quedaba pensando que el archivo estaba re-escaneado.
      if (result.written === 0 && result.escriturasFallidas > 0) {
        const c = result.causa;
        return res.status(500).json({
          success: false,
          error: `El archivo se ha analizado pero NO se ha podido guardar.`
            + (c ? ` ${c.reason}${c.hint ? ` ${c.hint}` : ''}` : ''),
          causa: c || undefined,
          data: result,
        });
      }
      res.json({ success: true, data: result });
    } catch (err) {
      console.error('[scan-file] error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // === CAPACIDADES DEL ESCANEO ===
  // Catalogo (para pintar), global y lo que cada ruta sobrescribe/resulta.
  router.get('/scan/capacidades', async (req, res) => {
    let rutas = [];
    try { rutas = typeof loadScanPaths === 'function' ? await loadScanPaths() : []; } catch { rutas = []; }
    res.json({
      success: true,
      data: {
        catalogo: escaneoConfig.CAPACIDADES,
        global: escaneoConfig.global(),
        rutas: (Array.isArray(rutas) ? rutas : []).map(r => ({
          id: r.id,
          sobrescribe: r.escaneo || {},
          efectivas: escaneoConfig.deRuta(r),
        })),
      },
    });
  });

  // body: { global: { caras: false } } — solo lo que cambia.
  router.patch('/scan/capacidades', async (req, res) => {
    try {
      const nuevo = await escaneoConfig.setGlobal((req.body && req.body.global) || {});
      res.json({ success: true, data: { global: nuevo } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
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

    const allPaths = await loadScanPaths();
    // Solo las rutas activas con algun trabajo encendido: una ruta con todo
    // apagado se salta, no se recorre para nada.
    const activePaths = (Array.isArray(allPaths) ? allPaths : [])
      .filter(p => p && p.isActive !== false)
      .filter(p => { const c = escaneoConfig.deRuta(p); return escaneoConfig.IDS.some(id => c[id]); });
    if (activePaths.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay rutas activas con algo que escanear' });
    }

    // El VLM solo hace falta si alguna ruta va a describir.
    const algunaDescribe = activePaths.some(p => escaneoConfig.deRuta(p).descripcion);
    const sinVlm = await vlmSiHaceFalta({ descripcion: algunaDescribe });
    if (sinVlm) return res.status(sinVlm.status).json({ success: false, error: sinVlm.error });

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

    // Marca numerica para el tiempo total del batch (startedAt es ISO para el
    // status; aqui necesitamos ms para restar al cerrar).
    const batchStartMs = Date.now();
    setImmediate(async () => {
      // Intencion en disco antes de empezar: un batch de miles de archivos
      // dura horas y es justo el que no puede permitirse morir en silencio.
      await scanState.iniciar({
        tipo: 'batch',
        rutas: activePaths.map(p => p.path),
        force,
        reanudando: !!(req.body && req.body.reanudando),
      });
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
              // Se relee al llegar a cada ruta: si cambias un interruptor a
              // mitad del lote, la siguiente ruta ya lo respeta.
              capacidades: await capacidadesPara(p.path),
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
              elapsedMs: Date.now() - batchStartMs,
            });
          } catch (e) { console.warn('[scan-all] broadcast done falló:', e.message); }
        }
        resetBatch();
        // El bucle acabo (completo, abortado o reventado): nada que reanudar.
        await scanState.finalizar().catch(() => {});
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
    if (!(await isPathAllowed(folderPath))) {
      return res.status(403).json({ success: false, error: 'Ruta fuera de las bibliotecas configuradas' });
    }
    try {
      const st = await fs.stat(folderPath).catch(() => null);
      if (!st || !st.isDirectory()) {
        return res.status(404).json({ success: false, error: `Ruta no encontrada o no es directorio: ${folderPath}` });
      }
      const folders = await scanOrchestrator.listFoldersWithMedia(folderPath);

      // Cobertura de escaneo visual por carpeta (solo archivos DIRECTOS de cada
      // una, no recursivo: cada subcarpeta se escanea y se reporta por separado).
      // Se cuenta sobre la lista en memoria, que es la que refleja el estado real.
      const media = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
      const normDir = (s) => (s || '').replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
      const descritosPorDir = new Map();
      for (const f of media) {
        if (!f.fullPath) continue;
        const dir = normDir(f.fullPath.replace(/[\\/][^\\/]+$/, ''));
        let e = descritosPorDir.get(dir);
        if (!e) { e = { total: 0, descritos: 0 }; descritosPorDir.set(dir, e); }
        e.total++;
        if (typeof f.visual_description === 'string' && f.visual_description.trim()) e.descritos++;
      }

      const enriched = await Promise.all(folders.map(async (f) => {
        const ctx = await folderContext.readFolderContext(f.dir);
        const cobertura = descritosPorDir.get(normDir(f.dir)) || { total: 0, descritos: 0 };
        return {
          ...f,
          hasContext: ctx.exists,
          context: ctx.exists ? { meta: ctx.meta, body: ctx.body } : null,
          // Display name editable de la carpeta (null si conserva el original).
          folderName: folderNames.getName(f.dir),
          visualTotal: cobertura.total,
          visualScanned: cobertura.descritos,
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
    if (!(await isPathAllowed(folderPath))) {
      return res.status(403).json({ success: false, error: 'Ruta fuera de las bibliotecas configuradas' });
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

  // === SET FOLDER DISPLAY NAME ===
  // POST /api/folders/name
  // body: { folderPath: string, displayName: string|null }
  // Asigna el nombre de presentacion de una carpeta (uno por carpeta; todos sus
  // archivos heredan + enumeracion _NNN). displayName vacio/null restaura el
  // nombre original. El archivo fisico NO se toca nunca.
  router.post('/folders/name', async (req, res) => {
    const { folderPath, displayName } = req.body || {};
    if (!folderPath || typeof folderPath !== 'string') {
      return res.status(400).json({ success: false, error: 'folderPath requerido' });
    }
    if (!(await isPathAllowed(folderPath))) {
      return res.status(403).json({ success: false, error: 'Ruta fuera de las bibliotecas configuradas' });
    }
    const st = await fs.stat(folderPath).catch(() => null);
    if (!st || !st.isDirectory()) {
      return res.status(404).json({ success: false, error: `Carpeta no encontrada: ${folderPath}` });
    }

    try {
      const result = await folderNames.setName(folderPath, displayName);
      // Refrescar en memoria los MediaFile de esta carpeta (sin re-escanear disco):
      // re-aplica catalog + el nuevo display name + enumeracion sobre los hermanos.
      if (typeof refreshDir === 'function') {
        await refreshDir(folderPath);
      }
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Retoma el escaneo que quedo a medias si el proceso anterior murio.
   *
   * Lo llama server.js despues de la sincronizacion inicial. Reentra por los
   * MISMOS endpoints en vez de duplicar el bucle: asi hereda todos los guards
   * (Ollama vivo, rutas permitidas, no solapar escaneos) y no hay dos caminos
   * distintos que puedan divergir.
   *
   * No hace falta recordar por que archivo iba: el catalogo se vuelca cada
   * pocos archivos y un escaneo con force:false salta lo ya descrito.
   */
  router.reanudarSiQuedoAMedias = async function reanudarSiQuedoAMedias(puerto) {
    let pendiente;
    try {
      pendiente = scanState.pendienteDeReanudar();
    } catch (err) {
      console.warn('[scan-state] no se pudo leer el estado de reanudacion:', err.message);
      return;
    }
    if (!pendiente) return;

    const base = `http://127.0.0.1:${puerto}/api`;
    const destino = pendiente.tipo === 'batch' ? '/scan/start-all' : '/scan/start';
    const cuerpo = pendiente.tipo === 'batch'
      ? { force: pendiente.force, reanudando: true }
      : { path: pendiente.carpeta, force: pendiente.force, reanudando: true };

    console.log(
      `🔁 Habia un escaneo a medias (${pendiente.tipo}${pendiente.carpeta ? ': ' + pendiente.carpeta : ''}, ` +
      `${pendiente.ultimoAvance || 0} archivos hechos). Retomandolo...`
    );

    try {
      const r = await fetch(base + destino, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      const json = await r.json().catch(() => ({}));
      if (r.ok && json.success) {
        console.log('🔁 Escaneo retomado. Lo ya descrito se salta solo.');
      } else {
        // Si no se puede retomar (Ollama caido, ruta desconectada), se deja el
        // estado activo: en el proximo arranque se vuelve a intentar.
        console.warn(`🔁 No se pudo retomar el escaneo: ${json.error || r.status}. Se reintentara al proximo arranque.`);
      }
    } catch (err) {
      console.warn('🔁 No se pudo retomar el escaneo:', err.message);
    }
  };

  return router;
};
