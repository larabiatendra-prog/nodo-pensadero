/**
 * Lo tuyo que se quedo sin archivo por un cambio de letra — Pensadero
 *
 * Tomas apartadas, notas, material oculto, favoritos... se apuntan por el id
 * del archivo (md5 de su ruta, CON la letra) o por su mediaKey
 * ("biblioteca:ruta relativa"). Cuando Windows cambia la letra de un disco o
 * se cruzan dos discos con la misma carpeta, esas claves dejan de coincidir y
 * lo tuyo se queda colgando: no se borra, pero ya no se ve. Paso de verdad
 * (29/09/2026): de 491 tomas apartadas solo 13 seguian con su archivo, y 30
 * ocultos y 2 notas estaban apuntados a la biblioteca del otro disco (la que
 * lo estuvo leyendo mientras las letras estaban cruzadas).
 *
 * Aqui se busca, sin tocar nada, el archivo de cada apunte huerfano:
 *   - un id: el archivo cuya ruta, con otra letra, da ese id;
 *   - una ruta (favoritos antiguos): la misma ruta con otra letra;
 *   - una mediaKey: la misma ruta relativa en OTRA biblioteca cuya carpeta se
 *     llama igual (dos discos con «(1) WORKS»): es el caso de las letras
 *     cruzadas. Entre bibliotecas cualquiera no: una camara repite nombres
 *     (P1000001.JPG) y la nota iria a otra foto.
 * Solo si no hay duda: un candidato, o varios que son copias identicas (mismo
 * tamaño y fecha: la misma foto en dos discos). Si no, no se toca: mejor no
 * reenlazar que reenlazar mal (mismo criterio que services/reenlazar.js).
 *
 * Un apunte cuyo archivo es CONOCIDO (aunque su disco no este conectado) no es
 * huerfano: por eso `conocidos` son todos los archivos de la cache, no solo
 * los de los discos conectados.
 */

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ES_ID = /^[0-9a-f]{32}$/i;
const ES_RUTA = /^[a-z]:[\\/]/i;

const relDe = (mediaKey) => {
  const i = String(mediaKey || '').indexOf(':');
  return i > 0 ? String(mediaKey).slice(i + 1).toLowerCase() : null;
};
const bibliotecaDe = (mediaKey) => {
  const i = String(mediaKey || '').indexOf(':');
  return i > 0 ? String(mediaKey).slice(0, i) : null;
};
const msDe = (f) => new Date(f && f.modifiedAt).getTime();

/** Una clave de un almacen, a lo que es: id, ruta o mediaKey. */
function clasificar(clave) {
  const k = String(clave || '');
  if (!k) return null;
  if (ES_ID.test(k)) return { id: k };
  if (ES_RUTA.test(k)) return { ruta: k };
  if (relDe(k)) return { mediaKey: k };
  return null;
}

/**
 * @param {Array<{id, mediaKey, fullPath, name, size, modifiedAt}>} conocidos
 * @param {Array<{id?: string, mediaKey?: string, ruta?: string}>} apuntes
 * @param {(ruta: string) => string} idDe - el mismo md5 que da los fileId
 * @param {Record<string, string>} [bibliotecas] - id de biblioteca -> su ruta
 * @returns {Array<{de: {id, mediaKey, fullPath}, a: {id, mediaKey, fullPath, name}}>}
 */
function paresParaHuerfanos(conocidos, apuntes, idDe, bibliotecas = {}) {
  const carpetaDe = (lib) => {
    const r = bibliotecas[lib];
    return r ? String(r).replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase() : null;
  };
  const ids = new Set();
  const claves = new Set();
  const rutas = new Set();
  for (const f of conocidos) {
    if (f.id) ids.add(f.id);
    if (f.mediaKey) claves.add(f.mediaKey);
    if (f.fullPath) rutas.add(f.fullPath.toLowerCase());
  }
  const huerfanos = [];
  const vistos = new Set();
  for (const ap of apuntes || []) {
    if (!ap) continue;
    const firma = `${ap.id || ''}|${ap.mediaKey || ''}|${ap.ruta || ''}`;
    if (vistos.has(firma)) continue;
    vistos.add(firma);
    if ((ap.id && ids.has(ap.id)) || (ap.mediaKey && claves.has(ap.mediaKey))
      || (ap.ruta && (rutas.has(ap.ruta.toLowerCase()) || ids.has(ap.ruta) || claves.has(ap.ruta)))) continue;
    huerfanos.push(ap);
  }
  if (huerfanos.length === 0) return [];

  // Se construye solo si hace falta: 25 variantes por archivo conocido.
  const porId = new Map();
  const porRuta = new Map();
  const porRel = new Map();
  const meter = (m, k, f) => { const l = m.get(k); if (l) l.push(f); else m.set(k, [f]); };
  const hayIds = huerfanos.some(h => h.id);
  const hayRutas = huerfanos.some(h => h.ruta);
  for (const f of conocidos) {
    if (f.mediaKey) { const rel = relDe(f.mediaKey); if (rel) meter(porRel, rel, f); }
    if (!f.fullPath || !ES_RUTA.test(f.fullPath) || (!hayIds && !hayRutas)) continue;
    const suya = f.fullPath[0].toUpperCase();
    const resto = f.fullPath.slice(1);
    for (const L of LETRAS) {
      if (L === suya) continue;
      if (hayIds) meter(porId, idDe(L + resto), f);
      if (hayRutas) meter(porRuta, (L + resto).toLowerCase(), f);
    }
  }

  const pares = [];
  for (const h of huerfanos) {
    let candidatos = [];
    if (h.id) candidatos = porId.get(h.id) || [];
    if (!candidatos.length && h.ruta) candidatos = porRuta.get(h.ruta.toLowerCase()) || [];
    if (!candidatos.length && h.mediaKey) {
      const lib = bibliotecaDe(h.mediaKey);
      const carpeta = carpetaDe(lib);
      candidatos = !carpeta ? [] : (porRel.get(relDe(h.mediaKey)) || []).filter(f => {
        const suya = bibliotecaDe(f.mediaKey);
        return suya !== lib && carpetaDe(suya) === carpeta;
      });
    }
    if (candidatos.length === 0) continue;
    if (candidatos.length > 1) {
      const [p] = candidatos;
      const copias = candidatos.every(f => typeof f.size === 'number' && f.size === p.size && msDe(f) === msDe(p) && Number.isFinite(msDe(f)));
      if (!copias) continue;
    }
    for (const f of candidatos) {
      pares.push({
        de: { id: h.id || null, mediaKey: h.mediaKey || null, fullPath: h.ruta || null },
        a: { id: f.id || null, mediaKey: f.mediaKey || null, fullPath: f.fullPath || null, name: f.name || null },
      });
    }
  }
  return pares;
}

module.exports = { paresParaHuerfanos, clasificar };
