// «Acotar» — el embudo de etiquetas bajo la barra de busqueda.
//
// Dice por donde se puede seguir estrechando lo que ya se ve, para que nadie
// tenga que saberse el vocabulario de memoria. Logica pura (sin React ni red):
// la UI esta en components/Acotar.tsx y el calculo se lanza desde App.tsx
// sobre lo filtrado, que ya esta entero en memoria (no hace falta servidor).
//
// Umbrales medidos el 28/09/2026 sobre el archivo real (4.334 archivos con los
// discos de hoy, 16.283 contando el que estaba desconectado): lo escaneado
// lleva ~28 etiquetas por archivo (la mediana; lo no escaneado, 1-7), y 3 de
// cada 4 etiquetas distintas las lleva un solo archivo.
//  - cobertura 5-60 %: con el 10 % de suelo, filtrando por una persona solo
//    salian cosas de todo el archivo (flores, traje); con el 5 % aparecen las
//    del momento (novios, ramo, corbata). Por encima del 60 % no acota:
//    "cambio de escena" esta en el 68 % de los videos.
//  - alias por NOMBRE, no por coincidencia: la regla "si la mitad de lo que
//    lleva la etiqueta lleva tambien a la persona, es ella con otro nombre"
//    quitaba justo lo mas revelador. Filtrando por el novio de una boda,
//    "corbata" le acompañaba en el 76 %, "novios" en el 61 %, "ramo" en el
//    52 %; con otras personas, "espada" en el 100 % o "ring de boxeo" en el
//    82 %. Y la etiqueta que SI era ella (su nombre, de la carpeta de su
//    cumpleaños) solo le acompañaba en el 47 %: la cara no sale en todas las
//    tomas. Asi que es alias lo que se llama como ella.

import { normalizeText } from './smartTags.ts';

export const ACOTAR = {
  /** Con menos resultados no hay nada que acotar. */
  minResultados: 12,
  /** Etiquetas que dejarian menos archivos: callejon sin salida. */
  minArchivos: 3,
  coberturaMin: 0.05,
  coberturaMax: 0.6,
  calcular: 12,
  visibles: 5,
} as const;

/** Lo minimo de un archivo para el embudo. */
export interface ArchivoAcotable {
  tags: string[];
  faces?: { person_id?: string; display_name?: string }[];
}

export interface SugerenciaAcotar {
  etiqueta: string;
  /** Cuantos archivos quedan al pulsarla (con el mismo filtro que la barra). */
  n: number;
}

// Etiquetas normalizadas por archivo. Los objetos de archivo viven hasta que se
// recarga la lista, asi que se normaliza una vez por archivo y no en cada
// filtro (con 36.000 archivos y ~28 etiquetas cada uno se nota).
const cacheNorm = new WeakMap<object, { de: string[]; norm: string[] }>();

const cacheDesc = new WeakMap<object, { de: string; norm: string }>();

/**
 * Lo que la IA describio del archivo, normalizado y cacheado igual que las
 * etiquetas. La busqueda normal no lo miraba: "carruaje" o "novios" no
 * encontraban nada si no eran etiqueta, aunque la descripcion lo dijera.
 */
export function descripcionNormalizada(file: { visual_description?: string }): string {
  const d = typeof file.visual_description === 'string' ? file.visual_description : '';
  const hecho = cacheDesc.get(file);
  if (hecho && hecho.de === d) return hecho.norm;
  const norm = normalizeText(d);
  cacheDesc.set(file, { de: d, norm });
  return norm;
}

export function etiquetasNormalizadas(file: { tags: string[] }): string[] {
  const tags = Array.isArray(file.tags) ? file.tags : [];
  const hecho = cacheNorm.get(file);
  if (hecho && hecho.de === tags) return hecho.norm;
  const norm = tags.map(normalizeText);
  cacheNorm.set(file, { de: tags, norm });
  return norm;
}

/**
 * ¿El archivo pasa por la etiqueta? Es EL filtro de etiquetas de la galeria
 * (incluidas y excluidas): coincidencia por trozo, sin mayusculas ni tildes,
 * asi que "alegria" y "alegría" son la misma. El embudo cuenta con esto para
 * que el numero de cada pill sea lo que sale al pulsarla.
 */
export function llevaEtiqueta(file: { tags: string[] }, etiqueta: string): boolean {
  return llevaEtiquetaNormalizada(file, normalizeText(etiqueta));
}

/** Igual, con la etiqueta ya normalizada (para filtrar muchos archivos). */
export function llevaEtiquetaNormalizada(file: { tags: string[] }, q: string): boolean {
  if (!q) return true;
  return etiquetasNormalizadas(file).some(t => t.includes(q));
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre'];

// Palabras que ya cubre el filtro de tipo (foto, video, audio, export).
const DE_TIPO = new Set(['video', 'videos', 'foto', 'fotos', 'imagen', 'imagenes', 'audio',
  'audios', 'export', 'exports']);

/**
 * Etiquetas que no se sugieren porque ya las cubre otro filtro (fechas, tipo)
 * o porque no dicen nada. Ojo: no vale "tiene cifras" ("fiesta 40 años" es una
 * etiqueta buena); lo que sobra es lo que no tiene ni una letra ("2.7", el
 * numero de orden de una carpeta, o "24-10-12", una fecha).
 */
export function cubiertaPorOtroFiltro(etiquetaNorm: string): boolean {
  if (!/\p{L}/u.test(etiquetaNorm)) return true;
  if (MESES.includes(etiquetaNorm)) return true;
  if (DE_TIPO.has(etiquetaNorm)) return true;
  return false;
}

// Huella de un conjunto de posiciones: dos etiquetas que dejan EXACTAMENTE los
// mismos archivos ("Cumpleaños" y el nombre de la carpeta del cumpleaños) son
// una sola sugerencia.
function huella(indices: number[]): string {
  let h = 2166136261;
  for (const i of indices) { h ^= i; h = Math.imul(h, 16777619); }
  return `${indices.length}:${h >>> 0}`;
}

/** Cuantos archivos del catalogo llevan cada etiqueta (normalizada, una vez por archivo). */
export function frecuenciasCatalogo(catalogo: ArchivoAcotable[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const f of catalogo) {
    for (const t of new Set(etiquetasNormalizadas(f))) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

export interface EntradaAcotar {
  /** Lo que se esta viendo ahora (ya filtrado). */
  subconjunto: ArchivoAcotable[];
  /** Todo el archivo, para medir lo comun que es cada etiqueta. */
  catalogo: ArchivoAcotable[];
  /** frecuenciasCatalogo(catalogo), calculado aparte porque cambia poco. */
  frecuencias: Map<string, number>;
  /** Etiquetas activas, incluidas o excluidas. */
  activas: string[];
  /** Terminos de texto libre activos: su etiqueta homonima ya la ofrece la pista. */
  textos?: string[];
  /** Personas activas (person_id). */
  personas?: string[];
  opciones?: Partial<typeof ACOTAR>;
}

/**
 * Hasta `calcular` etiquetas que acotan lo que se ve, de mas a menos
 * reveladora. Se ordena por LIFT (cobertura aqui / frecuencia en todo el
 * archivo) y no por frecuencia: la frecuencia bruta devuelve siempre las
 * genericas ("adulto", "exterior"), que estan en todas partes.
 */
export function sugerirAcotar(e: EntradaAcotar): SugerenciaAcotar[] {
  const o = { ...ACOTAR, ...(e.opciones || {}) };
  const sub = e.subconjunto;
  const total = e.catalogo.length;
  if (sub.length < o.minResultados || sub.length >= total || total === 0) return [];

  const fuera = new Set([...e.activas, ...(e.textos || [])].map(normalizeText));

  // Indice invertido de lo que se ve: etiqueta normalizada -> posiciones (en
  // orden). De paso, la grafia mas repetida de cada una para enseñarla
  // ("alegría" y "alegria" son la misma).
  const posiciones = new Map<string, number[]>();
  const grafias = new Map<string, Map<string, number>>();
  for (let i = 0; i < sub.length; i++) {
    const f = sub[i];
    const norm = etiquetasNormalizadas(f);
    const vistas = new Set<string>();
    for (let j = 0; j < norm.length; j++) {
      const k = norm[j];
      if (!k || vistas.has(k)) continue;
      vistas.add(k);
      let p = posiciones.get(k);
      if (!p) { p = []; posiciones.set(k, p); }
      p.push(i);
      let g = grafias.get(k);
      if (!g) { g = new Map(); grafias.set(k, g); }
      g.set(f.tags[j], (g.get(f.tags[j]) || 0) + 1);
    }
  }

  // Alias de las personas activas: la etiqueta que se llama como ella (su
  // nombre entero, el de pila o su id) es ella con otro nombre. "Casa X" no:
  // eso es un sitio, y acota.
  const personas = e.personas || [];
  const alias = new Set<string>();
  if (personas.length > 0) {
    for (const f of sub) {
      for (const cara of f.faces || []) {
        if (!cara.person_id || !personas.includes(cara.person_id)) continue;
        alias.add(normalizeText(cara.person_id.replace(/_/g, ' ')));
        const nombre = normalizeText(cara.display_name || '');
        if (nombre) {
          alias.add(nombre);
          const pila = nombre.split(/[\s(]+/)[0];
          if (pila.length >= 3) alias.add(pila);
        }
      }
    }
  }

  const candidatas: { k: string; n: number; lift: number }[] = [];
  for (const [k, p] of posiciones) {
    const n = p.length;
    if (n < o.minArchivos || fuera.has(k) || alias.has(k) || cubiertaPorOtroFiltro(k)) continue;
    const cobertura = n / sub.length;
    if (cobertura < o.coberturaMin || cobertura > o.coberturaMax) continue;
    const enCatalogo = e.frecuencias.get(k) || n;
    candidatas.push({ k, n, lift: cobertura / (enCatalogo / total) });
  }
  candidatas.sort((a, b) => b.lift - a.lift || b.n - a.n);

  const claves = [...posiciones.keys()];
  const salida: SugerenciaAcotar[] = [];
  const huellas = new Set<string>();
  for (const c of candidatas) {
    if (salida.length >= o.calcular) break;

    // Recuento con el filtro de verdad (por trozo): "luz" deja pasar tambien
    // "luz_natural". Lo que sale al pulsar es esto, no el recuento exacto.
    const familia = claves.filter(k => k.includes(c.k));
    let indices = posiciones.get(c.k)!;
    if (familia.length > 1) {
      const union = new Set<number>();
      for (const k of familia) for (const i of posiciones.get(k)!) union.add(i);
      indices = [...union].sort((a, b) => a - b);
    }
    const n = indices.length;
    if (n < o.minArchivos || n >= sub.length || n / sub.length > o.coberturaMax) continue;
    const h = huella(indices);
    if (huellas.has(h)) continue;
    huellas.add(h);

    let etiqueta = c.k, max = -1;
    for (const [t, veces] of grafias.get(c.k)!) if (veces > max) { etiqueta = t; max = veces; }
    salida.push({ etiqueta, n });
  }
  return salida;
}

/**
 * Para saber si el conjunto de sugerencias ha cambiado (por contenido, no por
 * referencia): al cambiar, la fila vuelve a plegarse.
 */
export function claveSugerencias(s: SugerenciaAcotar[]): string {
  return s.map(x => normalizeText(x.etiqueta)).join('\u0001');
}
