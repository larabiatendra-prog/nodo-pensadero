/**
 * Descartes Manager — Pensadero
 *
 * Tomas gemelas que el usuario ha apartado: de un grupo de doce intentos del
 * mismo plano se queda con uno y los otros once dejan de aparecer en la
 * galeria. NO se borra ni se mueve nada en disco — esto es solo una lista de
 * "no me lo enseñes"; la vista de Tomas gemelas los sigue mostrando y se puede
 * deshacer en cualquier momento.
 *
 * Es una decision humana y por tanto NO regenerable: vive en su propio store
 * plano y se escribe de forma atomica, mismo patron que notes_persistent.json.
 *
 * Formato:
 *   { "version": 1, "descartes": { "<fileId>": { "desde": "ISO" } } }
 */

const fs = require('fs').promises;
const path = require('path');
const { atomicWriteFile, quarantineCorrupt } = require('./utils/jsonStore');
const fallos = require('./utils/failureReason');

class DescartesManager {
  constructor() {
    this.file = path.join(__dirname, 'descartes_persistent.json');
    this.items = new Map(); // fileId -> { desde }
    this.loaded = false;
    this.saveQueue = Promise.resolve();
  }

  async ensureLoaded() {
    if (!this.loaded) await this.load();
    return this;
  }

  async load() {
    try {
      const existe = await fs.access(this.file).then(() => true).catch(() => false);
      if (!existe) {
        this.items = new Map();
        this.loaded = true;
        return;
      }
      const raw = await fs.readFile(this.file, 'utf-8');
      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        // Un JSON roto no puede tumbar el arranque ni perderse en silencio:
        // se aparta con su motivo y se sigue con la lista vacia.
        await quarantineCorrupt(this.file, parseErr);
        this.items = new Map();
        this.loaded = true;
        return;
      }
      this.items = new Map();
      const dict = (data && data.descartes) || {};
      for (const [fileId, valor] of Object.entries(dict)) {
        if (!fileId) continue;
        this.items.set(fileId, { desde: (valor && valor.desde) || new Date().toISOString() });
      }
      this.loaded = true;
    } catch (err) {
      fallos.record('leer los descartes', err, { path: this.file });
      this.items = new Map();
      this.loaded = true;
    }
  }

  _save() {
    this.saveQueue = this.saveQueue.then(async () => {
      const data = { version: 1, descartes: {} };
      for (const [fileId, valor] of this.items.entries()) {
        data.descartes[fileId] = valor;
      }
      await atomicWriteFile(this.file, JSON.stringify(data, null, 2));
    }).catch(err => {
      fallos.record('guardar los descartes', err, { path: this.file });
    });
    return this.saveQueue;
  }

  list() {
    return Array.from(this.items.keys());
  }

  isDescartado(fileId) {
    return this.items.has(fileId);
  }

  /**
   * Marca o desmarca en bloque. Devuelve la lista completa resultante para que
   * el frontend no tenga que adivinar el estado.
   */
  async set(fileIds, descartar) {
    await this.ensureLoaded();
    const ids = Array.isArray(fileIds) ? fileIds.filter(Boolean) : [];
    if (ids.length === 0) return this.list();
    const ahora = new Date().toISOString();
    for (const id of ids) {
      if (descartar) {
        if (!this.items.has(id)) this.items.set(id, { desde: ahora });
      } else {
        this.items.delete(id);
      }
    }
    await this._save();
    return this.list();
  }

  /**
   * Un archivo ha cambiado de sitio (otra letra, otra carpeta): lo apartado
   * pasa a su id nuevo. Ver services/reenlazar.js. Antes no se hacia, y al
   * cambiar de letra un disco sus tomas apartadas volvian a la galeria (el
   * 29/09/2026 quedaban 13 de 491 enlazadas). Un id viejo puede ir a varios
   * nuevos (la misma foto copiada en dos discos): apartar es "no me enseñes
   * esta toma", y vale para las dos.
   * @returns {Promise<number>} tomas reenlazadas
   */
  async reenlazar(pares) {
    await this.ensureLoaded();
    const destinos = new Map();
    for (const { de, a } of pares || []) {
      if (!de || !a || !de.id || !a.id || de.id === a.id || !this.items.has(de.id)) continue;
      if (!destinos.has(de.id)) destinos.set(de.id, []);
      destinos.get(de.id).push(a.id);
    }
    let n = 0;
    for (const [viejo, nuevos] of destinos) {
      const valor = this.items.get(viejo);
      for (const id of nuevos) {
        if (!this.items.has(id)) { this.items.set(id, valor); n++; }
      }
      this.items.delete(viejo);
    }
    if (destinos.size > 0) await this._save();
    return n;
  }

  getStats() {
    return { total: this.items.size };
  }
}

module.exports = new DescartesManager();
