/**
 * Papelera de Pensadero
 *
 * Borrar archivos del archivo NUNCA es inmediato. Primero vienen aqui: se
 * mueven (un rename: mismo disco, instantaneo, sin copiar) a
 * `<biblioteca>\.pensadero\papelera\<lote>\` conservando su ruta relativa, y
 * se apuntan en un manifiesto. Desde ahi se restauran a su sitio o se vacian,
 * y vaciar es lo unico que borra de verdad. Lo hace el usuario, con
 * confirmacion; nunca un proceso automatico.
 *
 * Por que no la papelera de Windows: en discos externos puede no existir, y
 * entonces "enviar a la papelera" borra en el acto y sin avisar. Aqui el
 * comportamiento es el mismo en cualquier disco y siempre reversible.
 *
 * La carpeta `.pensadero` ya la salta el escaneo, asi que lo que esta en la
 * papelera desaparece de la aplicacion en la siguiente sincronizacion. Cada
 * lote lleva ademas su propio `manifiesto.json` dentro de su carpeta: si se
 * perdiera el indice del backend, cada lote sigue sabiendo de donde vino cada
 * archivo.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { atomicWriteFile } = require('../utils/jsonStore');
const fallos = require('../utils/failureReason');

const INDICE = path.join(__dirname, '..', 'data', 'papelera.json');
const SUBCARPETA = path.join('.pensadero', 'papelera');

let lotes = null;
// Una operacion a la vez: mover, restaurar y vaciar tocan el mismo indice.
let cola = Promise.resolve();
const enOrden = (fn) => {
  const p = cola.then(fn, fn);
  cola = p.catch(() => {});
  return p;
};

function cargar() {
  if (lotes) return lotes;
  try {
    const d = JSON.parse(fs.readFileSync(INDICE, 'utf-8'));
    lotes = Array.isArray(d.lotes) ? d.lotes : [];
  } catch {
    lotes = [];
  }
  return lotes;
}

async function guardar() {
  await atomicWriteFile(INDICE, JSON.stringify({ lotes }, null, 2));
}

const norm = (p) => path.resolve(String(p || '')).toLowerCase().replace(/[\\/]+$/, '');

/** La biblioteca que contiene un archivo: la ruta configurada mas larga que lo abarque. */
function bibliotecaDe(fullPath, bibliotecas) {
  const f = norm(fullPath);
  let mejor = null;
  for (const b of bibliotecas) {
    if (!b || !b.path) continue;
    const raiz = norm(b.path);
    if ((f === raiz || f.startsWith(raiz + path.sep)) && (!mejor || raiz.length > norm(mejor.path).length)) mejor = b;
  }
  return mejor;
}

function nombreLote(motivo) {
  const d = new Date();
  const dos = (n) => String(n).padStart(2, '0');
  const sello = `${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}-${dos(d.getHours())}${dos(d.getMinutes())}${dos(d.getSeconds())}`;
  const slug = String(motivo || 'lote').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'lote';
  return `${sello}-${slug}`;
}

/**
 * Mueve archivos a la papelera. Nada se borra: cada archivo se renombra dentro
 * de su propia biblioteca, en el mismo disco.
 * @param {Array<{fullPath:string, name?:string, size?:number}>} files
 * @param {{motivo:string, bibliotecas:Array<{path:string}>}} opts
 */
function mover(files, { motivo, bibliotecas }) {
  return enOrden(async () => {
    cargar();
    const id = nombreLote(motivo);
    const archivos = [];
    const fallidos = [];
    const porRaiz = new Map(); // raiz de la biblioteca -> entradas del manifiesto

    for (const f of files) {
      const bib = bibliotecaDe(f.fullPath, bibliotecas || []);
      if (!bib) { fallidos.push({ ruta: f.fullPath, motivo: 'no está dentro de ninguna biblioteca' }); continue; }
      const raiz = path.resolve(bib.path);
      const relativa = path.relative(raiz, path.resolve(f.fullPath));
      const destino = path.join(raiz, SUBCARPETA, id, relativa);
      try {
        const st = await fsp.stat(f.fullPath);
        await fsp.mkdir(path.dirname(destino), { recursive: true });
        await fsp.rename(f.fullPath, destino);
        const entrada = { origen: path.resolve(f.fullPath), destino, bytes: st.size };
        archivos.push(entrada);
        if (!porRaiz.has(raiz)) porRaiz.set(raiz, []);
        porRaiz.get(raiz).push(entrada);
      } catch (err) {
        const causa = fallos.record('mover un archivo a la papelera', err, { path: f.fullPath });
        fallidos.push({ ruta: f.fullPath, motivo: causa.reason });
      }
    }

    // El manifiesto viaja con el lote: la papelera se puede entender sin el backend.
    for (const [raiz, entradas] of porRaiz) {
      const manifiesto = path.join(raiz, SUBCARPETA, id, 'manifiesto.json');
      try {
        await atomicWriteFile(manifiesto, JSON.stringify({ lote: id, motivo, fecha: new Date().toISOString(), archivos: entradas }, null, 2));
      } catch (err) {
        fallos.record('escribir el manifiesto de la papelera', err, { path: manifiesto });
      }
    }

    if (archivos.length > 0) {
      lotes.unshift({
        id, motivo, fecha: new Date().toISOString(), estado: 'en_papelera',
        bytes: archivos.reduce((s, a) => s + a.bytes, 0),
        raices: Array.from(porRaiz.keys()),
        archivos,
      });
      await guardar();
    }
    return { lote: archivos.length ? id : null, movidos: archivos.length, bytes: archivos.reduce((s, a) => s + a.bytes, 0), fallidos };
  });
}

/** Los lotes, con lo que sigue de verdad en disco y si su disco esta conectado. */
async function listar() {
  cargar();
  const out = [];
  for (const l of lotes) {
    if (l.estado === 'vaciado' || l.estado === 'restaurado') continue;
    let presentes = 0;
    let bytes = 0;
    for (const a of l.archivos) {
      if (fs.existsSync(a.destino)) { presentes++; bytes += a.bytes || 0; }
    }
    const conectado = (l.raices || []).every(r => fs.existsSync(r));
    out.push({
      id: l.id, motivo: l.motivo, fecha: l.fecha, estado: l.estado,
      archivos: l.archivos.length, presentes, bytes, conectado,
      // Unos pocos nombres para reconocer el lote sin abrir nada.
      muestra: l.archivos.slice(0, 6).map(a => path.basename(a.origen)),
    });
  }
  return out;
}

/** Devuelve cada archivo del lote a donde estaba. No pisa nada que ya exista alli. */
function restaurar(idLote) {
  return enOrden(async () => {
    cargar();
    const l = lotes.find(x => x.id === idLote);
    if (!l) return null;
    let restaurados = 0;
    const pendientes = [];
    const conflictos = [];
    for (const a of l.archivos) {
      if (!fs.existsSync(a.destino)) {
        // O ya se restauro antes o su disco no esta: si no esta el disco, queda pendiente.
        if (!fs.existsSync(path.parse(a.destino).root)) pendientes.push(a);
        continue;
      }
      if (fs.existsSync(a.origen)) { conflictos.push(a.origen); pendientes.push(a); continue; }
      try {
        await fsp.mkdir(path.dirname(a.origen), { recursive: true });
        await fsp.rename(a.destino, a.origen);
        restaurados++;
      } catch (err) {
        fallos.record('restaurar un archivo de la papelera', err, { path: a.origen });
        pendientes.push(a);
      }
    }
    if (pendientes.length === 0) {
      l.estado = 'restaurado';
      await borrarCarpetasDelLote(l);
    } else {
      l.archivos = pendientes;
    }
    await guardar();
    return { restaurados, pendientes: pendientes.length, conflictos };
  });
}

/** Carpetas del lote (una por biblioteca), si existen. */
async function borrarCarpetasDelLote(l) {
  for (const raiz of l.raices || []) {
    const dir = path.join(raiz, SUBCARPETA, l.id);
    if (!fs.existsSync(dir)) continue;
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch (err) {
      fallos.record('borrar la carpeta de un lote de la papelera', err, { path: dir });
    }
  }
}

/**
 * Vacia un lote: ESTO SI BORRA, y no tiene vuelta atras. Solo lo que este en
 * un disco conectado; lo demas se queda en el lote hasta que se conecte.
 */
function vaciar(idLote) {
  return enOrden(async () => {
    cargar();
    const l = lotes.find(x => x.id === idLote);
    if (!l) return null;
    let borrados = 0;
    let bytes = 0;
    const quedan = [];
    for (const a of l.archivos) {
      if (!fs.existsSync(path.parse(a.destino).root)) { quedan.push(a); continue; }
      if (!fs.existsSync(a.destino)) continue;
      try {
        await fsp.unlink(a.destino);
        borrados++;
        bytes += a.bytes || 0;
      } catch (err) {
        fallos.record('vaciar la papelera', err, { path: a.destino });
        quedan.push(a);
      }
    }
    if (quedan.length === 0) {
      l.estado = 'vaciado';
      l.vaciado = new Date().toISOString();
      await borrarCarpetasDelLote(l);
      // Lo vaciado no se recuerda: ni rutas ni nombres de lo que ya no existe.
      l.archivos = [];
    } else {
      l.archivos = quedan;
    }
    await guardar();
    return { borrados, bytes, quedan: quedan.length };
  });
}

module.exports = { mover, listar, restaurar, vaciar, bibliotecaDe };
