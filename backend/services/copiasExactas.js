/**
 * Copias exactas — Pensadero
 *
 * El mismo archivo, byte a byte, en dos sitios: un disco y su copia de
 * seguridad conectados a la vez, una carpeta duplicada al reorganizar, un
 * "clip (1).mp4" que dejo el explorador. La galeria los enseñaba dos veces
 * como si fueran dos recuerdos.
 *
 * No confundir con las tomas gemelas (services/duplicateFinder.js): alli son
 * archivos DISTINTOS que se parecen y la decision es cual vale mas. Aqui el
 * contenido es el mismo y la unica pregunta es DONDE se queda.
 *
 * Como se sabe que son el mismo archivo — por el contenido, nunca por el
 * nombre: una copia puede llamarse distinto y dos archivos distintos pueden
 * llamarse igual (IMG_0001.JPG de dos moviles).
 *   1. Solo se miran los archivos con EXACTAMENTE el mismo tamaño; el resto no
 *      puede ser copia de nada y no se lee.
 *   2. De esos, una huella: el tamaño mas el SHA-1 de tres trozos de 64 KB
 *      (principio, mitad y final); si el archivo es pequeño, entero. Leer
 *      terabytes enteros no escala; tres trozos bastan para el material de
 *      camara, que lleva cabeceras con fecha y numeracion propias. Lo que se
 *      hace con el resultado es esconder, nunca borrar: un falso positivo se
 *      deshace con un clic.
 *   3. La huella se guarda (data/huellas_contenido.json, regenerable) por
 *      archivo con su tamaño y fecha de modificacion: cada archivo se lee UNA
 *      vez, y al reconectar un disco no se vuelve a leer nada.
 *
 * Que se ve y que se esconde — siempre UNA copia de cada contenido, nunca
 * cero ni dos:
 *   - Lo que se guarda (data/copias.json, NO regenerable: es una decision del
 *     usuario) es QUE COPIA PREFIERES de cada contenido, no una lista fija de
 *     archivos escondidos. Se resuelve contra lo que esta conectado AHORA: si
 *     la preferida esta en un disco desconectado, se ve otra. Con una lista
 *     fija, trabajar un dia solo con el disco de backup haria desaparecer ese
 *     material de la galeria.
 *   - Un disco marcado como "copia de seguridad" en Rutas es en si mismo una
 *     decision: sus copias se esconden solas mientras el original este
 *     conectado, sin preguntar.
 *   - Lo que no tiene decision ni lo resuelve la copia de seguridad se sigue
 *     viendo entero y cuenta como pendiente: es lo que anuncia el aviso de la
 *     home.
 *   - El candado manda sobre todo: si una copia esta oculta, todas sus copias
 *     lo estan. Si no, un backup enseñaria lo que se escondio en el original.
 *
 * Se filtra en el SERVIDOR (ver `visibles`), igual que el candado: todas las
 * rutas que entregan material dejan de ver las copias sin tener que acordarse.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFile } = require('../utils/jsonStore');
const fallos = require('../utils/failureReason');
const mediaIdentity = require('../utils/mediaIdentity');

const DIR_DATOS = path.join(__dirname, '..', 'data');
const ARCHIVO_HUELLAS = path.join(DIR_DATOS, 'huellas_contenido.json');
const ARCHIVO_DECISIONES = path.join(DIR_DATOS, 'copias.json');

/** Tamaño de cada trozo que se lee para la huella. */
const TROZO = 64 * 1024;

// ── Estado ────────────────────────────────────────────────────────────────

let huellas = null;     // clave -> { s: tamaño, m: modificado, h: huella }
let decisiones = null;  // huella -> { quedan: [clave], origen: 'auto'|'manual', desde }
let colaDecisiones = Promise.resolve();

/** Lo que se ve y lo que no, resuelto contra la ultima lista de archivos. */
let resolucion = vacia();

const estado = {
  calculando: false,
  leidos: 0,
  porLeer: 0,
  ultimaVez: null,
};
let enCurso = null;
let pendienteDe = null; // { files, opts } si llego otra pasada mientras corria una

/** Lo que el servidor le presta: rutas, candado, huellas humanas, escaneo. */
let ctx = {
  getArchivos: () => [],
  cargarRutas: async () => [],
  estaOculto: () => false,
  contextoHumano: async () => () => ({}),
  trabajo: () => ({}),
  alCambiar: () => {},
};

function vacia() {
  return { grupos: [], escondidas: new Set(), escondidasClave: new Set(), grupoDe: new Map(), lista: null };
}

function configurar(deps) {
  ctx = { ...ctx, ...(deps || {}) };
}

/** Identidad de un archivo: la portable si la tiene (sobrevive a un cambio de letra). */
function claveDe(f) {
  return (f && (f.mediaKey || f.id)) || null;
}

function modificadoDe(f) {
  const m = f && f.modifiedAt;
  if (!m) return null;
  const t = m instanceof Date ? m.getTime() : Date.parse(m);
  return Number.isFinite(t) ? t : String(m);
}

// ── Persistencia ──────────────────────────────────────────────────────────

function leerJson(archivo, operacion) {
  try {
    return JSON.parse(fs.readFileSync(archivo, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') fallos.record(operacion, err, { path: archivo });
    return null;
  }
}

function cargarHuellas() {
  if (huellas) return huellas;
  const datos = leerJson(ARCHIVO_HUELLAS, 'leer las huellas de contenido');
  huellas = new Map(Object.entries((datos && datos.huellas) || {}));
  return huellas;
}

function cargarDecisiones() {
  if (decisiones) return decisiones;
  const datos = leerJson(ARCHIVO_DECISIONES, 'leer las decisiones de copias');
  decisiones = new Map();
  for (const [huella, d] of Object.entries((datos && datos.grupos) || {})) {
    const quedan = Array.isArray(d && d.quedan) ? d.quedan.filter(q => typeof q === 'string' && q) : [];
    if (!quedan.length) continue;
    decisiones.set(huella, {
      quedan,
      origen: d.origen === 'manual' ? 'manual' : 'auto',
      desde: typeof d.desde === 'string' ? d.desde : new Date().toISOString(),
    });
  }
  return decisiones;
}

async function guardarHuellas() {
  try {
    await atomicWriteFile(ARCHIVO_HUELLAS, JSON.stringify({ version: 1, huellas: Object.fromEntries(huellas) }));
  } catch (err) {
    fallos.record('guardar las huellas de contenido', err, { path: ARCHIVO_HUELLAS });
  }
}

/** Las escrituras de decisiones van de una en una: dos clics seguidos no se pisan. */
function guardarDecisiones() {
  colaDecisiones = colaDecisiones.then(async () => {
    try {
      const datos = { version: 1, grupos: Object.fromEntries(decisiones) };
      await atomicWriteFile(ARCHIVO_DECISIONES, JSON.stringify(datos, null, 2), { backup: true });
    } catch (err) {
      fallos.record('guardar las decisiones de copias', err, { path: ARCHIVO_DECISIONES });
      throw err;
    }
  });
  return colaDecisiones;
}

// ── Huella de contenido ───────────────────────────────────────────────────

async function calcularHuella(ruta, tamano) {
  const fd = await fsp.open(ruta, 'r');
  try {
    const hash = crypto.createHash('sha1');
    hash.update(String(tamano));
    if (tamano <= TROZO * 3) {
      const buf = Buffer.alloc(tamano);
      await fd.read(buf, 0, tamano, 0);
      hash.update(buf);
    } else {
      const buf = Buffer.alloc(TROZO);
      for (const pos of [0, Math.floor((tamano - TROZO) / 2), tamano - TROZO]) {
        const { bytesRead } = await fd.read(buf, 0, TROZO, pos);
        hash.update(buf.subarray(0, bytesRead));
      }
    }
    return `${tamano.toString(36)}-${hash.digest('hex').slice(0, 24)}`;
  } finally {
    await fd.close();
  }
}

/** Huella ya calculada y todavia valida para este archivo, o null. */
function huellaDe(f) {
  const e = huellas && huellas.get(claveDe(f));
  if (!e || e.s !== f.size || e.m !== modificadoDe(f)) return null;
  return e.h;
}

/**
 * Pone al dia las huellas de los archivos que PUEDEN tener copia y recalcula
 * que se ve. Se llama al terminar cada sincronizacion, sin esperarla: la
 * primera pasada sobre un disco de backup lee mucho y no puede retrasar nada.
 *
 * @param {Array} files - el catalogo entero de lo conectado (no el visible)
 * @param {{ bibliotecasLeidas?: Set<string> }} opts - las bibliotecas que se han
 *        recorrido en esta pasada: solo de ellas se puede afirmar que un
 *        archivo ya no existe.
 */
function actualizar(files, opts = {}) {
  if (enCurso) {
    pendienteDe = { files, opts };
    return enCurso;
  }
  enCurso = (async () => {
    try {
      await pasada(files, opts);
    } finally {
      enCurso = null;
    }
    if (pendienteDe) {
      const p = pendienteDe;
      pendienteDe = null;
      await actualizar(p.files, p.opts);
    }
  })();
  return enCurso;
}

async function pasada(files, opts) {
  cargarHuellas();
  cargarDecisiones();
  const lista = Array.isArray(files) ? files : [];

  const porTamano = new Map();
  for (const f of lista) {
    if (!f || !f.fullPath || !claveDe(f) || !(f.size > 0)) continue;
    const arr = porTamano.get(f.size);
    if (arr) arr.push(f); else porTamano.set(f.size, [f]);
  }
  const porLeer = [];
  for (const arr of porTamano.values()) {
    if (arr.length < 2) continue;
    for (const f of arr) if (!huellaDe(f)) porLeer.push(f);
  }

  estado.calculando = true;
  estado.leidos = 0;
  estado.porLeer = porLeer.length;
  // Con lo que ya se sabe, antes de leer nada: al arrancar las huellas estan
  // guardadas y las copias ya conocidas no tienen por que asomar mientras se
  // leen las nuevas.
  if (porLeer.length > 0) await recalcular(lista);
  let cambios = false;
  try {
    for (const f of porLeer) {
      try {
        const h = await calcularHuella(f.fullPath, f.size);
        huellas.set(claveDe(f), { s: f.size, m: modificadoDe(f), h });
        cambios = true;
      } catch (err) {
        // Un disco que se desconecta a mitad, un archivo bloqueado: se apunta
        // agregado por causa y se sigue. Ese archivo simplemente no entra en
        // ningun grupo hasta la siguiente pasada.
        fallos.record('leer un archivo para buscar copias exactas', err, { path: f.fullPath });
      }
      estado.leidos++;
      // Guardar cada tanto: una primera pasada larga que se corta no se pierde entera.
      if (cambios && estado.leidos % 500 === 0) await guardarHuellas();
    }

    if (opts.bibliotecasLeidas instanceof Set && opts.bibliotecasLeidas.size > 0) {
      // Solo se poda lo de las bibliotecas recorridas: las huellas de un disco
      // desconectado o desvinculado son justo lo que evita releerlo al volver.
      const presentes = new Set(lista.map(claveDe).filter(Boolean));
      for (const clave of huellas.keys()) {
        if (presentes.has(clave)) continue;
        const lib = mediaIdentity.libraryIdFromKey(clave);
        if (lib && opts.bibliotecasLeidas.has(lib)) { huellas.delete(clave); cambios = true; }
      }
    }
    if (cambios) await guardarHuellas();
  } finally {
    estado.calculando = false;
    estado.ultimaVez = new Date().toISOString();
  }

  await recalcular(lista);
}

// ── Que copia se queda ────────────────────────────────────────────────────

/**
 * Elige la copia que se queda y dice por que. Cada criterio solo desempata lo
 * que el anterior dejo empatado, y el motivo es el primero que decidio algo:
 *   1. La que tiene algo tuyo (favorito, nota, coleccion). Esconderla la
 *      sacaria de esa coleccion o de tus favoritos.
 *   2. La que NO esta en un disco marcado como copia de seguridad.
 *   3. La mas trabajada (descripcion, caras, busqueda visual): es la que ya
 *      sale en las busquedas.
 *   4. La del disco del sistema, que es el unico que seguro esta siempre.
 *   5. La de la biblioteca que va antes en Rutas: la primera que se añade
 *      suele ser la principal.
 *   6. La de ruta mas corta, y al final el orden alfabetico, para que la
 *      eleccion no baile de un dia para otro.
 */
function proponer(miembros, bibliotecas, humano) {
  const bib = (f) => bibliotecas.get(f.libraryId) || {};
  const criterios = [
    {
      valor: f => { const h = humano(f); return (h.favorito ? 1 : 0) + (h.nota ? 1 : 0) + (h.coleccion ? 1 : 0); },
      motivo: (f) => {
        const h = humano(f);
        const que = [h.favorito && 'favorito', h.nota && 'nota', h.coleccion && 'colección'].filter(Boolean);
        return `tiene algo tuyo (${que.join(', ')})`;
      },
    },
    { valor: f => (bib(f).copiaSeguridad ? 0 : 1), motivo: () => 'las otras están en un disco de copia de seguridad' },
    {
      valor: f => { const t = ctx.trabajo(f) || {}; return (t.descripcion ? 1 : 0) + (t.caras ? 1 : 0) + (t.visual ? 1 : 0); },
      motivo: () => 'es la que tiene más escaneo hecho',
    },
    { valor: f => (bib(f).enSistema ? 1 : 0), motivo: () => 'está en el disco del sistema, que siempre está conectado' },
    { valor: f => -(bib(f).orden ?? 999), motivo: () => 'su biblioteca va antes en Rutas' },
    { valor: f => -String(f.fullPath || '').length, motivo: () => 'es la de ruta más corta' },
  ];

  let quedan = miembros;
  let motivo = null;
  for (const c of criterios) {
    if (quedan.length === 1) break;
    const valores = quedan.map(c.valor);
    const max = Math.max(...valores);
    const siguen = quedan.filter((_, i) => valores[i] === max);
    if (siguen.length < quedan.length) {
      quedan = siguen;
      if (!motivo) motivo = c.motivo(siguen[0]);
    }
  }
  const elegida = [...quedan].sort((a, b) => String(a.fullPath).localeCompare(String(b.fullPath)))[0];
  return { file: elegida, motivo: motivo || 'son equivalentes: se queda la primera' };
}

// ── Resolucion ────────────────────────────────────────────────────────────

async function bibliotecasActuales() {
  const sistema = (process.env.SystemDrive || 'C:').toLowerCase();
  const mapa = new Map();
  let rutas = [];
  try {
    rutas = await ctx.cargarRutas();
  } catch (err) {
    fallos.record('leer las rutas para resolver copias', err, {});
  }
  (Array.isArray(rutas) ? rutas : []).forEach((r, i) => {
    if (!r || !r.id) return;
    mapa.set(r.id, {
      id: r.id,
      nombre: r.displayName || r.path,
      ruta: r.path,
      copiaSeguridad: !!r.copiaSeguridad,
      enSistema: typeof r.path === 'string' && r.path.toLowerCase().startsWith(sistema),
      orden: i,
    });
  });
  return mapa;
}

/**
 * Decide que se ve de cada grupo de copias con la lista de archivos dada.
 * Barato (no lee disco): se llama tras cada pasada y tras cada decision.
 */
async function recalcular(files) {
  // Sin lista, la del servidor en este momento: los objetos de archivo se
  // rehacen al refrescar una carpeta y los de la ultima pasada envejecen.
  const lista = Array.isArray(files) ? files : (ctx.getArchivos() || []);
  contexto = { bibliotecas: await bibliotecasActuales(), humano: await ctx.contextoHumano() };
  resolver(lista);
  return resumen();
}

/** Rutas y huellas humanas de la ultima resolucion: lo que `resolver` necesita sin esperar. */
let contexto = { bibliotecas: new Map(), humano: () => ({}) };

/**
 * El nucleo, sincrono: decide que se ve de cada grupo con la lista dada.
 * Va aparte de `recalcular` para que `visibles` pueda ponerse al dia en el
 * acto si la lista de archivos del servidor cambia por una via que no avisa
 * (desvincular una ruta, sincronizar una sola): con la resolucion vieja, una
 * copia seguiria escondida aunque su preferida ya no estuviera.
 */
function resolver(lista) {
  cargarHuellas();
  cargarDecisiones();
  const { bibliotecas, humano } = contexto;

  const porHuella = new Map();
  for (const f of lista) {
    if (!f || !f.id) continue;
    const h = huellaDe(f);
    if (!h) continue;
    const arr = porHuella.get(h);
    if (arr) arr.push(f); else porHuella.set(h, [f]);
  }

  const nueva = vacia();
  for (const [huella, miembros] of porHuella.entries()) {
    if (miembros.length < 2) continue;
    const decision = decisiones.get(huella) || null;
    let visibles;
    let estadoGrupo;

    if (decision) {
      const preferidas = new Set(decision.quedan);
      const presentes = miembros.filter(f => preferidas.has(claveDe(f)));
      if (presentes.length > 0) {
        visibles = presentes;
        estadoGrupo = 'decidido';
      } else {
        // La preferida no esta conectada: se ve otra en su lugar, sin tocar
        // la decision. Cuando vuelva su disco, vuelve ella.
        visibles = [proponer(miembros, bibliotecas, humano).file];
        estadoGrupo = 'suplente';
      }
    } else {
      const originales = miembros.filter(f => !(bibliotecas.get(f.libraryId) || {}).copiaSeguridad);
      visibles = originales.length > 0 ? originales : miembros;
      estadoGrupo = visibles.length > 1 ? 'pendiente' : 'copia-seguridad';
    }

    const idsVisibles = new Set(visibles.map(f => f.id));
    const grupo = { huella, tamano: miembros[0].size, miembros, visibles: idsVisibles, estado: estadoGrupo, decision };
    nueva.grupos.push(grupo);
    for (const f of miembros) {
      nueva.grupoDe.set(f.id, grupo);
      if (!idsVisibles.has(f.id)) {
        nueva.escondidas.add(f.id);
        const c = claveDe(f);
        if (c) nueva.escondidasClave.add(c);
      }
    }
  }

  nueva.lista = lista;
  const antes = firma(resolucion);
  resolucion = nueva;
  if (firma(nueva) !== antes) {
    try { ctx.alCambiar(); } catch { /* avisar es cortesia, no parte del calculo */ }
  }
}

/** Si la lista de archivos del servidor ya no es la resuelta, se resuelve otra vez. */
function alDia() {
  if (!resolucion.lista) return; // aun no se ha resuelto nada: no hay copias conocidas
  const actual = ctx.getArchivos();
  if (Array.isArray(actual) && actual !== resolucion.lista) resolver(actual);
}

/** Resume una resolucion para saber si algo visible ha cambiado. */
function firma(r) {
  const pendientes = r.grupos.filter(g => g.estado === 'pendiente').length;
  const ids = crypto.createHash('sha1').update([...r.escondidas].sort().join(',')).digest('hex');
  return `${r.grupos.length}|${pendientes}|${ids}`;
}

// ── Consulta ──────────────────────────────────────────────────────────────

/** Ids de las copias que caen bajo el candado de otra copia de su grupo. */
function bajoCandadoAjeno() {
  const ids = new Set();
  for (const g of resolucion.grupos) {
    if (!g.miembros.some(f => ctx.estaOculto(f))) continue;
    for (const f of g.miembros) ids.add(f.id);
  }
  return ids;
}

/**
 * Lo que se puede enseñar: sin las copias escondidas ni las de algo oculto.
 * Con `soloCandado`, las escondidas se quedan: abrir una copia concreta desde
 * su revision tiene que funcionar; enseñar lo que esta bajo candado, no.
 */
function visibles(files, { soloCandado = false } = {}) {
  alDia();
  if (!Array.isArray(files) || resolucion.grupos.length === 0) return files || [];
  const candado = bajoCandadoAjeno();
  const escondidas = soloCandado ? new Set() : resolucion.escondidas;
  if (escondidas.size === 0 && candado.size === 0) return files;
  return files.filter(f => !escondidas.has(f.id) && !candado.has(f.id));
}

/** Para listas que no pasan por `visibles` (la portada guarda sus propios nodos). */
function estaEscondida(f) {
  if (!f) return false;
  alDia();
  if ((f.id && resolucion.escondidas.has(f.id)) || (f.mediaKey && resolucion.escondidasClave.has(f.mediaKey))) return true;
  const g = f.id && resolucion.grupoDe.get(f.id);
  return !!g && g.miembros.some(m => ctx.estaOculto(m));
}

function resumen() {
  let pendientes = 0;
  let sobrantes = 0;
  let porCopiaSeguridad = 0;
  for (const g of resolucion.grupos) {
    if (g.estado === 'pendiente') { pendientes++; sobrantes += g.visibles.size - 1; }
    if (g.estado === 'copia-seguridad') porCopiaSeguridad += g.miembros.length - g.visibles.size;
  }
  return {
    calculando: estado.calculando,
    leidos: estado.leidos,
    porLeer: estado.porLeer,
    ultimaVez: estado.ultimaVez,
    grupos: resolucion.grupos.length,
    pendientes,
    sobrantes,
    escondidas: resolucion.escondidas.size,
    porCopiaSeguridad,
  };
}

const ORDEN_ESTADO = { pendiente: 0, suplente: 1, decidido: 2, 'copia-seguridad': 3 };

/**
 * Los grupos con todo lo que la vista de revision necesita para decidir, por
 * paginas: un disco de backup sin marcar son decenas de miles de grupos.
 *
 * Ademas dice entre que bibliotecas estan las pendientes (`pares`). Si casi
 * todas estan entre las mismas dos, lo sensato no es decidir una a una sino
 * marcar una como copia de seguridad, y la vista lo propone.
 *
 * @param {{ solo?: 'pendientes'|'todas', desde?: number, limite?: number }} opts
 */
async function listar({ solo = 'pendientes', desde = 0, limite = 60 } = {}) {
  await recalcular();
  const bibliotecas = await bibliotecasActuales();
  const humano = await ctx.contextoHumano();

  // Lo que esta bajo candado no se enseña ni aqui: seria una puerta trasera.
  const todos = resolucion.grupos.filter(g => !g.miembros.some(f => ctx.estaOculto(f)));
  const elegidos = todos
    .filter(g => solo === 'todas' || g.estado === 'pendiente')
    .map(g => ({ g, carpeta: path.dirname(g.miembros[0].relativePath || g.miembros[0].fullPath || '') }))
    .sort((a, b) => (ORDEN_ESTADO[a.g.estado] - ORDEN_ESTADO[b.g.estado])
      || a.carpeta.localeCompare(b.carpeta, 'es', { numeric: true }));

  const pares = new Map();
  for (const g of todos) {
    if (g.estado !== 'pendiente') continue;
    const libs = [...new Set(g.miembros.map(f => f.libraryId || '?'))].sort();
    if (libs.length !== 2) continue;
    const k = libs.join('|');
    pares.set(k, (pares.get(k) || 0) + 1);
  }
  const nombreDe = (id) => (bibliotecas.get(id) || {}).nombre || id;
  // La carpeta tal como se escribe en disco, relativa a su biblioteca. La
  // relativePath del catalogo va en minusculas: sirve para comparar, no para leer.
  const carpetaDe = (f) => {
    const dir = path.dirname(f.fullPath || '');
    const raiz = (bibliotecas.get(f.libraryId) || {}).ruta;
    if (raiz && dir.toLowerCase().startsWith(String(raiz).toLowerCase())) {
      return dir.slice(String(raiz).length).replace(/^[\\/]+/, '') || '.';
    }
    return dir;
  };

  const pagina = elegidos.slice(Math.max(0, desde), Math.max(0, desde) + Math.max(1, Math.min(limite, 500)));
  const grupos = pagina.map(({ g }) => {
    const propuesta = proponer(g.miembros, bibliotecas, humano);
    const preferidas = new Set(g.decision ? g.decision.quedan : []);
    return {
      huella: g.huella,
      tamano: g.tamano,
      estado: g.estado,
      origen: g.decision ? g.decision.origen : null,
      propuesta: { id: propuesta.file.id, motivo: propuesta.motivo },
      miembros: g.miembros.map(f => {
        const b = bibliotecas.get(f.libraryId) || {};
        return {
          id: f.id,
          name: f.name,
          type: f.type,
          fullPath: f.fullPath,
          carpeta: carpetaDe(f),
          thumbnail: f.thumbnail,
          duration: f.duration,
          biblioteca: { id: f.libraryId || null, nombre: b.nombre || null, copiaSeguridad: !!b.copiaSeguridad },
          humano: humano(f),
          trabajo: ctx.trabajo(f) || {},
          visible: g.visibles.has(f.id),
          preferida: preferidas.has(claveDe(f)),
        };
      }),
    };
  });

  return {
    total: elegidos.length,
    grupos,
    pares: [...pares.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, n]) => {
        const [a, b] = k.split('|');
        return { a: { id: a, nombre: nombreDe(a) }, b: { id: b, nombre: nombreDe(b) }, grupos: n };
      }),
  };
}

// ── Decisiones ────────────────────────────────────────────────────────────

/**
 * "Limpiar automaticamente": cada grupo pendiente se queda con su propuesta.
 * Devuelve las huellas decididas, que es lo que necesita el deshacer.
 */
async function limpiar() {
  cargarDecisiones();
  const bibliotecas = await bibliotecasActuales();
  const humano = await ctx.contextoHumano();
  const ahora = new Date().toISOString();
  const huellasDecididas = [];
  let aEsconder = 0;
  for (const g of resolucion.grupos) {
    if (g.estado !== 'pendiente') continue;
    if (g.miembros.some(f => ctx.estaOculto(f))) continue;
    const p = proponer(g.miembros, bibliotecas, humano);
    decisiones.set(g.huella, { quedan: [claveDe(p.file)], origen: 'auto', desde: ahora });
    huellasDecididas.push(g.huella);
    aEsconder += g.visibles.size - 1;
  }
  if (huellasDecididas.length) {
    await guardarDecisiones();
    await recalcular();
  }
  // `lote` identifica esta limpieza: deshacerla solo quita lo que ella decidio,
  // no lo que el usuario haya cambiado a mano despues en esos grupos.
  return { grupos: huellasDecididas.length, escondidas: aEsconder, huellas: huellasDecididas, lote: ahora };
}

/** Decision a mano sobre un grupo: `quedan` son ids de runtime de sus miembros. */
async function decidir(huella, quedanIds) {
  cargarDecisiones();
  const g = resolucion.grupos.find(x => x.huella === huella);
  if (!g) {
    const err = new Error('Ese grupo de copias ya no existe (¿se desconectó un disco?)');
    err.status = 404;
    throw err;
  }
  const pedidas = new Set(Array.isArray(quedanIds) ? quedanIds : []);
  const quedan = g.miembros.filter(f => pedidas.has(f.id)).map(claveDe).filter(Boolean);
  if (quedan.length === 0) {
    const err = new Error('Alguna copia tiene que quedarse');
    err.status = 400;
    throw err;
  }
  decisiones.set(huella, { quedan, origen: 'manual', desde: new Date().toISOString() });
  await guardarDecisiones();
  return recalcular();
}

/**
 * Quita decisiones: el grupo vuelve a pendiente (o a lo que diga la copia de
 * seguridad). Con `lote`, solo las de esa limpieza automatica que sigan igual.
 */
async function olvidar(huellasAQuitar, { lote = null } = {}) {
  cargarDecisiones();
  let quitadas = 0;
  for (const h of Array.isArray(huellasAQuitar) ? huellasAQuitar : []) {
    const d = decisiones.get(h);
    if (!d) continue;
    if (lote && (d.origen !== 'auto' || d.desde !== lote)) continue;
    decisiones.delete(h);
    quitadas++;
  }
  if (quitadas) {
    await guardarDecisiones();
    await recalcular();
  }
  return { quitadas, ...resumen() };
}

/**
 * Las copias exactas de cada archivo entre `files` (por la huella ya
 * calculada y al dia, ver `huellaDe`; lo que no tiene huella no tiene copia).
 * Para no volver a escanear lo que ya esta escaneado en otra copia
 * (utils/reaprovecharCopias.js) y decirlo en Rutas. No lee nada del disco.
 * @param {Array} files - el catalogo entero (tambien lo escondido)
 * @returns {{ copiasDe: (f) => Array }} las OTRAS copias de un archivo
 */
function indiceDeCopias(files) {
  cargarHuellas();
  const porHuella = new Map();
  for (const f of files || []) {
    const h = huellaDe(f);
    if (!h) continue;
    const l = porHuella.get(h);
    if (l) l.push(f); else porHuella.set(h, [f]);
  }
  return {
    copiasDe(f) {
      const h = huellaDe(f);
      const l = h ? porHuella.get(h) : null;
      if (!l || l.length < 2) return [];
      const yo = String(f.fullPath || '').toLowerCase();
      return l.filter(x => x !== f && String(x.fullPath || '').toLowerCase() !== yo);
    },
  };
}

module.exports = {
  configurar,
  actualizar,
  recalcular,
  visibles,
  estaEscondida,
  resumen,
  listar,
  limpiar,
  decidir,
  olvidar,
  indiceDeCopias,
  // Para pruebas y herramientas
  _proponer: proponer,
  _calcularHuella: calcularHuella,
};
