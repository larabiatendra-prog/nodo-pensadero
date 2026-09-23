/**
 * Etiquetas cambiadas a mano — Pensadero
 *
 * Las etiquetas de un archivo se DERIVAN en cada sincronizacion: del nombre
 * del archivo, de su carpeta y de lo que describio el escaneo. Renombrar,
 * borrar, fusionar o añadir una etiqueta desde el gestor solo cambiaba la
 * copia en memoria del servidor, asi que la siguiente sincronizacion (el
 * vigilante de discos la lanza solo) o un reinicio la devolvia como estaba.
 *
 * Aqui se guarda lo que el usuario ha cambiado, por archivo, como una capa
 * encima de lo derivado:
 *   - mas:   etiquetas que ha añadido.
 *   - menos: etiquetas que ha quitado (aunque el nombre o la carpeta las
 *            vuelvan a dar, no salen).
 * y se aplica al final de cada sincronizacion y de cada refresco de carpeta:
 * etiquetas = (derivadas - menos) + mas.
 *
 * Se guarda por mediaKey (sobrevive a un cambio de letra del disco) y, si el
 * archivo se mueve, lo lleva `services/reenlazar.js`. No es regenerable: es
 * trabajo del usuario. Vive en backend/data/etiquetas_manuales.json.
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteFile, quarantineCorruptSync } = require('../utils/jsonStore');
const fallos = require('../utils/failureReason');

const ARCHIVO = path.join(__dirname, '..', 'data', 'etiquetas_manuales.json');

let porClave = null;   // clave (mediaKey o id) -> { mas: string[], menos: string[] }
// Si el archivo existe pero no se pudo leer, no se escribe encima: se
// perderia lo que tiene. Se reintenta la lectura en el siguiente cambio.
let ilegible = false;
let cola = Promise.resolve();

/** Las escrituras van de una en una: dos cambios seguidos no se pisan. */
function enOrden(fn) {
  const siguiente = cola.then(fn, fn);
  cola = siguiente.catch(() => {});
  return siguiente;
}

function limpiarLista(l) {
  return Array.isArray(l) ? [...new Set(l.filter(t => typeof t === 'string' && t.trim()))] : [];
}

function cargar() {
  if (porClave && !ilegible) return porClave;
  let texto;
  try {
    texto = fs.readFileSync(ARCHIVO, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') { porClave = new Map(); ilegible = false; return porClave; }
    // Bloqueado, sin permiso...: se trabaja en memoria sin guardar.
    fallos.record('leer las etiquetas cambiadas a mano', err, { path: ARCHIVO });
    if (!porClave) porClave = new Map();
    ilegible = true;
    return porClave;
  }
  try {
    const datos = JSON.parse(texto);
    const m = new Map();
    for (const [clave, e] of Object.entries((datos && datos.archivos) || {})) {
      const mas = limpiarLista(e && e.mas);
      const menos = limpiarLista(e && e.menos);
      if (mas.length || menos.length) m.set(clave, { mas, menos });
    }
    porClave = m;
    ilegible = false;
  } catch (err) {
    // Roto: se aparta (cuarentena) para poder recuperarlo a mano y se empieza
    // de cero, en vez de escribir encima en el siguiente cambio.
    fallos.record('leer las etiquetas cambiadas a mano', err, { path: ARCHIVO });
    quarantineCorruptSync(ARCHIVO);
    porClave = new Map();
    ilegible = false;
  }
  return porClave;
}

async function guardar() {
  if (ilegible) {
    cargar();
    if (ilegible) {
      throw new Error('No se pudo leer etiquetas_manuales.json, y guardar ahora borraría lo que tiene. Mira /api/health (incidencias).');
    }
  }
  const archivos = {};
  for (const [clave, e] of porClave) archivos[clave] = e;
  try {
    await atomicWriteFile(ARCHIVO, JSON.stringify({ version: 1, archivos }, null, 2), { backup: true });
  } catch (err) {
    fallos.record('guardar las etiquetas cambiadas a mano', err, { path: ARCHIVO });
    throw err;
  }
}

const claveDe = (f) => (f && (f.mediaKey || f.id)) || null;

/** Lo cambiado a mano de un archivo (por su mediaKey o, si no la tiene, por su id). */
function entradaDe(f) {
  const m = cargar();
  if (!f) return null;
  return (f.mediaKey && m.get(f.mediaKey)) || (f.id && m.get(f.id)) || null;
}

function aplicarUno(f, e) {
  if (!e) return false;
  const menos = new Set(e.menos);
  const antes = Array.isArray(f.tags) ? f.tags : [];
  const tags = antes.filter(t => !menos.has(t));
  for (const t of e.mas) if (!tags.includes(t)) tags.push(t);
  f.tags = tags;
  return true;
}

/**
 * Pone lo cambiado a mano encima de las etiquetas derivadas. Muta y devuelve
 * la misma lista (como folderNames y fechaArchivo).
 * @param {Array} files
 */
function aplicar(files) {
  const m = cargar();
  if (m.size === 0 || !Array.isArray(files)) return files;
  for (const f of files) {
    if (f) aplicarUno(f, entradaDe(f));
  }
  return files;
}

/**
 * Apunta un cambio de etiquetas sobre unos archivos y lo aplica ya a esos
 * mismos objetos. Quitar gana a lo derivado; añadir despues de quitar (o al
 * reves) deja la ultima decision.
 * @param {Array} files - los MediaFile afectados
 * @param {{anadir?: string[], quitar?: string[]}} cambio
 * @returns {Promise<number>} archivos cambiados
 */
function cambiar(files, { anadir = [], quitar = [] } = {}) {
  return enOrden(async () => {
    const m = cargar();
    const mas = limpiarLista(anadir);
    const menos = limpiarLista(quitar);
    let n = 0;
    for (const f of Array.isArray(files) ? files : []) {
      const clave = claveDe(f);
      if (!clave) continue;
      const e = entradaDe(f) || { mas: [], menos: [] };
      for (const t of menos) {
        e.mas = e.mas.filter(x => x !== t);
        if (!e.menos.includes(t)) e.menos.push(t);
      }
      for (const t of mas) {
        e.menos = e.menos.filter(x => x !== t);
        if (!e.mas.includes(t)) e.mas.push(t);
      }
      // Se guarda por la clave buena: si estaba por id y ya tiene mediaKey, se pasa.
      if (f.mediaKey && f.id && f.id !== f.mediaKey) m.delete(f.id);
      if (e.mas.length || e.menos.length) m.set(clave, e);
      else m.delete(clave);
      aplicarUno(f, e);
      n++;
    }
    if (n > 0) await guardar();
    return n;
  });
}

/**
 * Un archivo ha cambiado de sitio: lo cambiado a mano pasa a su identidad
 * nueva. Ver services/reenlazar.js.
 * @returns {Promise<number>} archivos reenlazados
 */
function reenlazar(pares) {
  return enOrden(async () => {
    const m = cargar();
    let n = 0;
    for (const { de, a } of pares || []) {
      const nueva = a && (a.mediaKey || a.id);
      if (!nueva || !de) continue;
      const vieja = [de.mediaKey, de.id].find(k => k && k !== nueva && m.has(k));
      if (!vieja) continue;
      if (!m.has(nueva)) m.set(nueva, m.get(vieja));
      m.delete(vieja);
      n++;
    }
    if (n > 0) await guardar();
    return n;
  });
}

module.exports = { aplicar, cambiar, reenlazar, ARCHIVO };
