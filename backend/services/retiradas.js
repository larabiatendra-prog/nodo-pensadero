/**
 * Referencias retiradas — Pensadero
 *
 * Cuando la limpieza de huerfanos quita un archivo de una coleccion o de
 * favoritos, antes no quedaba rastro: el 16/09/2026 se vaciaron tres
 * colecciones y hoy no hay forma de saber que contenian. Aqui se apunta que
 * se quito, de donde y cual era su ruta, para poder reconstruirlo a mano.
 *
 * No se restaura solo: es la caja negra, no un deshacer. Guarda las ultimas
 * TOPE entradas (unas decenas de KB) en `data/referencias_retiradas.json`.
 */

const fs = require('fs').promises;
const path = require('path');
const { atomicWriteFile } = require('../utils/jsonStore');
const fallos = require('../utils/failureReason');

const ARCHIVO = path.join(__dirname, '..', 'data', 'referencias_retiradas.json');
const TOPE = 5000;

let cola = Promise.resolve();

/**
 * @param {'coleccion'|'favorito'} tipo
 * @param {Array<{ref:string, donde?:string, ruta?:string|null}>} items
 */
function anotar(tipo, items) {
  if (!Array.isArray(items) || items.length === 0) return cola;
  cola = cola.catch(() => {}).then(async () => {
    let lista = [];
    try {
      const raw = await fs.readFile(ARCHIVO, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) lista = parsed;
    } catch { /* no existe todavia o ilegible: se empieza de cero */ }
    const fecha = new Date().toISOString();
    for (const it of items) lista.push({ fecha, tipo, ...it });
    if (lista.length > TOPE) lista = lista.slice(lista.length - TOPE);
    await fs.mkdir(path.dirname(ARCHIVO), { recursive: true });
    await atomicWriteFile(ARCHIVO, JSON.stringify(lista, null, 2));
  }).catch(err => fallos.record('apuntar las referencias retiradas', err, { path: ARCHIVO }));
  return cola;
}

module.exports = { anotar, ARCHIVO };
