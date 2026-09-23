/**
 * Sistema de gestión de colecciones persistente
 * Garantiza que las colecciones y sus archivos no se pierdan nunca, independientemente de reinicios del sistema
 */

const fs = require('fs').promises;
const path = require('path');
const fallos = require('./utils/failureReason');
const mediaIdentity = require('./utils/mediaIdentity');
const crypto = require('crypto');
const { quarantineCorrupt } = require('./utils/jsonStore');
const retiradas = require('./services/retiradas');

// Límite máximo de archivos por colección
const MAX_FILES_PER_COLLECTION = 500;

// ── Como se guarda cada archivo en una coleccion manual ──────────────────
// Segun por donde se añadia, un archivo quedaba guardado de una de tres
// formas: su id de ruta (md5, de uno en uno), su ruta completa en minusculas
// (en grupo) o su mediaKey (al reenlazar un archivo movido). La limpieza de
// huerfanos solo reconocia las dos primeras como presentes... y las rutas, ni
// eso: se daban por desaparecidas en cuanto se leian todos los discos. La
// buena es la mediaKey: no cambia con la letra del disco y dice de que
// biblioteca es. Estas funciones reconocen las tres y guardan la buena.

/** Misma normalizacion de ruta que el frontend (`normalizePath`) y favoritos. */
function normRuta(p) {
  return String(p || '').replace(/\\+/g, '\\').trim().toLowerCase();
}

/** Indice de archivos por sus tres formas: id, mediaKey y ruta normalizada. */
function indiceDeArchivos(files) {
  const idx = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    if (!f) continue;
    if (f.fullPath) idx.set(normRuta(f.fullPath), f);
    if (f.mediaKey) idx.set(f.mediaKey, f);
    if (f.id) idx.set(f.id, f);
  }
  return idx;
}

/** El archivo al que apunta una referencia guardada (en cualquiera de sus formas), o null. */
function archivoDeRef(ref, idx) {
  if (typeof ref !== 'string' || !ref) return null;
  return idx.get(ref) || idx.get(normRuta(ref)) || null;
}

/** La forma en que se guarda un archivo: su mediaKey si la tiene. */
function claveDeArchivo(f) {
  return (f && (f.mediaKey || f.id)) || null;
}

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
      if (!exists) {
        console.log('📝 No existe archivo de colecciones previo, creando nuevo sistema...');
        await this.saveCollections(); // Crear archivo vacío
        return [];
      }

      const data = await fs.readFile(this.collectionsFile, 'utf-8');
      let collectionsArray;
      try {
        collectionsArray = JSON.parse(data);
      } catch (parseErr) {
        // JSON corrupto: NO arrancar con Map vacío para luego machacar el
        // fichero en el primer guardado. Ponerlo en cuarentena (.corrupt-<ts>)
        // para recuperación manual de las colecciones del usuario.
        console.error(`❌ collections_persistent.json corrupto: ${parseErr.message}`);
        await quarantineCorrupt(this.collectionsFile);
        this.collections = new Map();
        return [];
      }

      // Convertir array a Map para mejor rendimiento
      this.collections = new Map(
        collectionsArray.map(collection => [collection.id, collection])
      );

      console.log(`✅ Colecciones cargadas: ${this.collections.size} colecciones con un total de ${this.getTotalFilesCount()} archivos`);
      return Array.from(this.collections.values());
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

    // Encolar la operación de guardado. El `.catch(()=>{})` ANTES del `.then`
    // es crítico: si un guardado previo falló (p.ej. lock transitorio de
    // antivirus/backup sobre el .tmp en Windows), la promesa quedaría rechazada
    // y un `.then(onFulfilled)` encadenado NO se ejecutaría, envenenando la cola
    // para siempre (ningún guardado posterior volvería a correr). Absorbemos el
    // rechazo anterior para que la cola siga viva; el error del guardado ACTUAL
    // sí se propaga al llamante (que devuelve 500).
    this.saveQueue = this.saveQueue.catch(() => {}).then(() => this._performSave());
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
      fallos.record('guardar las colecciones', error, { path: this.collectionsFile });

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
   * Crear nueva colección.
   *
   * @param {string} name
   * @param {string} description
   * @param {string|null} coverImage
   * @param {string} coverType
   * @param {string|null} clientTempId
   * @param {object} [opts]
   * @param {'static'|'smart'} [opts.type] — tipo de coleccion (default 'static')
   * @param {Array} [opts.rules] — reglas (solo si type='smart')
   * @param {'AND'|'OR'} [opts.rule_combinator] — combinador (default 'AND')
   */
  async createCollection(name, description = '', coverImage = null, coverType = 'auto', clientTempId = null, opts = {}) {
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

      const type = opts.type === 'smart' ? 'smart' : 'static';
      const rules = Array.isArray(opts.rules) ? opts.rules : [];
      const rule_combinator = (opts.rule_combinator === 'OR') ? 'OR' : 'AND';

      // Validacion smart folder
      if (type === 'smart' && rules.length === 0) {
        throw new Error('Una Smart Folder necesita al menos una regla');
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
        clientTempId: clientTempId || null,
        type,
        rules,
        rule_combinator,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      this.collections.set(newCollection.id, newCollection);
      await this.saveCollections();

      console.log(`📁 Nueva colección creada: "${newCollection.name}" [${type}] (${newCollection.id})`);
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
   * Añade archivos a una coleccion manual con UN solo guardado. `refs` puede
   * traer ids, rutas o mediaKeys: cada archivo se guarda por su mediaKey si
   * esta en `files`, y no se repite aunque ya estuviera guardado de otra forma.
   * @param {string} collectionId
   * @param {string[]} refs
   * @param {Array} files - catalogo con el que resolver las referencias
   * @returns {Promise<{collection, added:number, skipped:number}>}
   */
  async anadirArchivos(collectionId, refs, files) {
    const collection = this.collections.get(collectionId);
    if (!collection) {
      const err = new Error('Colección no encontrada');
      err.status = 404;
      throw err;
    }
    const idx = indiceDeArchivos(files);
    const clave = (ref) => claveDeArchivo(archivoDeRef(ref, idx)) || ref;
    const yaEstan = new Set((collection.mediaFiles || []).map(clave));
    const nuevas = [];
    let skipped = 0;
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (typeof ref !== 'string' || !ref) continue;
      const c = clave(ref);
      if (yaEstan.has(c)) { skipped++; continue; }
      yaEstan.add(c);
      nuevas.push(c);
    }
    if (collection.mediaFiles.length + nuevas.length > MAX_FILES_PER_COLLECTION) {
      const err = new Error(
        `Operación excedería el límite de ${MAX_FILES_PER_COLLECTION} archivos. Actuales: ${collection.mediaFiles.length}, intentando añadir: ${nuevas.length}`
      );
      err.status = 413;
      err.code = 'COLLECTION_LIMIT_REACHED';
      throw err;
    }
    if (nuevas.length > 0) {
      collection.mediaFiles.push(...nuevas);
      collection.updatedAt = new Date().toISOString();
      await this.saveCollections();
      console.log(`📎 ${nuevas.length} archivo(s) añadidos a la colección "${collection.name}"`);
    }
    return { collection, added: nuevas.length, skipped };
  }

  /**
   * Quita archivos de una coleccion manual con UN solo guardado, este guardado
   * cada uno de la forma que este (id, ruta o mediaKey).
   * @returns {Promise<{collection, removed:number}>}
   */
  async quitarArchivos(collectionId, refs, files) {
    const collection = this.collections.get(collectionId);
    if (!collection) {
      const err = new Error('Colección no encontrada');
      err.status = 404;
      throw err;
    }
    const idx = indiceDeArchivos(files);
    const fuera = new Set();
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (typeof ref !== 'string' || !ref) continue;
      fuera.add(ref);
      fuera.add(normRuta(ref));
      const f = archivoDeRef(ref, idx);
      if (f) {
        if (f.id) fuera.add(f.id);
        if (f.mediaKey) fuera.add(f.mediaKey);
        if (f.fullPath) fuera.add(normRuta(f.fullPath));
      }
    }
    const antes = collection.mediaFiles.length;
    collection.mediaFiles = collection.mediaFiles.filter(r => !fuera.has(r) && !fuera.has(normRuta(r)));
    const removed = antes - collection.mediaFiles.length;
    if (removed > 0) {
      collection.updatedAt = new Date().toISOString();
      await this.saveCollections();
      console.log(`🗑️ ${removed} archivo(s) quitados de la colección "${collection.name}"`);
    }
    return { collection, removed };
  }

  /**
   * Pasa a mediaKey las referencias guardadas por id o por ruta de los
   * archivos que estan ahora en el catalogo. Se llama en cada sincronizacion:
   * lo guardado a la antigua se va poniendo al dia solo, igual que favoritos y
   * notas. Lo que no esta ahora (disco desconectado) se queda como estaba.
   * @returns {Promise<number>} referencias cambiadas
   */
  async aPortable(files) {
    const idx = indiceDeArchivos(files);
    let n = 0;
    for (const collection of this.collections.values()) {
      if (collection.type === 'smart' || !Array.isArray(collection.mediaFiles)) continue;
      let cambio = false;
      const vistas = new Set();
      const nuevas = [];
      for (const ref of collection.mediaFiles) {
        const f = archivoDeRef(ref, idx);
        const r = (f && f.mediaKey) || ref;
        if (r !== ref) { n++; cambio = true; }
        if (vistas.has(r)) { cambio = true; continue; }
        vistas.add(r);
        nuevas.push(r);
      }
      if (cambio) {
        collection.mediaFiles = nuevas;
        collection.updatedAt = new Date().toISOString();
      }
    }
    if (n > 0) {
      await this.saveCollections();
      console.log(`🔑 Colecciones: ${n} referencia(s) pasadas a identidad portable`);
    }
    return n;
  }

  /**
   * Las referencias de una coleccion tal como las espera el frontend: el id de
   * ruta de cada archivo que este en `files` (lo demas, tal cual). El frontend
   * compara por id; sin esto, lo guardado por mediaKey no salia en la coleccion.
   */
  refsParaCliente(collection, idx) {
    const out = [];
    const vistas = new Set();
    for (const ref of (collection && collection.mediaFiles) || []) {
      const f = archivoDeRef(ref, idx);
      const r = (f && f.id) || ref;
      if (vistas.has(r)) continue;
      vistas.add(r);
      out.push(r);
    }
    return out;
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

      // Smart folder: actualizar reglas y combinator si vienen
      if (updates.rules !== undefined) {
        if (!Array.isArray(updates.rules)) throw new Error('rules debe ser array');
        collection.rules = updates.rules;
        // Garantizar tipo smart si llegan reglas
        if (collection.type !== 'smart' && updates.rules.length > 0) {
          collection.type = 'smart';
        }
      }
      if (updates.rule_combinator !== undefined) {
        collection.rule_combinator = (String(updates.rule_combinator).toUpperCase() === 'OR') ? 'OR' : 'AND';
      }
      if (updates.type !== undefined) {
        collection.type = updates.type === 'smart' ? 'smart' : 'static';
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
   * Un archivo ha cambiado de sitio: sus referencias en las colecciones pasan
   * a la identidad nueva (la portable si la tiene), en el mismo orden.
   * Ver services/reenlazar.js.
   * @returns {Promise<number>} referencias reenlazadas
   */
  async reenlazar(pares) {
    const mapa = new Map();
    for (const { de, a } of pares || []) {
      const nuevo = a.mediaKey || a.id;
      if (!nuevo) continue;
      if (de.id) mapa.set(de.id, nuevo);
      if (de.mediaKey) mapa.set(de.mediaKey, nuevo);
    }
    if (mapa.size === 0) return 0;
    let n = 0;
    for (const collection of this.collections.values()) {
      let cambio = false;
      const vistos = new Set();
      const nuevas = [];
      for (const ref of collection.mediaFiles || []) {
        const r = mapa.get(ref) || ref;
        if (r !== ref) { n++; cambio = true; }
        if (vistos.has(r)) { cambio = true; continue; }
        vistos.add(r);
        nuevas.push(r);
      }
      if (mapa.has(collection.coverImage)) { collection.coverImage = mapa.get(collection.coverImage); cambio = true; }
      if (cambio) {
        collection.mediaFiles = nuevas;
        collection.updatedAt = new Date().toISOString();
      }
    }
    if (n > 0) await this.saveCollections();
    return n;
  }

  /**
   * Limpiar archivos huérfanos (archivos en colecciones que ya no existen)
   */
  async cleanupOrphanedFiles(files, opts = {}) {
    try {
      // Set (no Array.includes: esto corre en cada sync sobre miles de
      // archivos por cada coleccion) con las DOS identidades de cada archivo:
      // el id md5 de runtime y la mediaKey portable.
      const presentes = new Set();
      const lista = Array.isArray(files) ? files : [];
      for (const f of lista) {
        if (!f) continue;
        if (typeof f === 'string') { presentes.add(f); continue; }
        if (f.id) presentes.add(f.id);
        if (f.mediaKey) presentes.add(f.mediaKey);
        // Lo añadido en grupo se guardaba por ruta: sin esto, todo archivo
        // guardado asi contaba como desaparecido aunque estuviera ahi.
        if (f.fullPath) presentes.add(normRuta(f.fullPath));
      }
      const scanned = opts.scannedLibraryIds instanceof Set
        ? opts.scannedLibraryIds
        : new Set(Array.isArray(opts.scannedLibraryIds) ? opts.scannedLibraryIds : []);
      // Si alguna biblioteca activa no se ha podido leer, no se puede afirmar
      // que un id md5 haya desaparecido: puede estar en el disco desconectado.
      const todasLeidas = !!opts.todasLasBibliotecasLeidas;
      // Lo desaparecido hace poco puede estar a punto de aparecer en otro
      // sitio (services/reenlazar): se conserva mientras tanto.
      const protegidas = opts.protegidas instanceof Set ? opts.protegidas : null;

      // De que biblioteca es una referencia por id o por ruta (lo sabe quien
      // llama: la cache recuerda tambien lo de las rutas desactivadas).
      const ubicar = typeof opts.ubicar === 'function' ? opts.ubicar : () => null;

      // ¿Se puede DEMOSTRAR que esta referencia ya no existe?
      const puedeProbarQueFalta = (ref) => {
        const libId = mediaIdentity.libraryIdFromKey(ref) || ubicar(ref);
        // Con su biblioteca localizada: solo si ESA se ha leido entera. Asi
        // desactivar una ruta no vacia sus colecciones: "todas las leidas"
        // cuenta solo las activas y lo de la desactivada no estaba.
        if (libId) return scanned.has(libId);
        return todasLeidas;                     // sin localizar: solo si se leyo todo
      };

      let totalRemovedFiles = 0;
      let protegidos = 0;
      const updatedCollections = [];
      // Rastro de lo que se quita (services/retiradas): con su ruta si se sabe.
      const rutaDe = typeof opts.rutaDe === 'function' ? opts.rutaDe : () => null;
      const quitadas = [];

      for (const collection of this.collections.values()) {
        const initialFileCount = collection.mediaFiles.length;
        collection.mediaFiles = collection.mediaFiles.filter(ref => {
          if (presentes.has(ref)) return true;
          if (!puedeProbarQueFalta(ref) || (protegidas && protegidas.has(ref))) { protegidos++; return true; }
          quitadas.push({ ref, donde: collection.name, ruta: rutaDe(ref) || null });
          return false;
        });

        const removedFiles = initialFileCount - collection.mediaFiles.length;
        if (removedFiles > 0) {
          totalRemovedFiles += removedFiles;
          collection.updatedAt = new Date().toISOString();
          updatedCollections.push(collection.name);
        }
      }

      if (protegidos > 0) {
        console.log(`🛡️ ${protegidos} referencia(s) de bibliotecas no recorridas: se conservan en sus colecciones`);
      }
      if (totalRemovedFiles > 0) {
        retiradas.anotar('coleccion', quitadas);
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
// Para las rutas: resolver referencias con el mismo criterio que aqui.
collectionsManager.indiceDeArchivos = indiceDeArchivos;
collectionsManager.normRuta = normRuta;

module.exports = collectionsManager;