/**
 * Lectura segura de los registros que no se pueden regenerar (personas,
 * lugares) — Pensadero
 *
 * El registro vive en memoria y se escribe entero en cada cambio. Si al leerlo
 * algo salia mal (el archivo a medio escribir, bloqueado por el antivirus,
 * editado a mano y roto), la memoria se quedaba VACIA y el siguiente guardado
 * escribia un registro vacio encima: se perdian todos los nombres y alias.
 *
 * Esta lectura dice que ha pasado sin tocar la memoria, y quien la usa decide:
 * si ya tenia algo bueno cargado lo conserva; si es la primera vez, el archivo
 * roto se aparta (cuarentena `.corrupt-<fecha>`) para recuperarlo a mano y se
 * prueba la copia `.bak` que deja cada guardado.
 */

const fs = require('fs');
const path = require('path');
const { quarantineCorruptSync } = require('./jsonStore');

/** El contenido si es un registro valido (JSON con el array `campo`), o null. */
function registroValido(texto, campo) {
  try {
    // Un BOM al principio (Bloc de notas al guardar a mano) rompe JSON.parse.
    const datos = JSON.parse(String(texto).replace(/^﻿/, ''));
    return datos && Array.isArray(datos[campo]) ? datos : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} ruta
 * @param {string} campo - el array que tiene que traer ('people', 'spaces')
 * @param {{ primeraVez?: boolean, soloLectura?: boolean }} [opts]
 *   primeraVez: aun no hay nada bueno en memoria (se puede apartar y usar la copia).
 *   soloLectura: no apartar nada ni usar la copia (herramientas de diagnostico).
 * @returns {{
 *   estado: 'ok'|'no_existe'|'ilegible'|'roto',
 *   datos?: object, desdeCopia?: boolean, apartado?: string|null, error?: Error
 * }}
 *   ilegible: existe pero no se pudo leer (bloqueado, permisos): NO escribir encima.
 *   roto: se leyo y no es un registro valido; `apartado` dice si ya no esta ahi.
 */
function leerRegistro(ruta, campo, { primeraVez = false, soloLectura = false } = {}) {
  let texto;
  try {
    texto = fs.readFileSync(ruta, 'utf-8');
  } catch (err) {
    return { estado: err.code === 'ENOENT' ? 'no_existe' : 'ilegible', error: err };
  }
  const datos = registroValido(texto, campo);
  if (datos) return { estado: 'ok', datos };

  const error = new Error(`${path.basename(ruta)} está dañado: no es JSON válido o le falta "${campo}"`);
  if (!primeraVez || soloLectura) return { estado: 'roto', error, apartado: null };

  const apartado = quarantineCorruptSync(ruta);
  let copia = null;
  try { copia = registroValido(fs.readFileSync(`${ruta}.bak`, 'utf-8'), campo); } catch { /* no hay copia */ }
  if (copia) return { estado: 'ok', datos: copia, desdeCopia: true, apartado, error };
  return { estado: 'roto', error, apartado };
}

module.exports = { leerRegistro };
