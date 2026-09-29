/**
 * Que disco es este — Pensadero
 *
 * Una biblioteca se guardaba solo por su ruta, y la ruta lleva la letra de
 * unidad, que Windows reparte segun el orden en que se enchufan los discos.
 * Paso de verdad (20-22/09/2026): la biblioteca `D:\(1) WORKS` apunto un dia
 * a un disco de 20.163 archivos y otro dia a otro de 11.949, con la misma
 * identidad, y cuando el primero volvio como E: se añadio como biblioteca
 * nueva. Favoritos, notas y colecciones de un disco quedaban colgando del otro.
 *
 * El numero de serie del volumen (lo que Node devuelve en `stat.dev` en
 * Windows) es del disco, no de la letra: sobrevive a cambiar de letra y cambia
 * si en esa letra hay otro disco. No escribe nada en los discos del usuario,
 * asi que funciona tambien con los de solo lectura. Solo cambia al formatear.
 */

const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');

/** Numero de serie del volumen donde vive `ruta`, o null si no se sabe. */
async function serialDe(ruta) {
  if (!ruta) return null;
  try {
    const st = await fs.stat(ruta);
    // 0 = el sistema no da serie (algunas unidades de red o virtuales): no
    // sirve para distinguir discos, y usarlo daria falsos "otro disco".
    return typeof st.dev === 'number' && st.dev > 0 ? st.dev : null;
  } catch {
    return null;
  }
}

/** "D:" de "D:\\(1) WORKS", o '' si la ruta no empieza por una letra de unidad. */
function unidadDe(ruta) {
  const m = /^([a-z]):/i.exec(String(ruta || ''));
  return m ? `${m[1].toUpperCase()}:` : '';
}

/**
 * Serie de cada letra de unidad montada ahora mismo. Se pregunta una vez por
 * pasada: con varios discos desconectados se buscan todos contra la misma foto.
 * @returns {Promise<Map<string, number>>} "E:" -> serie
 */
async function seriesDeUnidades() {
  const mapa = new Map();
  // A: y B: son disqueteras historicas; preguntar por ellas puede tardar.
  const letras = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  await Promise.all(letras.map(async (l) => {
    const serie = await serialDe(`${l}:\\`);
    if (serie) mapa.set(`${l}:`, serie);
  }));
  return mapa;
}

/**
 * Busca en que letra esta ahora el disco con serie `serie`, con la misma
 * carpeta que tenia la biblioteca. Devuelve la ruta nueva o null.
 * @param {number} serie
 * @param {string} rutaVieja - p. ej. "D:\\(1) WORKS"
 * @param {Map<string, number>} [unidades] - de seriesDeUnidades(), para no repetir
 */
async function buscarDisco(serie, rutaVieja, unidades) {
  if (!serie || !rutaVieja) return null;
  const vieja = unidadDe(rutaVieja);
  if (!vieja) return null;
  const resto = rutaVieja.slice(2); // "\\(1) WORKS" (o "\\" si era la raiz)
  const mapa = unidades || await seriesDeUnidades();
  for (const [letra, s] of mapa) {
    if (s !== serie || letra === vieja) continue;
    const candidata = path.join(`${letra}\\`, resto);
    const st = await fs.stat(candidata).catch(() => null);
    if (st && st.isDirectory()) return candidata;
  }
  return null;
}

/**
 * Nombre (etiqueta) y capacidad de cada disco montado, por su numero de serie
 * (el mismo que `stat.dev`: comprobado el 29/09/2026 con Win32_Volume). Sirve
 * para distinguir dos bibliotecas que se llaman igual (la misma carpeta en un
 * disco de 6 TB y en otro de 10 TB). Una consulta a Windows cuesta ~1 s, asi
 * que se guarda unos minutos. Si falla, un mapa vacio: es solo informacion.
 * @returns {Promise<Map<number, {etiqueta: string|null, capacidad: number|null, letra: string|null}>>}
 */
let infoCacheada = null;
function infoDiscos() {
  if (infoCacheada && Date.now() - infoCacheada.en < 5 * 60 * 1000) return Promise.resolve(infoCacheada.mapa);
  if (process.platform !== 'win32') return Promise.resolve(new Map());
  const orden = 'Get-CimInstance Win32_Volume | Where-Object DriveLetter | Select-Object DriveLetter,Label,Capacity,SerialNumber | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', orden], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      const mapa = new Map();
      if (!err) {
        try {
          const datos = JSON.parse(String(stdout || '').trim() || '[]');
          for (const v of Array.isArray(datos) ? datos : [datos]) {
            const serie = Number(v && v.SerialNumber);
            if (!serie) continue;
            mapa.set(serie, {
              etiqueta: typeof v.Label === 'string' && v.Label.trim() ? v.Label.trim() : null,
              capacidad: Number(v.Capacity) || null,
              letra: v.DriveLetter || null,
            });
          }
        } catch { /* sin informacion: no pasa nada */ }
      }
      infoCacheada = { en: Date.now(), mapa };
      resolve(mapa);
    });
  });
}

module.exports = { serialDe, unidadDe, seriesDeUnidades, buscarDisco, infoDiscos };
