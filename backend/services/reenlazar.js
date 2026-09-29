/**
 * Lo tuyo sigue al archivo cuando cambia de sitio — Pensadero
 *
 * Favoritos, notas, colecciones y el candado se guardan por la identidad del
 * archivo (su mediaKey o su id de ruta). Mover una carpeta, pasar el material
 * de un disco a otro o cambiar la letra de un disco cambia esa identidad, y la
 * limpieza de huerfanos borraba la referencia: el 16/09/2026 una
 * sincronizacion vacio tres colecciones (114 archivos) de golpe.
 *
 * Aqui se casa lo que ha desaparecido en una pasada con lo que ha aparecido en
 * la misma: mismo nombre, mismo tamaño y misma fecha de modificacion. Copiar o
 * mover en Windows conserva la fecha de modificacion, asi que un archivo movido
 * casa y dos archivos distintos practicamente nunca. Si hay duda (dos
 * candidatos con la misma huella) no se casa nada: mejor no reenlazar que
 * reenlazar mal.
 *
 * Tambien lo usa el cambio de ubicacion de una biblioteca, donde la
 * correspondencia es exacta (misma ruta relativa) y no hace falta adivinar.
 */

const path = require('path');
const fallos = require('../utils/failureReason');

function msDe(fecha) {
  const t = fecha instanceof Date ? fecha.getTime() : new Date(fecha).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Nombre + tamaño + fecha de modificacion. null si falta algo. */
function huellaDe(f) {
  if (!f) return null;
  const nombre = String(f.name || (f.fullPath ? path.basename(f.fullPath) : '')).toLowerCase();
  const ms = msDe(f.modifiedAt);
  if (!nombre || typeof f.size !== 'number' || ms === null) return null;
  return `${nombre}|${f.size}|${ms}`;
}

function identidad(f) {
  return { id: f.id || null, mediaKey: f.mediaKey || null, fullPath: f.fullPath || null, name: f.name || null };
}

/**
 * Empareja archivos desaparecidos con archivos recien aparecidos.
 * @param {Array} desaparecidos - fileData de lo que ya no esta
 * @param {Array} llegados - MediaFile nuevos en esta pasada
 * @returns {Array<{de, a}>}
 */
function emparejar(desaparecidos, llegados) {
  if (!desaparecidos.length || !llegados.length) return [];
  const contar = (lista) => {
    const m = new Map();
    for (const f of lista) {
      const h = huellaDe(f);
      if (!h) continue;
      const e = m.get(h);
      if (e) e.n++; else m.set(h, { n: 1, f });
    }
    return m;
  };
  const fuera = contar(desaparecidos);
  const dentro = contar(llegados);
  const pares = [];
  for (const [h, d] of fuera) {
    const l = dentro.get(h);
    // Una sola posibilidad a cada lado, o nada.
    if (!l || d.n !== 1 || l.n !== 1) continue;
    pares.push({ de: identidad(d.f), a: identidad(l.f) });
  }
  return pares;
}

/**
 * Lleva favoritos, colecciones, notas, candado, etiquetas cambiadas a mano e
 * indice visual de `de` a `a`. Cada almacen guarda por su cuenta y solo si
 * algo ha cambiado.
 * @returns {Promise<{favoritos:number, colecciones:number, notas:number, ocultos:number, etiquetas:number, visual:number}>}
 */
async function aplicar(pares, almacenes) {
  const r = { favoritos: 0, colecciones: 0, notas: 0, ocultos: 0, etiquetas: 0, visual: 0, descartes: 0, proxies: 0 };
  if (!Array.isArray(pares) || pares.length === 0) return r;
  const { favoritos, colecciones, notas, ocultos, etiquetas, clipIndex, descartes, proxies } = almacenes || {};
  const paso = async (clave, nombre, fn) => {
    try {
      r[clave] = (await fn()) || 0;
    } catch (err) {
      fallos.record(`reenlazar ${nombre} de archivos movidos`, err);
    }
  };
  if (favoritos) await paso('favoritos', 'los favoritos', () => favoritos.reenlazar(pares));
  if (colecciones) await paso('colecciones', 'las colecciones', () => colecciones.reenlazar(pares));
  if (notas) await paso('notas', 'las notas', () => notas.reenlazar(pares));
  if (ocultos) await paso('ocultos', 'el material oculto', () => ocultos.reenlazar(pares));
  if (etiquetas) await paso('etiquetas', 'las etiquetas cambiadas a mano', () => etiquetas.reenlazar(pares));
  // Van por el id de ruta, que cambia con la letra del disco: sin esto las
  // tomas apartadas volvian a la galeria y los videos preparados se perdian
  // (seguian en el disco con el nombre viejo). 29/09/2026.
  if (descartes) await paso('descartes', 'las tomas apartadas', () => descartes.reenlazar(pares));
  if (proxies) await paso('proxies', 'los videos preparados', () => proxies.reenlazarPares(pares));
  if (clipIndex) {
    await paso('visual', 'el indice visual', async () => {
      let n = 0;
      for (const { de, a } of pares) {
        if (!de.id || !a.id || de.id === a.id) continue;
        const emb = clipIndex.get(de.id);
        if (!emb) continue;
        // Los momentos de un video van con el (remove los quita del id viejo).
        const momentos = typeof clipIndex.getMomentos === 'function' ? clipIndex.getMomentos(de.id) : [];
        if (!clipIndex.has(a.id)) {
          clipIndex.upsert(a.id, emb);
          if (momentos.length > 0) clipIndex.setMomentos(a.id, momentos);
        }
        clipIndex.remove(de.id);
        n++;
      }
      if (n > 0) await clipIndex.save();
      return n;
    });
  }
  return r;
}

// ── Desaparecidos recientes ─────────────────────────────────────────────
// Mover material rara vez cae en UNA pasada: se quita un disco (y lo suyo
// desaparece) y otro dia se añade el nuevo (y aparece). Lo desaparecido se
// recuerda DIAS_MEMORIA dias para poder casarlo cuando aparezca, y mientras
// tanto sus referencias no se borran (ver `refsProtegidas`).

const fs = require('fs').promises;
const { atomicWriteFile } = require('../utils/jsonStore');

const ARCHIVO_POOL = path.join(__dirname, '..', 'data', 'desaparecidos_recientes.json');
const DIAS_MEMORIA = 30;
const TOPE_POOL = 60000;

let pool = null;      // Map<rutaEnMinusculas, entrada>
let poolSucio = false;

async function cargarPool() {
  if (pool) return pool;
  pool = new Map();
  try {
    const lista = JSON.parse(await fs.readFile(ARCHIVO_POOL, 'utf-8'));
    for (const e of Array.isArray(lista) ? lista : []) {
      if (e && e.fullPath) pool.set(String(e.fullPath).toLowerCase(), e);
    }
  } catch { /* no existe todavia o ilegible: se empieza vacio (es regenerable) */ }
  return pool;
}

/** Apunta lo que acaba de desaparecer. */
async function recordar(desaparecidos) {
  await cargarPool();
  const desde = new Date().toISOString();
  for (const f of desaparecidos || []) {
    if (!f || !f.fullPath || !huellaDe(f)) continue;
    pool.set(String(f.fullPath).toLowerCase(), {
      ...identidad(f), size: f.size, modifiedAt: f.modifiedAt, desde,
    });
    poolSucio = true;
  }
}

/**
 * Casa lo recien llegado con lo desaparecido (de esta pasada o de las de los
 * ultimos dias). Lo casado sale de la memoria.
 * @returns {Promise<Array<{de, a}>>}
 */
async function casar(llegados) {
  await cargarPool();
  if (pool.size === 0 || !llegados || llegados.length === 0) return [];
  // Lo que vuelve a aparecer en su mismo sitio no se ha movido: fuera.
  for (const f of llegados) {
    if (f && f.fullPath && pool.delete(String(f.fullPath).toLowerCase())) poolSucio = true;
  }
  const pares = emparejar(Array.from(pool.values()), llegados);
  for (const { de } of pares) {
    if (de.fullPath && pool.delete(String(de.fullPath).toLowerCase())) poolSucio = true;
  }
  return pares;
}

/** Identidades de lo desaparecido hace poco: sus referencias NO se borran aun. */
async function refsProtegidas() {
  await cargarPool();
  const refs = new Set();
  for (const e of pool.values()) {
    if (e.id) refs.add(e.id);
    if (e.mediaKey) { refs.add(e.mediaKey); refs.add(String(e.mediaKey).toLowerCase()); }
    if (e.fullPath) refs.add(String(e.fullPath).replace(/\\+/g, '\\').trim().toLowerCase());
  }
  return refs;
}

/** Olvida lo que lleva mas de DIAS_MEMORIA fuera y guarda si algo cambio. */
async function guardarPool() {
  await cargarPool();
  const limite = Date.now() - DIAS_MEMORIA * 24 * 3600 * 1000;
  for (const [k, e] of pool) {
    if (!e.desde || new Date(e.desde).getTime() < limite) { pool.delete(k); poolSucio = true; }
  }
  if (pool.size > TOPE_POOL) {
    const viejos = Array.from(pool.entries()).sort((a, b) => String(a[1].desde).localeCompare(String(b[1].desde)));
    for (const [k] of viejos.slice(0, pool.size - TOPE_POOL)) pool.delete(k);
    poolSucio = true;
  }
  if (!poolSucio) return;
  try {
    await fs.mkdir(path.dirname(ARCHIVO_POOL), { recursive: true });
    await atomicWriteFile(ARCHIVO_POOL, JSON.stringify(Array.from(pool.values())));
    poolSucio = false;
  } catch (err) {
    fallos.record('guardar la lista de archivos desaparecidos', err, { path: ARCHIVO_POOL });
  }
}

module.exports = { huellaDe, emparejar, aplicar, recordar, casar, refsProtegidas, guardarPool, ARCHIVO_POOL };
