/**
 * Notes Manager — Pensadero
 *
 * Notas humanas libres en dos ambitos:
 *   - files:    nota por archivo individual, keyed por `fileId` (el id que usa
 *               el frontend, hash estable de la ruta absoluta).
 *   - sessions: nota por "sesion" colapsada de la galeria, keyed por la session
 *               key derivada del nombre de archivo (ver useSessionGroups.ts).
 *
 * Es metadata humana persistente, NO regenerable, asi que vive en su propio
 * store plano `notes_persistent.json` (mismo patron que favorites/collections)
 * y se escribe de forma atomica. Nunca toca media_cache.json (regenerable) ni
 * renombra archivos.
 *
 * Formato del archivo:
 *   {
 *     "version": 1,
 *     "files":    { "<fileId>":     { "note": "...", "updatedAt": "ISO" } },
 *     "sessions": { "<sessionKey>": { "note": "...", "updatedAt": "ISO" } }
 *   }
 */

const fs = require('fs').promises;
const path = require('path');
const { atomicWriteFile, quarantineCorrupt } = require('./utils/jsonStore');
const fallos = require('./utils/failureReason');

class NotesManager {
  constructor() {
    this.notesFile = path.join(__dirname, 'notes_persistent.json');
    this.files = new Map();    // fileId -> { note, updatedAt }
    this.sessions = new Map(); // sessionKey -> { note, updatedAt }
    this.loaded = false;
    this.saveQueue = Promise.resolve();
  }

  async ensureLoaded() {
    if (!this.loaded) await this.load();
    return this;
  }

  async load() {
    try {
      const exists = await fs.access(this.notesFile).then(() => true).catch(() => false);
      if (!exists) {
        this.files = new Map();
        this.sessions = new Map();
        this.loaded = true;
        return;
      }
      const raw = await fs.readFile(this.notesFile, 'utf-8');
      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        console.error(`❌ notes_persistent.json corrupto: ${parseErr.message}`);
        await quarantineCorrupt(this.notesFile);
        this.files = new Map();
        this.sessions = new Map();
        this.loaded = true;
        return;
      }
      this.files = new Map(Object.entries(data.files || {}));
      this.sessions = new Map(Object.entries(data.sessions || {}));
      this.loaded = true;
    } catch (err) {
      console.error('❌ Error cargando notas:', err.message);
      this.files = new Map();
      this.sessions = new Map();
      this.loaded = true;
    }
  }

  _save() {
    this.saveQueue = this.saveQueue.catch(() => {}).then(() => this._performSave());
    return this.saveQueue;
  }

  async _performSave() {
    const out = {
      version: 1,
      files: Object.fromEntries(this.files),
      sessions: Object.fromEntries(this.sessions),
    };
    try {
      await atomicWriteFile(this.notesFile, JSON.stringify(out, null, 2));
    } catch (err) {
      fallos.record('guardar las notas', err, { path: this.notesFile });
      throw err;   // la ruta lo convierte en 500: las notas no son regenerables
    }
  }

  _mapFor(scope) {
    if (scope === 'file') return this.files;
    if (scope === 'session') return this.sessions;
    return null;
  }

  /**
   * Establece (o borra, si `note` viene vacio) la nota de un ambito.
   * Devuelve { deleted } / { note }.
   */
  async setNote(scope, key, note, legacyKey = null) {
    await this.ensureLoaded();
    const map = this._mapFor(scope);
    if (!map) throw new Error(`scope invalido: ${scope}`);
    const k = String(key || '').trim();
    if (!k) throw new Error('key requerida');

    // Clave anterior del MISMO archivo (el id md5, antes de la identidad
    // portable). Se retira al escribir para que no queden dos notas del mismo
    // archivo: si no, borrar la nota nueva haria reaparecer la vieja.
    const legacy = String(legacyKey || '').trim();
    const retiraLegacy = legacy && legacy !== k && map.has(legacy);

    const text = typeof note === 'string' ? note.trim() : '';
    if (!text) {
      const existed = map.delete(k);
      if (retiraLegacy) map.delete(legacy);
      await this._save();
      return { deleted: existed || retiraLegacy };
    }
    map.set(k, { note: text, updatedAt: new Date().toISOString() });
    if (retiraLegacy) map.delete(legacy);
    await this._save();
    return { note: text, legacyRetirada: retiraLegacy || undefined };
  }

  /** Devuelve { files: { id: note }, sessions: { key: note } } como strings planos. */
  async getAll() {
    await this.ensureLoaded();
    const flatten = (map) => {
      const obj = {};
      for (const [k, v] of map.entries()) {
        const note = v && typeof v === 'object' ? v.note : v;
        if (typeof note === 'string' && note.trim()) obj[k] = note;
      }
      return obj;
    };
    return { files: flatten(this.files), sessions: flatten(this.sessions) };
  }
}

// Singleton
const notesManager = new NotesManager();
module.exports = notesManager;
