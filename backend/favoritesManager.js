/**
 * Sistema de gestión de favoritos persistente
 * Garantiza que los favoritos no se pierdan nunca, independientemente de reinicios del sistema
 */

const fs = require('fs').promises;
const path = require('path');

// Identificador canonico: path normalizado (lowercase + colapsar separadores).
// Debe coincidir con src/utils/formatData.ts en el frontend.
function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\+/g, '\\').trim().toLowerCase();
}

class FavoritesManager {
  constructor() {
    this.favoritesFile = path.join(__dirname, 'favorites_persistent.json');
    this.favorites = new Map(); // pathKey -> { fileId, filePath, addedAt, lastModified }
  }

  /**
   * Cargar favoritos persistentes desde archivo
   */
  async loadFavorites() {
    try {
      const exists = await fs.access(this.favoritesFile).then(() => true).catch(() => false);
      if (exists) {
        const data = await fs.readFile(this.favoritesFile, 'utf-8');
        const favoritesArray = JSON.parse(data);

        // Convertir array a Map para mejor rendimiento.
        // Clave canonica = path normalizado. Entradas legacy (md5 hex de 32 chars)
        // se descartan en carga: el frontend reintroducira los favoritos con path.
        this.favorites = new Map();
        for (const fav of favoritesArray) {
          const key = normalizePath(fav.fileId);
          if (!key) continue;
          const isLegacyMd5 = /^[a-f0-9]{32}$/i.test(fav.fileId) && !fav.fileId.includes('\\') && !fav.fileId.includes('/');
          if (isLegacyMd5) {
            console.log(`⚠️ Descartando favorito legacy md5: ${fav.fileId}`);
            continue;
          }
          this.favorites.set(key, { ...fav, fileId: key });
        }

        console.log(`✅ Favoritos cargados: ${this.favorites.size} archivos marcados como favoritos`);
        return this.favorites;
      } else {
        console.log('📝 No existe archivo de favoritos previo, creando nuevo sistema...');
        await this.saveFavorites(); // Crear archivo vacío
        return this.favorites;
      }
    } catch (error) {
      console.error('❌ Error cargando favoritos:', error);
      this.favorites = new Map();
      return this.favorites;
    }
  }

  /**
   * Guardar favoritos al archivo persistente
   */
  async saveFavorites() {
    try {
      const favoritesArray = Array.from(this.favorites.values());
      await fs.writeFile(
        this.favoritesFile,
        JSON.stringify(favoritesArray, null, 2),
        'utf-8'
      );
      console.log(`💾 Favoritos guardados: ${favoritesArray.length} archivos`);
    } catch (error) {
      console.error('❌ Error guardando favoritos:', error);
      throw error;
    }
  }

  /**
   * Marcar archivo como favorito
   */
  async addFavorite(fileId, filePath = null) {
    try {
      const key = normalizePath(fileId);
      if (!key) return false;

      const favoriteData = {
        fileId: key,
        filePath: filePath || fileId,
        addedAt: new Date().toISOString(),
        lastModified: new Date().toISOString()
      };

      this.favorites.set(key, favoriteData);
      await this.saveFavorites();

      console.log(`❤️ Archivo marcado como favorito: ${key}`);
      return true;
    } catch (error) {
      console.error(`❌ Error añadiendo favorito ${fileId}:`, error);
      return false;
    }
  }

  /**
   * Quitar archivo de favoritos
   */
  async removeFavorite(fileId) {
    try {
      const key = normalizePath(fileId);
      const existed = this.favorites.delete(key);
      if (existed) {
        await this.saveFavorites();
        console.log(`💔 Archivo eliminado de favoritos: ${key}`);
        return true;
      } else {
        console.log(`⚠️ Archivo no estaba en favoritos: ${key}`);
        return false;
      }
    } catch (error) {
      console.error(`❌ Error eliminando favorito ${fileId}:`, error);
      return false;
    }
  }

  /**
   * Verificar si un archivo es favorito
   */
  isFavorite(fileId) {
    return this.favorites.has(normalizePath(fileId));
  }

  /**
   * Obtener entrada de favorito (o null) por path
   */
  getFavorite(fileId) {
    return this.favorites.get(normalizePath(fileId)) || null;
  }

  /**
   * Obtener todos los favoritos
   */
  getAllFavorites() {
    return Array.from(this.favorites.values());
  }

  /**
   * Obtener estadísticas de favoritos
   */
  getStats() {
    return {
      totalFavorites: this.favorites.size,
      oldestFavorite: this.getOldestFavorite(),
      newestFavorite: this.getNewestFavorite()
    };
  }

  /**
   * Obtener favorito más antiguo
   */
  getOldestFavorite() {
    if (this.favorites.size === 0) return null;

    let oldest = null;
    let oldestDate = new Date();

    for (const fav of this.favorites.values()) {
      const favDate = new Date(fav.addedAt);
      if (favDate < oldestDate) {
        oldestDate = favDate;
        oldest = fav;
      }
    }

    return oldest;
  }

  /**
   * Obtener favorito más reciente
   */
  getNewestFavorite() {
    if (this.favorites.size === 0) return null;

    let newest = null;
    let newestDate = new Date('1900-01-01');

    for (const fav of this.favorites.values()) {
      const favDate = new Date(fav.addedAt);
      if (favDate > newestDate) {
        newestDate = favDate;
        newest = fav;
      }
    }

    return newest;
  }

  /**
   * Limpiar favoritos huérfanos (archivos que ya no existen)
   */
  async cleanupOrphanedFavorites(existingPaths) {
    try {
      const existingSet = new Set(existingPaths.map(p => normalizePath(p)));
      const orphanedIds = [];

      for (const key of this.favorites.keys()) {
        if (!existingSet.has(key)) {
          orphanedIds.push(key);
        }
      }

      if (orphanedIds.length > 0) {
        console.log(`🧹 Limpiando ${orphanedIds.length} favoritos huérfanos...`);

        orphanedIds.forEach(id => {
          this.favorites.delete(id);
        });

        await this.saveFavorites();
        console.log(`✅ Favoritos huérfanos eliminados: ${orphanedIds.length}`);
      }

      return orphanedIds.length;
    } catch (error) {
      console.error('❌ Error limpiando favoritos huérfanos:', error);
      return 0;
    }
  }

  /**
   * Aplicar favoritos a un array de archivos de media
   */
  applyFavoritesToFiles(mediaFiles) {
    const updatedFiles = mediaFiles.map(file => ({
      ...file,
      isFavorite: this.isFavorite(file.fullPath || file.path || '')
    }));

    const favoritesCount = updatedFiles.filter(f => f.isFavorite).length;
    console.log(`✨ Favoritos aplicados: ${favoritesCount}/${updatedFiles.length} archivos son favoritos`);

    return updatedFiles;
  }

  /**
   * Crear backup de favoritos
   */
  async createBackup() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(__dirname, `favorites_backup_${timestamp}.json`);

      const favoritesArray = Array.from(this.favorites.values());
      await fs.writeFile(backupPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        totalFavorites: favoritesArray.length,
        favorites: favoritesArray
      }, null, 2));

      console.log(`💾 Backup de favoritos creado: ${backupPath}`);
      return backupPath;
    } catch (error) {
      console.error('❌ Error creando backup de favoritos:', error);
      throw error;
    }
  }
}

// Exportar instancia singleton
const favoritesManager = new FavoritesManager();

module.exports = favoritesManager;