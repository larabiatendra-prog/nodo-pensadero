/**
 * jsonStore — utilidades de persistencia JSON segura (Pensadero)
 *
 * Centraliza dos garantias para los ficheros de datos no regenerables
 * (favoritos, scan_paths, registries de personas/espacios, alias_table):
 *
 *  1. Escritura ATOMICA: se escribe a `<destino>.tmp` y luego `rename` sobre
 *     el destino. El rename es atomico en NTFS y en POSIX, asi que un crash
 *     a mitad de escritura nunca deja el JSON destino truncado/corrupto: o
 *     esta el contenido viejo intacto o el nuevo completo.
 *
 *  2. CUARENTENA de corruptos: cuando un JSON no parsea al cargar, en vez de
 *     machacarlo con la siguiente escritura (perdiendo datos recuperables a
 *     mano), se renombra a `<destino>.corrupt-<timestamp>` para inspeccion.
 *
 * Hay version async (fs.promises) y sync (fs) porque algunos modulos del
 * backend persisten de forma sincrona (peopleRegistry, spacesRegistry).
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

function _tmpPath(targetPath) {
  return `${targetPath}.tmp`;
}

function _corruptName(filePath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${filePath}.corrupt-${ts}`;
}

/**
 * Escribe `content` en `targetPath` de forma atomica (tmp + rename).
 * Crea la carpeta padre si no existe. Limpia el .tmp si algo falla.
 *
 * El rename atomico protege contra TRUNCADO (crash a media escritura). NO
 * protege contra un bug logico que escriba contenido valido-pero-erroneo
 * (p.ej. faces[] vacio). Para datos NO regenerables (registry, embeddings.json)
 * pasar `{ backup: true }`: antes del rename se copia el destino actual a
 * `<destino>.bak`, dejando una red de seguridad de la version previa buena.
 *
 * @param {string} targetPath
 * @param {string} content
 * @param {{ backup?: boolean }} [opts]
 */
async function atomicWriteFile(targetPath, content, opts = {}) {
  const tmp = _tmpPath(targetPath);
  try {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(tmp, content, 'utf-8');
    if (opts.backup) {
      // Copiar el destino actual (si existe) a un unico .bak rotatorio.
      await fsp.copyFile(targetPath, `${targetPath}.bak`).catch(() => {});
    }
    await fsp.rename(tmp, targetPath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Variante sincrona de atomicWriteFile.
 * @param {string} targetPath
 * @param {string} content
 * @param {{ backup?: boolean }} [opts]
 */
function atomicWriteFileSync(targetPath, content, opts = {}) {
  const tmp = _tmpPath(targetPath);
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(tmp, content, 'utf-8');
    if (opts.backup) {
      try { fs.copyFileSync(targetPath, `${targetPath}.bak`); } catch {}
    }
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Renombra un fichero ilegible/corrupto a `<nombre>.corrupt-<ts>` para no
 * machacarlo con la siguiente escritura. Best-effort: si el rename falla
 * (p.ej. el fichero ya no existe) devuelve null sin lanzar.
 * @param {string} filePath
 * @returns {Promise<string|null>} ruta de cuarentena o null
 */
async function quarantineCorrupt(filePath) {
  try {
    const dest = _corruptName(filePath);
    await fsp.rename(filePath, dest);
    console.warn(`⚠️ JSON corrupto puesto en cuarentena: ${dest}`);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Variante sincrona de quarantineCorrupt.
 * @param {string} filePath
 * @returns {string|null}
 */
function quarantineCorruptSync(filePath) {
  try {
    const dest = _corruptName(filePath);
    fs.renameSync(filePath, dest);
    console.warn(`⚠️ JSON corrupto puesto en cuarentena: ${dest}`);
    return dest;
  } catch {
    return null;
  }
}

module.exports = {
  atomicWriteFile,
  atomicWriteFileSync,
  quarantineCorrupt,
  quarantineCorruptSync,
};
