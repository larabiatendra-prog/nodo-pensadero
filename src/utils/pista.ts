// Interpretar lo escrito en la barra: la promocion silenciosa y la pista
// («¿Quizás…?») que sale debajo. Logica pura; la UI esta en SearchBar.tsx.
//
// Reglas duras: nunca corrige ni filtra por su cuenta, solo sugiere y el
// usuario decide con un clic. La unica excepcion es la promocion silenciosa,
// que solo ocurre cuando no cambia NI UN resultado. Toda accion lleva su
// recuento a la vista; si la alternativa da menos, el numero lo dice.

import { normalizeText } from './smartTags.ts';

/** Algo a lo que se puede cambiar un termino: una etiqueta o una persona. */
export type Valor =
  | { clase: 'etiqueta'; valor: string }
  | { clase: 'persona'; id: string; nombre: string };

/** Lo que se quita al aceptar: un termino de texto o una etiqueta (caso 0). */
export type Quitar = { clase: 'texto' | 'etiqueta'; valor: string };

export interface Pista {
  /** 0: etiqueta que es persona; 1: texto que es persona; 2: texto que es etiqueta. */
  caso: 0 | 1 | 2 | 'prefijo' | 'errata' | 'natural';
  /** La frase, en gris. */
  frase: string;
  /** La accion, subrayada y en el color de acento (lleva el recuento). */
  accion: string;
  n: number;
  quitar: Quitar;
  /** `natural`: no se cambia por nada, se busca la frase en lenguaje natural. */
  poner: Valor | { clase: 'natural'; texto: string };
}

interface Entrada {
  norm: string;
  valor: Valor;
  nombre: string;
}

/** Etiquetas y personas ya normalizadas, para no repetirlo en cada tecla. */
export interface Vocabulario {
  etiquetas: Entrada[];
  personas: Entrada[];
  etiquetaPorNorm: Map<string, Entrada>;
  personaPorNorm: Map<string, Entrada>;
}

export function prepararVocabulario(
  etiquetas: string[],
  personas: { person_id: string; display_name: string }[],
): Vocabulario {
  const v: Vocabulario = { etiquetas: [], personas: [], etiquetaPorNorm: new Map(), personaPorNorm: new Map() };
  for (const t of etiquetas) {
    const norm = normalizeText(t);
    if (!norm || v.etiquetaPorNorm.has(norm)) continue;
    const e: Entrada = { norm, nombre: t, valor: { clase: 'etiqueta', valor: t } };
    v.etiquetas.push(e);
    v.etiquetaPorNorm.set(norm, e);
  }
  for (const p of personas) {
    const nombre = p.display_name || p.person_id;
    const norm = normalizeText(nombre);
    if (!norm || v.personaPorNorm.has(norm)) continue;
    const e: Entrada = { norm, nombre, valor: { clase: 'persona', id: p.person_id, nombre } };
    v.personas.push(e);
    v.personaPorNorm.set(norm, e);
  }
  return v;
}

/**
 * Distancia de Levenshtein, cortando en cuanto supera `max` (devuelve max+1).
 * Poda barata: si la diferencia de longitud ya lo supera, ni se calcula.
 */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let minFila = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < minFila) minFila = v;
    }
    if (minFila > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Letras minimas para proponer un prefijo: con una o dos, cualquier cosa empieza asi. */
export const MIN_PREFIJO = 3;
/** Letras minimas para buscar erratas. */
export const MIN_ERRATA = 4;

function activo(e: Entrada, etiquetasActivas: Set<string>, personasActivas: string[]): boolean {
  return e.valor.clase === 'etiqueta'
    ? etiquetasActivas.has(e.norm)
    : personasActivas.includes(e.valor.id);
}

// La mas corta de las que cumplen; a igual largo, por orden alfabetico.
function masCorta(lista: Entrada[]): Entrada | null {
  let mejor: Entrada | null = null;
  for (const e of lista) {
    if (!mejor || e.norm.length < mejor.norm.length || (e.norm.length === mejor.norm.length && e.norm < mejor.norm)) mejor = e;
  }
  return mejor;
}

/** La etiqueta MAS CORTA que empieza por el texto; si no hay, la persona mas corta. */
export function prefijoMasCorto(texto: string, v: Vocabulario, excluir: (e: Entrada) => boolean = () => false): Valor | null {
  const q = normalizeText(texto);
  if (q.length < MIN_PREFIJO) return null;
  const cumple = (e: Entrada) => e.norm !== q && e.norm.startsWith(q) && !excluir(e);
  const e = masCorta(v.etiquetas.filter(cumple)) || masCorta(v.personas.filter(cumple));
  return e ? e.valor : null;
}

/**
 * La etiqueta o persona mas parecida a un texto con una errata: distancia 1
 * como mucho si tiene 5 letras o menos, 2 si es mas largo. A igual distancia,
 * la mas corta.
 */
export function errataMasCercana(texto: string, v: Vocabulario, excluir: (e: Entrada) => boolean = () => false): Valor | null {
  const q = normalizeText(texto);
  if (q.length < MIN_ERRATA) return null;
  const max = q.length <= 5 ? 1 : 2;
  let mejor: Entrada | null = null;
  let mejorD = max + 1;
  for (const e of [...v.etiquetas, ...v.personas]) {
    if (e.norm === q || excluir(e)) continue;
    const d = levenshtein(q, e.norm, max);
    if (d > max) continue;
    if (d < mejorD || (d === mejorD && mejor && e.norm.length < mejor.norm.length)) { mejor = e; mejorD = d; }
  }
  return mejor ? mejor.valor : null;
}

export interface EntradaPista {
  /** Terminos de texto libre activos; la pista habla del ultimo. */
  textos: string[];
  /** Etiquetas incluidas (las excluidas no se ofrecen a cambiar). */
  incluidas: string[];
  /** Incluidas y excluidas: lo que ya esta no se propone. */
  etiquetasActivas: string[];
  personasActivas: string[];
  vocabulario: Vocabulario;
  /** Cuantos resultados hay ahora. */
  resultados: number;
  /** Cuantos habria quitando `quitar` y poniendo `poner` (con el resto de filtros). */
  contar: (quitar: Quitar, poner: Valor) => number;
}

const nombreDe = (x: Valor) => (x.clase === 'etiqueta' ? x.valor : x.nombre);

/**
 * Una sola pista, la primera que se cumpla en este orden:
 *   0. sin texto, una etiqueta activa que se llama como una persona;
 *   1. el texto es una persona;  2. el texto es una etiqueta;
 *   3. una etiqueta (o persona) que empieza por el texto;
 *   4. solo sin resultados: una errata;
 *   5. solo sin resultados y sin errata: buscarlo con lenguaje natural.
 * Una accion que dejaria 0 resultados no se ofrece: se pasa a la siguiente
 * (salvo la 5, que no filtra: lanza otra busqueda).
 */
export function decidirPista(e: EntradaPista): Pista | null {
  const v = e.vocabulario;
  const etiquetasActivas = new Set(e.etiquetasActivas.map(normalizeText));
  const esActivo = (x: Entrada) => activo(x, etiquetasActivas, e.personasActivas);
  const texto = e.textos.length > 0 ? e.textos[e.textos.length - 1] : null;

  if (!texto) {
    // 0. La accion SUSTITUYE la etiqueta por la persona: sumarlas daria la
    // interseccion (menos que cualquiera de las dos).
    for (const t of e.incluidas) {
      const p = v.personaPorNorm.get(normalizeText(t));
      if (!p || esActivo(p)) continue;
      const quitar: Quitar = { clase: 'etiqueta', valor: t };
      const n = e.contar(quitar, p.valor);
      if (n > 0) return { caso: 0, frase: `«${t}» también es una persona.`, accion: `Filtrar solo por ${p.nombre} (${n})`, n, quitar, poner: p.valor };
    }
    return null;
  }

  const q = normalizeText(texto);
  const quitar: Quitar = { clase: 'texto', valor: texto };

  const persona = v.personaPorNorm.get(q);
  if (persona && !esActivo(persona)) {
    const n = e.contar(quitar, persona.valor);
    if (n > 0) return { caso: 1, frase: `«${texto}» también es una persona.`, accion: `Filtrar solo por ${persona.nombre} (${n})`, n, quitar, poner: persona.valor };
  }

  const etiqueta = v.etiquetaPorNorm.get(q);
  if (etiqueta && !esActivo(etiqueta)) {
    const n = e.contar(quitar, etiqueta.valor);
    if (n > 0) return { caso: 2, frase: `«${texto}» también es una etiqueta.`, accion: `Filtrar solo por la etiqueta (${n})`, n, quitar, poner: etiqueta.valor };
  }

  if (!etiqueta) {
    const pre = prefijoMasCorto(texto, v, esActivo);
    if (pre) {
      const n = e.contar(quitar, pre);
      if (n > 0) return { caso: 'prefijo', frase: `Ninguna etiqueta se llama «${texto}»: se busca como coincidencia de texto.`, accion: `¿Quizás ${nombreDe(pre)}? (${n})`, n, quitar, poner: pre };
    }
  }

  // Con resultados no se corrige: puede estar buscando eso exactamente.
  if (e.resultados === 0) {
    const err = errataMasCercana(texto, v, esActivo);
    if (err) {
      const n = e.contar(quitar, err);
      if (n > 0) return { caso: 'errata', frase: `Sin resultados para «${texto}».`, accion: `¿Quizás ${nombreDe(err)}? (${n})`, n, quitar, poner: err };
    }
    // 5. Ni errata: el modo normal busca palabras tal cual, y una frase («fotos
    // del perro») casi nunca aparece entera. Para eso esta el lenguaje natural,
    // que mucha gente no sabe que existe (es un icono a la izquierda).
    return { caso: 'natural', frase: `Sin resultados para «${texto}».`, accion: 'Buscarlo con lenguaje natural', n: 0, quitar, poner: { clase: 'natural', texto } };
  }
  return null;
}

/**
 * Promocion silenciosa al enviar: si el texto se llama exactamente como una
 * etiqueta o una persona y filtrar por ella deja EXACTAMENTE los mismos
 * archivos que buscarlo como texto, se pone como esa ficha sin preguntar.
 * `mismosResultados` compara los conjuntos (no solo cuantos: una persona
 * puede salir en archivos cuyo texto no la nombra).
 */
export function promocionSilenciosa(
  texto: string,
  v: Vocabulario,
  activas: { etiquetas: string[]; personas: string[] },
  mismosResultados: (poner: Valor) => boolean,
): Valor | null {
  const q = normalizeText(texto);
  if (!q) return null;
  const etiquetasActivas = new Set(activas.etiquetas.map(normalizeText));
  const candidatos = [v.etiquetaPorNorm.get(q), v.personaPorNorm.get(q)];
  for (const c of candidatos) {
    if (!c || activo(c, etiquetasActivas, activas.personas)) continue;
    if (mismosResultados(c.valor)) return c.valor;
  }
  return null;
}
