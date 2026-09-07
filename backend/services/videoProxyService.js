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
 *  - probeCompat clasifica cada video: native (no necesita proxy) / remux
 *    (video ya compatible, solo cambiar contenedor+audio: copy de video, rapido)
 *    / transcode (recodificar video con NVENC, reescalando a <=1080p).
 *  - Generacion idempotente y persistente: una vez hecho, se reutiliza. Cola con
 *    concurrencia limitada y dedupe por fileId para no saturar la GPU.
 *  - Indice durable en backend/video_proxies.json.
 *
 * Aprovecha el ffmpeg/ffprobe del SISTEMA (como visualScanService) para tener
 * h264_nvenc; si NVENC falla, cae a libx264 (CPU) automaticamente.
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const pathsConfig = require('../config/paths');
const { atomicWriteFile } = require('../utils/jsonStore');

// Binario ffmpeg de respaldo (sin NVENC) si no hay ffmpeg en el PATH.
let installerFfmpeg = null;
try { installerFfmpeg = require('@ffmpeg-installer/ffmpeg').path; } catch { /* opcional */ }

const INDEX_FILE = path.join(__dirname, '..', 'video_proxies.json');
const MAX_HEIGHT = parseInt(process.env.VIDEO_PROXY_MAX_HEIGHT, 10) || 1080;
const CONCURRENCY = parseInt(process.env.VIDEO_PROXY_CONCURRENCY, 10) || 1;

// Codecs/pixfmt/contenedores que el navegador reproduce nativamente.
const NATIVE_VCODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const NATIVE_PIXFMTS = new Set(['yuv420p', 'yuvj420p']); // 8-bit 4:2:0
const NATIVE_ACODECS = new Set(['aac', 'mp3', 'opus', 'vorbis']);
const NATIVE_CONTAINERS = new Set(['mp4', 'mov', 'm4v', 'm4a', 'webm', '3gp', '3gpp']);

// === Estado en memoria ===
let index = null;                 // fileId -> { kind, status, srcW, srcH, outW, outH, srcMtime, error }
const inFlight = new Map();       // fileId -> Promise (generacion en curso)
let nvencSupported = null;        // null=desconocido, true/false tras primer intento
let active = 0;
const queue = [];

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
    catch (err) { console.warn('[videoProxy] no se pudo guardar el indice:', err.message); }
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
    'format=format_name:stream=codec_type,codec_name,pix_fmt,width,height,channels',
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
  return {
    container: (data.format && data.format.format_name) || '',
    vcodec: v.codec_name || '',
    pixfmt: v.pix_fmt || '',
    acodec: a ? (a.codec_name || '') : '',
    achannels: a ? (a.channels || 0) : 0,
    width: v.width || 0,
    height: v.height || 0,
  };
}

/**
 * Clasifica: 'native' | 'remux' | 'transcode'.
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
  if (vNative) return 'remux';   // video ya vale; arreglar contenedor/audio (copy de video)
  return 'transcode';            // recodificar video
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

// El remux copia el video sin tocar (conserva resolucion); solo el transcode
// reescala. Las dimensiones de salida y el flag downscaled dependen del tipo.
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
function buildArgs({ kind, input, output, dims, useNvenc }) {
  // -dn/-sn: descartar streams de datos (timecode) y subtitulos que algunas
  // camaras incrustan y que no aportan a la reproduccion web.
  const common = ['-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-dn', '-sn'];
  // -ac 2: downmix a estereo. El AAC 5.1 no suena en navegadores; el estereo
  // es universalmente reproducible (suficiente para previsualizacion).
  const tail = ['-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', output];
  if (kind === 'remux') {
    return [...common, '-c:v', 'copy', ...tail];
  }
  // transcode
  const venc = useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];
  const scale = dims.downscaled ? ['-vf', `scale=${dims.outW}:${dims.outH}`] : [];
  return [...common, ...venc, '-pix_fmt', 'yuv420p', ...scale, ...tail];
}

async function runFfmpeg(args) {
  // Preferir ffmpeg del sistema (con NVENC). Si no existe, caer al de installer.
  let r = await runProcess('ffmpeg', args);
  if (r.code === -1 && installerFfmpeg) {
    r = await runProcess(installerFfmpeg, args);
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

/**
 * Genera el proxy en disco (bloqueante hasta terminar). Actualiza el indice.
 */
async function generate(file, kind, info) {
  let loc = pathsConfig.resolveProxyLocation({ fullPath: file.fullPath, fileId: file.id });
  loc = await ensureDir(loc, file);
  if (!loc) throw new Error('no se pudo crear el directorio de proxies');

  const dims = dimsForKind(kind, info.width, info.height);
  const tmp = `${loc.proxyPath}.tmp.mp4`;

  const attempt = async (useNvenc) => {
    try { await fsp.unlink(tmp); } catch {}
    const args = buildArgs({ kind, input: file.fullPath, output: tmp, dims, useNvenc });
    const r = await runFfmpeg(args);
    return r;
  };

  let r;
  if (kind === 'transcode' && nvencSupported !== false) {
    r = await attempt(true);
    if (r.code === 0) {
      nvencSupported = true;
    } else {
      // NVENC no disponible/fallo -> CPU
      console.warn(`[videoProxy] NVENC fallo en ${file.name || file.id}; reintentando con libx264 (CPU)`);
      nvencSupported = false;
      r = await attempt(false);
    }
  } else {
    r = await attempt(kind === 'transcode' ? false : true); // remux ignora useNvenc
  }

  if (r.code !== 0) {
    try { await fsp.unlink(tmp); } catch {}
    throw new Error(`ffmpeg salio con codigo ${r.code}: ${(r.stderr || '').slice(-300)}`);
  }

  // Rename atomico tmp -> final.
  await fsp.rename(tmp, loc.proxyPath);

  const entry = index[file.id] || {};
  entry.kind = kind;
  entry.status = 'ready';
  entry.srcW = info.width;
  entry.srcH = info.height;
  entry.outW = dims.outW;
  entry.outH = dims.outH;
  entry.downscaled = dims.downscaled;
  entry.srcMtime = file.srcMtime;
  delete entry.error;
  index[file.id] = entry;
  scheduleSave();
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
 * @returns {Promise<{status:'native'|'ready'|'generating'|'error', url?:string,
 *   kind?:string, downscaled?:boolean, srcW?:number, srcH?:number,
 *   outW?:number, outH?:number, error?:string}>}
 */
async function getPlayable(file) {
  await loadIndex();
  if (!file || !file.fullPath || !file.id) return { status: 'error', error: 'archivo invalido' };

  let srcMtime = 0;
  try { srcMtime = (await fsp.stat(file.fullPath)).mtimeMs; }
  catch { return { status: 'error', error: 'original no accesible' }; }
  file.srcMtime = srcMtime;

  // Clasificacion (cacheada por mtime).
  let cached = index[file.id];
  let kind, info;
  if (cached && cached.srcMtime === srcMtime && cached.kind) {
    kind = cached.kind;
    info = { width: cached.srcW, height: cached.srcH };
  } else {
    const probed = await probe(file.fullPath);
    if (!probed) return { status: 'error', error: 'no se pudo analizar el video' };
    kind = classify(probed);
    info = probed;
    index[file.id] = { kind, status: kind === 'native' ? 'native' : 'pending', srcW: probed.width, srcH: probed.height, srcMtime };
    scheduleSave();
    cached = index[file.id];
  }

  if (kind === 'native') {
    return { status: 'native', url: pathsConfig.getStreamUrl(file.id) };
  }

  // Necesita proxy. Resolver ubicacion y comprobar si ya esta listo.
  const loc = pathsConfig.resolveProxyLocation({ fullPath: file.fullPath, fileId: file.id });
  const dims = dimsForKind(kind, info.width, info.height);

  let proxyExists = false;
  try { await fsp.access(loc.proxyPath); proxyExists = true; } catch {}

  if (proxyExists && cached.status === 'ready' && cached.srcMtime === srcMtime) {
    return {
      status: 'ready', url: loc.proxyUrl, kind,
      downscaled: !!cached.downscaled, srcW: cached.srcW, srcH: cached.srcH,
      outW: cached.outW, outH: cached.outH,
    };
  }

  // Lanzar generacion (dedupe + cola) sin bloquear la respuesta.
  startGeneration(file, kind, info);
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
 * Pre-calienta el proxy de un video (fire-and-forget), usado por el escaneo.
 * @param {{id:string, fullPath:string, name?:string}} file
 */
function prewarm(file) {
  getPlayable(file).catch(() => {});
}

/**
 * Devuelve la ruta absoluta del proxy si existe y esta listo, o null.
 */
async function getReadyProxyPath(file) {
  await loadIndex();
  const loc = pathsConfig.resolveProxyLocation({ fullPath: file.fullPath, fileId: file.id });
  try { await fsp.access(loc.proxyPath); return loc.proxyPath; } catch { return null; }
}

module.exports = {
  getPlayable,
  prewarm,
  getReadyProxyPath,
  probe,
  classify,
};
