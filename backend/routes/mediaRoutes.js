/**
 * Media Routes — Pensadero
 *
 * Rutas:
 * - /api/files/*   — CRUD de archivos y metadatos
 * - /api/sync      — Sincronización manual
 * - /api/tags/*    — Gestión de tags
 * - /api/stream/*  — Streaming con range requests
 * - /api/download/* — Descargas individuales y ZIP
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const mime = require('mime-types');
const archiver = require('archiver');
const { spawn } = require('child_process');
const fallos = require('../utils/failureReason');

const favoritesManager = require('../favoritesManager');
const etiquetasManuales = require('../services/etiquetasManuales');
const pathsConfig = require('../config/paths');
const videoProxyService = require('../services/videoProxyService');

// Cuantos videos de la misma carpeta se preparan por delante al abrir uno.
// Dos bastan para no alcanzar nunca a la cola pasando clips, y no convierten
// abrir un video en una tarea de fondo interminable.
const VECINOS_ADELANTADOS = 2;

/**
 * Prepara por detras los siguientes videos de la carpeta del que acabas de
 * abrir. Pasar de un clip al siguiente es lo que mas se hace en una sesion de
 * brutos, y es justo donde se notaba la espera.
 */
function adelantarVecinos(file, todos) {
  try {
    if (!file.fullPath) return;
    const carpeta = path.dirname(file.fullPath);
    const mismos = todos.filter(f => f.type === 'video' && f.fullPath && path.dirname(f.fullPath) === carpeta);
    mismos.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es', { numeric: true }));
    const i = mismos.findIndex(f => f.id === file.id);
    if (i === -1) return;
    for (const f of mismos.slice(i + 1, i + 1 + VECINOS_ADELANTADOS)) {
      videoProxyService.prewarm({ id: f.id, fullPath: f.fullPath, name: f.name });
    }
  } catch {
    // Adelantarse es un lujo: si falla, el video que has abierto va igual.
  }
}

/**
 * Sirve un fichero con soporte para Range requests (HTTP 206) y guardas de
 * stream. Extraido de /stream/:id para reutilizarlo tambien al servir proxies.
 */
async function streamFileWithRange(req, res, filePath, contentTypeOverride) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return res.status(404).json({ success: false, message: 'Archivo no encontrado' });
  }
  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = contentTypeOverride || mime.lookup(filePath) || 'application/octet-stream';

  const attachStreamGuards = (readStream) => {
    readStream.on('error', (streamErr) => {
      console.error(`❌ Error leyendo stream de ${path.basename(filePath)}:`, streamErr.message);
      if (!res.headersSent) res.status(500).json({ success: false, message: 'Error leyendo el archivo' });
      else res.destroy(streamErr);
    });
    res.on('close', () => readStream.destroy());
  };

  if (range) {
    const matches = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!matches) { res.set('Content-Range', `bytes */${fileSize}`); return res.status(416).end(); }
    let start = matches[1] === '' ? NaN : parseInt(matches[1], 10);
    let end = matches[2] === '' ? fileSize - 1 : parseInt(matches[2], 10);
    if (Number.isNaN(start) && !Number.isNaN(end)) { start = Math.max(0, fileSize - end); end = fileSize - 1; }
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;
    if (start > end || start >= fileSize) { res.set('Content-Range', `bytes */${fileSize}`); return res.status(416).end(); }

    const chunksize = (end - start) + 1;
    res.status(206);
    res.set({
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    });
    const readStream = fsSync.createReadStream(filePath, { start, end });
    attachStreamGuards(readStream);
    readStream.pipe(res);
  } else {
    res.set({ 'Content-Length': fileSize, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    const readStream = fsSync.createReadStream(filePath);
    attachStreamGuards(readStream);
    readStream.pipe(res);
  }
}

/**
 * Factory function que crea el router con las dependencias inyectadas
 * @param {Object} deps - Dependencias del servidor principal
 * @param {Function} deps.getMediaFiles - Función para obtener la lista de archivos
 * @param {Function} deps.setMediaFiles - Función para actualizar la lista de archivos
 * @param {Function} deps.getFileCache - Función para obtener el cache de archivos
 * @param {Function} deps.setFileCache - Función para actualizar el cache
 * @param {Function} deps.saveCache - Función para persistir el cache
 * @param {Function} deps.syncFiles - Función para sincronizar archivos
 * @param {Function} deps.broadcastProgress - Función para enviar progreso por WebSocket
 * @param {Function} deps.generateThumbnail - Función para generar thumbnails
 * @param {Function} deps.extractSmartTags - Función para extraer tags inteligentes
 * @param {string} deps.CONTENT_DIR - Directorio de contenido principal
 */
module.exports = function createMediaRoutes(deps) {
  const {
    getMediaFiles,
    setMediaFiles,
    getFileCache,
    setFileCache,
    saveCache,
    syncFiles,
    broadcastProgress,
    generateThumbnail,
    extractSmartTags,
    CONTENT_DIR
  } = deps;
  // Sin candado inyectado (pruebas, arranques viejos) se entrega todo.
  const getVisibles = typeof deps.getMediaFilesVisibles === 'function'
    ? deps.getMediaFilesVisibles
    : getMediaFiles;
  const getAbribles = typeof deps.getMediaFilesAbribles === 'function'
    ? deps.getMediaFilesAbribles
    : getVisibles;

  // ============================================
  // ARCHIVOS - CRUD Y METADATOS
  // ============================================

  /**
   * GET /api/files
   * Obtiene todos los archivos con favoritos aplicados
   */
  router.get('/files', async (req, res) => {
    try {
      const mediaFiles = getVisibles();
      console.log(`📡 Solicitud de archivos - ${mediaFiles.length} disponibles`);

      // Aplicar favoritos persistentes antes de devolver los archivos
      const filesWithFavorites = favoritesManager.applyFavoritesToFiles(mediaFiles);

      res.json({
        success: true,
        data: filesWithFavorites,
        count: filesWithFavorites.length,
        contentDir: CONTENT_DIR,
        favoritesStats: favoritesManager.getStats()
      });
    } catch (error) {
      console.error('Error obteniendo archivos:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message
      });
    }
  });

  /**
   * POST /api/sync
   * Sincroniza archivos manualmente
   */
  router.post('/sync', async (req, res) => {
    try {
      console.log('🔄 Sincronización manual solicitada');
      await syncFiles();
      const mediaFiles = getMediaFiles();
      const fileCache = getFileCache();
      res.json({
        success: true,
        message: 'Sincronización completada',
        count: mediaFiles.length,
        contentDir: CONTENT_DIR,
        cacheStats: {
          cached: fileCache.size,
          total: mediaFiles.length
        }
      });
    } catch (error) {
      console.error('Error durante sincronización:', error);
      res.status(500).json({
        success: false,
        message: 'Error durante la sincronización',
        error: error.message
      });
    }
  });

  /**
   * GET /api/files/:id
   * Obtiene un archivo específico por ID
   */
  router.get('/files/:id', (req, res) => {
    const mediaFiles = getAbribles();
    const file = mediaFiles.find(f => f.id === req.params.id);
    if (file) {
      res.json({ success: true, data: file });
    } else {
      res.status(404).json({ success: false, message: 'Archivo no encontrado' });
    }
  });

  // id -> fileData del cache persistente, construido perezosamente y rehecho
  // si el cache cambia de tamaño. Solo se usa cuando la lista en memoria no
  // tiene el archivo (arranque).
  let _porIdCache = null;
  let _tamCache = -1;
  const archivoEnCache = (fileId) => {
    const cache = typeof getFileCache === 'function' ? getFileCache() : null;
    if (!cache || typeof cache.values !== 'function') return null;
    if (!_porIdCache || _tamCache !== cache.size) {
      _porIdCache = new Map();
      for (const entrada of cache.values()) {
        const fd = entrada && entrada.fileData;
        if (fd && fd.id) _porIdCache.set(fd.id, fd);
      }
      _tamCache = cache.size;
    }
    return _porIdCache.get(fileId) || null;
  };

  // Placeholder SVG inline (gris) cuando no hay thumbnail servible.
  const svgPlaceholderMarkup = (label, name, bg) => {
    const shortName = (name || '').length > 25 ? (name || '').substring(0, 22) + '...' : (name || '');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="${bg}"/><text x="150" y="105" font-family="Arial" font-size="14" fill="white" text-anchor="middle" font-weight="bold">${label}</text><text x="150" y="135" font-family="Arial" font-size="10" fill="white" text-anchor="middle">${shortName}</text></svg>`;
  };

  /**
   * GET /api/thumbnails/:fileId
   * Sirve el thumbnail de un archivo resolviendo internamente su ubicacion en
   * disco a partir del fileId (sin aceptar rutas arbitrarias → sin path
   * traversal). Orden de resolucion:
   *   1) Destino por-carpeta: <dir-del-archivo>\.pensadero\thumbnails
   *   2) Compat: directorio legacy backend/thumbnails (mismo nombre)
   *   3) Generar bajo demanda en el destino nuevo
   *   4) Placeholder si todo falla (no rompe la UI)
   */
  router.get('/thumbnails/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    const sendPlaceholder = (label = 'Archivo', name = '', bg = '%23f3f4f6') => {
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(svgPlaceholderMarkup(label, name, bg));
    };
    try {
      // Durante la sincronizacion inicial la lista aun esta vacia, pero la
      // portada ya pide miniaturas: se buscan tambien en el cache de disco.
      const file = getMediaFiles().find(f => f.id === fileId) || archivoEnCache(fileId);
      if (!file || !file.fullPath) return sendPlaceholder('?', fileId, '%23999999');

      const newLoc = pathsConfig.resolveThumbnailLocation({ fullPath: file.fullPath, fileId, fileName: file.name });
      // legacy:true → ubicacion legacy (backend/thumbnails) con el mismo nombre.
      const legacyLoc = pathsConfig.resolveThumbnailLocation({ fullPath: file.fullPath, fileId, fileName: file.name, legacy: true });

      const serveIfExists = () => {
        for (const cand of [newLoc.thumbnailPath, legacyLoc.thumbnailPath]) {
          if (cand && fsSync.existsSync(cand)) {
            res.setHeader('Cache-Control', 'public, max-age=604800');
            res.sendFile(cand);
            return true;
          }
        }
        return false;
      };

      // 1) y 2): servir si ya existe (nuevo o legacy).
      if (serveIfExists()) return;

      // 3) generar bajo demanda en el destino nuevo.
      const result = await generateThumbnail(file.fullPath, fileId, file.name);
      // Placeholder inline (audio/error): servir el SVG decodificado.
      if (typeof result === 'string' && result.startsWith('data:')) {
        const svg = decodeURIComponent(result.substring(result.indexOf(',') + 1));
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(svg);
      }
      if (serveIfExists()) return;
      return sendPlaceholder('Archivo', file.name);
    } catch (error) {
      console.error('Error sirviendo thumbnail:', error.message);
      return sendPlaceholder('Error', fileId, '%23fee2e2');
    }
  });

  /**
   * POST /api/files/:id/open-path
   * Abre el explorador de archivos con el archivo seleccionado
   */
  router.post('/files/:id/open-path', async (req, res) => {
    try {
      const mediaFiles = getMediaFiles();
      const file = mediaFiles.find(f => f.id === req.params.id);

      if (!file) {
        return res.status(404).json({
          success: false,
          error: 'Archivo no encontrado'
        });
      }

      const filePath = file.fullPath;
      console.log(`📂 Abriendo archivo seleccionado: ${filePath}`);

      // Sin consola de comandos de por medio: antes era `exec` con la ruta
      // metida en el texto del comando, y un % o un & en el nombre de un
      // archivo cambiaba lo que se ejecutaba. explorer necesita las comillas
      // pegadas a /select, asi que en Windows la linea se pasa tal cual
      // (una ruta de Windows no puede llevar comillas).
      let programa, args, opciones = {};
      if (process.platform === 'win32') {
        programa = 'explorer.exe';
        args = [`/select,"${filePath}"`];
        opciones = { windowsVerbatimArguments: true };
      } else if (process.platform === 'darwin') {
        programa = 'open';
        args = ['-R', filePath];
      } else {
        programa = 'xdg-open';
        args = [path.dirname(filePath)];
      }

      // explorer termina con codigo 1 aunque abra bien: solo cuenta si se pudo lanzar.
      const hijo = spawn(programa, args, { ...opciones, detached: true, stdio: 'ignore' });
      hijo.once('error', (error) => {
        const causa = fallos.record('abrir la carpeta del archivo', error, { path: filePath });
        res.status(500).json({ success: false, error: `No se ha podido abrir la carpeta. ${causa.reason}` });
      });
      hijo.once('spawn', () => {
        hijo.unref();
        res.json({ success: true, path: filePath });
      });

    } catch (error) {
      console.error('❌ Error en endpoint open-path:', error);
      res.status(500).json({
        success: false,
        error: 'Error interno del servidor'
      });
    }
  });

  /**
   * PATCH /api/files/:id
   * Actualiza un archivo (tags, favorito, descripción)
   */
  router.patch('/files/:id', async (req, res) => {
    try {
      const mediaFiles = getMediaFiles();
      const fileIndex = mediaFiles.findIndex(f => f.id === req.params.id);

      if (fileIndex === -1) {
        console.log(`⚠️ Intento de actualizar archivo inexistente: ${req.params.id}`);
        return res.status(404).json({
          success: false,
          message: 'Archivo no encontrado'
        });
      }

      const allowedFields = ['isFavorite', 'tags', 'description'];
      const updates = {};

      for (const field of allowedFields) {
        if (req.body.hasOwnProperty(field)) {
          updates[field] = req.body[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No hay campos válidos para actualizar. Campos permitidos: ' + allowedFields.join(', ')
        });
      }

      const fileId = req.params.id;
      const file = mediaFiles[fileIndex];
      let favoriteMetadata = null;

      if (updates.hasOwnProperty('isFavorite')) {
        // Clave canonica para favoritos = fullPath normalizado (alineado con frontend).
        const favoriteKey = file.fullPath || file.path || file.name;

        if (updates.isFavorite) {
          await favoritesManager.addFavorite(favoriteKey, favoriteKey);
          console.log(`❤️ Archivo ${fileId} marcado como favorito persistentemente`);

          const favoriteData = favoritesManager.getFavorite(favoriteKey);
          if (favoriteData) {
            favoriteMetadata = {
              addedAt: favoriteData.addedAt,
              lastModified: favoriteData.lastModified
            };
          }
        } else {
          await favoritesManager.removeFavorite(favoriteKey);
          console.log(`💔 Archivo ${fileId} eliminado de favoritos persistentemente`);
        }
      }

      // Las etiquetas se guardan como lo que cambia respecto a las que tenia
      // (services/etiquetasManuales.js): asignarlas sin mas se perdia en la
      // siguiente sincronizacion, porque la cache no guarda esta copia.
      if (Array.isArray(updates.tags)) {
        const nuevas = updates.tags.filter(t => typeof t === 'string');
        const antes = Array.isArray(file.tags) ? file.tags : [];
        await etiquetasManuales.cambiar([file], {
          anadir: nuevas.filter(t => !antes.includes(t)),
          quitar: antes.filter(t => !nuevas.includes(t)),
        });
        delete updates.tags;
      }

      mediaFiles[fileIndex] = {
        ...mediaFiles[fileIndex],
        ...updates
      };

      const response = {
        success: true,
        data: mediaFiles[fileIndex]
      };

      if (favoriteMetadata) {
        response.favoriteMetadata = favoriteMetadata;
      }

      res.json(response);

    } catch (error) {
      console.error('❌ Error actualizando archivo:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // ============================================
  // TAGS
  // ============================================

  /**
   * GET /api/tags
   * Obtiene todos los tags únicos disponibles
   */
  router.get('/tags', (req, res) => {
    const mediaFiles = getVisibles();
    const allTags = [];
    const tagCounts = new Map(); // recuento de uso para topTags
    const years = new Set();
    const months = new Set();
    // Años, meses y rango salen de la fecha UNICA de cada archivo (`fechaDia`,
    // utils/fechaArchivo.js), no de las etiquetas: lo fechado por la camara o
    // por el disco no lleva etiqueta de año, y los años 19xx no casaban con
    // /^20\d{2}$/. Asi la lista coincide con lo que filtra /api/search.
    const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    let diaMin = 0;
    let diaMax = 0;
    let conFecha = 0;

    mediaFiles.forEach(file => {
      (file.tags || []).forEach(tag => {
        allTags.push(tag);
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      });

      const dia = Number(file.fechaDia) || 0;
      if (dia) {
        conFecha++;
        years.add(String(Math.floor(dia / 10000)));
        const mes = Math.floor(dia / 100) % 100;
        if (mes >= 1 && mes <= 12) months.add(mes);
        if (!diaMin || dia < diaMin) diaMin = dia;
        if (dia > diaMax) diaMax = dia;
      }
    });
    // 'AAAA-MM-DD', que es lo que entiende un <input type="date"> como min/max.
    const aTexto = (d) => `${Math.floor(d / 10000)}-${String(Math.floor(d / 100) % 100).padStart(2, '0')}-${String(d % 100).padStart(2, '0')}`;

    const uniqueTags = [...new Set(allTags)].sort();

    // Top 12 tags más usadas (excluyendo años/meses para que sean
    // descubrimientos útiles, no obviedades de fecha).
    const monthsSpanishLower = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const topTags = [...tagCounts.entries()]
      .filter(([tag]) => !/^(19|20)\d{2}$/.test(tag) && !monthsSpanishLower.includes(tag.toLowerCase()))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([tag, count]) => ({ tag, count }));

    res.json({
      success: true,
      data: {
        allTags: uniqueTags,
        topTags,
        years: Array.from(years).sort(),
        months: Array.from(months).sort((a, b) => a - b).map(m => MESES[m - 1]),
        dateRange: diaMin ? { earliest: aTexto(diaMin), latest: aTexto(diaMax) } : null,
        totalFiles: mediaFiles.length,
        filesWithDates: conFecha
      }
    });
  });

  /**
   * POST /api/tags/bulk-update
   * Actualización masiva de tags
   */
  router.post('/tags/bulk-update', async (req, res) => {
    try {
      const { fileIds, addTags = [], removeTags = [] } = req.body;
      const mediaFiles = getMediaFiles();

      if (!fileIds || !Array.isArray(fileIds)) {
        return res.status(400).json({
          success: false,
          message: 'fileIds debe ser un array de IDs de archivos'
        });
      }

      // Antes se cambiaba solo la copia en memoria y se guardaba la cache, que
      // no la contiene: la siguiente sincronizacion lo deshacia todo. Ahora el
      // cambio se apunta aparte y se vuelve a poner encima de lo derivado en
      // cada sincronizacion (services/etiquetasManuales.js).
      const pedidos = new Set(fileIds);
      const afectados = mediaFiles.filter(file => pedidos.has(file.id));
      const updatedCount = await etiquetasManuales.cambiar(afectados, {
        anadir: Array.isArray(addTags) ? addTags : [],
        quitar: Array.isArray(removeTags) ? removeTags : [],
      });

      console.log(`✅ Tags actualizados: ${updatedCount} archivos, removidos: [${removeTags.join(', ')}], añadidos: [${addTags.join(', ')}]`);

      res.json({
        success: true,
        data: {
          updatedFiles: updatedCount,
          removedTags: removeTags,
          addedTags: addTags
        }
      });

    } catch (error) {
      console.error('❌ Error en bulk-update de tags:', error);
      res.status(500).json({
        success: false,
        message: 'Error actualizando tags: ' + error.message
      });
    }
  });

  // ============================================
  // STREAMING DE VIDEO
  // ============================================

  /**
   * GET /api/stream/:id
   * Streaming de archivos multimedia con soporte para range requests
   */
  router.get('/stream/:id', async (req, res) => {
    try {
      const mediaFiles = getMediaFiles();
      const fileId = req.params.id;
      const file = mediaFiles.find(f => f.id === fileId);

      if (!file) {
        console.log(`❌ Archivo no encontrado para streaming con ID: ${fileId}`);
        return res.status(404).json({
          success: false,
          message: 'Archivo no encontrado'
        });
      }

      const filePath = file.fullPath || path.join(CONTENT_DIR, file.path);

      try {
        await fs.access(filePath);
      } catch (error) {
        console.log(`❌ Archivo físico no encontrado: ${filePath}`);
        return res.status(404).json({
          success: false,
          message: 'Archivo no encontrado en el sistema de archivos'
        });
      }

      console.log(`🎬 Streaming archivo: ${file.name}`);

      const stat = await fs.stat(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      const contentType = mime.lookup(filePath) || 'application/octet-stream';

      // pipe() NO propaga errores del origen. Sin un listener 'error' en el
      // readStream, un fallo de disco a mitad de stream (p.ej. un disco externo
      // desconectado durante la reproduccion) lanza una excepcion no capturada
      // que tumba el proceso Node entero. Este guard lo convierte en un 500/abort
      // limpio y, ademas, libera el descriptor si el cliente corta la conexion.
      const attachStreamGuards = (readStream) => {
        readStream.on('error', (streamErr) => {
          console.error(`❌ Error leyendo stream de ${file.name}:`, streamErr.message);
          if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Error leyendo el archivo' });
          } else {
            res.destroy(streamErr);
          }
        });
        res.on('close', () => readStream.destroy());
      };

      if (range) {
        // Parsear y VALIDAR el Range. Un Range malformado o fuera de rango debe
        // responder 416 (Range Not Satisfiable), no NaN ni un stream corrupto.
        const matches = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!matches) {
          res.set('Content-Range', `bytes */${fileSize}`);
          return res.status(416).end();
        }
        let start = matches[1] === '' ? NaN : parseInt(matches[1], 10);
        let end = matches[2] === '' ? fileSize - 1 : parseInt(matches[2], 10);
        // Suffix range "bytes=-N" → ultimos N bytes
        if (Number.isNaN(start) && !Number.isNaN(end)) {
          start = Math.max(0, fileSize - end);
          end = fileSize - 1;
        }
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;
        if (start > end || start >= fileSize) {
          res.set('Content-Range', `bytes */${fileSize}`);
          return res.status(416).end();
        }

        const chunksize = (end - start) + 1;
        res.status(206);
        res.set({
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': contentType
        });

        const readStream = fsSync.createReadStream(filePath, { start, end });
        attachStreamGuards(readStream);
        readStream.pipe(res);
      } else {
        res.set({
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes'
        });

        const readStream = fsSync.createReadStream(filePath);
        attachStreamGuards(readStream);
        readStream.pipe(res);
      }

    } catch (error) {
      console.error('Error en streaming:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message
      });
    }
  });

  // ============================================
  // PROXIES DE REPRODUCCION (formatos no nativos)
  // ============================================

  /**
   * GET /api/media/:id/playable
   * Estado de reproduccion de un video. Devuelve { status, url, ... }:
   *  - native    -> reproducir directo el original (url = /api/stream/:id)
   *  - ready     -> proxy listo (url = /api/media/:id/proxy)
   *  - generating-> proxy en cola/generandose (el front reconsulta)
   *  - error     -> no se pudo (el front ofrece descargar el original)
   * ?forzar=1: preparar version ligera aunque parezca nativo (el navegador no
   * pudo abrir el original).
   * ?sinPreparar=1: devolver lo que haya ahora, sin encolar nada (la portada).
   */
  router.get('/media/:id/playable', async (req, res) => {
    const file = getMediaFiles().find(f => f.id === req.params.id);
    if (!file) return res.status(404).json({ success: false, message: 'Archivo no encontrado' });
    const fullPath = file.fullPath || path.join(CONTENT_DIR, file.path);
    try {
      const sinPreparar = req.query.sinPreparar === '1';
      const data = await videoProxyService.getPlayable(
        { id: file.id, fullPath, name: file.name },
        { forzar: req.query.forzar === '1', sinPreparar },
      );
      res.json({ success: true, data });
      // Quien pide "lo que haya" tampoco quiere que se preparen los vecinos.
      if (!sinPreparar) adelantarVecinos({ ...file, fullPath }, getMediaFiles());
    } catch (err) {
      console.error('Error en /playable:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  /**
   * GET /api/media/:id/proxy
   * Sirve el MP4 proxy web-compatible (con range/seek). 404 si aun no esta listo.
   */
  router.get('/media/:id/proxy', async (req, res) => {
    const file = getMediaFiles().find(f => f.id === req.params.id);
    if (!file) return res.status(404).json({ success: false, message: 'Archivo no encontrado' });
    const fullPath = file.fullPath || path.join(CONTENT_DIR, file.path);
    const proxyPath = await videoProxyService.getReadyProxyPath({ id: file.id, fullPath });
    if (!proxyPath) return res.status(404).json({ success: false, message: 'Proxy no disponible todavia' });
    await streamFileWithRange(req, res, proxyPath, 'video/mp4');
  });

  // ============================================
  // DESCARGAS
  // ============================================

  /**
   * GET /api/download/:id
   * Descarga un archivo individual
   */
  router.get('/download/:id', async (req, res) => {
    try {
      const mediaFiles = getMediaFiles();
      const fileId = req.params.id;
      const file = mediaFiles.find(f => f.id === fileId);

      if (!file) {
        console.log(`❌ Archivo no encontrado con ID: ${fileId}`);
        return res.status(404).json({
          success: false,
          message: 'Archivo no encontrado'
        });
      }

      const filePath = file.fullPath || path.join(CONTENT_DIR, file.path);

      try {
        await fs.access(filePath);
      } catch (error) {
        console.log(`❌ Archivo físico no encontrado para descarga: ${filePath}`);
        return res.status(404).json({
          success: false,
          message: 'Archivo no encontrado en el sistema de archivos'
        });
      }

      console.log(`📥 Descargando archivo: ${file.name}`);

      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');

      res.sendFile(path.resolve(filePath), (err) => {
        if (err) {
          console.error('Error enviando archivo:', err);
          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              message: 'Error descargando el archivo',
              error: err.message
            });
          }
        } else {
          console.log(`✅ Archivo descargado exitosamente: ${file.name}`);
        }
      });

    } catch (error) {
      console.error('Error en descarga:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: error.message
      });
    }
  });

  /**
   * Los archivos que pide una descarga ZIP y cuales estan en disco ahora.
   * `fileIds` llega como array (JSON) o como texto JSON (formulario).
   */
  async function archivosParaZip(fileIdsCrudos) {
    let fileIds = fileIdsCrudos;
    if (typeof fileIds === 'string') {
      try { fileIds = JSON.parse(fileIds); } catch { fileIds = fileIds.split(','); }
    }
    if (!Array.isArray(fileIds)) fileIds = [];
    const porId = new Map(getMediaFiles().map(f => [f.id, f]));
    const pedidos = fileIds.map(id => porId.get(id)).filter(Boolean);
    const disponibles = [];
    for (const file of pedidos) {
      const filePath = file.fullPath || path.join(CONTENT_DIR, file.path);
      try {
        await fs.access(filePath);
        disponibles.push({ ...file, fullPath: filePath });
      } catch { /* disco desconectado o archivo movido: no entra */ }
    }
    return { total: fileIds.length, disponibles };
  }

  /**
   * POST /api/download/zip/comprobar  body { fileIds }
   * Cuantos de esos archivos iran en el ZIP. La descarga en si va por un
   * formulario (el navegador la guarda en disco mientras llega) y un fallo
   * alli no se ve: se comprueba antes para poder decirlo.
   */
  router.post('/download/zip/comprobar', async (req, res) => {
    try {
      const { total, disponibles } = await archivosParaZip((req.body || {}).fileIds);
      res.json({ success: true, data: { total, disponibles: disponibles.length } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/download/zip   body { fileIds, nombre? } (JSON o formulario)
   * Descarga varios archivos como un ZIP que se va enviando segun se crea.
   * Sin comprimir: video y fotos ya van comprimidos y comprimirlos otra vez
   * (antes a nivel 9) solo gastaba CPU y tiempo sin ganar espacio.
   */
  router.post('/download/zip', async (req, res) => {
    try {
      const { total, disponibles } = await archivosParaZip((req.body || {}).fileIds);
      if (total === 0) {
        return res.status(400).json({ success: false, message: 'Se requiere un array de IDs de archivos' });
      }
      if (disponibles.length === 0) {
        return res.status(404).json({ success: false, message: 'Ningún archivo está disponible físicamente' });
      }
      console.log(`📦 ZIP con ${disponibles.length} de ${total} archivos pedidos`);

      // Nombre del ZIP: el que pida la pantalla (el de la colección), sin
      // caracteres que Windows no admite.
      const base = String((req.body || {}).nombre || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80)
        || `archivos_${new Date().toISOString().split('T')[0]}`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(base)}.zip"; filename*=UTF-8''${encodeURIComponent(base)}.zip`);

      const archive = archiver('zip', { store: true });
      archive.on('warning', (err) => console.warn('Aviso creando ZIP:', err.message));
      archive.on('error', (err) => {
        console.error('Error creando ZIP:', err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: 'Error creando archivo ZIP', error: err.message });
        } else {
          res.destroy(err);
        }
      });
      // Si se cancela la descarga, dejar de leer los archivos.
      res.on('close', () => { if (!res.writableFinished) archive.abort(); });
      archive.pipe(res);

      // Dos archivos con el mismo nombre (IMG_0001.JPG de dos moviles) no
      // pueden ir con el mismo nombre: al descomprimir uno pisaria al otro.
      const usados = new Map();
      for (const file of disponibles) {
        const clave = file.name.toLowerCase();
        const n = (usados.get(clave) || 0) + 1;
        usados.set(clave, n);
        const ext = path.extname(file.name);
        const nombre = n === 1 ? file.name : `${path.basename(file.name, ext)} (${n})${ext}`;
        archive.file(file.fullPath, { name: nombre });
      }
      await archive.finalize();
    } catch (error) {
      console.error('Error en descarga ZIP:', error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error interno del servidor', error: error.message });
      }
    }
  });

  // ============================================
  // (Eliminado) REMOVE BACKGROUND — el servicio backgroundRemovalService
  // se ha quitado en la migración a Pensadero.
  // ============================================

  return router;
};
