/**
 * Estado persistente del escaneo en curso — Pensadero
 *
 * Los jobs de escaneo vivian solo en memoria. Cuando el backend se caia a
 * mitad de una tanda larga, el supervisor lo relanzaba en segundos pero el
 * escaneo NO volvia: la GPU se quedaba parada el resto de la noche sin que
 * nada lo dijera. Paso el 07/09/2026 dos veces (10:30 y 23:22), la segunda a
 * 330 archivos de 4717.
 *
 * Aqui se guarda la INTENCION (que se estaba escaneando y con que opciones),
 * no el progreso archivo a archivo: de eso ya se encarga el catalogo, que se
 * vuelca cada pocos archivos y hace que un re-escaneo salte lo ya descrito.
 *
 * @module services/scanState
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('../utils/jsonStore');

const STATE_FILE = path.join(__dirname, '..', 'scan_state.json');

// Tope de reanudaciones sin que el escaneo avance. Si el proceso se estrella
// siempre en el mismo archivo, reanudar en bucle solo quema la noche: a partir
// de aqui se para y se deja dicho por que.
const MAX_REANUDACIONES_SIN_AVANCE = 3;

let _estado = null;

function _leer() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // No existe o esta corrupto: no hay escaneo que reanudar.
  }
}

async function _escribir(estado) {
  _estado = estado;
  try {
    await atomicWriteFile(STATE_FILE, JSON.stringify(estado, null, 2));
  } catch (err) {
    // Que falle el guardado no debe tumbar el escaneo: se pierde la capacidad
    // de reanudar, no el trabajo. Pero hay que decirlo.
    console.warn('[scan-state] no se pudo guardar el estado de reanudacion:', err.message);
  }
}

/**
 * Marca que empieza un escaneo. `tipo` es 'batch' (todas las rutas activas) o
 * 'carpeta' (una sola). Se conserva el contador de reanudaciones si es la
 * continuacion de un escaneo interrumpido con la misma intencion.
 */
async function iniciar({ tipo, rutas = [], carpeta = null, force = false, reanudando = false }) {
  const previo = reanudando ? (_estado || _leer()) : null;
  await _escribir({
    version: 1,
    activo: true,
    tipo,
    rutas,
    carpeta,
    force,
    iniciado: new Date().toISOString(),
    reanudaciones: previo ? (previo.reanudaciones || 0) + 1 : 0,
    // Progreso del arranque anterior, para detectar si reanudar sirve de algo.
    avancePrevio: previo ? (previo.ultimoAvance || 0) : 0,
    ultimoAvance: 0,
  });
}

/**
 * Registra cuantos archivos lleva descritos el escaneo actual. Lo llama el
 * orquestador en cada volcado de catalogo, asi que sale gratis. Sirve para
 * distinguir "se cayo pero avanzaba" de "se cae siempre en el mismo sitio".
 */
async function anotarAvance(done) {
  const estado = _estado || _leer();
  if (!estado || !estado.activo) return;
  if (typeof done !== 'number' || done <= (estado.ultimoAvance || 0)) return;
  estado.ultimoAvance = done;
  await _escribir(estado);
}

/** El escaneo termino (bien, cancelado o por error controlado): ya no hay nada que reanudar. */
async function finalizar() {
  const estado = _estado || _leer();
  if (!estado) return;
  await _escribir({ ...estado, activo: false, terminado: new Date().toISOString() });
}

/**
 * Devuelve el escaneo a reanudar, o null si no hay ninguno o no merece la pena.
 * Solo se llama al arrancar: si el fichero dice `activo: true` es que el
 * proceso anterior murio sin llegar a finalizar.
 */
function pendienteDeReanudar() {
  const estado = _leer();
  _estado = estado;
  if (!estado || !estado.activo) return null;

  const avanzo = (estado.ultimoAvance || 0) > (estado.avancePrevio || 0);
  if (!avanzo && (estado.reanudaciones || 0) >= MAX_REANUDACIONES_SIN_AVANCE) {
    console.error(
      `[scan-state] El escaneo se ha reanudado ${estado.reanudaciones} veces sin avanzar ` +
      `(atascado en ${estado.ultimoAvance} archivos). Se deja parado: reanudar otra vez solo ` +
      'repetiria el fallo. Revisa el log para ver en que archivo se cae.'
    );
    return null;
  }
  return estado;
}

module.exports = {
  iniciar,
  anotarAvance,
  finalizar,
  pendienteDeReanudar,
  STATE_FILE,
  MAX_REANUDACIONES_SIN_AVANCE,
};
