/**
 * Version JPG de una imagen que el navegador no sabe mostrar (HEIC, TIFF):
 * la que recibe la ficha. Antes recibia el original y decia "Error cargando
 * imagen", aunque la miniatura si salia (esa ya se hacia convirtiendo).
 *
 * Se hace una vez y se guarda junto a las miniaturas, en el `.pensadero` de la
 * carpeta del archivo (`vistas/<id>.jpg`, regenerable); si ahi no se puede
 * escribir, en la carpeta temporal del sistema. Se rehace si el original es
 * mas nuevo. Descargar sigue dando el original.
 */
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const sharp = require('sharp');

const LADO = 2560;
const enCurso = new Map();

const reducir = (entrada, salida) => sharp(entrada, { failOn: 'none' })
  .rotate()
  .resize({ width: LADO, height: LADO, fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 88 })
  .toFile(salida);

/**
 * Decodifica una imagen que sharp no lee (las HEIC de iPhone van en HEVC) con
 * el ffmpeg del PATH, el mismo de miniaturas y proxies, a un JPG temporal.
 */
function decodificarConFfmpeg(origen, destino) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', origen, '-frames:v', '1', '-q:v', '2', destino],
      { timeout: 120000, windowsHide: true },
      (err) => (err ? reject(err) : resolve()));
  });
}

/** Escribe en `destino` el JPG de `origen`: sharp y, si no puede, ffmpeg + sharp. */
async function convertir(origen, destino) {
  const tmp = `${destino}.${process.pid}.tmp.jpg`;
  try {
    try {
      await reducir(origen, tmp);
    } catch {
      const crudo = path.join(os.tmpdir(), `pensadero-vista-${process.pid}-${Date.now()}.jpg`);
      try {
        await decodificarConFfmpeg(origen, crudo);
        await reducir(crudo, tmp);
      } finally {
        fsp.unlink(crudo).catch(() => {});
      }
    }
    await fsp.rename(tmp, destino);
  } catch (err) {
    fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Ruta del JPG listo para servir (lo hace si falta o es viejo). Una sola
 * conversion a la vez por archivo: abrir la ficha y la precarga a la vez no
 * convierten dos veces.
 * @returns {Promise<string>}
 */
async function vistaJpg(origen, fileId) {
  const { mtimeMs } = await fsp.stat(origen);
  const sitios = [
    path.join(path.dirname(origen), '.pensadero', 'vistas', `${fileId}.jpg`),
    path.join(os.tmpdir(), 'pensadero-vistas', `${fileId}.jpg`),
  ];
  for (const s of sitios) {
    try {
      if ((await fsp.stat(s)).mtimeMs >= mtimeMs) return s;
    } catch { /* aun no existe: se hace abajo */ }
  }
  if (enCurso.has(fileId)) return enCurso.get(fileId);
  const trabajo = (async () => {
    let ultimo = null;
    for (const s of sitios) {
      try {
        await fsp.mkdir(path.dirname(s), { recursive: true });
        await convertir(origen, s);
        return s;
      } catch (err) {
        ultimo = err; // disco de solo lectura, lleno...: el siguiente sitio
      }
    }
    throw ultimo;
  })().finally(() => enCurso.delete(fileId));
  enCurso.set(fileId, trabajo);
  return trabajo;
}

module.exports = { vistaJpg };
