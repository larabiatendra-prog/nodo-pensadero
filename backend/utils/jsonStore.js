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

// Contador monotono de proceso para nombres .tmp UNICOS por escritura. Antes el
// .tmp era fijo (`<destino>.tmp`): dos escrituras concurrentes al mismo destino
// compartian el mismo temporal y se machacaban/renombraban cruzado (corrupcion).
// Con un sufijo unico cada escritura usa su propio temporal y el rename final es
// atomico, asi que nunca se corrompe el destino (a lo sumo gana la ultima).
let _writeSeq = 0;
function _tmpPath(targetPath) {
  return `${targetPath}.${process.pid}.${++_writeSeq}.tmp`;
}

function _corruptName(filePath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${filePath}.corrupt-${ts}`;
}

// --- Serializacion de escrituras fisicas por destino ---
// Encadena los atomicWriteFile() al MISMO path para que sus fases
// (writeTmp -> backup -> rename) no se solapen. Es defensa interna automatica
// para TODOS los escritores; la coherencia del ciclo completo read-modify-write
// (evitar lost-update) la aporta withFileLock() a nivel de llamador.
const _writeChains = new Map(); // targetPath -> Promise de la escritura en curso

function _enqueueWrite(targetPath, task) {
  const prev = _writeChains.get(targetPath) || Promise.resolve();
  // El fallo de una escritura no debe abortar la siguiente: se traga aqui.
  const next = prev.then(task, task);
  _writeChains.set(targetPath, next);
  // Liberar la entrada del Map cuando esta cadena sea la ultima (evita fuga).
  next.then(() => {
    if (_writeChains.get(targetPath) === next) _writeChains.delete(targetPath);
  }, () => {
    if (_writeChains.get(targetPath) === next) _writeChains.delete(targetPath);
  });
  return next;
}

// --- Mutex asincrono por clave (normalmente la ruta de un fichero) ---
// Serializa una seccion critica read-modify-write sobre el MISMO recurso para
// evitar lost-update: sin esto, A lee, B lee, A escribe, B escribe datos viejos
// y se pierde la escritura de A. Los llamadores envuelven TODO el ciclo
// (leer -> mutar -> escribir) con withFileLock(path, async () => {...}); claves
// distintas corren en paralelo. Es un namespace SEPARADO de _writeChains, asi
// que un atomicWriteFile() dentro del callback no se autobloquea.
const _locks = new Map(); // key -> Promise cola del lock

function withFileLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  const result = prev.then(() => fn());
  // La cola avanza pase lo que pase (no se bloquea si fn lanza).
  const tail = result.then(() => {}, () => {});
  _locks.set(key, tail);
  tail.then(() => {
    if (_locks.get(key) === tail) _locks.delete(key);
  });
  return result;
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
  // Encolar tras cualquier escritura en curso al MISMO destino: sus fases no se
  // solapan aunque dos llamadores escriban a la vez.
  return _enqueueWrite(targetPath, async () => {
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
  });
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
  withFileLock,
};
