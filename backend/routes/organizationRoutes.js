/**
 * Organization Routes — Pensadero
 *
 * Favoritos y colecciones (single-user, sin auth).
 *
 * Endpoints expuestos:
 *   GET    /api/favorites                  → array de fileIds favoritos
 *   POST   /api/favorites/toggle           → body {fileId} → { fileId, isFavorite }
 *
 *   GET    /api/collections                → array de Collection
 *   POST   /api/collections                → body {name, files?, coverImage?, description?}
 *   PATCH  /api/collections/:id            → body {name?, coverImage?, description?, coverType?}
 *   DELETE /api/collections/:id
 *   DELETE /api/collections                → limpia todas
 *   PATCH  /api/collections/reorder        → body {orderedIds}
 *
 *   POST   /api/collections/:id/files      → body {fileIds: [...]} → añade
 *   DELETE /api/collections/:id/files      → body {fileIds: [...]} → quita
 *   POST   /api/collections/:id/files/bulk → alias del anterior (compat)
 *   DELETE /api/collections/:id/files/:fileId → quita uno (compat)
 */

const express = require('express');
const router = express.Router();

const favoritesManager = require('../favoritesManager');
const collectionsManager = require('../collectionsManager');

module.exports = function createOrganizationRoutes(deps) {
  // deps no se usa actualmente; lo dejamos por compatibilidad si en futuro
  // hace falta enriquecer respuestas con mediaFiles.

  // ============================================
  // FAVORITOS
  // ============================================

  /**
   * GET /api/favorites
   * Devuelve un array plano de fileIds (contrato pedido por el frontend).
   */
  router.get('/favorites', (req, res) => {
    try {
      const favorites = favoritesManager.getAllFavorites();
      const fileIds = favorites.map(f => f.fileId);
      res.json(fileIds);
    } catch (error) {
      console.error('❌ Error obteniendo favoritos:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/favorites/toggle
   * Body: { fileId }
   * Devuelve: { fileId, isFavorite }
   */
  router.post('/favorites/toggle', async (req, res) => {
    try {
      const { fileId } = req.body || {};

      if (!fileId) {
        return res.status(400).json({ error: 'Se requiere fileId' });
      }

      const wasFav = favoritesManager.isFavorite(fileId);

      if (wasFav) {
        await favoritesManager.removeFavorite(fileId);
      } else {
        await favoritesManager.addFavorite(fileId);
      }

      res.json({ fileId, isFavorite: !wasFav });
    } catch (error) {
      console.error('❌ Error en toggle favorito:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // COLECCIONES — CRUD
  // ============================================

  /**
   * GET /api/collections
   * Devuelve un array plano de Collection (contrato pedido por el frontend).
   */
  router.get('/collections', (req, res) => {
    try {
      const collections = collectionsManager.getAllCollections();
      res.json(collections);
    } catch (error) {
      console.error('❌ Error obteniendo colecciones:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/collections
   * Body: { name, files?, coverImage?, description?, coverType?, clientTempId? }
   * Si llega `files: [...]` se añaden tras crear la colección.
   */
  router.post('/collections', async (req, res) => {
    try {
      const {
        name,
        description,
        coverImage,
        coverType,
        clientTempId,
        files
      } = req.body || {};

      // Anti-duplicado por clientTempId
      if (clientTempId) {
        const existing = collectionsManager.findByClientTempId(clientTempId);
        if (existing) {
          return res.json(existing);
        }
      }

      const newCollection = await collectionsManager.createCollection(
        name,
        description || '',
        coverImage || null,
        coverType || 'auto',
        clientTempId || null
      );

      // Si se pasaron archivos iniciales, añadirlos
      if (Array.isArray(files) && files.length > 0) {
        for (const fileId of files) {
          try {
            await collectionsManager.addFileToCollection(newCollection.id, fileId);
          } catch (err) {
            console.warn(`⚠️ No se pudo añadir ${fileId} a la nueva colección:`, err.message);
          }
        }
      }

      const final = collectionsManager.getCollection(newCollection.id);
      res.status(201).json(final);
    } catch (error) {
      console.error('❌ Error creando colección:', error);
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * PATCH /api/collections/:id
   * Body: { name?, description?, coverImage?, coverType? }
   */
  router.patch('/collections/:id', async (req, res) => {
    try {
      const { name, description, coverImage, coverType } = req.body || {};
      const collection = await collectionsManager.updateCollection(
        req.params.id,
        { name, description, coverImage, coverType }
      );
      res.json(collection);
    } catch (error) {
      console.error('❌ Error actualizando colección:', error);
      if (error.message === 'Colección no encontrada') {
        res.status(404).json({ error: error.message });
      } else {
        res.status(400).json({ error: error.message });
      }
    }
  });

  /**
   * DELETE /api/collections/:id
   */
  router.delete('/collections/:id', async (req, res) => {
    try {
      await collectionsManager.deleteCollection(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Error eliminando colección:', error);
      if (error.message === 'Colección no encontrada') {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  });

  /**
   * DELETE /api/collections
   * Limpia todas las colecciones (mantenimiento).
   */
  router.delete('/collections', async (req, res) => {
    try {
      const deletedCount = await collectionsManager.clearAllCollections();
      res.json({ success: true, deletedCount });
    } catch (error) {
      console.error('❌ Error limpiando colecciones:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * PATCH /api/collections/reorder
   * Body: { orderedIds: [id1, id2, ...] }
   */
  router.patch('/collections/reorder', async (req, res) => {
    try {
      const { orderedIds } = req.body || {};
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'Se requiere orderedIds (array)' });
      }
      const reordered = await collectionsManager.reorderCollections(orderedIds);
      res.json(reordered);
    } catch (error) {
      console.error('❌ Error reordenando colecciones:', error);
      res.status(400).json({ error: error.message });
    }
  });

  // ============================================
  // ARCHIVOS DENTRO DE COLECCIONES
  // ============================================

  /**
   * Helper: añadir múltiples archivos a una colección con validación de límite.
   */
  async function addFilesToCollection(collectionId, fileIds) {
    const collection = collectionsManager.getCollection(collectionId);
    if (!collection) {
      const err = new Error('Colección no encontrada');
      err.status = 404;
      throw err;
    }

    const newFiles = fileIds.filter(fid => !collection.mediaFiles.includes(fid));
    const finalCount = collection.mediaFiles.length + newFiles.length;

    if (finalCount > 500) {
      const err = new Error(
        `Operación excedería el límite de 500 archivos. Actuales: ${collection.mediaFiles.length}, intentando añadir: ${newFiles.length}`
      );
      err.status = 413;
      err.code = 'COLLECTION_LIMIT_REACHED';
      throw err;
    }

    let added = 0;
    let skipped = 0;
    for (const fileId of fileIds) {
      if (!collection.mediaFiles.includes(fileId)) {
        await collectionsManager.addFileToCollection(collectionId, fileId);
        added++;
      } else {
        skipped++;
      }
    }

    return {
      collection: collectionsManager.getCollection(collectionId),
      stats: { added, skipped, total: fileIds.length }
    };
  }

  /**
   * POST /api/collections/:id/files
   * Body: { fileIds: [...] }  (también acepta { fileId } para compatibilidad)
   */
  router.post('/collections/:id/files', async (req, res) => {
    try {
      const body = req.body || {};
      const fileIds = Array.isArray(body.fileIds)
        ? body.fileIds
        : (body.fileId ? [body.fileId] : []);

      if (fileIds.length === 0) {
        return res.status(400).json({ error: 'Se requiere fileIds (array) o fileId' });
      }

      const { collection, stats } = await addFilesToCollection(req.params.id, fileIds);
      res.json({ ...collection, _stats: stats });
    } catch (error) {
      console.error('❌ Error añadiendo archivos a colección:', error);
      const status = error.status || 500;
      res.status(status).json({ error: error.message, code: error.code });
    }
  });

  /**
   * POST /api/collections/:id/files/bulk
   * Body: { fileIds: [...] }  (alias compat)
   */
  router.post('/collections/:id/files/bulk', async (req, res) => {
    try {
      const { fileIds } = req.body || {};
      if (!Array.isArray(fileIds) || fileIds.length === 0) {
        return res.status(400).json({ error: 'Se requiere fileIds (array no vacío)' });
      }
      const { collection, stats } = await addFilesToCollection(req.params.id, fileIds);
      res.json({ ...collection, _stats: stats });
    } catch (error) {
      console.error('❌ Error en bulk-add:', error);
      const status = error.status || 500;
      res.status(status).json({ error: error.message, code: error.code });
    }
  });

  /**
   * DELETE /api/collections/:id/files
   * Body: { fileIds: [...] }   → quita múltiples archivos
   */
  router.delete('/collections/:id/files', async (req, res) => {
    try {
      const { fileIds } = req.body || {};
      if (!Array.isArray(fileIds) || fileIds.length === 0) {
        return res.status(400).json({ error: 'Se requiere fileIds (array no vacío)' });
      }

      let removed = 0;
      for (const fileId of fileIds) {
        try {
          await collectionsManager.removeFileFromCollection(req.params.id, fileId);
          removed++;
        } catch (err) {
          if (err.message === 'Colección no encontrada') {
            return res.status(404).json({ error: err.message });
          }
        }
      }
      const collection = collectionsManager.getCollection(req.params.id);
      res.json({ ...collection, _stats: { removed, total: fileIds.length } });
    } catch (error) {
      console.error('❌ Error quitando archivos de colección:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/collections/:id/files/:fileId
   * (Compatibilidad con la versión vieja)
   */
  router.delete('/collections/:id/files/:fileId', async (req, res) => {
    try {
      const collection = await collectionsManager.removeFileFromCollection(
        req.params.id,
        req.params.fileId
      );
      res.json(collection);
    } catch (error) {
      console.error('❌ Error eliminando archivo de colección:', error);
      if (error.message === 'Colección no encontrada') {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  });

  return router;
};
