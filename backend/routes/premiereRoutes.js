/**
 * Llevar material a Premiere — rutas
 *
 * La tarjeta «A Premiere» pide el XML al abrirse (y otra vez al cambiar una
 * opcion), asi que cuando se arrastra la ficha ya esta hecho. El XML vive en
 * memoria una hora: no se escribe en ningun disco salvo que se pida
 * «Guardar en Descargas» (que es el sitio de siempre de lo que bajas).
 *
 * Endpoints:
 *   POST /api/premiere/xml            body { ids, nombre, ordenar, marcadores, secuencia }
 *                                     -> { token, url, archivo, resumen, avisos }
 *   GET  /api/premiere/xml/:token/:archivo   el XML (lo que se arrastra o se guarda)
 *   POST /api/premiere/xml/:token/mostrar    lo guarda en Descargas y abre el
 *                                     explorador con el archivo marcado
 *
 * Enviar directamente (la extension de premiere/extension, ver services/premiereEnlace.js):
 *   GET  /api/premiere/estado         -> { conectado, proyecto, version, abierto }
 *                                     (abierto: hay un Premiere en marcha, con o sin extension)
 *   POST /api/premiere/enviar         body { token } -> { id }
 *   GET  /api/premiere/envios/:id     -> { estado: pendiente|entregado|hecho|error, error, proyecto }
 *   POST /api/premiere/latido         (la extension) body { proyecto, rutaProyecto, version }
 *                                     -> { envios: [{ id, url, archivo }] }
 *   GET  /api/premiere/plan/:token    (la extension) lo que hay que hacer dentro de Premiere
 *   POST /api/premiere/envios/:id/progreso  (la extension) body { texto }
 *   POST /api/premiere/envios/:id     (la extension) body { ok, error, resumen }
 *   POST /api/premiere/instalar       instala la extension (premiere/Instalar en Premiere.ps1)
 *
 * Solo entra lo visible (sin candado ni copias exactas sobrantes): `getMediaFiles`
 * es `mediaFilesVisibles`.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const premiereXml = require('../services/premiereXml');
const premierePlan = require('../services/premierePlan');
const { crearEnlace } = require('../services/premiereEnlace');
const fallos = require('../utils/failureReason');

const VIDA_MS = 60 * 60 * 1000;
const INSTALADOR = path.join(__dirname, '..', '..', 'premiere', 'Instalar en Premiere.ps1');
/**
 * Huella de la extension (lo que hay en premiere/extension): la extension la
 * recibe en cada latido y, si cambia, se recarga sola entre envios.
 */
let huellaExtension = { en: 0, valor: null };
function versionExtension() {
  if (Date.now() - huellaExtension.en < 10000) return huellaExtension.valor;
  let valor = null;
  try {
    const h = crypto.createHash('sha1');
    for (const f of ['enlace.js', 'host.jsx', 'index.html', 'fondo.html']) {
      h.update(fs.readFileSync(path.join(__dirname, '..', '..', 'premiere', 'extension', f)));
    }
    valor = h.digest('hex').slice(0, 12);
  } catch { valor = null; }
  huellaExtension = { en: Date.now(), valor };
  return valor;
}

/** ¿Esta la extension en la carpeta de extensiones de Adobe de este usuario? */
function extensionInstalada() {
  if (process.platform !== 'win32' || !process.env.APPDATA) return false;
  return fs.existsSync(path.join(process.env.APPDATA, 'Adobe', 'CEP', 'extensions', 'pensadero-premiere', 'CSXS', 'manifest.xml'));
}
const MAX_ARCHIVOS = 5000;
const MEDIR_A_LA_VEZ = 6;

/** ffprobe de lo que hace falta para el XML. null si no se puede leer. */
function ffprobe(ruta) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels:stream_side_data=rotation:stream_tags=rotate',
      '-of', 'json', ruta,
    ], { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const d = JSON.parse(stdout);
        const streams = d.streams || [];
        const v = streams.find(s => s.codec_type === 'video');
        const a = streams.find(s => s.codec_type === 'audio');
        const fraccion = (txt) => {
          const [n, m] = String(txt || '').split('/').map(Number);
          return n > 0 && m > 0 ? n / m : 0;
        };
        // r_frame_rate es la cadencia nominal; avg sirve si r viene rara (90000/1).
        let fps = v ? fraccion(v.r_frame_rate) : 0;
        if (!(fps > 0 && fps <= 240) && v) fps = fraccion(v.avg_frame_rate);
        // El giro (camara o movil en vertical): las medidas van como se ven.
        const giro = v && (v.side_data_list || []).find(x => x && x.rotation !== undefined);
        const rot = v ? Math.abs(parseInt(giro ? giro.rotation : (v.tags && v.tags.rotate), 10) || 0) % 360 : 0;
        const girado = rot === 90 || rot === 270;
        const w = v ? v.width || 0 : 0;
        const h = v ? v.height || 0 : 0;
        resolve({
          duracionS: parseFloat((d.format || {}).duration) || 0,
          fps: fps > 0 && fps <= 240 ? fps : 0,
          ancho: girado ? h : w,
          alto: girado ? w : h,
          rot,
          audio: !!a,
          canales: a ? a.channels || 2 : 0,
          frecuencia: a ? parseInt(a.sample_rate, 10) || 48000 : 0,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * ¿Hay un Premiere en marcha? Solo para decir bien que falta cuando la
 * extension no da señales: «abre Premiere» no es lo mismo que «Premiere esta
 * abierto pero sin la extension» (se instalo con Premiere abierto y hay que
 * reabrirlo). Cacheado unos segundos: la cesta pregunta a menudo.
 */
let premiereEnMarcha = { en: 0, abierto: false };
function premiereAbierto() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (Date.now() - premiereEnMarcha.en < 5000) return Promise.resolve(premiereEnMarcha.abierto);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Adobe Premiere Pro.exe', '/NH'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const abierto = !err && /Adobe Premiere Pro.exe/i.test(String(stdout));
      premiereEnMarcha = { en: Date.now(), abierto };
      resolve(abierto);
    });
  });
}

module.exports = function createPremiereRoutes(deps = {}) {
  const router = express.Router();
  const { getMediaFiles, notesManager, loadScanPaths } = deps;

  const hechos = new Map();   // token -> { xml, archivo, creado }
  const enlace = deps.enlace || crearEnlace();
  const medidas = new Map();  // ruta|tamaño|fecha -> medida

  const limpiar = () => {
    const ahora = Date.now();
    for (const [k, v] of hechos) if (ahora - v.creado > VIDA_MS) hechos.delete(k);
  };

  async function medir(f) {
    let st;
    try { st = await fs.promises.stat(f.fullPath); } catch { return { conectado: false, medida: null }; }
    const clave = `${f.fullPath}|${st.size}|${st.mtimeMs}`;
    if (!medidas.has(clave)) medidas.set(clave, await ffprobe(f.fullPath));
    return { conectado: true, medida: medidas.get(clave) };
  }

  /** Lo que el catalogo ya sabe (para lo que esta en un disco desconectado). */
  function delCatalogo(f) {
    const t = f.technical || {};
    let ancho = (f.dimensions && f.dimensions.width) || 0;
    let alto = (f.dimensions && f.dimensions.height) || 0;
    const res = /^(\d+)\s*x\s*(\d+)$/i.exec(String(f.resolution || t.resolution || ''));
    if ((!ancho || !alto) && res) { ancho = +res[1]; alto = +res[2]; }
    return {
      duracionS: Number(f.duration || t.duration) || 0,
      fps: Number(f.fps || t.fps) || 0,
      ancho, alto,
      // Sin poder mirarlo, un video de camara casi siempre lleva sonido.
      audio: f.type === 'video' || f.type === 'audio',
      canales: 2,
      frecuencia: 48000,
    };
  }

  router.post('/premiere/xml', async (req, res) => {
    try {
      limpiar();
      const body = req.body || {};
      const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, MAX_ARCHIVOS) : [];
      if (ids.length === 0) return res.status(400).json({ success: false, error: 'No hay archivos que llevar.' });

      const porId = new Map(getMediaFiles().map(f => [f.id, f]));
      const elegidos = [];
      let fuera = 0;
      for (const id of new Set(ids)) {
        const f = porId.get(id);
        // Lo que esta bajo candado o es una copia sobrante no esta en la lista.
        if (!f || !f.fullPath || !['video', 'image', 'audio'].includes(f.type)) { fuera++; continue; }
        elegidos.push(f);
      }

      await (notesManager && notesManager.ensureLoaded ? notesManager.ensureLoaded().catch(() => {}) : null);
      const notaDe = (f) => {
        const n = notesManager && (notesManager.files.get(f.mediaKey) || notesManager.files.get(f.id));
        return n ? String(n.note || '') : '';
      };

      // Medir de pocos en pocos: es un ffprobe por archivo (en cache despues).
      const resultados = new Array(elegidos.length);
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(MEDIR_A_LA_VEZ, elegidos.length) }, async () => {
        while (i < elegidos.length) {
          const k = i++;
          resultados[k] = await medir(elegidos[k]);
        }
      }));

      const rutas = loadScanPaths ? await loadScanPaths().catch(() => []) : [];
      const bibliotecas = new Map((rutas || []).map(r => [r.id, r]));
      const desconectados = new Map();
      let sinDatos = 0;
      // Lo que ffprobe no abre, Premiere tampoco, y al importarlo saca un aviso
      // que lo deja parado hasta que alguien pulse Aceptar: no se envia. Las
      // fotos no se filtran (Premiere abre PSD y otros que ffprobe no lee).
      const ilegibles = [];
      const clips = [];
      elegidos.forEach((f, k) => {
        const { conectado, medida } = resultados[k];
        const datos = medida || delCatalogo(f);
        if (!conectado) {
          const b = bibliotecas.get(f.libraryId);
          const disco = (b && b.disco && b.disco.etiqueta) || (b && b.displayName) || path.parse(f.fullPath).root;
          desconectados.set(disco, (desconectados.get(disco) || 0) + 1);
        }
        if (conectado && !medida && f.type !== 'image') { ilegibles.push(f.name); return; }
        // Un video o un audio sin duracion no se puede describir a Premiere.
        if (f.type !== 'image' && !(datos.duracionS > 0)) { sinDatos++; return; }
        clips.push({
          nombre: f.name,
          ruta: f.fullPath,
          tipo: f.type,
          conectado,
          ...datos,
          audio: f.type === 'audio' ? true : !!datos.audio,
          dia: f.fechaDia || null,
          minuto: f.fechaMinuto || 0,
          carpeta: f.folderName || path.basename(path.dirname(f.fullPath)),
          personas: (f.faces || []).map(x => x && (x.display_name || x.name)).filter(Boolean),
          descripcion: f.visual_description || f.description || '',
          nota: notaDe(f),
          favorito: !!f.isFavorite,
        });
      });

      if (clips.length === 0) {
        return res.status(400).json({
          success: false,
          error: ilegibles.length
            ? `Ninguno de esos archivos se puede llevar: ${ilegibles.length === 1 ? 'el que hay no se puede leer' : 'no se pueden leer'} (¿dañados?).`
            : 'Ninguno de esos archivos se puede llevar: los que están en discos desconectados aún no se han escaneado.',
        });
      }

      const opciones = {
        nombre: String(body.nombre || '').trim().slice(0, 120) || 'Pensadero',
        ordenar: body.ordenar,
        marcadores: body.marcadores !== false,
        secuencia: !!body.secuencia,
        duplicar: !!body.duplicar,
      };
      const xml = premiereXml.construirXml(opciones, clips);
      const plan = premierePlan.construirPlan({ ...opciones, descartados: ilegibles }, clips);
      const archivo = premiereXml.nombreDeArchivo(opciones.nombre);
      const token = crypto.randomBytes(9).toString('hex');
      hechos.set(token, { xml, plan, archivo, creado: Date.now() });

      const bandejas = opciones.ordenar === 'todo' ? 0 : premiereXml.agrupar(clips, opciones.ordenar).length;
      const cadencias = opciones.secuencia ? premiereXml.cadenciasDistintas(clips) : [];
      res.json({
        success: true,
        data: {
          token,
          archivo,
          url: `/api/premiere/xml/${token}/${encodeURIComponent(archivo)}`,
          resumen: {
            clips: clips.length,
            videos: clips.filter(c => c.tipo === 'video').length,
            fotos: clips.filter(c => c.tipo === 'image').length,
            audios: clips.filter(c => c.tipo === 'audio').length,
            bandejas,
            secuencia: opciones.secuencia,
          },
          avisos: {
            desconectados: Array.from(desconectados, ([disco, n]) => ({ disco, n })),
            sinDatos,
            fuera,
            ilegibles,
            cadencias: cadencias.length > 1 ? cadencias : [],
          },
          // Como quedara la secuencia y cuantos clips no encajan (se dice antes de enviar).
          prevision: premierePlan.prevision(clips, opciones.secuencia),
        },
      });
    } catch (err) {
      const causa = fallos.record('preparar el XML para Premiere', err, {});
      res.status(500).json({ success: false, error: `No se ha podido preparar el XML. ${causa.reason}` });
    }
  });

  router.get('/premiere/xml/:token/:archivo?', (req, res) => {
    const h = hechos.get(req.params.token);
    if (!h) return res.status(404).type('text/plain').send('Este XML ya no está: vuelve a abrir «A Premiere».');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="${encodeURIComponent(h.archivo)}"; filename*=UTF-8''${encodeURIComponent(h.archivo)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(h.xml);
  });

  // ── Enviar directamente a Premiere ─────────────────────────────────────
  router.get('/premiere/estado', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const e = enlace.estado();
    const abierto = e.conectado ? true : await premiereAbierto().catch(() => false);
    res.json({ success: true, data: { ...e, abierto, instalada: e.conectado || extensionInstalada() } });
  });

  // Un clic desde la cesta: el instalador de premiere/ (enlaza la extension y
  // permite extensiones sin firmar si hacia falta). Solo toca la carpeta de
  // extensiones de Adobe del usuario y su ajuste de Adobe en el registro.
  router.post('/premiere/instalar', (req, res) => {
    if (process.platform !== 'win32') return res.status(400).json({ success: false, error: 'Solo en Windows.' });
    if (!fs.existsSync(INSTALADOR)) {
      return res.status(404).json({ success: false, error: 'Falta el instalador (carpeta premiere de Pensadero).' });
    }
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALADOR],
      { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
        if (err || !extensionInstalada()) {
          const causa = fallos.record('instalar la extension de Premiere', err || new Error(String(stderr || stdout)), {});
          return res.status(500).json({ success: false, error: `No se ha podido instalar. ${causa.reason}` });
        }
        premiereEnMarcha = { en: 0, abierto: false };
        res.json({ success: true });
      });
  });

  router.post('/premiere/enviar', (req, res) => {
    limpiar();
    const token = String((req.body || {}).token || '');
    const h = hechos.get(token);
    if (!h) return res.status(404).json({ success: false, error: 'Ese XML ya no está: vuelve a abrir la cesta.' });
    try {
      const id = enlace.enviar({ token, archivo: h.archivo });
      res.json({ success: true, data: { id } });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ success: false, error: err.message });
      const causa = fallos.record('enviar a Premiere', err, {});
      res.status(500).json({ success: false, error: causa.reason });
    }
  });

  router.get('/premiere/envios/:id', (req, res) => {
    const e = enlace.consultar(req.params.id);
    if (!e) return res.status(404).json({ success: false, error: 'Ese envío ya no está.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: e });
  });

  // La extension se lleva el plan del envio.
  router.get('/premiere/plan/:token', (req, res) => {
    const h = hechos.get(req.params.token);
    if (!h) return res.status(404).json({ success: false, error: 'Ese envío ya no está.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, plan: h.plan });
  });

  // La extension va contando (y con eso sigue viva aunque Premiere este ocupado).
  router.post('/premiere/envios/:id/progreso', (req, res) => {
    res.json({ success: enlace.progreso(req.params.id, String((req.body || {}).texto || '').slice(0, 200)) });
  });

  router.post('/premiere/latido', (req, res) => {
    const llevar = enlace.latido(req.body || {}).map(e => ({
      id: e.id,
      archivo: e.archivo,
      plan: `/api/premiere/plan/${e.token}`,
      url: `/api/premiere/xml/${e.token}/${encodeURIComponent(e.archivo)}`,
    }));
    res.json({ success: true, envios: llevar, extension: versionExtension() });
  });

  router.post('/premiere/envios/:id', (req, res) => {
    const b = req.body || {};
    if (!b.ok) fallos.record('importar en Premiere', new Error(String(b.error || 'sin motivo')), {});
    // El resumen de la extension, en frases para la cesta.
    const e = enlace.consultar(req.params.id);
    const h = e ? hechos.get(e.token) : null;
    const resumen = b.resumen && typeof b.resumen === 'object' ? {
      importados: Number(b.resumen.importados) || 0,
      total: Number(b.resumen.total) || 0,
      bandeja: String(b.resumen.bandeja || ''),
      secuencia: b.resumen.secuencia || null,
      // Lo que ya estaba en el proyecto y se uso sin duplicar, y en que bandejas.
      reutilizados: Array.isArray(b.resumen.reutilizados) ? {
        n: b.resumen.reutilizados.length,
        bandejas: Array.from(new Set(b.resumen.reutilizados.map(x => String((x && x.bandeja) || '')))),
      } : { n: 0, bandejas: [] },
      avisos: premierePlan.explicarResultado(b.resumen, h && h.plan),
    } : null;
    res.json({ success: enlace.resolver(req.params.id, { ok: !!b.ok, error: b.error, resumen }) });
  });

  router.post('/premiere/xml/:token/mostrar', async (req, res) => {
    const h = hechos.get(req.params.token);
    if (!h) return res.status(404).json({ success: false, error: 'Este XML ya no está: vuelve a abrir «A Premiere».' });
    let destino;
    try {
      const carpeta = path.join(os.homedir(), 'Downloads');
      await fs.promises.mkdir(carpeta, { recursive: true });
      // Nunca se pisa uno que ya este: «Boda (2).xml».
      const base = h.archivo.replace(/\.xml$/i, '');
      destino = path.join(carpeta, h.archivo);
      for (let n = 2; fs.existsSync(destino); n++) destino = path.join(carpeta, `${base} (${n}).xml`);
      await fs.promises.writeFile(destino, h.xml, 'utf8');
    } catch (err) {
      const causa = fallos.record('guardar el XML para Premiere', err, { path: destino });
      return res.status(500).json({ success: false, error: `No se ha podido guardar. ${causa.reason}` });
    }
    if (process.platform !== 'win32') return res.json({ success: true, ruta: destino });
    // Como «Abrir en el explorador»: sin consola de por medio.
    const hijo = spawn('explorer.exe', [`/select,"${destino}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' });
    hijo.once('error', (err) => {
      fallos.record('abrir la carpeta del XML', err, { path: destino });
      res.json({ success: true, ruta: destino, sinExplorador: true });
    });
    hijo.once('spawn', () => { hijo.unref(); res.json({ success: true, ruta: destino }); });
  });

  return router;
};

module.exports.ffprobe = ffprobe;
