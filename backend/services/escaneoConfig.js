/**
 * Que hace un escaneo — Pensadero
 *
 * El escaneo con IA son varios trabajos distintos que antes iban siempre
 * juntos. Aqui se decide cuales se encienden: para todo el archivo (global) y,
 * encima, por biblioteca (lo que una ruta no diga, lo hereda del global).
 *
 * Cada trabajo cuesta recursos distintos, y esa es la razon de poder apagarlos:
 * describir con el VLM es la GPU a tope unos segundos por archivo; el optical
 * flow es CPU; los proxies son NVENC. Quien escanea un disco de brutos quiza
 * solo quiera caras y busqueda visual esta noche, y descripciones otro dia.
 *
 * Donde vive:
 *   - global: `config/runtime.json` -> "escaneo": { descripcion: true, ... }
 *   - por ruta: `scan_paths.json` -> cada ruta puede llevar "escaneo": { caras: false }
 *     (solo las claves que difieren; una clave ausente hereda del global)
 *
 * Lo que NO decide este modulo: que archivos faltan. Eso lo sabe el
 * orquestador leyendo `entry.escaneo` de cada archivo (ver scanOrchestrator).
 */

const runtime = require('../config/runtime');

/**
 * Catalogo de capacidades, en el orden en que se enseñan. `recurso` y `coste`
 * son para la interfaz: dicen que se gasta, no lo miden.
 */
const CAPACIDADES = [
  {
    id: 'descripcion',
    nombre: 'Descripciones',
    detalle: 'Qué pasa en cada foto o vídeo, planos, luz y ambiente. Es lo que hace funcionar la búsqueda por lenguaje natural.',
    recurso: 'GPU',
    coste: 'alto',
  },
  {
    id: 'caras',
    nombre: 'Caras',
    detalle: 'Detecta caras y reconoce a las personas que ya conoces.',
    recurso: 'GPU',
    coste: 'medio',
  },
  {
    id: 'busquedaVisual',
    nombre: 'Búsqueda visual',
    detalle: 'Huella visual de cada archivo: buscar por imagen, parecidos, tomas gemelas y espacios.',
    recurso: 'GPU',
    coste: 'bajo',
  },
  {
    id: 'movimiento',
    nombre: 'Movimiento de cámara',
    detalle: 'Mide paneos, zooms y cortes en los vídeos. Más fiable que lo que adivina la IA.',
    recurso: 'CPU',
    coste: 'medio',
    soloVideo: true,
  },
  {
    id: 'proxies',
    nombre: 'Vídeos listos para ver',
    detalle: 'Prepara una copia reproducible de los vídeos que el navegador no abre (MTS, MOV de 10 bits…).',
    recurso: 'GPU (NVENC) y disco',
    coste: 'medio',
    soloVideo: true,
  },
];

const IDS = CAPACIDADES.map(c => c.id);

/** Todo encendido: el comportamiento de siempre. */
const DE_FABRICA = Object.freeze(Object.fromEntries(IDS.map(id => [id, true])));

/** Deja solo claves conocidas con valor booleano. */
function limpiar(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const id of IDS) {
    if (typeof obj[id] === 'boolean') out[id] = obj[id];
  }
  return out;
}

/** Capacidades globales efectivas (fabrica + lo guardado). */
function global() {
  return { ...DE_FABRICA, ...limpiar(runtime.get('escaneo', {})) };
}

/** Guarda cambios globales. `parcial` solo con lo que cambia. */
async function setGlobal(parcial) {
  const nuevo = { ...global(), ...limpiar(parcial) };
  await runtime.set('escaneo', nuevo);
  return nuevo;
}

/**
 * Sobrescrituras de una ruta, normalizadas. `null` en `cambios` borra la
 * sobrescritura de esa capacidad (vuelve a heredar).
 */
function aplicarARuta(pathConfig, cambios) {
  const actual = limpiar(pathConfig && pathConfig.escaneo);
  for (const id of IDS) {
    if (!cambios || !Object.prototype.hasOwnProperty.call(cambios, id)) continue;
    const v = cambios[id];
    if (v === null) delete actual[id];
    else if (typeof v === 'boolean') actual[id] = v;
  }
  return actual;
}

/** Capacidades efectivas de una ruta: global + lo que la ruta sobrescriba. */
function deRuta(pathConfig) {
  return { ...global(), ...limpiar(pathConfig && pathConfig.escaneo) };
}

const normRuta = (s) => String(s || '').replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');

/**
 * Capacidades para escanear `carpeta`, que puede ser la raiz de una ruta o una
 * subcarpeta suya: manda la biblioteca que la contiene (la mas especifica si
 * hubiera anidadas). Fuera de toda biblioteca, las globales.
 */
function paraCarpeta(carpeta, rutas) {
  const objetivo = normRuta(carpeta);
  let mejor = null;
  for (const r of Array.isArray(rutas) ? rutas : []) {
    const base = normRuta(r && r.path);
    if (!base) continue;
    if (objetivo === base || objetivo.startsWith(base + '\\')) {
      if (!mejor || base.length > normRuta(mejor.path).length) mejor = r;
    }
  }
  return mejor ? deRuta(mejor) : global();
}

/** Normaliza lo que llegue al orquestador: sin nada, todo encendido. */
function normalizar(caps) {
  return { ...DE_FABRICA, ...limpiar(caps) };
}

module.exports = {
  CAPACIDADES,
  IDS,
  DE_FABRICA,
  global,
  setGlobal,
  aplicarARuta,
  deRuta,
  paraCarpeta,
  normalizar,
};
