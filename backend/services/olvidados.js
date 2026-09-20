/**
 * Caras olvidadas — Pensadero
 *
 * Olvidar a una persona no es solo borrar su ficha. Al borrarla, sus caras
 * vuelven a ser "desconocidas" y el descubrimiento de caras frecuentes la
 * volveria a proponer como alguien nuevo en la siguiente pasada: eso no es
 * olvidar, es cambiarle el nombre por "¿quien es?".
 *
 * Aqui se guarda solo su HUELLA: el centroide de 512 numeros, sin nombre, sin
 * fotos, sin rutas. No sirve para reconocer a nadie (no entra en la
 * identificacion); solo le dice al descubrimiento "esta cara, no me la vuelvas
 * a proponer", tambien en material que se escanee despues.
 *
 * Se puede vaciar desde Personas ("volver a proponerlas"): entonces esas caras
 * vuelven a salir como desconocidas, como si nunca se hubiera olvidado nada.
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('../utils/jsonStore');
const { decodeEmbedding, encodeEmbedding } = require('./faceService');
const fallos = require('../utils/failureReason');

const ARCHIVO = path.join(__dirname, '..', 'data', 'olvidados.json');
// Mismo umbral que la identificacion: si esta cara se reconoceria como esa
// persona, es que es esa persona.
const UMBRAL = parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.5');

let huellas = null; // [{ centroide: Float32Array, desde: ISO }]

function cargar() {
  if (huellas) return huellas;
  try {
    const datos = JSON.parse(fs.readFileSync(ARCHIVO, 'utf-8'));
    huellas = (Array.isArray(datos.huellas) ? datos.huellas : [])
      .map(h => ({ centroide: decodeEmbedding(h.centroide_b64), desde: h.desde || null }))
      .filter(h => h.centroide && h.centroide.length === 512);
  } catch {
    // No existe todavia (nadie olvidado) o ilegible: sin huellas.
    huellas = [];
  }
  return huellas;
}

async function guardar() {
  const datos = {
    huellas: huellas.map(h => ({ centroide_b64: encodeEmbedding(h.centroide), desde: h.desde })),
  };
  try {
    await atomicWriteFile(ARCHIVO, JSON.stringify(datos));
  } catch (err) {
    // Sin guardar, la persona volveria a proponerse al reiniciar: que se sepa.
    fallos.record('guardar las caras olvidadas', err, { path: ARCHIVO });
    throw err;
  }
}

/** Anota la huella de alguien a quien se olvida. `centroide`: 512 numeros. */
async function agregar(centroide) {
  cargar();
  if (!centroide || centroide.length !== 512) return false;
  huellas.push({ centroide: Float32Array.from(centroide), desde: new Date().toISOString() });
  await guardar();
  return true;
}

/** ¿Es esta cara de alguien olvidado? `emb`: embedding de 512 normalizado. */
function esOlvidada(emb) {
  const lista = cargar();
  if (lista.length === 0 || !emb || emb.length !== 512) return false;
  for (const h of lista) {
    let dot = 0;
    for (let i = 0; i < 512; i++) dot += emb[i] * h.centroide[i];
    if (dot >= UMBRAL) return true;
  }
  return false;
}

function total() {
  return cargar().length;
}

/** Vuelve a proponer todas las caras olvidadas. */
async function vaciar() {
  cargar();
  const antes = huellas.length;
  huellas = [];
  await guardar();
  return antes;
}

module.exports = { agregar, esOlvidada, total, vaciar };
