/**
 * Ocultos Manager — Pensadero
 *
 * Material que el usuario ha puesto bajo candado: deja de aparecer en la
 * galeria, en las busquedas, en los recuerdos, en las colecciones y en las
 * estadisticas. Para verlo o sacarlo de ahi hace falta la clave.
 *
 * Es un candado de pudor, no una caja fuerte: los archivos siguen en su disco,
 * sin cifrar, y cualquiera con acceso al explorador de Windows los ve. Lo que
 * protege es la aplicacion — que un pase de diapositivas, una busqueda o un
 * eco del dia no pongan en pantalla algo que no quieres que salga.
 *
 * Donde se filtra: en el SERVIDOR, al entregar la lista de archivos (ver
 * `visibles`). Si se filtrara solo en el navegador, bastaria con que una vista
 * nueva olvidara el filtro para que lo oculto volviera a salir.
 *
 * Donde NO se filtra, a proposito: el agregado de personas y la limpieza de
 * huerfanos. Una persona que solo aparece en material oculto no es una "ficha
 * vacia": si se la tratara asi, la limpieza de fichas la borraria.
 *
 * Clave: la identidad portable (`mediaKey`) cuando existe, para que lo oculto
 * siga oculto si el disco cambia de letra; si no, el id de runtime.
 *
 * Formato:
 *   {
 *     "version": 1,
 *     "clave": { "salt": "<hex>", "hash": "<hex>" } | null,   // null = "1234"
 *     "ocultos": { "<mediaKey|id>": { "id": "<md5>", "nombre": "...", "desde": "ISO" } }
 *   }
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFile, quarantineCorrupt } = require('./utils/jsonStore');
const fallos = require('./utils/failureReason');

/** Clave de fabrica mientras el usuario no ponga otra. */
const CLAVE_INICIAL = '1234';
/** Cuanto dura abierta la caja tras poner la clave. */
const LLAVE_MS = 30 * 60 * 1000;
/** Ventana para deshacer un ocultado sin pedir la clave. */
const DESHACER_MS = 20 * 1000;

function derivar(clave, salt) {
  return crypto.scryptSync(String(clave), Buffer.from(salt, 'hex'), 32).toString('hex');
}

class OcultosManager {
  constructor() {
    this.file = path.join(__dirname, 'ocultos_persistent.json');
    this.items = new Map(); // clave -> { id, nombre, desde }
    this.ids = new Set();   // ids de runtime de lo oculto, para filtrar rapido
    this.clave = null;      // { salt, hash } | null
    this.loaded = false;
    this.saveQueue = Promise.resolve();
    this.llaves = new Map();    // token -> caduca (ms)
    this.deshacer = new Map();  // token -> { caduca, claves: string[] }
  }

  async ensureLoaded() {
    if (!this.loaded) await this.load();
    return this;
  }

  async load() {
    try {
      const existe = await fs.access(this.file).then(() => true).catch(() => false);
      this.items = new Map();
      this.clave = null;
      if (existe) {
        const raw = await fs.readFile(this.file, 'utf-8');
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch (parseErr) {
          // Un JSON roto no se machaca: se aparta con su motivo. Mientras
          // tanto no hay nada oculto, y eso se dice en el log con la causa.
          await quarantineCorrupt(this.file, parseErr);
        }
        if (data && typeof data === 'object') {
          if (data.clave && data.clave.salt && data.clave.hash) this.clave = data.clave;
          for (const [k, v] of Object.entries(data.ocultos || {})) {
            if (!k) continue;
            this.items.set(k, {
              id: (v && v.id) || null,
              nombre: (v && v.nombre) || '',
              desde: (v && v.desde) || new Date().toISOString(),
            });
          }
        }
      }
      this._reindexar();
      this.loaded = true;
    } catch (err) {
      fallos.record('leer el material oculto', err, { path: this.file });
      this.items = new Map();
      this._reindexar();
      this.loaded = true;
    }
  }

  _reindexar() {
    this.ids = new Set();
    for (const [k, v] of this.items) {
      this.ids.add(k);
      if (v.id) this.ids.add(v.id);
    }
  }

  _save() {
    // Se encadena sobre la cola ya saneada: si un guardado anterior fallo, el
    // siguiente tiene que intentarlo igual, no heredar el rechazo.
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      const data = { version: 1, clave: this.clave, ocultos: {} };
      for (const [k, v] of this.items) data.ocultos[k] = v;
      await atomicWriteFile(this.file, JSON.stringify(data, null, 2), { backup: true });
    }).catch(err => {
      fallos.record('guardar el material oculto', err, { path: this.file });
      throw err;
    });
    return this.saveQueue;
  }

  // ── Consulta ────────────────────────────────────────────────────────────

  /** Clave con la que se guarda un archivo: la portable si la tiene. */
  claveDe(file) {
    return (file && (file.mediaKey || file.id)) || null;
  }

  estaOculto(file) {
    if (!file || this.ids.size === 0) return false;
    return (!!file.mediaKey && this.ids.has(file.mediaKey)) || (!!file.id && this.ids.has(file.id));
  }

  /** Lo que la aplicacion puede enseñar. Devuelve el mismo array si no hay nada oculto. */
  visibles(files) {
    if (!Array.isArray(files) || this.ids.size === 0) return files || [];
    return files.filter(f => !this.estaOculto(f));
  }

  total() {
    return this.items.size;
  }

  // ── Cambios ─────────────────────────────────────────────────────────────

  /**
   * Oculta. No pide clave: esconder algo nunca expone nada. Devuelve un token
   * de un solo uso para deshacerlo durante unos segundos sin clave, porque un
   * candado puesto por error no deberia exigir la contraseña para quitarlo.
   */
  async ocultar(files) {
    await this.ensureLoaded();
    const ahora = new Date().toISOString();
    const claves = [];
    for (const f of files) {
      const k = this.claveDe(f);
      if (!k || this.items.has(k)) continue;
      this.items.set(k, { id: f.id || null, nombre: f.displayName || f.name || '', desde: ahora });
      claves.push(k);
    }
    if (claves.length === 0) return { ocultados: 0, deshacer: null };
    this._reindexar();
    await this._save();
    const token = crypto.randomBytes(18).toString('hex');
    this.deshacer.set(token, { caduca: Date.now() + DESHACER_MS, claves });
    return { ocultados: claves.length, deshacer: token };
  }

  /**
   * Saca del candado. `ids` puede traer ids de runtime o claves portables: los
   * archivos de un disco desconectado no tienen id ahora mismo, pero su
   * entrada si tiene clave y hay que poder liberarla igual.
   */
  async mostrar(idsOClaves) {
    await this.ensureLoaded();
    const buscados = new Set(idsOClaves.filter(Boolean));
    let cambiados = 0;
    for (const [k, v] of Array.from(this.items)) {
      if (buscados.has(k) || (v.id && buscados.has(v.id))) {
        this.items.delete(k);
        cambiados++;
      }
    }
    if (cambiados > 0) {
      this._reindexar();
      await this._save();
    }
    return cambiados;
  }

  async deshacerOcultado(token) {
    this._purgar();
    const d = this.deshacer.get(token);
    if (!d) return null;
    this.deshacer.delete(token);
    return this.mostrar(d.claves);
  }

  // ── Clave y llaves ──────────────────────────────────────────────────────

  comprobarClave(clave) {
    if (typeof clave !== 'string' || clave.length === 0) return false;
    if (!this.clave) {
      const a = Buffer.from(clave);
      const b = Buffer.from(CLAVE_INICIAL);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    const h = Buffer.from(derivar(clave, this.clave.salt), 'hex');
    const esperado = Buffer.from(this.clave.hash, 'hex');
    return h.length === esperado.length && crypto.timingSafeEqual(h, esperado);
  }

  /** Abre la caja: devuelve una llave temporal, o null si la clave no vale. */
  abrir(clave) {
    if (!this.comprobarClave(clave)) return null;
    this._purgar();
    const token = crypto.randomBytes(24).toString('hex');
    this.llaves.set(token, Date.now() + LLAVE_MS);
    return { llave: token, caduca: Date.now() + LLAVE_MS };
  }

  /** ¿La llave sigue valida? Cada uso la renueva: caduca por inactividad. */
  llaveValida(token) {
    this._purgar();
    if (!token || !this.llaves.has(token)) return false;
    this.llaves.set(token, Date.now() + LLAVE_MS);
    return true;
  }

  cerrar(token) {
    if (token) this.llaves.delete(token);
  }

  async cambiarClave(actual, nueva) {
    await this.ensureLoaded();
    if (!this.comprobarClave(actual)) return { ok: false, error: 'La clave actual no es correcta' };
    if (typeof nueva !== 'string' || nueva.length < 4) {
      return { ok: false, error: 'La clave nueva necesita al menos 4 caracteres' };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    this.clave = { salt, hash: derivar(nueva, salt) };
    await this._save();
    // Las llaves abiertas con la clave vieja dejan de valer.
    this.llaves.clear();
    return { ok: true };
  }

  _purgar() {
    const ahora = Date.now();
    for (const [t, caduca] of this.llaves) if (caduca < ahora) this.llaves.delete(t);
    for (const [t, d] of this.deshacer) if (d.caduca < ahora) this.deshacer.delete(t);
  }

  /** Entradas crudas, para listar lo que esta en un disco desconectado. */
  entradas() {
    return Array.from(this.items, ([clave, v]) => ({ clave, ...v }));
  }
}

module.exports = new OcultosManager();
