/**
 * System Routes - Rutas de Sistema, Estadísticas y Scan-Paths
 *
 * Este módulo exporta una función factory que recibe las dependencias
 * necesarias de server.js y devuelve un router configurado.
 *
 * Rutas incluidas:
 * - /api/system/info - Información del sistema y diagnóstico
 * - /api/statistics - Estadísticas de la biblioteca
 * - /api/colors - Paleta global de colores
 * - /api/scan-paths/* - Gestión de rutas de escaneo
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Analizador de colores (stateless - se importa directamente)
const colorAnalyzer = require('../colorAnalyzer');
const mediaIdentity = require('../utils/mediaIdentity');
// Piezas que /api/health interroga. Singletons: importarlas aqui no arranca
// nada (CLIP y caras son de inicio perezoso).
const { getInstance: getScanner } = require('../visualScanService');
const { getInstance: getClipService } = require('../services/clipService');
const { getInstance: getFaceService } = require('../services/faceService');
const runtime = require('../config/runtime');
const fallos = require('../utils/failureReason');
const escaneoConfig = require('../services/escaneoConfig');
const scanOrchestrator = require('../services/scanOrchestrator');
const volumen = require('../utils/volumen');

/**
 * Factory function que crea el router con las dependencias inyectadas
 * @param {Object} deps - Dependencias del servidor principal
 * @param {Function} deps.getMediaFiles - Obtiene la lista de archivos
 * @param {Function} deps.getCollections - Obtiene las colecciones
 * @param {Function} deps.broadcastProgress - Progreso por WebSocket
 * @param {Function} deps.loadScanPaths - Lee scan_paths.json (la version UNICA, de server.js)
 * @param {Function} deps.saveScanPaths - Lo guarda; LANZA si no puede
 * @param {Function} deps.syncFiles - Sincroniza ({ soloIds } para unas rutas)
 * @param {Function} deps.remapearBiblioteca - Lleva cache, miniaturas e identidades a la ruta nueva
 * @param {string} deps.CONTENT_DIR - Directorio de contenido principal
 * @param {Function} [deps.alCambiarRutas] - Tras editar una ruta (p. ej. marcarla como copia de seguridad)
 */
module.exports = function createSystemRoutes(deps) {
  const {
    getMediaFiles,
    getCollections,
    broadcastProgress,
    loadScanPaths,
    saveScanPaths,
    syncFiles,
    remapearBiblioteca,
    CONTENT_DIR,
    alCambiarRutas,
  } = deps;

  // ============================================
  // FUNCIONES AUXILIARES PARA SCAN-PATHS
  // ============================================
  // Leer y guardar las rutas es cosa de server.js: aqui habia una copia propia
  // que se habia separado de la de la sincronizacion (una migraba el esquema y
  // la otra no; una tragaba los fallos al guardar y la otra tambien).

  /**
   * Las rutas para enseñar. Sin ninguna configurada, la carpeta por defecto
   * (CONTENT_DIR) si existe: es la que sincroniza el servidor en ese caso.
   */
  async function rutasParaMostrar() {
    const paths = await loadScanPaths();
    if (paths.length > 0 || !CONTENT_DIR) return paths;
    const existe = await fs.access(CONTENT_DIR).then(() => true).catch(() => false);
    if (!existe) return [];
    return [mediaIdentity.ensureScanPathSchema({
      id: 'default',
      path: CONTENT_DIR,
      isActive: true,
      lastScan: null,
      fileCount: getMediaFiles().length,
      status: 'connected',
    })];
  }

  /** Respuesta de error con la causa en cristiano (utils/failureReason). */
  function responderFallo(res, operacion, err) {
    const exp = fallos.explainFailure(err, { operacion });
    return res.status(500).json({
      success: false,
      error: `No se pudo ${operacion}. ${exp.reason}${exp.hint ? ` ${exp.hint}` : ''}`,
      causa: { reason: exp.reason, hint: exp.hint, code: exp.code },
    });
  }

  /** Sincroniza unas rutas en segundo plano (no se espera: puede tardar minutos). */
  function sincronizarLuego(ids) {
    if (typeof syncFiles !== 'function') return;
    syncFiles({ soloIds: ids }).catch(err => fallos.record('sincronizar tras cambiar las rutas', err));
  }

  const normRaiz = (p) => mediaIdentity.normalizeLibraryRoot(p);

  /**
   * Valida una carpeta candidata a biblioteca. Devuelve { ruta } normalizada o
   * { error, status, extra }.
   * @param {Array} paths - las rutas configuradas
   * @param {string|null} idPropio - la biblioteca que se esta editando (se ignora a si misma)
   */
  async function validarCarpeta(entrada, paths, idPropio = null) {
    if (typeof entrada !== 'string' || !entrada.trim()) {
      return { status: 400, error: 'La ruta es requerida' };
    }
    // Absoluta y sin barra final (salvo la raiz de una unidad): "d:\fotos\" y
    // "D:\Fotos" eran dos bibliotecas distintas para la comprobacion de repetidas.
    let ruta = path.resolve(entrada.trim().replace(/^"(.*)"$/, '$1'));
    if (!/^[a-z]:\\$/i.test(ruta)) ruta = ruta.replace(/[\\/]+$/, '');
    if (/^[a-z]:\\/i.test(ruta)) ruta = ruta[0].toUpperCase() + ruta.slice(1);

    const st = await fs.stat(ruta).catch(() => null);
    if (!st) return { status: 400, error: 'La ruta no existe o no es accesible' };
    if (!st.isDirectory()) return { status: 400, error: 'Eso es un archivo, no una carpeta' };

    const n = normRaiz(ruta);
    for (const p of paths) {
      if (!p || p.id === idPropio || !p.path) continue;
      const o = normRaiz(p.path);
      const nombre = p.displayName || p.path;
      if (o === n) return { status: 400, error: `Esa carpeta ya es la biblioteca «${nombre}»` };
      // Una biblioteca dentro de otra indexaba dos veces lo mismo, con dos
      // identidades distintas (el 22/09/2026 se añadio D:\ con D:\(1) WORKS dentro).
      if (n.startsWith(o + '\\') || (o.endsWith(':') && n.startsWith(o))) {
        return { status: 400, error: `Esa carpeta ya está dentro de la biblioteca «${nombre}» (${p.path}), así que ya se sincroniza.` };
      }
      if (o.startsWith(n + '\\') || (n.endsWith(':') && o.startsWith(n))) {
        return { status: 400, error: `Esa carpeta contiene la biblioteca «${nombre}» (${p.path}). Se indexaría dos veces: quita esa antes o elige otra carpeta.` };
      }
    }

    // ¿Es el disco de una biblioteca que ya existe, con otra letra? Es lo que
    // paso con E:\(1) WORKS el 22/09/2026: se añadio como nueva y lo de ese
    // disco (favoritos, notas, colecciones) se quedo colgando de la vieja.
    const serie = await volumen.serialDe(ruta);
    if (serie) {
      const resto = ruta.slice(2).toLowerCase();
      const suya = paths.find(p => p && p.id !== idPropio && p.volumen === serie
        && String(p.path || '').slice(2).toLowerCase() === resto
        && normRaiz(p.path) !== n);
      if (suya) {
        return {
          status: 409,
          error: `Este disco ya está añadido como «${suya.displayName || suya.path}» (${suya.path}). Cambia su ubicación en vez de añadirlo otra vez, y no se pierde nada de lo suyo.`,
          extra: { mismoDisco: { id: suya.id, nombre: suya.displayName || suya.path, ruta: suya.path, nuevaRuta: ruta } },
        };
      }
    }
    return { ruta, serie };
  }

  // ============================================
  // INFORMACIÓN DEL SISTEMA
  // ============================================

  /**
   * GET /api/system/info
   * Información del sistema y diagnóstico
   */
  // ============================================
  // SALUD DEL CIRCUITO COMPLETO
  // ============================================

  // ffmpeg no aparece ni desaparece en caliente: se resuelve una vez y se cachea.
  let _ffmpegCache = null;
  function checkFfmpeg() {
    if (_ffmpegCache) return Promise.resolve(_ffmpegCache);
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        _ffmpegCache = result;
        resolve(result);
      };
      try {
        const p = spawn('ffmpeg', ['-version']);
        p.on('error', () => {
          // Sin ffmpeg en PATH queda el binario del paquete npm: degradado
          // (sin NVENC) pero funcional. Conviene saber en cual estamos.
          try {
            const fallback = require('@ffmpeg-installer/ffmpeg').path;
            finish({ ok: true, source: 'paquete npm (sin NVENC)', path: fallback });
          } catch {
            finish({ ok: false, error: 'ffmpeg no encontrado ni en PATH ni como paquete' });
          }
        });
        p.on('close', () => finish({ ok: true, source: 'PATH' }));
        setTimeout(() => finish({ ok: false, error: 'ffmpeg no respondio en 5s' }), 5000);
      } catch (err) {
        finish({ ok: false, error: err.message });
      }
    });
  }

  /**
   * GET /api/health — estado de todas las piezas en una sola llamada.
   *
   * Existe para responder "esta el circuito entero?" sin abrir cinco pestanas
   * ni leer logs. Cada pieza que puede degradarse en silencio (Ollama, CLIP,
   * caras, ffmpeg, rutas) sale aqui con su estado real. Lo consumen la UI y
   * Pensadero_Doctor.bat.
   */
  router.get('/health', async (req, res) => {
    const checks = {};

    // --- VLM / Ollama: sin esto no hay descripciones ---
    try {
      const h = await getScanner().healthCheck();
      checks.ollama = {
        ok: !!h.ollamaRunning && !!h.modelAvailable,
        running: !!h.ollamaRunning,
        model: h.model,
        modelAvailable: !!h.modelAvailable,
      };
      if (!h.ollamaRunning) checks.ollama.error = 'Ollama no responde. Arrancalo con: ollama serve';
      else if (!h.modelAvailable) checks.ollama.error = `Modelo ${h.model} no instalado. Ejecuta: ollama pull ${h.model}`;
    } catch (err) {
      checks.ollama = { ok: false, error: err.message };
    }

    // --- CLIP y caras: de inicio perezoso, así que "no arrancado" NO es error.
    // Lo que sí es error es `unavailable`: lo intentó y no pudo.
    const lazyPiece = (status) => {
      if (!status) return { ok: false, state: 'desconocido' };
      if (status.unavailable) {
        return { ok: false, state: 'roto', error: status.lastError || 'no disponible' };
      }
      return { ok: true, state: status.ready ? 'listo' : 'inactivo (arranca al usarse)' };
    };

    try {
      checks.clip = lazyPiece(getClipService().getStatus());
    } catch (err) {
      checks.clip = { ok: false, state: 'roto', error: err.message };
    }

    // --- Incidencias: que ha fallado y por que. Agregadas por causa, asi que
    // 9.378 errores iguales salen como una linea con su contador. Es lo que
    // faltaba el 09/09/2026, cuando un disco lleno tiro un escaneo entero y
    // health seguia todo en verde.
    try {
      const inc = fallos.summary();
      checks.incidencias = {
        ok: inc.ok,
        total: inc.total,
        distintas: inc.distintas,
        porCausa: inc.porCausa,
        error: inc.principal ? `${inc.principal.reason} (${inc.principal.operacion}, x${inc.principal.veces})` : undefined,
        hint: inc.principal ? inc.principal.hint : undefined,
        items: inc.items.slice(0, 10).map(i => ({
          operacion: i.operacion, code: i.code, reason: i.reason, hint: i.hint,
          veces: i.veces, ultima: new Date(i.ultima).toISOString(), ultimoPath: i.ultimoPath,
        })),
      };
    } catch (err) {
      checks.incidencias = { ok: false, error: err.message };
    }

    try {
      const fs2 = getFaceService().getStatus();
      checks.faces = lazyPiece(fs2);
      if (fs2) checks.faces.trainedPersons = fs2.trainedPersons;
      if (fs2 && Array.isArray(fs2.providers) && fs2.providers.length) {
        checks.faces.providers = fs2.providers;
      }
    } catch (err) {
      checks.faces = { ok: false, state: 'roto', error: err.message };
    }

    checks.ffmpeg = await checkFfmpeg();

    // --- Bibliotecas: accesibles de verdad, comprobado ahora, no el estado
    // guardado de la ultima sincronizacion.
    try {
      const paths = await rutasParaMostrar();
      const rutas = [];
      for (const p of paths) {
        let accesible = false;
        try {
          await fs.access(p.path);
          accesible = true;
        } catch { /* no accesible */ }
        // otroDisco: en esa letra hay un disco que no es el de la biblioteca.
        rutas.push({ path: p.path, displayName: p.displayName || null, isActive: p.isActive !== false, accesible, otroDisco: p.status === 'otro_disco' });
      }
      const rotas = rutas.filter(r => r.isActive && (!r.accesible || r.otroDisco));
      checks.bibliotecas = {
        ok: rotas.length === 0,
        total: rutas.length,
        rutas,
        error: rotas.length > 0 ? `${rotas.length} biblioteca(s) activa(s) no accesible(s)` : undefined,
      };
    } catch (err) {
      checks.bibliotecas = { ok: false, error: err.message };
    }

    // --- Cobertura de escaneo visual: cuanto queda pendiente de describir.
    // No es un fallo, es trabajo por hacer, pero conviene verlo aqui.
    try {
      const media = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
      let scanned = 0;
      for (const f of media) {
        if (typeof f.visual_description === 'string' && f.visual_description.trim()) scanned++;
      }
      checks.escaneo = {
        ok: true,
        total: media.length,
        descritos: scanned,
        pendientes: media.length - scanned,
      };
    } catch (err) {
      checks.escaneo = { ok: false, error: err.message };
    }

    // --- Proceso: memoria y uptime. Si el RSS se acerca al techo del heap,
    // aqui se ve antes de que el proceso muera sin explicacion.
    const mem = process.memoryUsage();
    const heapLimitMb = Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576);
    checks.proceso = {
      ok: true,
      pid: process.pid,
      uptimeSegundos: Math.round(process.uptime()),
      rssMb: Math.round(mem.rss / 1048576),
      heapUsadoMb: Math.round(mem.heapUsed / 1048576),
      heapTopeMb: heapLimitMb,
      node: process.version,
    };

    const problemas = Object.entries(checks)
      .filter(([, v]) => v && v.ok === false)
      .map(([k]) => k);

    res.json({
      success: true,
      data: {
        ok: problemas.length === 0,
        problemas,
        modeloActivo: getScanner().model,
        preferencias: runtime.all(),
        checks,
        timestamp: new Date().toISOString(),
      },
    });
  });

  router.get('/system/info', async (req, res) => {
    try {
      const mediaFiles = getMediaFiles();
      const collections = getCollections();

      // Verificar acceso a la carpeta
      let directoryExists = false;
      let directoryContent = [];

      try {
        await fs.access(CONTENT_DIR);
        directoryExists = true;
        directoryContent = await fs.readdir(CONTENT_DIR);
      } catch (error) {
        console.error('No se puede acceder a la carpeta:', error);
      }

      const videoCount = mediaFiles.filter(f => f.type === 'video').length;

      res.json({
        success: true,
        data: {
          contentDirectory: CONTENT_DIR,
          directoryExists,
          directoryItemCount: directoryContent.length,
          fileCount: mediaFiles.length,
          videoCount: videoCount,
          collectionCount: collections.length,
          serverTime: new Date(),
          supportedTypes: ['image', 'video', 'audio'],
          lastSync: mediaFiles.length > 0 ? 'OK' : 'Sin archivos encontrados',
          ffmpegEnabled: true
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Error obteniendo información del sistema',
        error: error.message
      });
    }
  });

  // ============================================
  // ESTADÍSTICAS
  // ============================================

  /**
   * GET /api/statistics
   * Estadísticas completas de la biblioteca
   */
  router.get('/statistics', (req, res) => {
    try {
      const mediaFiles = getMediaFiles();

      // Calcular estadísticas básicas
      // ⭐ HOTFIX v2.3: Defensas para file.size undefined
      const totalFiles = mediaFiles.length;
      const totalSize = mediaFiles.reduce((sum, file) => sum + (file?.size || 0), 0);

      // Estadísticas por tipo
      const videoFiles = mediaFiles.filter(f => f.type === 'video');
      const audioFiles = mediaFiles.filter(f => f.type === 'audio');
      const imageFiles = mediaFiles.filter(f => f.type === 'image');

      const videoCount = videoFiles.length;
      const videoSize = videoFiles.reduce((sum, file) => sum + (file?.size || 0), 0);

      const audioCount = audioFiles.length;
      const audioSize = audioFiles.reduce((sum, file) => sum + (file?.size || 0), 0);

      const imageCount = imageFiles.length;
      const imageSize = imageFiles.reduce((sum, file) => sum + (file?.size || 0), 0);

      // Archivos por año (basado en extractedDate o createdAt)
      const filesByYear = {};
      mediaFiles.forEach(file => {
        const date = file.extractedDate ? new Date(file.extractedDate) : new Date(file.createdAt);
        const year = date.getFullYear().toString();

        if (!filesByYear[year]) {
          filesByYear[year] = { year: year, count: 0 };
        }
        filesByYear[year].count++;
      });

      // Convertir a array y ordenar por año (del más antiguo al más nuevo)
      const yearsArray = Object.values(filesByYear)
        .sort((a, b) => parseInt(a.year) - parseInt(b.year)); // Orden ascendente por año

      // Top etiquetas
      const tagCount = {};
      mediaFiles.forEach(file => {
        file.tags.forEach(tag => {
          // Excluir fechas y años
          if (!/^\d{2}-\d{2}-\d{2}$/.test(tag) && !/^\d{4}$/.test(tag) &&
              !['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'].includes(tag)) {
            tagCount[tag] = (tagCount[tag] || 0) + 1;
          }
        });
      });

      const topTags = Object.entries(tagCount)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 20)
        .map(([tag, count]) => ({ tag, count }));

      // Datos por tipo para gráficos
      const filesByType = [
        { type: 'video', count: videoCount, size: videoSize },
        { type: 'audio', count: audioCount, size: audioSize },
        { type: 'image', count: imageCount, size: imageSize }
      ];

      // Actividad reciente (últimos 30 días)
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

      const recentActivity = [];
      for (let d = new Date(thirtyDaysAgo); d <= now; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        const dayFiles = mediaFiles.filter(f => {
          const createdDate = new Date(f.createdAt).toISOString().split('T')[0];
          const modifiedDate = new Date(f.modifiedAt).toISOString().split('T')[0];
          return createdDate === dateStr || modifiedDate === dateStr;
        });

        if (dayFiles.length > 0) {
          recentActivity.push({
            date: d.toLocaleDateString('es-ES', { month: 'short', day: 'numeric' }),
            uploads: dayFiles.filter(f => new Date(f.createdAt).toISOString().split('T')[0] === dateStr).length,
            modifications: dayFiles.filter(f => new Date(f.modifiedAt).toISOString().split('T')[0] === dateStr).length
          });
        }
      }

      console.log(`📊 Estadísticas calculadas: ${totalFiles} archivos, ${(totalSize / (1024*1024*1024)).toFixed(2)} GB`);

      res.json({
        success: true,
        data: {
          totalFiles,
          totalSize,
          videoCount,
          videoSize,
          audioCount,
          audioSize,
          imageCount,
          imageSize,
          filesByYear: yearsArray,
          filesByType,
          topTags,
          recentActivity: recentActivity.slice(-14) // Últimas 2 semanas
        }
      });

    } catch (error) {
      console.error('Error calculando estadísticas:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message
      });
    }
  });

  // ============================================
  // COLORES
  // ============================================

  /**
   * GET /api/colors
   * Paleta global de colores extraída de la biblioteca
   */
  router.get('/colors', (req, res) => {
    try {
      const mediaFiles = getMediaFiles();
      const globalPalette = colorAnalyzer.extractGlobalPalette(mediaFiles);

      res.json({
        success: true,
        data: {
          totalFiles: mediaFiles.length,
          filesWithColors: mediaFiles.filter(f => f.colorData).length,
          globalPalette: globalPalette,
          dominantColors: globalPalette.slice(0, 12) // Top 12 más comunes para el picker
        }
      });
    } catch (error) {
      console.error('Error obteniendo colores globales:', error);
      res.status(500).json({
        success: false,
        error: 'Error interno del servidor',
        message: error.message
      });
    }
  });

  // ============================================
  // GESTIÓN DE RUTAS DE ESCANEO (SCAN-PATHS)
  // ============================================

  /**
   * GET /api/scan-paths
   * Obtiene todas las rutas configuradas
   */
  router.get('/scan-paths', async (req, res) => {
    try {
      const paths = await rutasParaMostrar();
      // Enriquecer cada ruta con su cobertura, sobre la lista en memoria (live),
      // no sobre el fileCount persistido:
      //  - visualTotal: lo que el escaneo mira (audio y formatos raros fuera;
      //    antes contaban y salian como "faltan" para siempre).
      //  - visualScanned: de eso, lo que tiene descripcion.
      //  - pendientes: lo que le falta algun trabajo encendido AHORA en esa
      //    ruta (antes solo se contaban descripciones, asi que con las caras
      //    encendidas despues el boton de escanear salia apagado).
      const media = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
      // Normaliza para comparar prefijos en Windows: barras unificadas a "\",
      // minusculas y sin barra final.
      const norm = (s) => (s || '').replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
      const enriched = paths.map((p) => {
        const base = norm(p.path);
        const caps = escaneoConfig.deRuta(p);
        let visualTotal = 0;
        let visualScanned = 0;
        let pendientes = 0;
        if (base) {
          for (const f of media) {
            const fp = norm(f.fullPath);
            if (!fp || !(fp === base || fp.startsWith(base + '\\'))) continue;
            if (!scanOrchestrator.esEscaneable(f.name || f.fullPath)) continue;
            visualTotal++;
            if (typeof f.visual_description === 'string' && f.visual_description.trim()) {
              visualScanned++;
            }
            if (scanOrchestrator.archivoPendiente(f, caps)) pendientes++;
          }
        }
        return { ...p, visualTotal, visualScanned, pendientes, escaneoEfectivo: caps };
      });
      res.json({
        success: true,
        data: enriched
      });
    } catch (error) {
      console.error('❌ Error obteniendo rutas:', error);
      res.status(500).json({
        success: false,
        error: 'Error obteniendo rutas'
      });
    }
  });

  /**
   * POST /api/scan-paths
   * Añade una nueva ruta de escaneo, ya vinculada, y la sincroniza en segundo
   * plano (antes habia que añadir, vincular y sincronizar a mano).
   */
  router.post('/scan-paths', async (req, res) => {
    try {
      const paths = await loadScanPaths();
      const v = await validarCarpeta(req.body && req.body.path, paths);
      if (v.error) return res.status(v.status).json({ success: false, error: v.error, ...(v.extra || {}) });

      const newPathConfig = mediaIdentity.ensureScanPathSchema({
        id: crypto.randomBytes(8).toString('hex'),
        path: v.ruta,
        isActive: true,
        lastScan: null,
        fileCount: 0,
        status: 'connected',
        // El disco de esta biblioteca: si otro dia aparece en otra letra, se
        // reconoce (ver utils/volumen.js).
        ...(v.serie ? { volumen: v.serie } : {}),
      });

      paths.push(newPathConfig);
      await saveScanPaths(paths);
      console.log(`✅ Nueva ruta añadida: ${v.ruta}`);
      sincronizarLuego([newPathConfig.id]);

      res.json({ success: true, data: newPathConfig, sincronizando: true });
    } catch (error) {
      return responderFallo(res, 'añadir la ruta', error);
    }
  });

  /**
   * POST /api/scan-paths/:id/sync
   * Sincroniza una ruta. Es la MISMA sincronizacion que la completa, limitada a
   * esta biblioteca: nombres de carpeta, fecha, favoritos, archivos movidos...
   * Antes tenia su propio camino, que se saltaba todo eso (sus archivos
   * desaparecian de los filtros por año hasta reiniciar) y podia correr a la
   * vez que otra sincronizacion.
   */
  router.post('/scan-paths/:id/sync', async (req, res) => {
    try {
      const { id } = req.params;
      const paths = await loadScanPaths();
      const pathConfig = paths.find(p => p.id === id);
      if (!pathConfig) {
        return res.status(404).json({ success: false, error: 'Ruta no encontrada' });
      }

      try {
        await fs.access(pathConfig.path);
      } catch {
        return res.status(400).json({ success: false, error: 'La ruta no existe o no es accesible' });
      }

      // Sincronizar una ruta desvinculada es volver a vincularla.
      if (!pathConfig.isActive) {
        pathConfig.isActive = true;
        await saveScanPaths(paths);
      }

      console.log(`🔄 Sincronizando ruta: ${pathConfig.path}`);
      const r = await syncFiles({ soloIds: [id] });
      if (r && r.error) {
        return res.status(500).json({ success: false, error: `No se pudo sincronizar: ${r.error}` });
      }
      const estado = (r && r.porBiblioteca && r.porBiblioteca[id]) || null;
      if (estado && estado.status === 'otro_disco') {
        return res.status(409).json({ success: false, error: estado.lastError, sugerencia: estado.sugerencia });
      }
      if (estado && estado.status === 'disconnected') {
        return res.status(409).json({ success: false, error: estado.lastError || 'El disco se ha desconectado' });
      }
      const fileCount = estado ? estado.fileCount : null;
      res.json({
        success: true,
        fileCount,
        aviso: estado && estado.lastError ? estado.lastError : undefined,
        message: `${fileCount ?? 0} archivos sincronizados`,
        stats: r ? r.stats : undefined,
        reenlazados: r ? r.reenlazados : undefined,
      });
    } catch (error) {
      broadcastProgress({ type: 'sync_error', status: 'Error durante la sincronización', percentage: 0, error: error.message });
      return responderFallo(res, 'sincronizar la ruta', error);
    }
  });

  /**
   * PATCH /api/scan-paths/:id/toggle
   * Vincula o desvincula una ruta. El estado es el real (si el disco no esta,
   * "desconectada", no "conectada" por haberla vinculado) y la galeria se pone
   * al dia sola: antes lo desvinculado seguia a la vista hasta reiniciar, y lo
   * vinculado no aparecia hasta sincronizar a mano.
   */
  router.patch('/scan-paths/:id/toggle', async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body || {};
      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ success: false, error: 'isActive debe ser true o false' });
      }

      const paths = await loadScanPaths();
      const pathConfig = paths.find(p => p.id === id);
      if (!pathConfig) {
        return res.status(404).json({ success: false, error: 'Ruta no encontrada' });
      }

      pathConfig.isActive = isActive;
      const accesible = await fs.access(pathConfig.path).then(() => true).catch(() => false);
      pathConfig.status = isActive && accesible ? 'connected' : 'disconnected';

      await saveScanPaths(paths);
      console.log(`✅ Ruta ${isActive ? 'activada' : 'desactivada'}: ${pathConfig.path}`);
      sincronizarLuego([id]);

      res.json({ success: true, data: pathConfig, sincronizando: true });
    } catch (error) {
      return responderFallo(res, 'cambiar la ruta', error);
    }
  });

  /**
   * PATCH /api/scan-paths/:id
   * Edita una biblioteca CONSERVANDO su id (libraryId estable). Sirve para
   * REMAPEAR la raiz cuando cambia la letra de unidad o se mueve el disco:
   * D:\Fotos -> K:\Fotos. Como el libraryId no cambia y los relativePath de los
   * archivos siguen iguales, las mediaKey portables se conservan -> favoritos,
   * notas y colecciones NO se pierden. Ademas se lleva la cache, las
   * miniaturas y el indice visual a la ruta nueva (remapearBiblioteca), asi que
   * no se reindexa nada. Antes este endpoint existia pero ningun boton lo usaba.
   *
   * Body (todos opcionales): { path, displayName, role, isActive, escaneo, copiaSeguridad }
   */
  router.patch('/scan-paths/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { path: newPath, displayName, role, isActive, escaneo, copiaSeguridad } = req.body || {};

      const paths = await loadScanPaths();
      const pathConfig = paths.find(p => p.id === id);
      if (!pathConfig) {
        return res.status(404).json({ success: false, error: 'Biblioteca no encontrada' });
      }

      let remapeo = null;
      if (typeof newPath === 'string' && newPath.trim()) {
        // Mismas reglas que al añadir: ni repetida, ni dentro de otra, ni el
        // disco de OTRA biblioteca (serian dos bibliotecas para un disco).
        const v = await validarCarpeta(newPath, paths, id);
        if (v.error) return res.status(v.status).json({ success: false, error: v.error });
        const ruta = v.ruta;
        if (normRaiz(ruta) !== normRaiz(pathConfig.path)) {
          remapeo = { vieja: pathConfig.path, nueva: ruta };
          pathConfig.path = ruta;
          pathConfig.status = isActive === false ? 'disconnected' : 'connected';
          pathConfig.lastError = null;
          pathConfig.sugerencia = null;
          // El disco de la ruta nueva pasa a ser el de la biblioteca.
          const serie = await volumen.serialDe(ruta);
          if (serie) pathConfig.volumen = serie; else delete pathConfig.volumen;
          console.log(`🔀 Biblioteca remapeada (id estable ${id}): ${remapeo.vieja} -> ${ruta}`);
        }
      }

      if (typeof displayName === 'string') pathConfig.displayName = displayName.trim() || mediaIdentity.defaultLibraryDisplayName(pathConfig.path);
      if (typeof role === 'string' || role === null) pathConfig.role = role || null;
      if (typeof isActive === 'boolean') {
        pathConfig.isActive = isActive;
        const accesible = await fs.access(pathConfig.path).then(() => true).catch(() => false);
        pathConfig.status = isActive && accesible ? 'connected' : 'disconnected';
      }
      // Trabajos del escaneo propios de esta ruta: { caras: false } apaga,
      // { caras: null } vuelve a heredar del global.
      if (escaneo && typeof escaneo === 'object') {
        const propio = escaneoConfig.aplicarARuta(pathConfig, escaneo);
        if (Object.keys(propio).length > 0) pathConfig.escaneo = propio;
        else delete pathConfig.escaneo;
      }
      // Disco de copia de seguridad: sus copias exactas se esconden solas
      // mientras el original este conectado (ver services/copiasExactas.js).
      if (typeof copiaSeguridad === 'boolean') {
        if (copiaSeguridad) pathConfig.copiaSeguridad = true;
        else delete pathConfig.copiaSeguridad;
      }

      await saveScanPaths(paths);

      let movido = null;
      if (remapeo && typeof remapearBiblioteca === 'function') {
        try {
          movido = await remapearBiblioteca(id, remapeo.vieja, remapeo.nueva);
        } catch (err) {
          // La ruta ya esta cambiada: lo peor es reindexar. Se dice y se sigue.
          fallos.record('llevar la biblioteca a su nueva ubicacion', err, { path: remapeo.nueva });
        }
      }
      if (typeof alCambiarRutas === 'function') {
        try { await alCambiarRutas(); } catch (err) { fallos.record('aplicar el cambio de una ruta', err, {}); }
      }
      if (remapeo || typeof isActive === 'boolean') sincronizarLuego([id]);

      res.json({ success: true, data: pathConfig, movido, sincronizando: !!(remapeo || typeof isActive === 'boolean') });
    } catch (error) {
      return responderFallo(res, 'editar la biblioteca', error);
    }
  });

  /**
   * DELETE /api/scan-paths/:id
   * Quita una ruta (los archivos del disco no se tocan). Sus archivos salen de
   * la galeria al momento; antes seguian a la vista hasta reiniciar.
   */
  router.delete('/scan-paths/:id', async (req, res) => {
    try {
      const { id } = req.params;

      if (id === 'default') {
        return res.status(400).json({
          success: false,
          error: 'No se puede eliminar la ruta por defecto'
        });
      }

      const paths = await loadScanPaths();
      const index = paths.findIndex(p => p.id === id);

      if (index === -1) {
        return res.status(404).json({
          success: false,
          error: 'Ruta no encontrada'
        });
      }

      const removedPath = paths[index];
      paths.splice(index, 1);

      await saveScanPaths(paths);
      console.log(`🗑️ Ruta eliminada: ${removedPath.path}`);
      sincronizarLuego([id]);

      res.json({
        success: true,
        message: 'Ruta eliminada correctamente'
      });
    } catch (error) {
      return responderFallo(res, 'quitar la ruta', error);
    }
  });

  return router;
};
