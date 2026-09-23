/**
 * Search Routes — Pensadero
 *
 * Agrupa busquedas avanzadas:
 *
 *  - GET  /api/search/by-color?hex=%23ff6600&threshold=30&max=200
 *      Devuelve los archivos cuya paleta tiene un color a distancia LAB
 *      <= threshold del hex objetivo.
 *
 *  - POST /api/search/by-image (multipart, field 'image')
 *      query: ?max=N&minSimilarity=F
 *      Calcula el embedding CLIP de la imagen subida y devuelve los top-N
 *      archivos del corpus mas similares (dot product en espacio CLIP).
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const mime = require('mime-types');
const { hexToLab, paletteMinDistance } = require('../colorUtils');
const clipIndex = require('../clipIndex');
const { getInstance: getClipService } = require('../services/clipService');
const { probeVideo, extractFrame } = require('../visualScanService');
const fallos = require('../utils/failureReason');

// Extensiones que se aceptan como consulta. El nombre del archivo lo pone el
// navegador: solo se usa para elegir la extension del temporal, y solo si es
// una de estas (nada de rutas ni nombres raros en el disco).
const EXT_IMAGEN = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const EXT_VIDEO = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts', '.ts', '.mpg', '.mpeg', '.wmv', '.3gp', '.mxf', '.dv', '.vob', '.flv', '.ogv']);
// Cuantos momentos de un video arrastrado se miran (repartidos del 5% al 95%).
const FOTOGRAMAS_VIDEO = 6;

function tipoDeConsulta(file) {
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const tipo = String(file.mimetype || mime.lookup(ext) || '');
  if (tipo.startsWith('video/') || EXT_VIDEO.has(ext)) return { tipo: 'video', ext: EXT_VIDEO.has(ext) ? ext : '.mp4' };
  if (tipo.startsWith('image/') || EXT_IMAGEN.has(ext)) return { tipo: 'imagen', ext: EXT_IMAGEN.has(ext) ? ext : '.jpg' };
  return null;
}

// A disco (no a memoria): un video de camara son cientos de MB. Cada consulta
// va a su propia carpeta temporal, que se borra entera al terminar.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdtemp(path.join(os.tmpdir(), 'pensadero-busqueda-'))
        .then(dir => { req.carpetaConsulta = dir; cb(null, dir); })
        .catch(err => cb(err));
    },
    filename: (req, file, cb) => {
      const t = tipoDeConsulta(file);
      cb(null, `consulta-${crypto.randomBytes(4).toString('hex')}${t ? t.ext : ''}`);
    },
  }),
  limits: { fileSize: 16 * 1024 * 1024 * 1024 },
});

/** multer con los fallos traducidos (antes salia una pagina HTML de error). */
function recibirConsulta(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    const borrar = req.carpetaConsulta ? fs.rm(req.carpetaConsulta, { recursive: true, force: true }) : Promise.resolve();
    borrar.catch(() => {}).finally(() => {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'El archivo es demasiado grande para buscar con él' });
      }
      const causa = fallos.record('recibir el archivo para buscar parecidas', err);
      res.status(500).json({ success: false, error: causa.reason });
    });
  });
}

module.exports = function createColorSearchRoutes(deps) {
  const { getMediaFiles } = deps || {};
  const router = express.Router();

  router.get('/search/by-color', (req, res) => {
    const hex = typeof req.query.hex === 'string' ? req.query.hex : '';
    const threshold = parseFloat(req.query.threshold);
    const maxResults = parseInt(req.query.max, 10);

    const targetLab = hexToLab(hex);
    if (!targetLab) {
      return res.status(400).json({ success: false, error: 'hex invalido (esperado #RRGGBB)' });
    }
    const thr = isFinite(threshold) && threshold > 0 ? threshold : 30;
    const limit = isFinite(maxResults) && maxResults > 0 ? maxResults : 500;

    const files = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
    if (!Array.isArray(files) || files.length === 0) {
      return res.json({ success: true, data: [], count: 0, threshold: thr });
    }

    const matches = [];
    for (const f of files) {
      const palette = f && f.colors && Array.isArray(f.colors.palette) ? f.colors.palette : null;
      if (!palette || palette.length === 0) continue;
      const best = paletteMinDistance(targetLab, palette);
      if (!best) continue;
      if (best.distance <= thr) {
        matches.push({
          fileId: f.id,
          name: f.name,
          distance: best.distance,
          matchedHex: best.matchedHex,
          matchedName: best.matchedName,
        });
      }
    }

    matches.sort((a, b) => a.distance - b.distance);
    const trimmed = matches.slice(0, limit);

    res.json({
      success: true,
      data: trimmed,
      count: trimmed.length,
      totalMatched: matches.length,
      threshold: thr,
      targetHex: hex,
    });
  });

  // ============================================
  // BUSQUEDA POR IMAGEN O VIDEO (CLIP)
  // ============================================
  //
  // Recibe una imagen o un video via multipart (campo 'image', por
  // compatibilidad) y devuelve los top-N archivos visibles mas parecidos.
  //   - imagen: su huella SigLIP-2 (girada segun su EXIF).
  //   - video: la huella de FOTOGRAMAS_VIDEO momentos repartidos; cada archivo
  //     puntua por el momento que mas se le parece (clipIndex.searchNearestAny).
  // Se busca SOLO entre lo que se puede enseñar (sin candado, sin copias
  // escondidas ni huellas de archivos que ya no estan): antes el top-N salia
  // del indice entero y la mitad se perdia al filtrar despues.
  router.post('/search/by-image', recibirConsulta, async (req, res) => {
    const carpeta = req.carpetaConsulta || null;
    const limpiar = () => (carpeta ? fs.rm(carpeta, { recursive: true, force: true }).catch(() => {}) : Promise.resolve());
    if (!req.file) {
      await limpiar();
      return res.status(400).json({ success: false, error: 'falta archivo (field "image")' });
    }

    const maxResults = parseInt(req.query.max, 10);
    const minSim = parseFloat(req.query.minSimilarity);
    const limit = isFinite(maxResults) && maxResults > 0 ? Math.min(maxResults, 500) : 100;
    const thr = isFinite(minSim) ? minSim : 0;

    try {
      const consulta = tipoDeConsulta(req.file);
      if (!consulta) {
        return res.status(415).json({ success: false, error: 'Solo se puede buscar con una imagen o un vídeo' });
      }

      const clipSvc = getClipService();
      const ready = await clipSvc.init();
      if (!ready) {
        return res.status(503).json({
          success: false,
          error: clipSvc.getStatus().lastError || 'El modelo de búsqueda visual no está disponible',
        });
      }

      // Las imagenes que mirar: la propia imagen, o fotogramas del video.
      let aMirar = [req.file.path];
      if (consulta.tipo === 'video') {
        const probe = await probeVideo(req.file.path);
        if (!probe) {
          return res.status(422).json({ success: false, error: 'No se ha podido leer ese vídeo' });
        }
        const dur = Number(probe.duration) || 0;
        const tiempos = dur > 1
          ? Array.from({ length: FOTOGRAMAS_VIDEO }, (_, i) => dur * (0.05 + 0.9 * i / Math.max(1, FOTOGRAMAS_VIDEO - 1)))
          : [0];
        aMirar = [];
        for (let i = 0; i < tiempos.length; i++) {
          const out = path.join(carpeta || os.tmpdir(), `fotograma-${i}.jpg`);
          // El modelo mira a ~512 px: sacar el fotograma ya pequeño es mas rapido.
          if (await extractFrame(req.file.path, tiempos[i], out, { maxLado: 960 })) aMirar.push(out);
        }
        if (aMirar.length === 0) {
          return res.status(422).json({ success: false, error: 'No se ha podido sacar ningún fotograma de ese vídeo' });
        }
      }

      const huellas = [];
      for (const p of aMirar) {
        const emb = await clipSvc.embedImage(p);
        if (emb) huellas.push(emb);
      }
      if (huellas.length === 0) {
        return res.status(422).json({
          success: false,
          error: consulta.tipo === 'video' ? 'No se ha podido analizar ese vídeo' : 'No se ha podido analizar esa imagen (¿formato HEIC u otro que no se lee?)',
        });
      }

      if (clipIndex.size() === 0) {
        return res.json({
          success: true,
          data: [],
          count: 0,
          message: 'El índice visual está vacío. Escanea con IA para indexar archivos.',
        });
      }

      const files = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
      const byId = new Map(files.map(f => [f.id, f]));
      const results = clipIndex.searchNearestAny(huellas, limit, id => byId.has(id));
      const data = results
        .filter(r => thr <= 0 || r.similarity >= thr)
        .map(r => {
          const f = byId.get(r.fileId);
          return { fileId: r.fileId, similarity: r.similarity, name: f.name, type: f.type };
        });

      res.json({
        success: true,
        data,
        count: data.length,
        totalIndexed: clipIndex.size(),
        consulta: { tipo: consulta.tipo, fotogramas: huellas.length },
      });
    } catch (err) {
      const causa = fallos.record('buscar archivos parecidos a una imagen', err);
      res.status(500).json({ success: false, error: causa.reason });
    } finally {
      await limpiar();
    }
  });

  // ============================================
  // BUSQUEDA POR TEXTO (SigLIP-2 multilingue, español)
  // ============================================
  //
  // POST /api/search/by-text  body: { query, max?, minSimilarity? }
  // Codifica el texto con el text encoder de SigLIP-2 y busca los top-N
  // archivos del corpus mas similares en el clipIndex.
  router.post('/search/by-text', express.json(), async (req, res) => {
    const { query } = req.body || {};
    const maxResults = parseInt(req.body?.max, 10);
    const minSim = parseFloat(req.body?.minSimilarity);
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ success: false, error: 'query requerido' });
    }
    const limit = isFinite(maxResults) && maxResults > 0 ? maxResults : 100;
    const thr = isFinite(minSim) ? minSim : 0;

    try {
      const clipSvc = getClipService();
      const ready = await clipSvc.init();
      if (!ready) {
        return res.status(503).json({
          success: false,
          error: clipSvc.getStatus().lastError || 'CLIP service no disponible',
        });
      }

      const queryEmb = await clipSvc.embedText(query.trim());
      if (!queryEmb) {
        return res.status(500).json({ success: false, error: 'no se pudo calcular embedding del texto' });
      }

      if (clipIndex.size() === 0) {
        return res.json({
          success: true,
          data: [],
          count: 0,
          message: 'El indice CLIP esta vacio. Escanea con IA para indexar archivos.',
        });
      }

      // Solo entre lo que se puede enseñar, igual que la busqueda por imagen.
      const files = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
      const byId = new Map(files.map(f => [f.id, f]));
      const results = clipIndex.searchNearest(queryEmb, limit, id => byId.has(id));
      const filtered = thr > 0 ? results.filter(r => r.similarity >= thr) : results;
      const enriched = filtered.map(r => {
        const f = byId.get(r.fileId);
        return { fileId: r.fileId, similarity: r.similarity, name: f.name, type: f.type };
      });

      res.json({
        success: true,
        data: enriched,
        count: enriched.length,
        totalIndexed: clipIndex.size(),
        query: query.trim(),
      });
    } catch (err) {
      console.error('[search-by-text]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
