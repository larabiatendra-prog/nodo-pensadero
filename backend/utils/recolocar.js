/**
 * Letras cruzadas entre bibliotecas — Pensadero
 *
 * Windows reparte las letras segun el orden en que se conectan los discos. Con
 * dos discos que tienen la misma carpeta (el caso real: dos discos externos
 * con la misma carpeta de trabajo), el disco de una biblioteca puede aparecer justo en la ruta que
 * tiene apuntada la otra. El aviso decia entonces «son el mismo disco: quita
 * una de las dos», y era falso: son dos discos, con las letras cruzadas.
 *
 * Aqui se decide, sin tocar nada, si la que ocupa la ruta es de verdad el
 * mismo disco y como poner cada disco en su sitio. Puro: el "donde esta ahora
 * el disco de serie X" llega de fuera (utils/volumen.buscarDisco), para poder
 * probarlo sin discos.
 */

const norm = (r) => String(r || '').toLowerCase().replace(/[\\/]+$/, '');
const nombreDe = (p) => p.displayName || p.path;

/**
 * Completa la sugerencia de las bibliotecas cuya ruta nueva esta ocupada:
 * `ocupadaPor.mismoDisco` (la que ocupa es el mismo disco) y, si no lo es,
 * `ocupadaPor.suDisco` (donde esta ahora el disco de la que ocupa, o null si
 * no esta conectado).
 * @param {object[]} objetivo  bibliotecas de esta pasada (con su `sugerencia`)
 * @param {object[]} todas
 * @param {(serie: number, rutaVieja: string) => Promise<string|null>} dondeEsta
 */
async function anotarCruces(objetivo, todas, dondeEsta) {
  for (const p of objetivo) {
    const s = p && p.sugerencia;
    if (!s || !s.ocupadaPor) continue;
    const otra = todas.find(q => q && q.id === s.ocupadaPor.id);
    if (!otra) continue;
    // Sin saber que disco es alguna de las dos, se da por el mismo (el aviso
    // de siempre): cruzar a ciegas podria llevar una biblioteca a otro disco.
    const mismo = !otra.volumen || !p.volumen || otra.volumen === p.volumen;
    s.ocupadaPor.mismoDisco = mismo;
    s.ocupadaPor.suDisco = mismo ? null : (await dondeEsta(otra.volumen, otra.path)) || null;
  }
}

/**
 * Plan para poner el disco de la biblioteca `id` en su sitio: la lista de
 * cambios de ruta, EN ORDEN, o un error que se puede enseñar tal cual.
 *
 * Si su ruta nueva la ocupa otra biblioteca que es otro disco, primero sale
 * esa (a donde esta ahora su disco) y luego entra esta: la cache va por ruta y
 * al reves se pisarian. Si los dos discos se han cambiado la letra el uno por
 * el otro no se hace: el orden no basta y se perderian miniaturas; con letras
 * fijas en Windows no vuelve a pasar.
 */
async function planRecolocar(todas, id, dondeEsta) {
  const p = todas.find(q => q && q.id === id);
  if (!p) return { status: 404, error: 'Biblioteca no encontrada' };
  if (!p.volumen) return { status: 409, error: 'Todavía no se sabe qué disco es esta biblioteca: sincronízala con su disco conectado.' };
  const destino = await dondeEsta(p.volumen, p.path);
  if (!destino) return { status: 409, error: 'Su disco no está conectado en otra letra ahora mismo.' };

  const otra = todas.find(q => q && q.id !== id && norm(q.path) === norm(destino));
  if (!otra) return { movimientos: [{ id, de: p.path, a: destino }] };

  if (!otra.volumen || otra.volumen === p.volumen) {
    return { status: 409, mismoDisco: true, error: `«${nombreDe(otra)}» es el mismo disco que esta biblioteca: quita una de las dos.` };
  }
  const destinoOtra = await dondeEsta(otra.volumen, otra.path);
  if (!destinoOtra) {
    return {
      status: 409, esperaOtra: true,
      error: `En ${destino} está ahora el disco de esta biblioteca, pero esa ruta la tiene «${nombreDe(otra)}», que es otro disco y ahora no está conectado. Conéctalo también y vuelve a intentarlo, o dale a cada disco una letra fija en Windows.`,
    };
  }
  if (norm(destinoOtra) === norm(p.path)) {
    return {
      status: 409, intercambio: true,
      error: `Los dos discos se han cambiado la letra el uno por el otro. Dales una letra fija a cada uno en Administración de discos y luego usa «Usar esa ubicación» en cada biblioteca.`,
    };
  }
  const tercera = todas.find(q => q && q.id !== id && q.id !== otra.id && norm(q.path) === norm(destinoOtra));
  if (tercera) {
    return { status: 409, error: `El disco de «${nombreDe(otra)}» está ahora en ${destinoOtra}, pero esa ruta la tiene «${nombreDe(tercera)}». Resuelve esa primero.` };
  }
  return {
    movimientos: [
      { id: otra.id, de: otra.path, a: destinoOtra },
      { id, de: p.path, a: destino },
    ],
  };
}

module.exports = { anotarCruces, planRecolocar };
