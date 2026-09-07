/**
 * Preferencias de runtime — Pensadero
 *
 * Lo que el usuario cambia desde la UI y tiene que sobrevivir a un reinicio.
 * Gana al `.env`, que pasa a ser el valor de fabrica.
 *
 * Existe porque el selector de modelo VLM solo cambiaba `this.model` en
 * memoria: al reiniciar volvia al `.env` sin avisar, y un lote cortado y
 * reanudado podia quedar descrito mitad con un modelo y mitad con otro.
 *
 * @module config/runtime
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('../utils/jsonStore');

const RUNTIME_FILE = path.join(__dirname, 'runtime.json');

// Carga sincrona al importar: el constructor de VisualScanService necesita el
// valor antes de que nadie pueda await-ear nada.
let _prefs = {};
try {
  const parsed = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf-8'));
  if (parsed && typeof parsed === 'object') _prefs = parsed;
} catch {
  // No existe (primera ejecucion) o esta corrupto: valores de fabrica.
  _prefs = {};
}

/** Devuelve la preferencia guardada, o `fallback` si no hay ninguna. */
function get(key, fallback = null) {
  return Object.prototype.hasOwnProperty.call(_prefs, key) ? _prefs[key] : fallback;
}

/** Guarda una preferencia (escritura atomica) y la deja activa en memoria. */
async function set(key, value) {
  _prefs[key] = value;
  await atomicWriteFile(RUNTIME_FILE, JSON.stringify(_prefs, null, 2));
  return value;
}

/** Copia de todas las preferencias activas. Para /api/health y diagnostico. */
function all() {
  return { ..._prefs };
}

module.exports = { get, set, all, RUNTIME_FILE };
