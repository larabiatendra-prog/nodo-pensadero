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

/**
 * Factory function que crea el router con las dependencias inyectadas
 * @param {Object} deps - Dependencias del servidor principal
 * @param {Function} deps.getMediaFiles - Obtiene la lista de archivos
 * @param {Function} deps.setMediaFiles - Establece la lista de archivos
 * @param {Function} deps.getCollections - Obtiene las colecciones
 * @param {Function} deps.broadcastProgress - Broadcast WebSocket
 * @param {Function} deps.saveCache - Guarda el cache de archivos
 * @param {Function} deps.scanDirectory - Escanea un directorio
 * @param {Function} deps.countMediaFiles - Cuenta archivos multimedia
 * @param {Function} deps.generateThumbnail - Genera thumbnail de archivos multimedia
 * @param {string} deps.CONTENT_DIR - Directorio de contenido principal
 */
module.exports = function createSystemRoutes(deps) {
  const {
    getMediaFiles,
    setMediaFiles,
    getCollections,
    broadcastProgress,
    saveCache,
    scanDirectory,
    countMediaFiles,
    generateThumbnail,
    CONTENT_DIR
  } = deps;

  // Archivo para persistir configuración de rutas
  const PATHS_CONFIG_FILE = path.join(__dirname, '..', 'scan_paths.json');

  // ============================================
  // FUNCIONES AUXILIARES PARA SCAN-PATHS
  // ============================================

  /**
   * Cargar configuración de rutas
   */
  async function loadScanPaths() {
    try {
      if (await fs.access(PATHS_CONFIG_FILE).then(() => true).catch(() => false)) {
        const data = await fs.readFile(PATHS_CONFIG_FILE, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.warn('⚠️ Error cargando rutas:', error.message);
    }

    // Configuración por defecto
    const mediaFiles = getMediaFiles();
    return [{
      id: 'default',
      path: CONTENT_DIR,
      isActive: true,
      lastScan: new Date().toISOString(),
      fileCount: mediaFiles.length,
      status: 'connected'
    }];
  }

  /**
   * Guardar configuración de rutas
   */
  async function saveScanPaths(paths) {
    try {
      await fs.writeFile(PATHS_CONFIG_FILE, JSON.stringify(paths, null, 2));
      console.log(`💾 Configuración de rutas guardada`);
    } catch (error) {
      console.error('❌ Error guardando rutas:', error.message);
    }
  }

  // ============================================
  // INFORMACIÓN DEL SISTEMA
  // ============================================

  /**
   * GET /api/system/info
   * Información del sistema y diagnóstico
   */
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
      const paths = await loadScanPaths();
      res.json({
        success: true,
        data: paths
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
   * Añade una nueva ruta de escaneo
   */
  router.post('/scan-paths', async (req, res) => {
    try {
      const { path: newPath } = req.body;

      if (!newPath) {
        return res.status(400).json({
          success: false,
          error: 'La ruta es requerida'
        });
      }

      // Verificar que la ruta existe
      try {
        await fs.access(newPath);
      } catch {
        return res.status(400).json({
          success: false,
          error: 'La ruta no existe o no es accesible'
        });
      }

      const paths = await loadScanPaths();

      // Verificar que no existe ya
      if (paths.some(p => p.path === newPath)) {
        return res.status(400).json({
          success: false,
          error: 'La ruta ya está configurada'
        });
      }

      const newPathConfig = {
        id: crypto.randomBytes(8).toString('hex'),
        path: newPath,
        isActive: false,
        lastScan: null,
        fileCount: 0,
        status: 'disconnected'
      };

      paths.push(newPathConfig);
      await saveScanPaths(paths);

      console.log(`✅ Nueva ruta añadida: ${newPath}`);

      res.json({
        success: true,
        data: newPathConfig
      });
    } catch (error) {
      console.error('❌ Error añadiendo ruta:', error);
      res.status(500).json({
        success: false,
        error: 'Error añadiendo ruta'
      });
    }
  });

  /**
   * POST /api/scan-paths/:id/sync
   * Sincroniza una ruta específica
   */
  router.post('/scan-paths/:id/sync', async (req, res) => {
    try {
      const { id } = req.params;
      const paths = await loadScanPaths();
      const pathConfig = paths.find(p => p.id === id);

      if (!pathConfig) {
        return res.status(404).json({
          success: false,
          error: 'Ruta no encontrada'
        });
      }

      console.log(`🔄 Sincronizando ruta: ${pathConfig.path}`);

      // Verificar que la ruta existe
      try {
        await fs.access(pathConfig.path);
      } catch {
        return res.status(400).json({
          success: false,
          error: 'La ruta no existe o no es accesible'
        });
      }

      // Enviar progreso inicial
      broadcastProgress({
        type: 'sync_start',
        status: `Escaneando ${pathConfig.path}...`,
        percentage: 0
      });

      // Contar archivos primero
      const totalFiles = await countMediaFiles(pathConfig.path);
      console.log(`📊 Total de archivos multimedia en ${pathConfig.path}: ${totalFiles}`);

      // Escanear archivos de esta ruta específica
      const scanResult = await scanDirectory(pathConfig.path, pathConfig.path, totalFiles, 0);

      // Procesar miniaturas para videos nuevos
      let videoCount = 0;
      for (const file of scanResult.files) {
        if (file.type === 'video' && !file.thumbnail) {
          videoCount++;
          broadcastProgress({
            type: 'sync_progress',
            status: `Generando miniatura para video ${videoCount}...`,
            percentage: Math.round((videoCount / scanResult.files.length) * 100)
          });

          try {
            const thumbnailPath = await generateThumbnail(file.fullPath, file.id, file.name);
            file.thumbnail = `/thumbnails/${path.basename(thumbnailPath)}`;
          } catch (error) {
            console.error(`Error generando miniatura para ${file.name}:`, error);
          }
        }
      }

      // Añadir archivos encontrados a la lista global
      // Primero eliminar archivos existentes de esta ruta
      let mediaFiles = getMediaFiles();
      mediaFiles = mediaFiles.filter(f => !f.fullPath || !f.fullPath.startsWith(pathConfig.path));

      // Luego añadir los nuevos
      mediaFiles.push(...scanResult.files);
      setMediaFiles(mediaFiles);

      console.log(`✅ Total de archivos en el sistema: ${mediaFiles.length}`);

      // Actualizar configuración
      pathConfig.lastScan = new Date().toISOString();
      pathConfig.fileCount = scanResult.files.length;
      pathConfig.status = 'connected';
      pathConfig.isActive = true;

      await saveScanPaths(paths);

      // Guardar cache si hay cambios
      if (scanResult.stats.newFiles > 0 || scanResult.stats.modifiedFiles > 0) {
        await saveCache();
      }

      // Enviar progreso final
      broadcastProgress({
        type: 'sync_complete',
        status: `✅ ${scanResult.files.length} archivos sincronizados`,
        percentage: 100,
        stats: scanResult.stats
      });

      res.json({
        success: true,
        fileCount: scanResult.files.length,
        message: `${scanResult.files.length} archivos sincronizados`,
        stats: scanResult.stats
      });
    } catch (error) {
      console.error('❌ Error sincronizando ruta:', error);

      broadcastProgress({
        type: 'sync_error',
        status: 'Error durante la sincronización',
        percentage: 0,
        error: error.message
      });

      res.status(500).json({
        success: false,
        error: 'Error sincronizando ruta'
      });
    }
  });

  /**
   * PATCH /api/scan-paths/:id/toggle
   * Cambia estado activo/inactivo de una ruta
   */
  router.patch('/scan-paths/:id/toggle', async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;

      const paths = await loadScanPaths();
      const pathConfig = paths.find(p => p.id === id);

      if (!pathConfig) {
        return res.status(404).json({
          success: false,
          error: 'Ruta no encontrada'
        });
      }

      pathConfig.isActive = isActive;
      pathConfig.status = isActive ? 'connected' : 'disconnected';

      await saveScanPaths(paths);

      console.log(`✅ Ruta ${isActive ? 'activada' : 'desactivada'}: ${pathConfig.path}`);

      res.json({
        success: true,
        data: pathConfig
      });
    } catch (error) {
      console.error('❌ Error cambiando estado de ruta:', error);
      res.status(500).json({
        success: false,
        error: 'Error cambiando estado de ruta'
      });
    }
  });

  /**
   * DELETE /api/scan-paths/:id
   * Elimina una ruta de escaneo
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

      let paths = await loadScanPaths();
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

      res.json({
        success: true,
        message: 'Ruta eliminada correctamente'
      });
    } catch (error) {
      console.error('❌ Error eliminando ruta:', error);
      res.status(500).json({
        success: false,
        error: 'Error eliminando ruta'
      });
    }
  });

  return router;
};
