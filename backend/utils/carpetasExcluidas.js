/**
 * Carpetas que no son archivo — Pensadero
 *
 * Basura de trabajo de las suites de edicion: previews de render, auto-saves y
 * caches de medios. Premiere y After Effects las regeneran solas, no son
 * material, y colarlas en el archivo cuesta caro por tres sitios: el VLM las
 * describe una a una (~9 s de GPU cada una), aparecen en la galeria como si
 * fueran tomas, y se cuelan en Tomas gemelas, donde uno acaba decidiendo a mano
 * cual de doce previews de la misma secuencia se queda.
 *
 * Existe por un caso real (15/09/2026): bajo `D:\(1) WORKS` habia 1.919 videos
 * de preview en 170 carpetas `.PRV`, 1.138 de ellos ya catalogados.
 *
 * Criterio de admision: solo entra lo que nombra el PROGRAMA, no el usuario.
 * Nada de "Proxies", "Renders" o "Cache" a secas — esos son nombres que la
 * gente pone a mano y llena de material bueno.
 */

/** Nombres exactos de carpeta, en minusculas. */
const NOMBRES = new Set([
  'adobe premiere pro video previews',
  'adobe premiere pro auto-save',
  'adobe after effects auto-save',
  'media cache',
  'media cache files',
]);

/**
 * ¿Esta carpeta es scratch de una suite de edicion?
 * @param {string} nombre - nombre de la carpeta, no la ruta entera.
 */
function esCarpetaExcluida(nombre) {
  if (!nombre) return false;
  const n = String(nombre).trim().toLowerCase();
  // Carpetas del propio Windows en la raiz de cada disco: la papelera
  // ($RECYCLE.BIN) y los puntos de restauracion. Lo borrado no es archivo; el
  // 16/09/2026 aparecian en la galeria imagenes de la papelera de F:.
  if (n.startsWith('$') || n === 'system volume information') return true;
  // Premiere crea una carpeta "<nombre de secuencia>.PRV" por cada secuencia
  // con preview renderizado.
  if (n.endsWith('.prv')) return true;
  return NOMBRES.has(n);
}

/**
 * ¿Este ARCHIVO es basura de sistema con extension de medio?
 *
 * macOS deja un "._<nombre>" de 4 KB junto a cada archivo que copia a un disco
 * FAT/exFAT (sus metadatos extendidos). Tienen la misma extension que el
 * original, asi que pasaban por video, foto o audio: el 16/09/2026 habia 3.411
 * en el catalogo, cada uno con su intento fallido de miniatura.
 * @param {string} nombre - nombre del archivo, no la ruta entera.
 */
function esArchivoBasura(nombre) {
  return !!nombre && String(nombre).startsWith('._');
}

module.exports = { esCarpetaExcluida, esArchivoBasura, NOMBRES };
