/**
 * Formatos que Pensadero reconoce — UN solo sitio.
 *
 * Antes habia cinco listas repartidas (sincronizacion, escaneo, personas,
 * busqueda por imagen, servir media) y no coincidian: el MXF solo estaba en
 * la de busqueda por imagen, asi que los rushes XDCAM de una productora no
 * existian para la app. Y la sincronizacion preguntaba primero a `mime-types`,
 * que conoce el MXF como `application/mxf` (no "video/") y lo descartaba antes
 * de mirar la lista de respaldo.
 */

const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.mts', '.m2ts',
  '.ts', '.wmv', '.flv', '.3gp', '.ogv', '.vob', '.dv', '.mxf',
]);

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif', '.tif', '.tiff', '.avif',
]);

const AUDIO_EXTS = new Set([
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.aif', '.aiff', '.wma',
]);

/**
 * Imagenes que el navegador no sabe mostrar: la ficha recibe una version JPG
 * (utils/vistaImagen.js). La miniatura ya se hacia convirtiendo; la ficha
 * recibia el original y decia "Error cargando imagen".
 */
const IMAGEN_NO_NATIVA = new Set(['.heic', '.heif', '.tif', '.tiff']);

/**
 * Lo que se reconoce pero aun no se sabe leer: no entra en la galeria, pero
 * Rutas lo cuenta en vez de decir "todo escaneado" con 32 RAW en la carpeta.
 * Clave: extension; valor: la familia con la que se avisa.
 */
const NO_LEIDOS = new Map([
  ...['.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.rw2', '.orf',
    '.dng', '.pef', '.srw', '.x3f', '.3fr', '.iiq', '.erf', '.kdc', '.mrw', '.rwl', '.raw']
    .map(e => [e, 'RAW de cámara']),
  ['.r3d', 'RAW de cine'], ['.braw', 'RAW de cine'], ['.ari', 'RAW de cine'],
]);

/** Tipo por extension ('video' | 'image' | 'audio'), o null si no es de aqui. */
function tipoPorExtension(ext) {
  const e = String(ext || '').toLowerCase();
  if (VIDEO_EXTS.has(e)) return 'video';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (AUDIO_EXTS.has(e)) return 'audio';
  return null;
}

module.exports = { VIDEO_EXTS, IMAGE_EXTS, AUDIO_EXTS, IMAGEN_NO_NATIVA, NO_LEIDOS, tipoPorExtension };
