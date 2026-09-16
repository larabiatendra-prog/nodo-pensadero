/**
 * Duplicate Finder — Pensadero NODO
 *
 * Agrupa las TOMAS GEMELAS: clips o fotos casi identicos entre si. En material
 * de camara esto es el pan de cada dia — doce intentos del mismo plano, la
 * rafaga de doce fotos de la misma escena — y la galeria las enseña las doce
 * veces como si fueran doce recuerdos distintos.
 *
 * Como se decide "casi identico":
 *   - Se compara el embedding SigLIP-2 que el escaneo ya dejo en `clip_index`
 *     (no se re-corre nada: es producto escalar sobre vectores normalizados).
 *   - SOLO se comparan archivos de la MISMA CARPETA. Las tomas de un plano
 *     viven juntas; comparar todo contra todo seria O(N^2) sobre 4000 archivos
 *     y ademas emparejaria cosas de eventos distintos que solo se parecen en
 *     "tipo de escena" (mismo error que ya documenta spacesRegistry).
 *   - El umbral por defecto es alto a proposito (0.96). Por debajo de ~0.93
 *     empiezan a entrar planos distintos del mismo sitio, que NO son gemelos.
 *
 * Limitacion conocida: si el mismo plano se repartio entre una carpeta y su
 * subcarpeta "clips", cada mitad se agrupa por su lado.
 */

const path = require('path');
const clipIndex = require('../clipIndex');

const UMBRAL_POR_DEFECTO = 0.96;
// Tope de seguridad por carpeta: 1500 archivos son ~1.1M pares, ya al limite
// de lo razonable en una peticion sincrona. Por encima, se salta y se avisa.
const MAX_POR_CARPETA = 1500;

/**
 * Minimo de fotogramas para considerar algo una secuencia. Con menos, tres
 * fotos numeradas de una rafaga son eso, una rafaga, y se decide mirandolas.
 */
const MIN_SECUENCIA = 5;

/**
 * ¿Este grupo es una SECUENCIA NUMERADA? (un render exportado a fotogramas:
 * "Deuda reducida0000.png", "0001", "0002"...)
 *
 * Solo ETIQUETA grupos que el parecido visual ya ha formado; no agrupa por su
 * cuenta. La primera version si agrupaba por nombre, y marco como "secuencia"
 * un carrete de camara entero (P1193567 a P1194030, 385 fotos distintas):
 * ofrecer ahi un "apartar la secuencia entera" habria sido una trampa.
 *
 * Criterio, deliberadamente estrecho:
 *   - mismo prefijo y misma extension,
 *   - numeracion RELLENA DE CEROS y de ancho fijo ("0007", no "7"),
 *   - que arranque por el principio (<= 1): un render empieza en 0 o en 1,
 *     mientras que una camara lleva un contador alto y arbitrario,
 *   - casi correlativa: se toleran huecos, los renders fallan fotogramas.
 */
function detectarSecuencia(archivos) {
  if (archivos.length < MIN_SECUENCIA) return null;
  const partes = [];
  for (const f of archivos) {
    const m = String(f.name || '').match(/^(.*?)(\d{3,})(\.[^.]+)$/);
    if (!m) return null;
    const digitos = m[2];
    if (digitos[0] !== '0') return null; // sin relleno de ceros no es un render
    partes.push({ prefijo: m[1], ancho: digitos.length, num: parseInt(digitos, 10), ext: m[3].toLowerCase() });
  }
  const { prefijo, ancho, ext } = partes[0];
  if (partes.some(p => p.prefijo !== prefijo || p.ancho !== ancho || p.ext !== ext)) return null;

  const nums = partes.map(p => p.num).sort((a, b) => a - b);
  if (nums[0] > 1) return null;
  const rango = nums[nums.length - 1] - nums[0] + 1;
  if (rango > nums.length * 1.5) return null;

  return { prefijo: prefijo.trim(), desde: nums[0], hasta: nums[nums.length - 1] };
}

/** Producto escalar. Los embeddings del indice estan L2-normalizados. */
function similitud(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Union-find minimo: agrupar por cadena de parecidos, no solo por pares. */
function crearConjuntos(n) {
  const padre = new Array(n).fill(0).map((_, i) => i);
  function raiz(i) {
    while (padre[i] !== i) { padre[i] = padre[padre[i]]; i = padre[i]; }
    return i;
  }
  function unir(a, b) {
    const ra = raiz(a), rb = raiz(b);
    if (ra !== rb) padre[ra] = rb;
  }
  return { raiz, unir };
}

/** Centroide de un grupo: su "aspecto medio", renormalizado para comparar. */
function centroideDe(embs) {
  const d = embs[0].length;
  const c = new Float32Array(d);
  for (const e of embs) for (let i = 0; i < d; i++) c[i] += e[i];
  let n = 0;
  for (let i = 0; i < d; i++) n += c[i] * c[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < d; i++) c[i] /= n;
  return c;
}

/**
 * Orden de la cola: por PARECIDO, no por tamaño.
 *
 * Esto se revisa del tiron, cientos de grupos seguidos, y se trabaja mucho
 * mejor si el grupo que viene se parece al que acabas de decidir: el ojo no se
 * recalibra en cada pase y el criterio no baila. El orden anterior —los mas
 * gordos delante— saltaba de una boda a un render y de ahi a la playa.
 *
 * Va en dos fases, y no por optimizar: primero encadena CARPETAS parecidas y
 * despues los grupos dentro de cada una, asi que una carpeta se revisa entera
 * antes de pasar a la siguiente. La carpeta es la unidad de significado del
 * archivo; una cadena plana mezclaba dos rodajes distintos solo porque se
 * parecian, y eso se lee como desorden aunque el coseno diga que no.
 *
 * Ademas es lo unico que aguanta el archivo grande: la cadena plana es
 * cuadratica en GRUPOS (1.273 grupos = 350 ms, 13.000 serian ~35 s), mientras
 * que en dos fases el cuadrado se reparte entre carpetas y el interior de cada
 * una (41 ms para los mismos 1.273).
 *
 * En ambas fases el recorrido es voraz: desde donde estas, saltas siempre a lo
 * mas parecido que quede sin visitar. No es el recorrido optimo —eso seria el
 * problema del viajante— pero deja vecinos parecidos, que es lo que se pide.
 * Medido sobre el archivo real: parecido medio con el vecino 0,82 frente a
 * 0,78 del orden viejo, y 14 saltos bruscos en vez de 58.
 */
function ordenarPorParecido(grupos, centroides, arranque) {
  const n = grupos.length;
  if (n < 3) return grupos;

  const orden = [];
  const secuencias = [];
  const porCarpeta = new Map();
  for (let i = 0; i < n; i++) {
    // Las secuencias, delante: una sola decision retira cientos de fotogramas
    // y ese trabajo no espera detras de nada.
    if (grupos[i].tipo === 'secuencia') { secuencias.push(i); continue; }
    const arr = porCarpeta.get(grupos[i].carpeta);
    if (arr) arr.push(i); else porCarpeta.set(grupos[i].carpeta, [i]);
  }
  secuencias.sort((a, b) => grupos[b].fileIds.length - grupos[a].fileIds.length);
  orden.push(...secuencias);

  const carpetas = [...porCarpeta.keys()];
  if (carpetas.length === 0) return orden.map(i => grupos[i]);
  const centroideCarpeta = carpetas.map(k => centroideDe(porCarpeta.get(k).map(i => centroides[i])));

  // De donde se arranca. Si hay secuencias, se sigue por lo mas parecido a la
  // ultima. Si no, por la carpeta mas atipica —la mas lejos de la media de
  // todas—: empezar por el centro del archivo parte el recorrido en dos.
  let actual;
  if (orden.length > 0) {
    actual = centroides[orden[orden.length - 1]];
  } else if (arranque) {
    actual = arranque;
  } else {
    const media = centroideDe(centroideCarpeta);
    let elegida = 0;
    let peor = Infinity;
    for (let c = 0; c < carpetas.length; c++) {
      const s = similitud(centroideCarpeta[c], media);
      if (s < peor) { peor = s; elegida = c; }
    }
    actual = centroideCarpeta[elegida];
  }

  const carpetaVista = new Uint8Array(carpetas.length);
  for (let vuelta = 0; vuelta < carpetas.length; vuelta++) {
    let mejorC = -1;
    let mejorSC = -Infinity;
    for (let c = 0; c < carpetas.length; c++) {
      if (carpetaVista[c]) continue;
      const s = similitud(centroideCarpeta[c], actual);
      if (s > mejorSC) { mejorSC = s; mejorC = c; }
    }
    carpetaVista[mejorC] = 1;

    const dentro = porCarpeta.get(carpetas[mejorC]);
    const grupoVisto = new Uint8Array(dentro.length);
    for (let k = 0; k < dentro.length; k++) {
      let mejorG = -1;
      let mejorSG = -Infinity;
      for (let j = 0; j < dentro.length; j++) {
        if (grupoVisto[j]) continue;
        const s = similitud(centroides[dentro[j]], actual);
        if (s > mejorSG) { mejorSG = s; mejorG = j; }
      }
      grupoVisto[mejorG] = 1;
      orden.push(dentro[mejorG]);
      actual = centroides[dentro[mejorG]];
    }
  }

  return orden.map(i => grupos[i]);
}

/**
 * Orden de la cola: por CUANTAS COPIAS tiene cada grupo, de mas a menos.
 *
 * Es el otro criterio util, y no compite con el parecido sino que lo usa:
 * los grupos se reparten en escalones por numero de copias (12, 10, 9...) y
 * DENTRO de cada escalon se encadenan por parecido, arrancando donde lo dejo
 * el escalon anterior. Un orden por tamaño a secas mandaba la carpeta 7 al
 * puesto 900 solo porque tenia una copia menos.
 *
 * Donde mas se nota es al final: en este archivo, 1.031 de 1.286 grupos son
 * de dos copias, asi que ese escalon es el 80% de la cola y va entero
 * encadenado. El numero de copias solo distingue algo arriba, y arriba es
 * donde manda.
 */
function ordenarPorCantidad(grupos, centroides) {
  const centroidePorGrupo = new Map();
  grupos.forEach((g, i) => centroidePorGrupo.set(g, centroides[i]));

  const escalones = new Map();
  for (const g of grupos) {
    const n = g.fileIds.length;
    const arr = escalones.get(n);
    if (arr) arr.push(g); else escalones.set(n, [g]);
  }

  const salida = [];
  let arranque = null;
  for (const n of [...escalones.keys()].sort((a, b) => b - a)) {
    const tramo = escalones.get(n);
    const puestos = ordenarPorParecido(tramo, tramo.map(g => centroidePorGrupo.get(g)), arranque);
    salida.push(...puestos);
    arranque = centroidePorGrupo.get(puestos[puestos.length - 1]);
  }
  return salida;
}
/**
 * @param {Array} mediaFiles - archivos servidos por /api/files (necesitan id y fullPath)
 * @param {object} opts - { umbral }
 * @returns {{ grupos: Array, stats: object }}
 */
function buscarGemelas(mediaFiles, opts = {}) {
  const umbral = typeof opts.umbral === 'number' && opts.umbral > 0 && opts.umbral <= 1
    ? opts.umbral
    : UMBRAL_POR_DEFECTO;

  const stats = {
    umbral,
    archivosConEmbedding: 0,
    carpetasComparadas: 0,
    carpetasSaltadas: 0,
    grupos: 0,
    archivosEnGrupos: 0,
  };

  if (!Array.isArray(mediaFiles) || mediaFiles.length === 0) {
    return { grupos: [], stats };
  }
  if (!clipIndex.isLoaded() || clipIndex.size() === 0) {
    return { grupos: [], stats, error: 'el indice CLIP esta vacio: escanea con CLIP activo' };
  }

  // Carpeta -> archivos con embedding
  const porCarpeta = new Map();
  for (const f of mediaFiles) {
    if (!f || !f.id || !f.fullPath) continue;
    const emb = clipIndex.get(f.id);
    if (!emb) continue;
    stats.archivosConEmbedding++;
    const carpeta = path.dirname(f.fullPath);
    const arr = porCarpeta.get(carpeta);
    if (arr) arr.push({ file: f, emb }); else porCarpeta.set(carpeta, [{ file: f, emb }]);
  }

  const grupos = [];
  // Centroide de cada grupo, en paralelo a `grupos`: solo vive aqui dentro
  // para ordenar la cola; no sale en la respuesta.
  const centroides = [];

  stats.secuencias = 0;

  for (const [carpeta, items] of porCarpeta.entries()) {
    if (items.length < 2) continue;
    if (items.length > MAX_POR_CARPETA) { stats.carpetasSaltadas++; continue; }
    stats.carpetasComparadas++;

    const { raiz, unir } = crearConjuntos(items.length);
    // Similitud minima observada dentro de cada cadena, para poder enseñar
    // "lo flojo" que es el grupo y afinar el umbral desde la UI.
    const minPorRaiz = new Map();

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const s = similitud(items[i].emb, items[j].emb);
        if (s >= umbral) {
          unir(i, j);
          const r = raiz(i);
          const prev = minPorRaiz.get(r);
          minPorRaiz.set(r, prev === undefined ? s : Math.min(prev, s));
        }
      }
    }

    const cubos = new Map();
    for (let i = 0; i < items.length; i++) {
      const r = raiz(i);
      const arr = cubos.get(r);
      if (arr) arr.push(i); else cubos.set(r, [i]);
    }

    for (const [r, indices] of cubos.entries()) {
      if (indices.length < 2) continue;
      // Orden natural dentro del grupo: como estan en la carpeta.
      const archivos = indices
        .map(i => items[i].file)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'es', { numeric: true }));
      const secuencia = detectarSecuencia(archivos);
      if (secuencia) stats.secuencias++;
      centroides.push(centroideDe(indices.map(i => items[i].emb)));
      grupos.push({
        id: `gem:${archivos[0].id}`,
        tipo: secuencia ? 'secuencia' : 'visual',
        prefijo: secuencia ? secuencia.prefijo : undefined,
        desde: secuencia ? secuencia.desde : undefined,
        hasta: secuencia ? secuencia.hasta : undefined,
        carpeta,
        // La etiqueta util es la carpeta, que es como el usuario piensa el evento.
        etiqueta: path.basename(carpeta),
        fileIds: archivos.map(a => a.id),
        similitudMin: Number((minPorRaiz.get(r) ?? umbral).toFixed(4)),
      });
      stats.archivosEnGrupos += archivos.length;
    }
  }

  // Cada grupo lleva su puesto en los DOS ordenes, asi la UI cambia de uno a
  // otro sin volver a pedir nada al servidor.
  const ordenados = ordenarPorParecido(grupos, centroides);
  ordenados.forEach((g, i) => { g.orden = i; });
  ordenarPorCantidad(grupos, centroides).forEach((g, i) => { g.ordenCantidad = i; });
  stats.grupos = ordenados.length;

  return { grupos: ordenados, stats };
}

module.exports = { buscarGemelas, UMBRAL_POR_DEFECTO };
