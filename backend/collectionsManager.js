/**
 * Sistema de gestión de colecciones persistente
 * Garantiza que las colecciones y sus archivos no se pierdan nunca, independientemente de reinicios del sistema
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Límite máximo de archivos por colección
const MAX_FILES_PER_COLLECTION = 500;

class CollectionsManager {
  constructor() {
    this.collectionsFile = path.join(__dirname, 'collections_persistent.json');
    this.collectionsTmpFile = path.join(__dirname, 'collections_persistent.tmp');
    this.collections = new Map(); // collectionId -> collection object
    this.saveQueue = Promise.resolve(); // Cola de guardado inicializada
    this.isSaving = false; // Flag para indicar si hay un guardado en curso
  }

  /**
   * Cargar colecciones persistentes desde archivo
   */
  async loadCollections() {
    try {
      const exists = await fs.access(this.collectionsFile).then(() => true).catch(() => false);
      if (exists) {
        const data = await fs.readFile(this.collectionsFile, 'utf-8');
        const collectionsArray = JSON.parse(data);

        // Convertir array a Map para mejor rendimiento
        this.collections = new Map(
          collectionsArray.map(collection => [collection.id, collection])
        );

        console.log(`✅ Colecciones cargadas: ${this.collections.size} colecciones con un total de ${this.getTotalFilesCount()} archivos`);
        return Array.from(this.collections.values());
      } else {
        console.log('📝 No existe archivo de colecciones previo, creando nuevo sistema...');
        await this.saveCollections(); // Crear archivo vacío
        return [];
      }
    } catch (error) {
      console.error('❌ Error cargando colecciones:', error);
      this.collections = new Map();
      return [];
    }
  }

  /**
   * Guardar colecciones al archivo persistente con cola de escritura y atomicidad
   */
  async saveCollections() {
    // Si ya hay un guardado en curso, informar que se está encolando
    if (this.isSaving) {
      console.log('💾 Guardado en cola...');
    }

    // Encolar la operación de guardado
    this.saveQueue = this.saveQueue.then(() => this._performSave());
    return this.saveQueue;
  }

  /**
   * Realizar el guardado real de forma atómica
   * @private
   */
  async _performSave() {
    try {
      this.isSaving = true;

      const collectionsArray = Array.from(this.collections.values());
      const jsonContent = JSON.stringify(collectionsArray, null, 2);

      // Paso 1: Escribir en archivo temporal
      await fs.writeFile(
        this.collectionsTmpFile,
        jsonContent,
        'utf-8'
      );

      // Paso 2: Rename atómico (en Windows también es atómico en filesystems NTFS)
      await fs.rename(this.collectionsTmpFile, this.collectionsFile);

      console.log(`✅ Colecciones guardadas correctamente: ${collectionsArray.length} colecciones con ${this.getTotalFilesCount()} archivos totales`);
    } catch (error) {
      console.error('❌ Error guardando colecciones:', error);

      // Intentar limpiar el archivo temporal si existe
      try {
        await fs.unlink(this.collectionsTmpFile).catch(() => {});
      } catch (cleanupError) {
        // Silenciar error de limpieza
      }

      throw error;
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Buscar colección por clientTempId
   */
  findByClientTempId(clientTempId) {
    if (!clientTempId) return null;

    return Array.from(this.collections.values())
      .find(c => c.clientTempId === clientTempId) || null;
  }

  /**
   * Crear nueva colección
   */
  async createCollection(name, description = '', coverImage = null, coverType = 'auto', clientTempId = null) {
    try {
      // Validar nombre
      if (!name || name.trim().length === 0) {
        throw new Error('El nombre de la colección no puede estar vacío');
      }

      if (name.trim().length > 50) {
        throw new Error('El nombre no puede tener más de 50 caracteres');
      }

      // Verificar que no existe otra colección con el mismo nombre
      const existingCollection = Array.from(this.collections.values())
        .find(c => c.name.toLowerCase() === name.trim().toLowerCase());

      if (existingCollection) {
        throw new Error('Ya existe una colección con ese nombre');
      }

      // Obtener el siguiente número de orden
      const maxOrder = this.getMaxOrder();

      // Crear nueva colección
      const newCollection = {
        id: this.generateCollectionId(),
        name: name.trim(),
        description: description.trim(),
        mediaFiles: [],
        coverImage: coverImage,
        coverType: coverType,
        order: maxOrder + 1,
        clientTempId: clientTempId || null, // ID temporal del cliente para evitar duplicados
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      this.collections.set(newCollection.id, newCollection);
      await this.saveCollections();

      console.log(`📁 Nueva colección creada: "${newCollection.name}" (${newCollection.id})`);
      return newCollection;
    } catch (error) {
      console.error(`❌ Error creando colección "${name}":`, error);
      throw error;
    }
  }

  /**
   * Obtener todas las colecciones ordenadas por 'order'
   */
  getAllCollections() {
    return Array.from(this.collections.values())
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /**
   * Obtener una colección por ID
   */
  getCollection(collectionId) {
    return this.collections.get(collectionId) || null;
  }

  /**
   * Añadir archivo a colección
   */
  async addFileToCollection(collectionId, fileId) {
    try {
      const collection = this.collections.get(collectionId);
      if (!collection) {
        throw new Error('Colección no encontrada');
      }

      // Verificar límite de archivos por colección
      if (collection.mediaFiles.length >= MAX_FILES_PER_COLLECTION) {
        const error = new Error(`Esta colección ha alcanzado el límite de ${MAX_FILES_PER_COLLECTION} archivos.`);
        error.code = 'COLLECTION_LIMIT_REACHED';
        throw error;
      }

      // Verificar si el archivo ya está en la colección
      if (!collection.mediaFiles.includes(fileId)) {
        collection.mediaFiles.push(fileId);
        collection.updatedAt = new Date().toISOString();

        await this.saveCollections();
        console.log(`📎 Archivo ${fileId} añadido a colección "${collection.name}"`);
      } else {
        console.log(`⚠️ Archivo ${fileId} ya existe en colección "${collection.name}"`);
      }

      return collection;
    } catch (error) {
      console.error(`❌ Error añadiendo archivo ${fileId} a colección ${collectionId}:`, error);
      throw error;
    }
  }

  /**
   * Eliminar archivo de colección
   */
  async removeFileFromCollection(collectionId, fileId) {
    try {
      const collection = this.collections.get(collectionId);
      if (!collection) {
        throw new Error('Colección no encontrada');
      }

      const initialLength = collection.mediaFiles.length;
      collection.mediaFiles = collection.mediaFiles.filter(f => f !== fileId);

      if (collection.mediaFiles.length !== initialLength) {
        collection.updatedAt = new Date().toISOString();
        await this.saveCollections();
        console.log(`🗑️ Archivo ${fileId} eliminado de colección "${collection.name}"`);
      } else {
        console.log(`⚠️ Archivo ${fileId} no estaba en colección "${collection.name}"`);
      }

      return collection;
    } catch (error) {
      console.error(`❌ Error eliminando archivo ${fileId} de colección ${collectionId}:`, error);
      throw error;
    }
  }

  /**
   * Actualizar colección (nombre, descripción, portada)
   */
  async updateCollection(collectionId, updates) {
    try {
      const collection = this.collections.get(collectionId);
      if (!collection) {
        throw new Error('Colección no encontrada');
      }

      // Validar nombre si se proporciona
      if (updates.name !== undefined) {
        if (!updates.name || updates.name.trim().length === 0) {
          throw new Error('El nombre no puede estar vacío');
        }

        if (updates.name.trim().length > 50) {
          throw new Error('El nombre no puede tener más de 50 caracteres');
        }

        // Verificar que no existe otra colección con el mismo nombre
        const existingCollection = Array.from(this.collections.values())
          .find(c => c.id !== collectionId && c.name.toLowerCase() === updates.name.trim().toLowerCase());

        if (existingCollection) {
          throw new Error('Ya existe una colección con ese nombre');
        }

        collection.name = updates.name.trim();
      }

      // Actualizar descripción si se proporciona
      if (updates.description !== undefined) {
        collection.description = updates.description.trim();
      }

      // Actualizar portada si se proporciona
      if (updates.coverImage !== undefined) {
        collection.coverImage = updates.coverImage;
      }

      // Actualizar tipo de portada si se proporciona
      if (updates.coverType !== undefined) {
        collection.coverType = updates.coverType;
      }

      // Actualizar timestamp
      collection.updatedAt = new Date().toISOString();

      await this.saveCollections();
      console.log(`✏️ Colección "${collection.name}" actualizada`);

      return collection;
    } catch (error) {
      console.error(`❌ Error actualizando colección ${collectionId}:`, error);
      throw error;
    }
  }

  /**
   * Eliminar colección completa
   */
  async deleteCollection(collectionId) {
    try {
      const collection = this.collections.get(collectionId);
      if (!collection) {
        throw new Error('Colección no encontrada');
      }

      this.collections.delete(collectionId);
      await this.saveCollections();

      console.log(`🗑️ Colección "${collection.name}" eliminada permanentemente`);
      return true;
    } catch (error) {
      console.error(`❌ Error eliminando colección ${collectionId}:`, error);
      throw error;
    }
  }

  /**
   * Limpiar todas las colecciones (para mantenimiento)
   */
  async clearAllCollections() {
    try {
      const deletedCount = this.collections.size;
      this.collections.clear();
      await this.saveCollections();

      console.log(`🧹 Todas las colecciones eliminadas: ${deletedCount} colecciones`);
      return deletedCount;
    } catch (error) {
      console.error('❌ Error limpiando todas las colecciones:', error);
      throw error;
    }
  }

  /**
   * Limpiar archivos huérfanos (archivos en colecciones que ya no existen)
   */
  async cleanupOrphanedFiles(existingFileIds) {
    try {
      let totalRemovedFiles = 0;
      const updatedCollections = [];

      for (const collection of this.collections.values()) {
        const initialFileCount = collection.mediaFiles.length;
        collection.mediaFiles = collection.mediaFiles.filter(fileId =>
          existingFileIds.includes(fileId)
        );

        const removedFiles = initialFileCount - collection.mediaFiles.length;
        if (removedFiles > 0) {
          totalRemovedFiles += removedFiles;
          collection.updatedAt = new Date().toISOString();
          updatedCollections.push(collection.name);
        }
      }

      if (totalRemovedFiles > 0) {
        await this.saveCollections();
        console.log(`🧹 Archivos huérfanos eliminados: ${totalRemovedFiles} archivos de ${updatedCollections.length} colecciones`);
        console.log(`   Colecciones afectadas: ${updatedCollections.join(', ')}`);
      }

      return totalRemovedFiles;
    } catch (error) {
      console.error('❌ Error limpiando archivos huérfanos:', error);
      return 0;
    }
  }

  /**
   * Obtener estadísticas de colecciones
   */
  getStats() {
    const collections = Array.from(this.collections.values());
    const totalFiles = this.getTotalFilesCount();

    const stats = {
      totalCollections: collections.length,
      totalFiles: totalFiles,
      averageFilesPerCollection: collections.length > 0 ? (totalFiles / collections.length).toFixed(1) : 0,
      largestCollection: this.getLargestCollection(),
      oldestCollection: this.getOldestCollection(),
      newestCollection: this.getNewestCollection()
    };

    return stats;
  }

  /**
   * Obtener conteo total de archivos en todas las colecciones
   */
  getTotalFilesCount() {
    return Array.from(this.collections.values())
      .reduce((total, collection) => total + collection.mediaFiles.length, 0);
  }

  /**
   * Obtener colección más grande
   */
  getLargestCollection() {
    const collections = Array.from(this.collections.values());
    if (collections.length === 0) return null;

    return collections.reduce((largest, current) =>
      current.mediaFiles.length > largest.mediaFiles.length ? current : largest
    );
  }

  /**
   * Obtener colección más antigua
   */
  getOldestCollection() {
    const collections = Array.from(this.collections.values());
    if (collections.length === 0) return null;

    return collections.reduce((oldest, current) =>
      new Date(current.createdAt) < new Date(oldest.createdAt) ? current : oldest
    );
  }

  /**
   * Obtener colección más reciente
   */
  getNewestCollection() {
    const collections = Array.from(this.collections.values());
    if (collections.length === 0) return null;

    return collections.reduce((newest, current) =>
      new Date(current.createdAt) > new Date(newest.createdAt) ? current : newest
    );
  }

  /**
   * Generar ID único para colección
   */
  generateCollectionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    const hash = crypto.createHash('md5').update(`${timestamp}-${random}`).digest('hex').substr(0, 8);
    return `col_${timestamp}_${hash}`;
  }

  /**
   * Crear backup de colecciones
   */
  async createBackup() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(__dirname, `collections_backup_${timestamp}.json`);

      const collectionsArray = Array.from(this.collections.values());
      const stats = this.getStats();

      await fs.writeFile(backupPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        totalCollections: collectionsArray.length,
        totalFiles: stats.totalFiles,
        collections: collectionsArray
      }, null, 2));

      console.log(`💾 Backup de colecciones creado: ${backupPath}`);
      return backupPath;
    } catch (error) {
      console.error('❌ Error creando backup de colecciones:', error);
      throw error;
    }
  }

  /**
   * Verificar integridad de colecciones
   */
  async verifyIntegrity() {
    try {
      const issues = [];

      for (const collection of this.collections.values()) {
        // Verificar que tiene ID válido
        if (!collection.id) {
          issues.push(`Colección sin ID: ${collection.name}`);
        }

        // Verificar que tiene nombre
        if (!collection.name || collection.name.trim().length === 0) {
          issues.push(`Colección sin nombre: ${collection.id}`);
        }

        // Verificar que mediaFiles es array
        if (!Array.isArray(collection.mediaFiles)) {
          issues.push(`Colección con mediaFiles inválido: ${collection.name} (${collection.id})`);
          collection.mediaFiles = [];
        }

        // Verificar fechas válidas
        try {
          new Date(collection.createdAt);
          new Date(collection.updatedAt);
        } catch (error) {
          issues.push(`Colección con fechas inválidas: ${collection.name} (${collection.id})`);
          collection.createdAt = new Date().toISOString();
          collection.updatedAt = new Date().toISOString();
        }
      }

      if (issues.length > 0) {
        console.warn(`⚠️ Problemas de integridad detectados: ${issues.length}`);
        issues.forEach(issue => console.warn(`   - ${issue}`));
        await this.saveCollections(); // Guardar correcciones
      } else {
        console.log('✅ Integridad de colecciones verificada correctamente');
      }

      return issues;
    } catch (error) {
      console.error('❌ Error verificando integridad de colecciones:', error);
      return [`Error durante verificación: ${error.message}`];
    }
  }

  /**
   * Obtener el orden máximo actual
   */
  getMaxOrder() {
    const collections = Array.from(this.collections.values());
    if (collections.length === 0) return 0;

    return Math.max(...collections.map(c => c.order || 0));
  }

  /**
   * Reordenar colecciones según un array de IDs
   */
  async reorderCollections(orderedIds) {
    try {
      if (!Array.isArray(orderedIds)) {
        throw new Error('Se esperaba un array de IDs');
      }

      // Verificar que todos los IDs existen
      const existingIds = new Set(this.collections.keys());
      const invalidIds = orderedIds.filter(id => !existingIds.has(id));

      if (invalidIds.length > 0) {
        throw new Error(`IDs de colección no encontrados: ${invalidIds.join(', ')}`);
      }

      // Verificar que no faltan IDs
      if (orderedIds.length !== this.collections.size) {
        throw new Error(`Se esperaban ${this.collections.size} IDs, pero se recibieron ${orderedIds.length}`);
      }

      // Actualizar el orden de cada colección
      orderedIds.forEach((id, index) => {
        const collection = this.collections.get(id);
        if (collection) {
          collection.order = index + 1;
          collection.updatedAt = new Date().toISOString();
        }
      });

      await this.saveCollections();
      console.log(`🔄 Colecciones reordenadas: ${orderedIds.length} colecciones`);

      return this.getAllCollections();
    } catch (error) {
      console.error('❌ Error reordenando colecciones:', error);
      throw error;
    }
  }

  /**
   * Normalizar órdenes de colecciones (asegurar secuencia 1,2,3...)
   */
  async normalizeOrder() {
    try {
      const collections = this.getAllCollections(); // Ya ordenadas
      let hasChanges = false;

      collections.forEach((collection, index) => {
        const expectedOrder = index + 1;
        if (collection.order !== expectedOrder) {
          collection.order = expectedOrder;
          collection.updatedAt = new Date().toISOString();
          hasChanges = true;
        }
      });

      if (hasChanges) {
        await this.saveCollections();
        console.log('🔧 Órdenes de colecciones normalizados');
      }

      return collections;
    } catch (error) {
      console.error('❌ Error normalizando órdenes:', error);
      throw error;
    }
  }
}

// Exportar instancia singleton
const collectionsManager = new CollectionsManager();

module.exports = collectionsManager;