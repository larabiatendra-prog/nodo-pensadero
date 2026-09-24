/**
 * Momentos de los videos — Pensadero
 *
 * La busqueda visual guardaba de cada video UNA huella: la de su fotograma
 * central. Arrastrar una imagen de otro instante del clip solo lo encontraba
 * entre los 50 primeros 7 de cada 12 veces (medido el 23/09/2026). Con 3
 * huellas (principio, medio y final) salia 78 de 80 veces; con 5, el primero
 * 76 de 80 veces en vez de 57.
 *
 * Aqui se calculan los "momentos" de los videos ya escaneados: huellas de
 * otros instantes, repartidos del 5% al 95% del clip, una cada
 * SEGUNDOS_POR_MOMENTO (minimo 3 contando la principal, maximo 12). El del
 * medio no se repite: es la huella principal. Los escaneos nuevos ya guardan
 * los suyos (scanOrchestrator, con los fotogramas que saca para describir);
 * este trabajo completa lo escaneado antes y los videos largos.
 *
 * Es un trabajo largo (sacar un fotograma de un disco externo: ~0,4 s de
 * mediana) que lanza el usuario, no un automatismo: se ve y se para desde
 * Estadisticas, espera si hay un escaneo en marcha y se puede retomar otro
 * dia, porque lo hecho queda en el catalogo de cada carpeta
 * (`entry.clip_momentos`, huellas compactas de clipIndex) y en el indice.
 * Solo LEE los videos: lo que escribe es el `_pensadero.json` de su carpeta.
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const clipIndex = require('../clipIndex');
const catalogReader = require('../catalogReader');
const { getInstance: getClipService } = require('./clipService');
const { probeVideo, extractFrame } = require('../visualScanService');
const { atomicWriteFile, withFileLock, normalizeLockKey } = require('../utils/jsonStore');
const fallos = require('../utils/failureReason');

const SEGUNDOS_POR_MOMENTO = 10;
const MIN_HUELLAS = 3;   // contando la principal
const MAX_HUELLAS = 12;
// El modelo mira a ~512 px: que ffmpeg saque el fotograma ya pequeño.
const LADO_FOTOGRAMA = 768;
// Cada cuantos videos se vuelca el catalogo de una carpeta grande: un corte
// no tira mas que eso.
const VOLCAR_CADA = 10;
// Tantos fallos seguidos es un disco que se ha ido, no archivos raros.
const MAX_FALLOS_SEGUIDOS = 25;
// Segundos por fotograma para estimar antes de empezar (medido: 0,4 s de
// mediana sacandolo de un disco externo, mas la huella en la GPU).
const SEG_POR_FOTOGRAMA_ESTIMADO = 0.6;
const CATALOGO = '_pensadero.json';

/**
 * Instantes (s) que deberia tener un video de `dur` segundos, SIN el del medio
 * (que es su huella principal). 3 huellas para un clip de hasta ~25 s.
 */
function instantesPara(dur) {
  if (!(dur > 1)) return [];
  const n = Math.max(MIN_HUELLAS, Math.min(MAX_HUELLAS, Math.round(dur / SEGUNDOS_POR_MOMENTO)));
  const ts = [];
  for (let i = 0; i < n; i++) ts.push(dur * (0.05 + 0.9 * i / (n - 1)));
  let medio = 0;
  for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i] - dur / 2) < Math.abs(ts[medio] - dur / 2)) medio = i;
  ts.splice(medio, 1);
  return ts.map(t => Math.round(t * 100) / 100);
}

/** Los instantes que le faltan, frente a los momentos que ya tiene. */
function instantesQueFaltan(dur, existentes) {
  const tolerancia = Math.max(1, dur * 0.03);
  const ya = (existentes || []).map(m => m.t).filter(Number.isFinite);
  return instantesPara(dur).filter(t => !ya.some(y => Math.abs(y - t) <= tolerancia));
}

/** ¿Le faltan momentos? Sin duracion conocida, solo si no tiene ninguno. */
function necesita(f) {
  if (!f || f.type !== 'video' || !f.fullPath || !clipIndex.has(f.id)) return false;
  if (f.duration > 1) return instantesQueFaltan(f.duration, clipIndex.getMomentos(f.id)).length > 0;
  return clipIndex.numMomentos(f.id) === 0;
}

// ── Estado del trabajo ────────────────────────────────────────────────────

let trabajo = null;

function vistaTrabajo() {
  if (!trabajo) return null;
  const t = trabajo;
  const hechos = t.hechos + t.fallidos;
  const transcurrido = (Date.now() - t.inicio) / 1000 - t.segundosEsperando;
  const porVideo = hechos > 0 ? transcurrido / hechos : null;
  return {
    total: t.total,
    hechos: t.hechos,
    fallidos: t.fallidos,
    momentos: t.momentos,
    actual: t.actual,
    esperandoEscaneo: t.esperandoEscaneo,
    terminado: t.terminado,
    cancelado: t.cancelado,
    motivo: t.motivo,
    inicio: new Date(t.inicio).toISOString(),
    restanteSeg: !t.terminado && porVideo !== null ? Math.round(porVideo * (t.total - hechos)) : null,
  };
}

/**
 * Lo que la pantalla necesita: cuantos videos (de los discos conectados)
 * tienen huella, cuantos tienen ya sus momentos, cuantos faltan y cuanto
 * tardaria, y el trabajo en marcha o el ultimo.
 */
function estado(files) {
  let conHuella = 0;
  let completos = 0;
  let pendientes = 0;
  let fotogramas = 0;
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || f.type !== 'video' || !clipIndex.has(f.id)) continue;
    conHuella++;
    if (necesita(f)) {
      pendientes++;
      fotogramas += f.duration > 1
        ? instantesQueFaltan(f.duration, clipIndex.getMomentos(f.id)).length
        : MIN_HUELLAS - 1;
    } else {
      completos++;
    }
  }
  return {
    videosConHuella: conHuella,
    completos,
    pendientes,
    estimacionSeg: Math.round(fotogramas * SEG_POR_FOTOGRAMA_ESTIMADO),
    trabajo: vistaTrabajo(),
  };
}

// ── El trabajo ────────────────────────────────────────────────────────────

/**
 * Escribe los momentos calculados en el catalogo de la carpeta. Mismo
 * protocolo que el escaneo: dentro del lock se RELEE el catalogo y solo se
 * toca `clip_momentos` de estas entradas; lo demas (caras asignadas a mano,
 * descripciones) se queda como este en disco ahora.
 */
async function volcarCarpeta(dir, porNombre) {
  if (porNombre.size === 0) return { escritos: 0 };
  const archivo = path.join(dir, CATALOGO);
  let escritos = 0;
  await withFileLock(normalizeLockKey(archivo), async () => {
    let catalogo;
    try {
      catalogo = JSON.parse(await fs.readFile(archivo, 'utf-8'));
    } catch (err) {
      // Sin _pensadero.json (la huella vino de un _marina.json o de un sidecar
      // suelto): los momentos se quedan en el indice, que es lo que busca.
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const [nombre, momentos] of porNombre) {
      const entrada = (catalogo.photos && catalogo.photos[nombre]) || (catalogo.clips && catalogo.clips[nombre]);
      if (!entrada) continue;
      entrada.clip_momentos = momentos;
      escritos++;
    }
    if (escritos > 0) {
      await atomicWriteFile(archivo, JSON.stringify(catalogo, null, 2));
      catalogReader.invalidateCatalog(dir);
    }
  });
  porNombre.clear();
  return { escritos };
}

/**
 * Empieza a calcular los momentos que faltan. Vuelve en el acto: el trabajo
 * sigue en segundo plano y se consulta con `estado`.
 * @param {Array} files - catalogo conectado
 * @param {{ hayEscaneo?: () => boolean }} opts - mientras devuelva true, espera
 */
async function empezar(files, { hayEscaneo = () => false } = {}) {
  if (trabajo && !trabajo.terminado) {
    const err = new Error('Ya se están calculando los momentos');
    err.status = 409;
    throw err;
  }
  const lista = (Array.isArray(files) ? files : []).filter(necesita);
  if (lista.length === 0) return vistaTrabajo();

  const clipSvc = getClipService();
  if (!(await clipSvc.init())) {
    const err = new Error(clipSvc.getStatus().lastError || 'El modelo de búsqueda visual no está disponible');
    err.status = 503;
    throw err;
  }

  // Por carpeta: cada catalogo se escribe una vez por tanda, no por video.
  lista.sort((a, b) => String(a.fullPath).localeCompare(String(b.fullPath)));
  trabajo = {
    total: lista.length, hechos: 0, fallidos: 0, momentos: 0,
    actual: null, esperandoEscaneo: false, segundosEsperando: 0,
    terminado: false, cancelado: false, motivo: null, inicio: Date.now(),
  };
  const yo = trabajo;
  correr(lista, yo, clipSvc, hayEscaneo).catch((err) => {
    fallos.record('calcular los momentos de los vídeos', err);
    yo.motivo = 'error';
    yo.terminado = true;
  });
  return vistaTrabajo();
}

async function correr(lista, yo, clipSvc, hayEscaneo) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pensadero-momentos-'));
  const pendientesPorCarpeta = new Map(); // dir -> Map<nombre, momentos>
  let seguidos = 0;
  const volcar = async (dir) => {
    const m = pendientesPorCarpeta.get(dir);
    if (!m || m.size === 0) return;
    try {
      await volcarCarpeta(dir, m);
    } catch (err) {
      fallos.record('guardar los momentos de los vídeos en su catálogo', err, { path: path.join(dir, CATALOGO) });
    }
  };
  try {
    let dirAnterior = null;
    for (const f of lista) {
      if (yo.cancelado) break;
      // Un escaneo usa la misma GPU y los mismos discos: se le deja pasar.
      while (hayEscaneo() && !yo.cancelado) {
        yo.esperandoEscaneo = true;
        await new Promise(ok => setTimeout(ok, 5000));
        yo.segundosEsperando += 5;
      }
      yo.esperandoEscaneo = false;
      if (yo.cancelado) break;

      const dir = path.dirname(f.fullPath);
      if (dirAnterior && dir !== dirAnterior) await volcar(dirAnterior);
      dirAnterior = dir;
      yo.actual = f.name;

      try {
        let dur = f.duration > 1 ? f.duration : 0;
        if (!dur) {
          const probe = await probeVideo(f.fullPath);
          dur = probe && probe.duration > 1 ? probe.duration : 0;
        }
        const existentes = clipIndex.getMomentos(f.id);
        const nuevos = [];
        for (const t of instantesQueFaltan(dur, existentes)) {
          if (yo.cancelado) break;
          const out = path.join(tmp, 'fotograma.jpg');
          if (!(await extractFrame(f.fullPath, t, out, { maxLado: LADO_FOTOGRAMA }))) continue;
          const emb = await clipSvc.embedImage(out);
          if (emb) nuevos.push({ t, e: clipIndex.comprimirHuella(emb) });
        }
        if (nuevos.length === 0 && dur > 1) throw new Error(`No se ha podido sacar ningún fotograma de ${f.name}`);
        const todos = existentes.concat(nuevos).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
        if (todos.length > 0) {
          clipIndex.setMomentos(f.id, todos);
          if (!pendientesPorCarpeta.has(dir)) pendientesPorCarpeta.set(dir, new Map());
          pendientesPorCarpeta.get(dir).set(f.name, todos);
          if (pendientesPorCarpeta.get(dir).size >= VOLCAR_CADA) await volcar(dir);
        }
        yo.momentos += nuevos.length;
        yo.hechos++;
        seguidos = 0;
      } catch (err) {
        yo.fallidos++;
        seguidos++;
        fallos.record('calcular los momentos de un vídeo', err, { path: f.fullPath, silencioso: true });
        if (seguidos >= MAX_FALLOS_SEGUIDOS) {
          // Casi seguro un disco que se ha desconectado: parar y decirlo.
          yo.motivo = 'fallos';
          break;
        }
      }
      clipIndex.save(); // como mucho una vez por minuto (ver clipIndex)
    }
  } finally {
    for (const dir of pendientesPorCarpeta.keys()) await volcar(dir);
    await clipIndex.save({ ya: true });
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    yo.actual = null;
    yo.esperandoEscaneo = false;
    yo.terminado = true;
  }
}

/** Para el trabajo en marcha: lo hecho hasta ahora se guarda. */
function parar() {
  if (!trabajo || trabajo.terminado) return false;
  trabajo.cancelado = true;
  return true;
}

module.exports = { estado, empezar, parar, instantesPara, instantesQueFaltan, necesita };
