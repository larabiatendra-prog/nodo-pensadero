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
const { exec } = require('child_process');

const favoritesManager = require('../favoritesManager');

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

  // ============================================
  // ARCHIVOS - CRUD Y METADATOS
  // ============================================

  /**
   * GET /api/files
   * Obtiene todos los archivos con favoritos aplicados
   */
  router.get('/files', async (req, res) => {
    try {
      const mediaFiles = getMediaFiles();
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
    const mediaFiles = getMediaFiles();
    const file = mediaFiles.find(f => f.id === req.params.id);
    if (file) {
      res.json({ success: true, data: file });
    } else {
      res.status(404).json({ success: false, message: 'Archivo no encontrado' });
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

      let command;
      const platform = process.platform;

      if (platform === 'win32') {
        command = `explorer /select,"${filePath}"`;
      } else if (platform === 'darwin') {
        command = `open -R "${filePath}"`;
      } else {
        command = `nautilus --select "${filePath}" || xdg-open "${path.dirname(filePath)}"`;
      }

      exec(command, (error, stdout, stderr) => {
        if (error && error.code !== 0 && !error.message.includes('Command failed: explorer /select')) {
          console.error(`❌ Error abriendo carpeta: ${error.message}`);
          return res.status(500).json({
            success: false,
            error: 'Error al abrir la carpeta'
          });
        }

        if (stderr && error) {
          console.warn(`⚠️  Advertencia al ejecutar comando: ${stderr}`);
        }

        console.log(`✅ Archivo seleccionado exitosamente: ${filePath}`);
        res.json({
          success: true,
          message: 'Archivo seleccionado exitosamente',
          path: filePath
        });
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
        const filePath = file.path || file.name;

        if (updates.isFavorite) {
          await favoritesManager.addFavorite(fileId, filePath);
          console.log(`❤️ Archivo ${fileId} marcado como favorito persistentemente`);

          const favoriteData = favoritesManager.getAllFavorites().find(f => f.fileId === fileId);
          if (favoriteData) {
            favoriteMetadata = {
              addedAt: favoriteData.addedAt,
              lastModified: favoriteData.lastModified
            };
          }
        } else {
          await favoritesManager.removeFavorite(fileId);
          console.log(`💔 Archivo ${fileId} eliminado de favoritos persistentemente`);
        }
      }

      mediaFiles[fileIndex] = {
        ...mediaFiles[fileIndex],
        ...updates
      };

      await saveCache();

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
    const mediaFiles = getMediaFiles();
    const allTags = [];
    const tagCounts = new Map(); // recuento de uso para topTags
    const years = new Set();
    const months = new Set();
    const dates = [];

    mediaFiles.forEach(file => {
      file.tags.forEach(tag => {
        allTags.push(tag);
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);

        if (/^20\d{2}$/.test(tag)) {
          years.add(tag);
        }

        const monthsSpanish = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
          'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
        if (monthsSpanish.includes(tag.toLowerCase())) {
          months.add(tag);
        }
      });

      if (file.extractedDate) {
        dates.push({
          date: file.extractedDate,
          filename: file.name
        });
      }
    });

    const uniqueTags = [...new Set(allTags)].sort();

    // Top 12 tags más usadas (excluyendo años/meses para que sean
    // descubrimientos útiles, no obviedades de fecha).
    const monthsSpanishLower = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const topTags = [...tagCounts.entries()]
      .filter(([tag]) => !/^20\d{2}$/.test(tag) && !monthsSpanishLower.includes(tag.toLowerCase()))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([tag, count]) => ({ tag, count }));

    res.json({
      success: true,
      data: {
        allTags: uniqueTags,
        topTags,
        years: Array.from(years).sort(),
        months: Array.from(months),
        dateRange: dates.length > 0 ? {
          earliest: new Date(Math.min(...dates.map(d => new Date(d.date)))),
          latest: new Date(Math.max(...dates.map(d => new Date(d.date))))
        } : null,
        totalFiles: mediaFiles.length,
        filesWithDates: dates.length
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

      let updatedCount = 0;

      mediaFiles.forEach(file => {
        if (fileIds.includes(file.id)) {
          if (removeTags.length > 0) {
            file.tags = file.tags.filter(tag => !removeTags.includes(tag));
          }

          if (addTags.length > 0) {
            addTags.forEach(newTag => {
              if (!file.tags.includes(newTag)) {
                file.tags.push(newTag);
              }
            });
          }

          updatedCount++;
        }
      });

      await saveCache();

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

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;

        res.status(206);
        res.set({
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': mime.lookup(filePath) || 'application/octet-stream'
        });

        const readStream = fsSync.createReadStream(filePath, { start, end });
        readStream.pipe(res);
      } else {
        res.set({
          'Content-Length': fileSize,
          'Content-Type': mime.lookup(filePath) || 'application/octet-stream',
          'Accept-Ranges': 'bytes'
        });

        const readStream = fsSync.createReadStream(filePath);
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
   * POST /api/download/zip
   * Descarga múltiples archivos como ZIP
   */
  router.post('/download/zip', async (req, res) => {
    try {
      const mediaFiles = getMediaFiles();
      const { fileIds } = req.body;

      if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Se requiere un array de IDs de archivos'
        });
      }

      console.log(`📦 Creando ZIP con ${fileIds.length} archivos:`, fileIds);

      const files = fileIds.map(id => mediaFiles.find(f => f.id === id)).filter(Boolean);

      if (files.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No se encontraron archivos válidos'
        });
      }

      const existingFiles = [];
      for (const file of files) {
        try {
          const filePath = file.fullPath || path.join(CONTENT_DIR, file.path);
          await fs.access(filePath);
          existingFiles.push({ ...file, fullPath: filePath });
          console.log(`✅ Archivo encontrado: ${file.name} en ${filePath}`);
        } catch (error) {
          const attemptedPath = file.fullPath || path.join(CONTENT_DIR, file.path);
          console.warn(`⚠️ Archivo no encontrado: ${file.name} en ${attemptedPath}`);
        }
      }

      if (existingFiles.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Ningún archivo está disponible físicamente'
        });
      }

      const zipFilename = `archivos_${new Date().toISOString().split('T')[0]}_${Date.now()}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

      const archive = archiver('zip', {
        zlib: { level: 9 }
      });

      archive.on('error', (err) => {
        console.error('Error creando ZIP:', err);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error creando archivo ZIP',
            error: err.message
          });
        }
      });

      archive.pipe(res);

      let filesAdded = 0;
      for (const file of existingFiles) {
        try {
          archive.file(file.fullPath, { name: file.name });
          filesAdded++;
          console.log(`📄 Añadido al ZIP: ${file.name}`);
        } catch (error) {
          console.warn(`⚠️ Error añadiendo ${file.name} al ZIP:`, error);
        }
      }

      if (filesAdded === 0) {
        return res.status(500).json({
          success: false,
          message: 'No se pudieron añadir archivos al ZIP'
        });
      }

      console.log(`✅ ZIP creado con ${filesAdded} archivos de ${files.length} solicitados`);

      await archive.finalize();

    } catch (error) {
      console.error('Error en descarga ZIP:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Error interno del servidor',
          error: error.message
        });
      }
    }
  });

  // ============================================
  // (Eliminado) REMOVE BACKGROUND — el servicio backgroundRemovalService
  // se ha quitado en la migración a Pensadero.
  // ============================================

  return router;
};
