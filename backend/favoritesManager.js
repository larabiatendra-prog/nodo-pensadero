/**
 * Sistema de gestión de favoritos persistente
 * Garantiza que los favoritos no se pierdan nunca, independientemente de reinicios del sistema
 */

const fs = require('fs').promises;
const path = require('path');
const { atomicWriteFile, quarantineCorrupt } = require('./utils/jsonStore');
const fallos = require('./utils/failureReason');
const mediaIdentity = require('./utils/mediaIdentity');
const retiradas = require('./services/retiradas');

// Identificador canonico LEGACY: path normalizado (lowercase + colapsar
// separadores). Debe coincidir con src/utils/formatData.ts en el frontend.
// Se conserva como clave de respaldo: los favoritos guardados antes de la
// identidad portable estan asi, y deben seguir funcionando sin migrar nada.
function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\+/g, '\\').trim().toLowerCase();
}

// "¿esto es una mediaKey o una ruta?" tiene UNA definicion, en mediaIdentity.
// Tenerla aqui duplicada ya salio mal: asumi 32 chars de libraryId cuando son
// 16, y el chequeo no casaba con ninguna clave real.
const looksLikeMediaKey = mediaIdentity.isMediaKey;

class FavoritesManager {
  constructor() {
    this.favoritesFile = path.join(__dirname, 'favorites_persistent.json');
    // clave -> { fileId, filePath, addedAt, lastModified }
    // La clave es la mediaKey cuando se puede derivar; si no, el path legacy.
    this.favorites = new Map();
    this.saveQueue = Promise.resolve(); // serializa escrituras concurrentes
    // Bibliotecas activas [{id, path}], inyectadas en cada sync. Sin ellas no
    // se puede derivar la mediaKey y se opera en modo legacy (por ruta).
    this._libraries = [];
  }

  /**
   * Inyecta las bibliotecas activas para poder derivar mediaKeys. Lo llama
   * performSync en cada pasada, igual que a folderNames, para reflejar
   * remapeos de raiz al instante.
   */
  setLibraries(libs) {
    this._libraries = (Array.isArray(libs) ? libs : [])
      .filter(l => l && l.id && l.path)
      .map(l => ({ id: l.id, path: l.path }));
  }

  /**
   * mediaKey de una entrada, o '' si no se puede derivar (biblioteca no
   * configurada, archivo fuera de toda biblioteca).
   */
  _mediaKeyFor(input) {
    if (!input) return '';
    const s = String(input);
    if (looksLikeMediaKey(s)) return normalizePath(s);
    if (this._libraries.length === 0) return '';
    const derived = mediaIdentity.deriveMediaKeyForPath(s, this._libraries);
    return derived && derived.mediaKey ? normalizePath(derived.mediaKey) : '';
  }

  /**
   * Todas las claves bajo las que puede estar guardado un archivo: la portable
   * primero y la legacy por ruta despues. Mirar las dos es lo que permite que
   * los favoritos de antes de la migracion sigan viendose.
   */
  _keysFor(input) {
    const legacy = normalizePath(input);
    const mk = this._mediaKeyFor(input);
    if (mk && mk !== legacy) return [mk, legacy];
    return legacy ? [legacy] : [];
  }

  /**
   * Cargar favoritos persistentes desde archivo
   */
  async loadFavorites() {
    try {
      const exists = await fs.access(this.favoritesFile).then(() => true).catch(() => false);
      if (!exists) {
        console.log('📝 No existe archivo de favoritos previo, creando nuevo sistema...');
        await this.saveFavorites(); // Crear archivo vacío
        return this.favorites;
      }

      const data = await fs.readFile(this.favoritesFile, 'utf-8');
      let favoritesArray;
      try {
        favoritesArray = JSON.parse(data);
      } catch (parseErr) {
        // JSON corrupto: NO arrancar con Map vacío y borrar todos los favoritos
        // en el primer guardado. Cuarentena para recuperación manual.
        console.error(`❌ favorites_persistent.json corrupto: ${parseErr.message}`);
        await quarantineCorrupt(this.favoritesFile);
        this.favorites = new Map();
        return this.favorites;
      }

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
    // Serializar escrituras: cleanupOrphanedFavorites (en syncFiles, background)
    // y addFavorite/removeFavorite (request del usuario) pueden coincidir. El
    // `.catch(()=>{})` evita envenenar la cola si un guardado falla.
    this.saveQueue = this.saveQueue.catch(() => {}).then(() => this._performSave());
    return this.saveQueue;
  }

  async _performSave() {
    try {
      const favoritesArray = Array.from(this.favorites.values());
      // Escritura atómica (tmp + rename): un crash a mitad nunca corrompe el
      // JSON destino. favorites_persistent.json NO es regenerable.
      await atomicWriteFile(this.favoritesFile, JSON.stringify(favoritesArray, null, 2));
      console.log(`💾 Favoritos guardados: ${favoritesArray.length} archivos`);
    } catch (error) {
      fallos.record('guardar los favoritos', error, { path: this.favoritesFile });
      throw error;
    }
  }

  /**
   * Marcar archivo como favorito
   */
  async addFavorite(fileId, filePath = null) {
    try {
      const legacyKey = normalizePath(fileId);
      if (!legacyKey) return false;
      // Clave portable si se puede; si no, la de siempre. Asi un favorito
      // sobrevive a que la biblioteca cambie de letra de unidad.
      const key = this._mediaKeyFor(fileId) || legacyKey;

      const favoriteData = {
        fileId: key,
        // filePath se conserva como dato de diagnostico (de donde salio), no
        // como identidad. La identidad es la clave.
        filePath: filePath || fileId,
        addedAt: new Date().toISOString(),
        lastModified: new Date().toISOString()
      };

      this.favorites.set(key, favoriteData);
      // Si el mismo archivo estaba guardado por ruta, quitar el duplicado: ya
      // vive bajo su mediaKey.
      if (key !== legacyKey) this.favorites.delete(legacyKey);
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
      // Borrar por AMBAS claves: el archivo puede estar guardado por mediaKey
      // (nuevo) o por ruta (antes de migrar). Quitar solo una lo dejaria medio
      // vivo y reapareciendo en el siguiente sync.
      const keys = this._keysFor(fileId);
      const key = keys[0] || '';
      let existed = false;
      for (const k of keys) { if (this.favorites.delete(k)) existed = true; }
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
    return this._keysFor(fileId).some(k => this.favorites.has(k));
  }

  /**
   * Igual que isFavorite pero para un MediaFile ya resuelto: usa su mediaKey
   * directamente (sin derivarla) y cae a la ruta. Es el camino rapido del
   * sync, que evalua miles de archivos por pasada.
   */
  isFavoriteFile(file) {
    if (!file) return false;
    if (file.mediaKey && this.favorites.has(normalizePath(file.mediaKey))) return true;
    return this.isFavorite(file.fullPath || file.path || '');
  }

  /**
   * Obtener entrada de favorito (o null) por path
   */
  getFavorite(fileId) {
    for (const k of this._keysFor(fileId)) {
      const v = this.favorites.get(k);
      if (v) return v;
    }
    return null;
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
   * ¿Podemos DEMOSTRAR que el archivo de esta clave ya no existe?
   *
   * Solo si su biblioteca se ha recorrido de verdad en este sync. Si el disco
   * estaba desconectado, la ausencia no prueba nada: el archivo sigue ahi, es
   * la unidad la que no esta.
   */
  _puedeProbarQueFalta(key, scannedLibraryIds) {
    if (!scannedLibraryIds || scannedLibraryIds.size === 0) return false;
    const libId = mediaIdentity.libraryIdFromKey(key);
    if (libId) return scannedLibraryIds.has(libId);
    // Clave legacy por ruta: ubicarla en una biblioteca para saber si se leyo.
    if (this._libraries.length === 0) return false;
    const derived = mediaIdentity.deriveMediaKeyForPath(key, this._libraries);
    return !!(derived && derived.libraryId && scannedLibraryIds.has(derived.libraryId));
  }

  /**
   * Un archivo ha cambiado de sitio (movido, o su disco cambio de letra): su
   * favorito pasa a la identidad nueva. Ver services/reenlazar.js.
   * @param {Array<{de:{mediaKey,fullPath}, a:{mediaKey,fullPath}}>} pares
   * @returns {Promise<number>} favoritos reenlazados
   */
  async reenlazar(pares) {
    let n = 0;
    const ahora = new Date().toISOString();
    for (const { de, a } of pares || []) {
      const viejas = [de.mediaKey, de.fullPath].filter(Boolean).map(normalizePath);
      const vieja = viejas.find(k => this.favorites.has(k));
      if (!vieja) continue;
      const nueva = normalizePath(a.mediaKey || a.fullPath);
      if (!nueva || viejas.includes(nueva)) continue;
      const fav = this.favorites.get(vieja);
      for (const k of viejas) this.favorites.delete(k);
      this.favorites.set(nueva, { ...fav, fileId: nueva, filePath: a.fullPath || fav.filePath, lastModified: ahora });
      n++;
    }
    if (n > 0) await this.saveFavorites();
    return n;
  }

  /**
   * Limpiar favoritos huérfanos (archivos que ya no existen).
   *
   * OJO con el criterio: antes bastaba con que la clave no apareciera entre las
   * rutas del sync para borrarla. Eso significaba que sincronizar con un disco
   * externo desenchufado BORRABA todos los favoritos de esa biblioteca, sin
   * vuelta atras y sin avisar. Ahora solo se borra lo que se puede demostrar
   * que falta: su biblioteca se ha recorrido y el archivo no estaba.
   *
   * @param {Array} files - MediaFile[] del sync (con mediaKey y fullPath)
   * @param {Set<string>} scannedLibraryIds - ids de bibliotecas SI recorridas
   */
  async cleanupOrphanedFavorites(files, scannedLibraryIds, opts = {}) {
    // Lo desaparecido hace poco puede estar a punto de aparecer en otro sitio
    // (services/reenlazar): su favorito se conserva mientras tanto.
    const protegidas = opts.protegidas instanceof Set ? opts.protegidas : null;
    try {
      const lista = Array.isArray(files) ? files : [];
      // Identidades presentes, por las dos claves posibles.
      const existingSet = new Set();
      for (const f of lista) {
        if (!f) continue;
        if (typeof f === 'string') { existingSet.add(normalizePath(f)); continue; }
        if (f.mediaKey) existingSet.add(normalizePath(f.mediaKey));
        if (f.fullPath) existingSet.add(normalizePath(f.fullPath));
      }
      const scanned = scannedLibraryIds instanceof Set
        ? scannedLibraryIds
        : new Set(Array.isArray(scannedLibraryIds) ? scannedLibraryIds : []);

      const orphanedIds = [];
      let protegidos = 0;
      for (const key of this.favorites.keys()) {
        if (existingSet.has(key)) continue;
        if (!this._puedeProbarQueFalta(key, scanned) || (protegidas && protegidas.has(key))) { protegidos++; continue; }
        orphanedIds.push(key);
      }
      if (protegidos > 0) {
        console.log(`🛡️ ${protegidos} favorito(s) de bibliotecas no recorridas: se conservan`);
      }

      if (orphanedIds.length > 0) {
        console.log(`🧹 Limpiando ${orphanedIds.length} favoritos huérfanos...`);
        // Rastro de lo quitado: antes no quedaba ninguno (ver services/retiradas).
        retiradas.anotar('favorito', orphanedIds.map(id => {
          const fav = this.favorites.get(id) || {};
          return { ref: id, ruta: fav.filePath || null };
        }));

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
      isFavorite: this.isFavoriteFile(file)
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