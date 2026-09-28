/**
 * Video Proxy Service — Pensadero
 *
 * Genera y sirve "proxies" de reproduccion: versiones MP4 web-compatibles
 * (H.264 8-bit 4:2:0 + AAC, +faststart) de los videos cuyo codec/contenedor
 * el navegador NO puede reproducir nativamente (p.ej. .m2ts MPEG-TS+AC3, o
 * .mov H.264 10-bit 4:2:2 + PCM de camaras profesionales).
 *
 * Diseno:
 *  - El archivo ORIGINAL nunca se toca. El proxy vive junto al archivo, en
 *    <su-carpeta>\.pensadero\proxies\<fileId>.mp4 (regenerable, fuera del repo).
 *  - classify decide: native (el navegador lo abre tal cual) o transcode
 *    (version ligera: H.264 8-bit, <=1080p y bitrate acotado, con NVENC).
 *
 *    Ya NO existe el "remux" (copiar el video y cambiar solo audio/contenedor).
 *    El 17/09/2026 se midio que habia 1,5 TB de proxies remux, cada uno del
 *    93-99 % del tamaño del original, y que casi todos lo eran SOLO por el
 *    audio PCM de las camaras Panasonic. Chromium reproduce ese PCM sin
 *    problema (probado: H.264 1080p y 4K + pcm_s16be en MP4, audio decodificado
 *    y cero fotogramas perdidos). Esos videos son nativos; los que de verdad
 *    no se abren (.m2ts, HEVC, 10-bit, 4:2:2) reciben una version ligera, que
 *    pesa una fraccion del original, nunca una copia.
 *
 *  - Si un video "nativo" falla al reproducirse, el frontend pide el proxy
 *    forzado (?forzar=1): la clasificacion puede equivocarse sin dejarte sin ver.
 *  - NUNCA se hace esperar. Un 4K de camara se abre en el navegador, pero lo
 *    arrastra: tarda en arrancar y mover la barra es lento. Con esos, el
 *    original se sirve YA y la version ligera se prepara por detras, para la
 *    proxima vez. Solo se espera con lo que no hay forma de abrir (HEVC,
 *    ProRes, MJPEG...), que es una minoria.
 *  - Nada se genera en un disco con poco espacio libre, y cada disco tiene un
 *    tope (ajustable, ver "Ajustes"). Al llegar al tope no se borra nada a
 *    espaldas del usuario: se para y se pregunta.
 *  - Generacion idempotente y persistente: una vez hecho, se reutiliza. Cola con
 *    concurrencia limitada y dedupe por fileId para no saturar la GPU.
 *  - Indice durable en backend/video_proxies.json.
 *
 * Aprovecha el ffmpeg/ffprobe del SISTEMA (como visualScanService) para tener
 * la grafica NVIDIA. Se prepara por niveles, del mas rapido al que funciona en
 * cualquier equipo (ver `modosPara`): todo en la grafica, leer en la grafica,
 * solo codificar en la grafica y, sin NVIDIA, todo por el procesador.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const pathsConfig = require('../config/paths');
const runtime = require('../config/runtime');
const { atomicWriteFile } = require('../utils/jsonStore');
const fallos = require('../utils/failureReason');

// Binario ffmpeg de respaldo (sin NVENC) si no hay ffmpeg en el PATH.
let installerFfmpeg = null;
try { installerFfmpeg = require('@ffmpeg-installer/ffmpeg').path; } catch { /* opcional */ }

const INDEX_FILE = path.join(__dirname, '..', 'video_proxies.json');
const MAX_HEIGHT = parseInt(process.env.VIDEO_PROXY_MAX_HEIGHT, 10) || 1080;
const CONCURRENCY = parseInt(process.env.VIDEO_PROXY_CONCURRENCY, 10) || 1;
// Techo de bitrate del proxy: es para ver en el navegador, no para editar.
const MAX_BITRATE = process.env.VIDEO_PROXY_MAXRATE || '5M';
// Tope de fabrica por disco. Lo que el usuario ponga manda sobre esto.
const TOPE_GB_FABRICA = parseFloat(process.env.VIDEO_PROXY_BUDGET_GB) || 40;
// Por debajo de este espacio libre no se escribe ningun proxy en ese disco.
const MIN_LIBRE_GB = parseFloat(process.env.VIDEO_PROXY_MIN_FREE_GB) || 30;
// Sube cuando cambian las reglas de classify: las entradas con otra version se
// vuelven a analizar en vez de fiarse de lo que decia la regla vieja.
const VERSION_CLASIFICACION = 2;

// Codecs/pixfmt/contenedores que el navegador reproduce nativamente.
const NATIVE_VCODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const NATIVE_PIXFMTS = new Set(['yuv420p', 'yuvj420p']); // 8-bit 4:2:0
// PCM incluido: Chromium lo decodifica en MP4/MOV (camaras Panasonic, Sony,
// Canon). Tratarlo como incompatible generaba copias completas del video.
const NATIVE_ACODECS = new Set([
  'aac', 'mp3', 'opus', 'vorbis', 'flac',
  'pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s24be', 'pcm_s32le', 'pcm_f32le', 'pcm_u8', 'pcm_alaw', 'pcm_mulaw',
]);
const NATIVE_CONTAINERS = new Set(['mp4', 'mov', 'm4v', 'm4a', 'webm', '3gp', '3gpp']);

// === Estado en memoria ===
let index = null;                 // fileId -> { kind, status, srcW, srcH, outW, outH, srcMtime, error }
const inFlight = new Map();       // fileId -> Promise (generacion en curso)
let nvencSupported = null;        // null=desconocido, true/false tras primer intento
// ¿La grafica puede LEER (decodificar) video? null = aun no se sabe.
let cudaDisponible = null;
// Tipos de video (codec|pixfmt) con los que "todo en la grafica" ya fallo aqui:
// no se vuelve a intentar con ellos (una GTX 1050 no lee el 4:2:2 de camara).
const sinTodoGpu = new Set();
let active = 0;
const queue = [];

// ---------------------------------------------------------------------------
// Ajustes del usuario (config/runtime.json -> "proxies")
// ---------------------------------------------------------------------------
/**
 * El tope es POR DISCO porque 40 GB en el disco del sistema es mucho y en una
 * LaCie de 8 TB no es nada. Un tope de 0 significa sin limite.
 *
 * Al llegar al tope:
 *  - 'preguntar' (de fabrica): se deja de preparar en ese disco y se levanta un
 *    aviso para que el usuario decida. Nada se borra sin decirlo.
 *  - 'liberar': se borran los proxies que hace mas que no se ven y se sigue.
 */
const AL_LLEGAR = new Set(['preguntar', 'liberar']);

/** Discos esperando una decision: raiz -> { desde, esperando, ultimo }. En
 *  memoria a proposito: si reinicias y el video sigue haciendo falta, la
 *  pregunta vuelve sola. */
const avisos = new Map();

function ajustes() {
  const g = runtime.get('proxies', {}) || {};
  const porDisco = {};
  for (const [raiz, gb] of Object.entries(g.porDisco || {})) {
    const n = parseFloat(gb);
    if (Number.isFinite(n) && n >= 0) porDisco[raizDe(raiz)] = n;
  }
  const tope = parseFloat(g.topeGB);
  return {
    topeGB: Number.isFinite(tope) && tope >= 0 ? tope : TOPE_GB_FABRICA,
    porDisco,
    alLlegar: AL_LLEGAR.has(g.alLlegar) ? g.alLlegar : 'preguntar',
  };
}

/** Tope de un disco en bytes; 0 = sin limite. */
function topeDe(raiz, a = ajustes()) {
  const gb = Object.prototype.hasOwnProperty.call(a.porDisco, raiz) ? a.porDisco[raiz] : a.topeGB;
  return gb > 0 ? gb * 1073741824 : 0;
}

/** Bytes que ocupan en ese disco los proxies que este servicio conoce. */
function ocupado(raiz) {
  let total = 0;
  for (const e of Object.values(index || {})) {
    if (e && e.status === 'ready' && e.ruta && e.bytes && raizDe(e.ruta) === raiz) total += e.bytes;
  }
  return total;
}

/**
 * Guarda ajustes. `porDisco: { "F:\\": null }` quita el tope propio de ese
 * disco (vuelve al general); `0` lo deja sin limite.
 */
async function setAjustes(parcial = {}) {
  const guardado = runtime.get('proxies', {}) || {};
  const nuevo = { ...guardado };
  if (parcial.topeGB !== undefined) {
    const n = parseFloat(parcial.topeGB);
    if (Number.isFinite(n) && n >= 0) nuevo.topeGB = n;
  }
  if (AL_LLEGAR.has(parcial.alLlegar)) nuevo.alLlegar = parcial.alLlegar;
  if (parcial.porDisco && typeof parcial.porDisco === 'object') {
    const pd = { ...(nuevo.porDisco || {}) };
    for (const [raiz, gb] of Object.entries(parcial.porDisco)) {
      const clave = raizDe(raiz);
      if (gb === null) { delete pd[clave]; continue; }
      const n = parseFloat(gb);
      if (Number.isFinite(n) && n >= 0) pd[clave] = n;
    }
    nuevo.porDisco = pd;
  }
  await runtime.set('proxies', nuevo);
  // Subir el tope ES la respuesta: el aviso de ese disco deja de tener sentido.
  for (const raiz of [...avisos.keys()]) {
    const limite = topeDe(raiz);
    if (!limite || ocupado(raiz) < limite) avisos.delete(raiz);
  }
  return ajustes();
}

// ---------------------------------------------------------------------------
// Indice persistente
// ---------------------------------------------------------------------------
async function loadIndex() {
  if (index) return index;
  try {
    index = JSON.parse(await fsp.readFile(INDEX_FILE, 'utf-8'));
  } catch {
    index = {};
  }
  return index;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await atomicWriteFile(INDEX_FILE, JSON.stringify(index, null, 2)); }
    catch (err) { fallos.record('guardar el indice de proxies de video', err, { path: INDEX_FILE }); }
  }, 500);
}

// ---------------------------------------------------------------------------
// ffprobe / clasificacion
// ---------------------------------------------------------------------------
function runProcess(cmd, args, timeoutMs = 0) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
      return;
    }
    let stdout = '', stderr = '';
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    }
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', err => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err) }); });
    p.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * ffprobe del video. Devuelve { container, vcodec, pixfmt, acodec, width, height }
 * o null si falla.
 */
async function probe(filePath) {
  const args = [
    '-v', 'error', '-show_entries',
    'format=format_name,duration,bit_rate:stream=codec_type,codec_name,pix_fmt,width,height,channels:stream_side_data=rotation:stream_tags=rotate',
    '-of', 'json', filePath,
  ];
  const r = await runProcess('ffprobe', args, 30000);
  if (r.code !== 0) return null;
  let data;
  try { data = JSON.parse(r.stdout); } catch { return null; }
  const streams = data.streams || [];
  const v = streams.find(s => s.codec_type === 'video');
  const a = streams.find(s => s.codec_type === 'audio');
  if (!v) return null;
  const fmt = data.format || {};
  // Giro del movil (matriz de visualizacion, o la etiqueta "rotate" antigua).
  const giro = (v.side_data_list || []).find(d => d && d.rotation !== undefined);
  const rotacion = Math.abs(parseInt(giro ? giro.rotation : (v.tags && v.tags.rotate), 10) || 0) % 360;
  return {
    container: fmt.format_name || '',
    rotacion,
    duracion: parseFloat(fmt.duration) || 0,
    bitrate: parseInt(fmt.bit_rate, 10) || 0,
    vcodec: v.codec_name || '',
    pixfmt: v.pix_fmt || '',
    acodec: a ? (a.codec_name || '') : '',
    achannels: a ? (a.channels || 0) : 0,
    width: v.width || 0,
    height: v.height || 0,
  };
}

// Por encima de esto el navegador va a tirones aunque pueda abrirlo: 4K de
// camara, 60 fps, bitrates de 90 Mbps. La version ligera lo vuelve instantaneo.
const ALTO_COMODO = parseInt(process.env.VIDEO_PROXY_ALTO_COMODO, 10) || 1080;
const MBPS_COMODO = parseFloat(process.env.VIDEO_PROXY_MBPS_COMODO) || 30;

/**
 * ¿Ganaria fluidez con una version ligera, aunque el navegador pueda abrirlo?
 * Esto NO decide si se puede ver (eso es classify), decide si merece la pena
 * tener ademas una copia ligera.
 */
function conviene(info) {
  if (!info) return false;
  if ((info.height || 0) > ALTO_COMODO) return true;
  return (info.bitrate || 0) / 1e6 > MBPS_COMODO;
}

/**
 * Clasifica: 'native' | 'transcode'.
 */
function classify(info) {
  const containers = (info.container || '').split(',').map(s => s.trim());
  const containerNative = containers.some(c => NATIVE_CONTAINERS.has(c));
  // Video reproducible: h264 exige 8-bit 4:2:0; vp8/vp9/av1 se aceptan tal cual.
  const vNative = NATIVE_VCODECS.has(info.vcodec) &&
    (info.vcodec !== 'h264' || NATIVE_PIXFMTS.has(info.pixfmt));
  // El audio multicanal (5.1) en AAC no suena en los navegadores; exigir <=2
  // canales para considerarlo nativo. Si tiene mas, se remuxa con downmix.
  const aNative = !info.acodec || (NATIVE_ACODECS.has(info.acodec) && (info.achannels || 0) <= 2);

  if (vNative && containerNative && aNative) return 'native';

  // Todo lo demas, version ligera. Nunca copia del video: aunque el video en
  // si fuera compatible (p.ej. H.264 dentro de un .m2ts), copiarlo duplica el
  // archivo entero para cambiar un contenedor.
  return 'transcode';
}

// ---------------------------------------------------------------------------
// Dimensiones de salida (cap a MAX_HEIGHT, dimensiones pares)
// ---------------------------------------------------------------------------
function outputDims(srcW, srcH) {
  if (!srcW || !srcH || srcH <= MAX_HEIGHT) return { outW: srcW, outH: srcH, downscaled: false };
  const outH = MAX_HEIGHT;
  const outW = Math.round((srcW * MAX_HEIGHT) / srcH / 2) * 2;
  return { outW, outH, downscaled: true };
}

// Solo el transcode tiene dimensiones propias (reescala por encima de MAX_HEIGHT).
function dimsForKind(kind, srcW, srcH) {
  if (kind === 'transcode') return outputDims(srcW, srcH);
  return { outW: srcW, outH: srcH, downscaled: false };
}

// ---------------------------------------------------------------------------
// Cola con concurrencia limitada
// ---------------------------------------------------------------------------
function enqueue(taskFn) {
  return new Promise((resolve, reject) => {
    queue.push({ taskFn, resolve, reject });
    drain();
  });
}
function drain() {
  while (active < CONCURRENCY && queue.length > 0) {
    const { taskFn, resolve, reject } = queue.shift();
    active++;
    Promise.resolve()
      .then(taskFn)
      .then(resolve, reject)
      .finally(() => { active--; drain(); });
  }
}

// ---------------------------------------------------------------------------
// Generacion del proxy
// ---------------------------------------------------------------------------
/**
 * Los niveles, del mas rapido al que funciona en cualquier equipo. Medido el
 * 28/09/2026 con 20 s de 4K de camara (RTX 5070 Ti), velocidad sobre tiempo real:
 *
 *   'gpu'      leer, reducir y codificar en la grafica  4,9x (H.264 4:2:2 10 bits) / 6,0x (HEVC 10 bits)
 *   'gpu-lee'  leer en la grafica, reducir aqui         2,9x / 4,6x
 *   'nvenc'    leer y reducir aqui, codificar alli      1,6x / 1,4x   (lo de antes)
 *   'cpu'      todo por el procesador                   1,3x / 1,6x
 *
 * Mismo resultado (PSNR 44 dB entre 'gpu' y 'nvenc'). Pero 'gpu' NO gira los
 * videos del movil (salen tumbados): solo se usa con los que no tienen giro.
 * 'gpu-lee' si gira, y si la grafica no sabe leer ese formato ffmpeg lo lee
 * por el procesador sin fallar.
 */
function modosPara(info) {
  const modos = [];
  if (nvencSupported !== false) {
    if (cudaDisponible !== false) {
      const firma = `${info.vcodec || ''}|${info.pixfmt || ''}`;
      if (info.rotacion === 0 && info.width > 0 && info.height > 0 && !sinTodoGpu.has(firma)) modos.push('gpu');
      modos.push('gpu-lee');
    }
    modos.push('nvenc');
  }
  modos.push('cpu');
  return modos;
}

/**
 * Prueba los niveles en orden hasta que uno sale, y aprende de lo que falla
 * para no volver a intentarlo en este equipo: sin NVIDIA, solo el primer video
 * paga los intentos. Si fallan todos, el problema es el archivo y no se aprende
 * nada (antes, un solo video roto apagaba la grafica para siempre).
 * @param {object} info  probe del video
 * @param {(modo: string) => Promise<{code:number}>} ejecutar
 */
async function conRespaldo(info, ejecutar) {
  const fallidos = [];
  let r = null;
  for (const modo of modosPara(info)) {
    r = await ejecutar(modo);
    if (r.code === 0) {
      if (modo !== 'cpu') nvencSupported = true;
      if (modo === 'gpu' || modo === 'gpu-lee') cudaDisponible = true;
      if (fallidos.includes('gpu')) sinTodoGpu.add(`${info.vcodec || ''}|${info.pixfmt || ''}`);
      if (fallidos.includes('gpu-lee') && modo !== 'gpu-lee') cudaDisponible = false;
      if (fallidos.includes('nvenc') && modo === 'cpu') { nvencSupported = false; cudaDisponible = false; }
      if (fallidos.length > 0) console.warn(`[videoProxy] ${fallidos.join(', ')} no pudo; preparado con '${modo}'`);
      return { r, modo };
    }
    fallidos.push(modo);
  }
  return { r, modo: null };
}

function buildArgs({ kind, input, output, dims, modo = 'nvenc' }) {
  // Leer en la grafica: con 'gpu' los fotogramas se quedan alli (para reducir
  // y codificar sin ir y volver); con 'gpu-lee' bajan a memoria.
  const leer = modo === 'gpu' ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']
    : modo === 'gpu-lee' ? ['-hwaccel', 'cuda'] : [];
  // -dn/-sn: descartar streams de datos (timecode) y subtitulos que algunas
  // camaras incrustan y que no aportan a la reproduccion web.
  const common = ['-y', ...leer, '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-dn', '-sn'];
  // -ac 2: downmix a estereo. El AAC 5.1 no suena en navegadores; el estereo
  // es universalmente reproducible (suficiente para previsualizacion).
  const tail = ['-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-movflags', '+faststart', output];
  // Calidad constante con techo de bitrate: en planos faciles pesa poco y en
  // los dificiles no se dispara.
  const techo = ['-maxrate', MAX_BITRATE, '-bufsize', String(parseInt(MAX_BITRATE, 10) * 2) + (MAX_BITRATE.replace(/[\d.]/g, '') || '')];
  const venc = modo !== 'cpu'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '25', '-b:v', '0', ...techo]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', ...techo];
  if (modo === 'gpu') {
    // Reducir y pasar a 8 bits 4:2:0 en la grafica (siempre: un 10 bits que no
    // se reduce tambien hay que convertirlo). Medidas pares, como pide nv12.
    const w = Math.floor((dims.outW || 0) / 2) * 2;
    const h = Math.floor((dims.outH || 0) / 2) * 2;
    return [...common, ...venc, '-vf', `scale_cuda=${w}:${h}:format=nv12`, ...tail];
  }
  const scale = dims.downscaled ? ['-vf', `scale=${dims.outW}:${dims.outH}`] : [];
  return [...common, ...venc, '-pix_fmt', 'yuv420p', ...scale, ...tail];
}

async function runFfmpeg(args, timeoutMs = 0) {
  // Preferir ffmpeg del sistema (con NVENC). Si no existe, caer al de installer.
  let r = await runProcess('ffmpeg', args, timeoutMs);
  if (r.code === -1 && installerFfmpeg) {
    r = await runProcess(installerFfmpeg, args, timeoutMs);
  }
  return r;
}

async function ensureDir(loc, file) {
  try {
    await fsp.mkdir(loc.proxyDir, { recursive: true });
    return loc;
  } catch (err) {
    if (!loc.legacy) {
      console.warn(`[videoProxy] no se pudo crear ${loc.proxyDir} (${err.message}); fallback legacy`);
      const legacy = pathsConfig.resolveProxyLocation({ fullPath: file.fullPath, fileId: file.id, legacy: true });
      try { await fsp.mkdir(legacy.proxyDir, { recursive: true }); return legacy; } catch { return null; }
    }
    return null;
  }
}

/** GB libres en el disco de `dir` (o de su raiz si aun no existe), o null. */
async function gbLibres(dir) {
  try {
    const st = await fsp.statfs(fs.existsSync(dir) ? dir : path.parse(path.resolve(dir)).root);
    return (st.bavail * st.bsize) / 1073741824;
  } catch {
    return null;
  }
}

/** Raiz del disco de una ruta ("F:\\"), para agrupar el presupuesto. */
const raizDe = (ruta) => path.parse(path.resolve(ruta)).root.toUpperCase();

/**
 * Elige donde escribir: junto al archivo si su disco tiene sitio; si no, en la
 * carpeta del sistema si ESE disco lo tiene. Si ninguno, error con la causa:
 * llenar un disco de proxies es lo que no puede volver a pasar.
 */
async function ubicacionConSitio(file) {
  const junto = pathsConfig.resolveProxyLocation({ fullPath: file.fullPath, fileId: file.id });
  const libresJunto = await gbLibres(junto.proxyDir);
  if (libresJunto === null || libresJunto >= MIN_LIBRE_GB) return junto;
  const sistema = pathsConfig.resolveProxyLocation({ fullPath: file.fullPath, fileId: file.id, legacy: true });
  const libresSistema = await gbLibres(sistema.proxyDir);
  if (libresSistema !== null && libresSistema >= MIN_LIBRE_GB) {
    console.warn(`[videoProxy] ${raizDe(junto.proxyDir)} solo tiene ${libresJunto.toFixed(0)} GB libres; el proxy va a ${sistema.proxyDir}`);
    return sistema;
  }
  const err = new Error(`Sin espacio para preparar el vídeo: ${raizDe(junto.proxyDir)} tiene ${libresJunto.toFixed(0)} GB libres (mínimo ${MIN_LIBRE_GB} GB)`);
  err.code = 'ENOSPC';
  throw err;
}

/**
 * Baja de su tope los proxies de un disco borrando los que hace mas que no se
 * ven. Son regenerables: si vuelves a abrir uno, se prepara otra vez. Solo
 * cuenta los que este servicio sabe donde estan (`ruta` y `bytes` en el indice).
 *
 * Solo borra por su cuenta si el usuario eligio 'liberar'. Con 'preguntar'
 * (de fabrica) esto solo corre cuando el usuario lo pide (`forzar`).
 */
async function aplicarPresupuesto(raiz, protegido, opts = {}) {
  const limite = topeDe(raiz);
  if (!limite) return 0;
  if (!opts.forzar && ajustes().alLlegar !== 'liberar') return 0;
  const delDisco = Object.entries(index)
    .filter(([, e]) => e && e.status === 'ready' && e.ruta && e.bytes && raizDe(e.ruta) === raiz);
  let total = delDisco.reduce((acc, [, e]) => acc + e.bytes, 0);
  if (total <= limite) return 0;
  delDisco.sort((a, b) => (a[1].usado || 0) - (b[1].usado || 0));
  let liberados = 0;
  for (const [id, e] of delDisco) {
    if (total <= limite) break;
    if (id === protegido || inFlight.has(id)) continue;
    try {
      await fsp.unlink(e.ruta);
    } catch (err) {
      if (err.code !== 'ENOENT') { fallos.record('liberar un proxy de video por presupuesto', err, { path: e.ruta }); continue; }
    }
    total -= e.bytes;
    liberados++;
    index[id] = { ...e, status: 'pending' };
    delete index[id].ruta;
    delete index[id].bytes;
  }
  if (liberados > 0) {
    console.log(`[videoProxy] tope de ${raiz}: ${liberados} proxy(s) poco vistos liberados`);
    scheduleSave();
  }
  return liberados;
}

/** Libera a mano los menos vistos de un disco hasta bajar de su tope. */
async function liberar(raiz) {
  await loadIndex();
  const r = raizDe(raiz);
  const n = await aplicarPresupuesto(r, null, { forzar: true });
  avisos.delete(r);
  return n;
}

/**
 * Retrato de los proxies para la interfaz: cuanto ocupan por disco, contra que
 * tope, cuanto le queda libre a ese disco y si alguno espera una decision.
 */
async function estado() {
  await loadIndex();
  const a = ajustes();
  const discos = new Map();
  // 'antiguos': preparados por la regla vieja, sin `ruta`/`bytes` en el indice.
  // No se pueden medir ni pesan en el tope; se los lleva limpiar-proxies.js.
  const totales = { listos: 0, bytes: 0, pendientes: 0, errores: 0, nativos: 0, forzados: 0, antiguos: 0 };
  for (const e of Object.values(index)) {
    if (!e) continue;
    if (e.status === 'native') { totales.nativos++; continue; }
    if (e.status === 'error') { totales.errores++; continue; }
    if (e.status !== 'ready') { totales.pendientes++; continue; }
    if (!e.ruta || !e.bytes) { totales.antiguos++; continue; }
    totales.listos++;
    if (e.forzado) totales.forzados++;
    const raiz = raizDe(e.ruta);
    const d = discos.get(raiz) || { raiz, n: 0, bytes: 0, visto: 0 };
    d.n++;
    d.bytes += e.bytes;
    if ((e.usado || 0) > d.visto) d.visto = e.usado || 0;
    discos.set(raiz, d);
    totales.bytes += e.bytes;
  }
  // Un disco con tope propio se enseña aunque aun no tenga ningun proxy.
  for (const raiz of Object.keys(a.porDisco)) {
    if (!discos.has(raiz)) discos.set(raiz, { raiz, n: 0, bytes: 0, visto: 0 });
  }
  const lista = [];
  for (const d of discos.values()) {
    const limite = topeDe(d.raiz, a);
    lista.push({
      ...d,
      topeGB: limite ? limite / 1073741824 : 0,
      propio: Object.prototype.hasOwnProperty.call(a.porDisco, d.raiz),
      libreGB: await gbLibres(d.raiz),
      aviso: avisos.has(d.raiz) ? { ...avisos.get(d.raiz) } : null,
    });
  }
  lista.sort((x, y) => y.bytes - x.bytes);
  return { ajustes: a, minLibreGB: MIN_LIBRE_GB, discos: lista, totales, lote: estadoLote() };
}

/** Ruta del proxy si existe en disco: la anotada, junto al archivo o la del sistema. */
async function rutaProxyExistente(file) {
  const e = index && index[file.id];
  const candidatos = [
    e && e.ruta,
    pathsConfig.resolveProxyLocation({ fullPath: file.fullPath, fileId: file.id }).proxyPath,
    pathsConfig.resolveProxyLocation({ fullPath: file.fullPath, fileId: file.id, legacy: true }).proxyPath,
  ].filter(Boolean);
  for (const c of candidatos) {
    try { await fsp.access(c); return c; } catch { /* siguiente */ }
  }
  return null;
}

/**
 * Genera el proxy en disco (bloqueante hasta terminar). Actualiza el indice.
 */
async function generate(file, kind, info) {
  let loc = await ubicacionConSitio(file);
  loc = await ensureDir(loc, file);
  if (!loc) throw new Error('no se pudo crear el directorio de proxies');

  // Lo clasificado antes de que se mirara el giro no lo sabe: sin saberlo no
  // se usa 'gpu' (un video del movil saldria tumbado), asi que se pregunta.
  if (info.rotacion === undefined || info.vcodec === undefined) {
    const p = await probe(file.fullPath);
    if (p) info = { ...info, ...p };
  }
  const dims = dimsForKind(kind, info.width, info.height);
  const tmp = `${loc.proxyPath}.tmp.mp4`;

  const { r } = await conRespaldo(info, async (modo) => {
    try { await fsp.unlink(tmp); } catch {}
    return runFfmpeg(buildArgs({ kind, input: file.fullPath, output: tmp, dims, modo }));
  });

  if (r.code !== 0) {
    try { await fsp.unlink(tmp); } catch {}
    throw new Error(`ffmpeg salio con codigo ${r.code}: ${(r.stderr || '').slice(-300)}`);
  }

  // Rename atomico tmp -> final.
  await fsp.rename(tmp, loc.proxyPath);

  let bytes = 0;
  try { bytes = (await fsp.stat(loc.proxyPath)).size; } catch { /* sin tamaño: fuera del presupuesto */ }
  const entry = index[file.id] || {};
  entry.v = VERSION_CLASIFICACION;
  entry.kind = kind;
  entry.status = 'ready';
  entry.ruta = loc.proxyPath;
  entry.bytes = bytes;
  entry.usado = Date.now();
  entry.srcW = info.width;
  entry.srcH = info.height;
  entry.outW = dims.outW;
  entry.outH = dims.outH;
  entry.downscaled = dims.downscaled;
  entry.srcMtime = file.srcMtime;
  delete entry.error;
  index[file.id] = entry;
  scheduleSave();
  await aplicarPresupuesto(raizDe(loc.proxyPath), file.id).catch(err => fallos.record('aplicar el presupuesto de proxies', err, {}));
  return loc.proxyPath;
}

// ---------------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------------

/**
 * Resuelve el estado de reproduccion de un archivo y dispara la generacion del
 * proxy si hace falta (no bloquea: devuelve 'generating' mientras se genera).
 *
 * @param {{id:string, fullPath:string, name?:string}} file
 * @param {{forzar?:boolean, sinPreparar?:boolean}} [opts] forzar: preparar proxy
 *   aunque parezca nativo (el navegador no pudo abrir el original).
 *   sinPreparar: devolver lo que haya AHORA sin poner nada a preparar (la
 *   portada enseña vídeos de fondo; no debe llenar la cola de la GPU).
 * @returns {Promise<{status:'native'|'ready'|'generating'|'error', url?:string,
 *   kind?:string, downscaled?:boolean, srcW?:number, srcH?:number,
 *   outW?:number, outH?:number, error?:string}>}
 */
async function getPlayable(file, opts = {}) {
  await loadIndex();
  if (!file || !file.fullPath || !file.id) return { status: 'error', error: 'archivo invalido' };

  let srcMtime = 0;
  try { srcMtime = (await fsp.stat(file.fullPath)).mtimeMs; }
  catch { return { status: 'error', error: 'original no accesible' }; }
  file.srcMtime = srcMtime;

  // Clasificacion (cacheada por mtime).
  let cached = index[file.id];
  let kind, info;
  if (cached && cached.srcMtime === srcMtime && cached.kind && cached.v === VERSION_CLASIFICACION) {
    kind = cached.kind;
    info = { width: cached.srcW, height: cached.srcH, bitrate: cached.bitrate, rotacion: cached.rot, vcodec: cached.vcodec, pixfmt: cached.pixfmt };
  } else {
    const probed = await probe(file.fullPath);
    if (!probed) return { status: 'error', error: 'no se pudo analizar el video' };
    kind = classify(probed);
    info = probed;
    // Un proxy de la regla vieja solo se aprovecha si era una version ligera
    // (transcode) y sigue haciendo falta. Un remux era una copia: se ignora y,
    // si el video aun necesita proxy, se prepara uno ligero.
    const aprovechable = !!cached && cached.srcMtime === srcMtime && cached.kind === 'transcode'
      && cached.status === 'ready' && kind === 'transcode';
    index[file.id] = {
      ...(aprovechable ? cached : {}),
      v: VERSION_CLASIFICACION,
      kind,
      status: kind === 'native' ? 'native' : (aprovechable ? 'ready' : 'pending'),
      srcW: probed.width, srcH: probed.height, srcMtime,
      bitrate: probed.bitrate || 0,
      dur: probed.duracion || 0,
      rot: probed.rotacion,
      vcodec: probed.vcodec,
      pixfmt: probed.pixfmt,
    };
    scheduleSave();
    cached = index[file.id];
  }

  // Se abre, pero pesa: se le prepara una version ligera igualmente. El
  // original sigue siendo reproducible, asi que nadie espera por esto:
  // `original: 'playable'` es lo que permite servirlo mientras se prepara.
  if (kind === 'native' && conviene(info) && !opts.sinPreparar) {
    kind = 'transcode';
    index[file.id] = { ...cached, kind, original: 'playable', status: cached.status === 'ready' ? 'ready' : 'pending' };
    scheduleSave();
    cached = index[file.id];
  }

  // El navegador no pudo con el original: a partir de ahora, version ligera.
  if (opts.forzar && kind === 'native') {
    kind = 'transcode';
    index[file.id] = { ...cached, kind, forzado: true, status: 'pending' };
    scheduleSave();
    cached = index[file.id];
  }

  if (kind === 'native') {
    return { status: 'native', url: pathsConfig.getStreamUrl(file.id), ligero: !conviene(info) };
  }

  // Necesita proxy. Resolver ubicacion y comprobar si ya esta listo.
  const loc = pathsConfig.resolveProxyLocation({ fullPath: file.fullPath, fileId: file.id });
  const dims = dimsForKind(kind, info.width, info.height);
  const existente = await rutaProxyExistente(file);

  if (existente && cached.status === 'ready' && cached.srcMtime === srcMtime) {
    // Se apunta cuando se usa: el presupuesto borra primero lo que no se ve.
    cached.usado = Date.now();
    if (!cached.ruta) cached.ruta = existente;
    scheduleSave();
    return {
      status: 'ready', url: loc.proxyUrl, kind,
      downscaled: !!cached.downscaled, srcW: cached.srcW, srcH: cached.srcH,
      outW: cached.outW, outH: cached.outH,
    };
  }

  // "Dame lo que haya": ni se prepara ni se encola. Si el original se puede
  // ver, se ve; si no, que se quede sin vídeo quien lo pidio asi.
  if (opts.sinPreparar) {
    return cached.original === 'playable'
      ? { status: 'native', url: pathsConfig.getStreamUrl(file.id), ligero: false }
      : { status: 'generating', kind };
  }

  // Antes de preparar nada: ¿donde iria y cabe ahi? Preguntarlo ahora evita
  // encolar un trabajo que iba a morir al final, y da una respuesta util.
  let destino;
  try {
    destino = await ubicacionConSitio(file);
  } catch (err) {
    index[file.id] = { ...cached, status: 'error', error: err.message };
    scheduleSave();
    return { status: 'error', motivo: 'espacio', error: err.message, kind };
  }
  const raiz = raizDe(destino.proxyDir);
  const a = ajustes();
  const limite = topeDe(raiz, a);
  const enSuTope = limite > 0 && ocupado(raiz) >= limite && a.alLlegar === 'preguntar';
  if (enSuTope) {
    // Con el original reproducible no hay nada que preguntar: se ve y ya.
    if (cached.original === 'playable') {
      return { status: 'native', url: pathsConfig.getStreamUrl(file.id), ligero: false, enSuTope: true, raiz };
    }
    const aviso = avisos.get(raiz) || { desde: Date.now(), esperando: 0 };
    aviso.esperando++;
    aviso.ultimo = file.name || file.id;
    avisos.set(raiz, aviso);
    const gb = (limite / 1073741824).toLocaleString('es-ES', { maximumFractionDigits: 1 });
    return {
      status: 'error', motivo: 'tope', raiz, topeGB: limite / 1073741824, kind,
      error: `Los vídeos preparados de ${raiz} han llegado a su tope de ${gb} GB.`,
    };
  }

  // Lanzar generacion (dedupe + cola) sin bloquear la respuesta.
  startGeneration(file, kind, info);

  // Si el original se puede ver, se ve AHORA: la version ligera es para la
  // proxima vez. Nadie mira una rueda girar por un video que ya funcionaba.
  if (cached.original === 'playable') {
    return { status: 'native', url: pathsConfig.getStreamUrl(file.id), ligero: false, preparando: true };
  }

  return {
    status: cached.status === 'error' ? 'error' : 'generating',
    kind, downscaled: dims.downscaled,
    srcW: info.width, srcH: info.height, outW: dims.outW, outH: dims.outH,
    error: cached.status === 'error' ? cached.error : undefined,
  };
}

function startGeneration(file, kind, info) {
  if (inFlight.has(file.id)) return inFlight.get(file.id);
  const entry = index[file.id] || {};
  entry.status = 'generating';
  index[file.id] = entry;
  scheduleSave();

  const p = enqueue(() => generate(file, kind, info))
    .catch((err) => {
      console.warn(`[videoProxy] error generando proxy de ${file.name || file.id}: ${err.message}`);
      const e = index[file.id] || {};
      e.status = 'error';
      e.error = err.message;
      index[file.id] = e;
      scheduleSave();
    })
    .finally(() => inFlight.delete(file.id));
  inFlight.set(file.id, p);
  return p;
}

/**
 * Pre-calienta el proxy de un video (fire-and-forget), usado por el escaneo y
 * por el adelanto de vecinos al abrir uno.
 * @param {{id:string, fullPath:string, name?:string}} file
 */
function prewarm(file) {
  getPlayable(file).catch(() => {});
}

// ---------------------------------------------------------------------------
// Cuanto tarda este equipo
// ---------------------------------------------------------------------------
/**
 * Mide cuanto tarda ESTE equipo en preparar un video: se prepara de verdad un
 * trozo corto de unos pocos videos de muestra (a la carpeta temporal, y se
 * borra) y se cronometra. Con la grafica un 4K va varias veces mas rapido que
 * el propio video; por el procesador puede ir mas lento que el video, y eso es
 * justo lo que hay que saber antes de lanzar horas de trabajo.
 *
 * Devuelve { segPorSegundo, arranqueSeg, encoder, muestras }: lo que se tarda
 * en preparar un segundo de video y lo que cuesta cada archivo aparte
 * (analizarlo y arrancar ffmpeg), que en clips cortos pesa. O null si no pudo
 * medir nada.
 */
const TROZO_SEG = 5;
let medida = null;

async function medirVelocidad(muestras) {
  if (medida && Date.now() - medida.en < 10 * 60 * 1000 && medida.nvenc === nvencSupported && medida.cuda === cudaDisponible) return medida;
  const porSegundo = [];
  const arranques = [];
  for (const f of muestras) {
    const t0 = Date.now();
    const info = await probe(f.fullPath);
    if (!info) continue;
    const analizar = (Date.now() - t0) / 1000;
    const dur = info.duracion || 0;
    const trozo = dur > 0 ? Math.min(TROZO_SEG, dur) : TROZO_SEG;
    // Desde el 20 % del video: el principio suele ser un plano quieto y engaña.
    const desde = dur > trozo * 3 ? Math.floor(dur * 0.2) : 0;
    const salida = path.join(os.tmpdir(), `pensadero-medida-${process.pid}-${Date.now()}.mp4`);
    const dims = dimsForKind('transcode', info.width, info.height);
    // Con los mismos niveles que el lote: se mide lo que de verdad va a pasar.
    let seg = 0;
    const { r } = await conRespaldo(info, async (modo) => {
      const args = buildArgs({ kind: 'transcode', input: f.fullPath, output: salida, dims, modo });
      // -ss/-t antes de -i: solo se lee y se prepara ese trozo.
      args.splice(1, 0, '-ss', String(desde), '-t', String(trozo));
      const inicio = Date.now();
      const res = await runFfmpeg(args, 120000);
      seg = (Date.now() - inicio) / 1000;
      return res;
    });
    const m = { r, seg };
    try { await fsp.unlink(salida); } catch { /* no llego a crearse */ }
    if (m.r.code !== 0) continue;
    // ffmpeg dice a que velocidad ha ido ("speed=6.2x") sin contar lo que
    // tardo en arrancar; la diferencia es el coste fijo de cada archivo.
    const velocidades = (m.r.stderr || '').match(/speed=\s*[\d.]+x/g) || [];
    const velocidad = velocidades.length ? parseFloat(velocidades[velocidades.length - 1].replace(/[^\d.]/g, '')) : 0;
    const soloTrozo = velocidad > 0 ? trozo / velocidad : m.seg;
    porSegundo.push(soloTrozo / trozo);
    arranques.push(Math.max(0, m.seg - soloTrozo) + analizar);
  }
  if (porSegundo.length === 0) return null;
  const media = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  medida = {
    segPorSegundo: media(porSegundo),
    arranqueSeg: media(arranques),
    encoder: nvencSupported === false ? 'procesador' : 'grafica',
    muestras: porSegundo.length,
    en: Date.now(),
    nvenc: nvencSupported,
    cuda: cudaDisponible,
  };
  return medida;
}

/** Tope de un disco (bytes; 0 = sin tope), lo que ya ocupan sus proxies y su sitio libre. */
async function presupuestoDe(raiz) {
  await loadIndex();
  const r = raizDe(raiz);
  return { topeBytes: topeDe(r), ocupadoBytes: ocupado(r), libreGB: await gbLibres(r), minLibreGB: MIN_LIBRE_GB };
}

// ---------------------------------------------------------------------------
// Preparar en lote
// ---------------------------------------------------------------------------
/**
 * Un solo lote a la vez, en memoria. Es trabajo de GPU: dos a la vez no van al
 * doble, van a la mitad cada uno y con el disco peleandose.
 */
let lote = null;

/** ¿Ya esta resuelto este archivo? (nada que preparar) */
function yaListo(id) {
  const e = index && index[id];
  return !!e && e.v === VERSION_CLASIFICACION && (e.status === 'ready' || e.status === 'native');
}

/**
 * Prepara una lista de videos, uno detras de otro. Un disco que llega a su
 * tope (o se queda sin sitio) deja de prepararse y el lote sigue con los
 * demas: ahi la decision es del usuario, no del lote. Con un lote de todos los
 * discos, parar entero al llenarse el primero dejaba el resto sin hacer.
 * @param {Array<{id,fullPath,name}>} files
 */
async function prepararLote(files, meta = {}) {
  await loadIndex();
  if (lote && !lote.terminado) throw new Error('ya hay una preparación en marcha');
  lote = {
    total: files.length, hechos: 0, saltados: 0, fallos: 0, bytes: 0,
    desde: Date.now(), terminado: false, cancelado: false,
    actual: null, motivo: null, raiz: meta.raiz || null,
    // Discos que se pararon (tope o sitio) y cuantos se quedaron sin preparar.
    topes: [], sinSitio: 0,
  };
  const mio = lote;
  const parados = new Set(); // raiz del original

  (async () => {
    for (const f of files) {
      if (mio.cancelado) { mio.motivo = 'cancelado'; break; }
      if (yaListo(f.id)) { mio.saltados++; continue; }
      const deDisco = raizDe(f.fullPath);
      if (parados.has(deDisco)) { mio.sinSitio++; continue; }
      mio.actual = f.name || f.id;
      try {
        const r = await getPlayable(f);
        const lleno = r.status === 'error' && (r.motivo === 'tope' || r.motivo === 'espacio');
        if (lleno || r.enSuTope) {
          const motivo = r.motivo === 'espacio' ? 'espacio' : 'tope';
          parados.add(deDisco);
          mio.topes.push({ raiz: r.raiz || deDisco, motivo });
          // Compatibilidad: el primero que se paro, como antes.
          if (!mio.motivo) { mio.motivo = motivo; mio.raiz = r.raiz || deDisco; }
          mio.sinSitio++;
          continue;
        }
        const enCurso = inFlight.get(f.id);
        if (enCurso) await enCurso;
        const e = index[f.id];
        if (e && e.status === 'ready') { mio.hechos++; mio.bytes += e.bytes || 0; }
        else if (e && e.status === 'error') mio.fallos++;
        else mio.saltados++;
      } catch {
        mio.fallos++;
      }
    }
    mio.actual = null;
    mio.terminado = true;
    mio.hasta = Date.now();
  })();

  return estadoLote();
}

/** Retrato del lote en marcha (o del ultimo), o null si nunca hubo ninguno. */
function estadoLote() {
  if (!lote) return null;
  const hechos = lote.hechos + lote.saltados + lote.fallos;
  const seg = (Date.now() - lote.desde) / 1000;
  const ritmo = hechos > 0 && seg > 0 ? hechos / seg : 0;
  return {
    ...lote,
    procesados: hechos,
    // Lo que falta, al ritmo que lleva. Sin ritmo todavia, no se inventa.
    restanteSeg: ritmo > 0 ? Math.round((lote.total - hechos) / ritmo) : null,
  };
}

/** Para el lote en marcha. Lo que ya se preparo se queda preparado. */
function cancelarLote() {
  if (lote && !lote.terminado) lote.cancelado = true;
  return estadoLote();
}

/**
 * Devuelve la ruta absoluta del proxy si existe y esta listo, o null.
 */
async function getReadyProxyPath(file) {
  await loadIndex();
  return rutaProxyExistente(file);
}

module.exports = {
  getPlayable,
  prewarm,
  getReadyProxyPath,
  probe,
  classify,
  ajustes,
  setAjustes,
  estado,
  liberar,
  conviene,
  yaListo,
  prepararLote,
  estadoLote,
  cancelarLote,
  medirVelocidad,
  presupuestoDe,
  // Para pruebas: los niveles y los argumentos de ffmpeg.
  _modosPara: modosPara,
  _buildArgs: buildArgs,
  _conRespaldo: conRespaldo,
  _reiniciarAprendido: () => { nvencSupported = null; cudaDisponible = null; sinTodoGpu.clear(); medida = null; },
  ALTO_COMODO,
  MBPS_COMODO,
  VERSION_CLASIFICACION,
};
