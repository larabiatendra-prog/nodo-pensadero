/**
 * Grupos de personas — Pensadero
 *
 * "Familia", "Los del instituto", "Equipo de rodaje": un nombre para varias
 * personas a la vez, para buscarlas juntas con @familia.
 *
 * Un grupo no es una persona mas ni cambia nada del reconocimiento: es solo
 * una lista de person_id con un nombre y la forma en que se busca:
 *
 *   - minimo: cuantos de ellos tienen que salir. null = el de fabrica (ver
 *     minimoPorDefecto en src/utils/grupos.ts, el 70% redondeado hacia arriba).
 *   - modo:   'archivo' (de fabrica) tienen que salir en la misma foto o video.
 *             'dia'     amplia: cuenta quien aparece a lo largo de ESE DIA, aunque
 *                       cada uno salga en un archivo distinto. Por eso ensena
 *                       archivos con menos gente de la pedida: es a proposito,
 *                       y el selector lo explica.
 *
 * De fabrica era 'dia' y confundia: "tienen que salir 3" y salian archivos con
 * una sola persona. Lo que se entiende al pedir 3 es 3 en el archivo.
 *
 * Se guarda en backend/data/grupos.json. Si una persona se borra desaparece
 * de sus grupos; si se fusiona, su sitio lo ocupa la superviviente.
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('../utils/jsonStore');
const fallos = require('../utils/failureReason');

const ARCHIVO = path.join(__dirname, '..', 'data', 'grupos.json');
const MODOS = new Set(['dia', 'archivo']);
const MAX_NOMBRE = 40;

let grupos = null; // [{ id, nombre, miembros:[], minimo, modo, creado }]
let cola = Promise.resolve();

/** Las escrituras van de una en una: dos cambios seguidos no se pisan. */
function enOrden(fn) {
  const siguiente = cola.then(fn, fn);
  cola = siguiente.catch(() => {});
  return siguiente;
}

function limpiarGrupo(g) {
  if (!g || typeof g !== 'object' || typeof g.id !== 'string') return null;
  const nombre = typeof g.nombre === 'string' ? g.nombre.trim().slice(0, MAX_NOMBRE) : '';
  if (!nombre) return null;
  const miembros = Array.isArray(g.miembros)
    ? [...new Set(g.miembros.filter(m => typeof m === 'string' && m.trim()))]
    : [];
  const minimo = Number.isInteger(g.minimo) && g.minimo >= 1 ? g.minimo : null;
  return {
    id: g.id,
    nombre,
    miembros,
    minimo,
    modo: MODOS.has(g.modo) ? g.modo : 'archivo',
    creado: typeof g.creado === 'string' ? g.creado : new Date().toISOString(),
  };
}

function cargar() {
  if (grupos) return grupos;
  try {
    const datos = JSON.parse(fs.readFileSync(ARCHIVO, 'utf-8'));
    grupos = (Array.isArray(datos.grupos) ? datos.grupos : []).map(limpiarGrupo).filter(Boolean);
  } catch (err) {
    // Aun no existe (nadie ha creado un grupo) o esta roto: se empieza vacio,
    // pero si estaba roto que quede dicho.
    if (err.code !== 'ENOENT') fallos.record('leer los grupos de personas', err, { path: ARCHIVO });
    grupos = [];
  }
  return grupos;
}

async function guardar() {
  try {
    await atomicWriteFile(ARCHIVO, JSON.stringify({ version: 1, grupos }, null, 2), { backup: true });
  } catch (err) {
    fallos.record('guardar los grupos de personas', err, { path: ARCHIVO });
    throw err;
  }
}

/** "Familia" y "familia " son el mismo nombre; con tildes o sin ellas, tambien. */
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function nuevoId() {
  return 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

class ErrorGrupo extends Error {
  constructor(mensaje, estado = 400) {
    super(mensaje);
    this.estado = estado;
  }
}

function comprobarNombre(nombre, idPropio = null) {
  const limpio = typeof nombre === 'string' ? nombre.trim().replace(/\s+/g, ' ') : '';
  if (!limpio) throw new ErrorGrupo('El grupo necesita un nombre.');
  if (limpio.length > MAX_NOMBRE) throw new ErrorGrupo(`El nombre no puede pasar de ${MAX_NOMBRE} letras.`);
  const clave = normalizar(limpio);
  if (cargar().some(g => g.id !== idPropio && normalizar(g.nombre) === clave)) {
    throw new ErrorGrupo(`Ya hay un grupo que se llama «${limpio}».`, 409);
  }
  return limpio;
}

function comprobarMiembros(miembros) {
  if (!Array.isArray(miembros)) throw new ErrorGrupo('Faltan las personas del grupo.');
  const limpios = [...new Set(miembros.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim()))];
  if (limpios.length < 2) throw new ErrorGrupo('Un grupo es de dos personas o más.');
  return limpios;
}

function listar() {
  return cargar().map(g => ({ ...g, miembros: [...g.miembros] }));
}

function crear({ nombre, miembros, minimo, modo }) {
  return enOrden(async () => {
    const grupo = limpiarGrupo({
      id: nuevoId(),
      nombre: comprobarNombre(nombre),
      miembros: comprobarMiembros(miembros),
      minimo,
      modo,
      creado: new Date().toISOString(),
    });
    cargar().push(grupo);
    try {
      await guardar();
    } catch (err) {
      grupos = grupos.filter(g => g.id !== grupo.id);
      throw err;
    }
    return { ...grupo };
  });
}

function actualizar(id, parcial = {}) {
  return enOrden(async () => {
    const lista = cargar();
    const i = lista.findIndex(g => g.id === id);
    if (i < 0) throw new ErrorGrupo('Ese grupo ya no existe.', 404);
    const antes = lista[i];
    const despues = { ...antes };
    if (parcial.nombre !== undefined) despues.nombre = comprobarNombre(parcial.nombre, id);
    if (parcial.miembros !== undefined) despues.miembros = comprobarMiembros(parcial.miembros);
    if (parcial.minimo !== undefined) {
      despues.minimo = parcial.minimo === null ? null : parseInt(parcial.minimo, 10);
      if (despues.minimo !== null && !(despues.minimo >= 1)) throw new ErrorGrupo('El mínimo es una persona o más.');
    }
    if (parcial.modo !== undefined) {
      if (!MODOS.has(parcial.modo)) throw new ErrorGrupo('Modo desconocido.');
      despues.modo = parcial.modo;
    }
    lista[i] = limpiarGrupo(despues);
    try {
      await guardar();
    } catch (err) {
      lista[i] = antes;
      throw err;
    }
    return { ...lista[i] };
  });
}

function borrar(id) {
  return enOrden(async () => {
    const lista = cargar();
    const i = lista.findIndex(g => g.id === id);
    if (i < 0) throw new ErrorGrupo('Ese grupo ya no existe.', 404);
    const [quitado] = lista.splice(i, 1);
    try {
      await guardar();
    } catch (err) {
      lista.splice(i, 0, quitado);
      throw err;
    }
    return quitado;
  });
}

/**
 * Una persona se borra (o se olvida): sale de todos sus grupos. Un grupo que
 * se queda con una sola persona se conserva igual; se ve en Personas y ahi se
 * decide si se completa o se borra.
 */
function quitarMiembro(personId) {
  return enOrden(async () => {
    let cambios = 0;
    for (const g of cargar()) {
      const n = g.miembros.length;
      g.miembros = g.miembros.filter(m => m !== personId);
      if (g.miembros.length !== n) cambios++;
    }
    if (cambios > 0) await guardar();
    return cambios;
  });
}

/** Dos fichas fusionadas: donde estaba la perdedora pasa a estar la superviviente. */
function renombrarMiembro(de, a) {
  return enOrden(async () => {
    let cambios = 0;
    for (const g of cargar()) {
      if (!g.miembros.includes(de)) continue;
      g.miembros = [...new Set(g.miembros.map(m => (m === de ? a : m)))];
      cambios++;
    }
    if (cambios > 0) await guardar();
    return cambios;
  });
}

module.exports = {
  listar,
  crear,
  actualizar,
  borrar,
  quitarMiembro,
  renombrarMiembro,
  ErrorGrupo,
};
