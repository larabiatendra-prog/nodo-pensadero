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
const multer = require('multer');
const { hexToLab, paletteMinDistance } = require('../colorUtils');
const clipIndex = require('../clipIndex');
const { getInstance: getClipService } = require('../services/clipService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

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
  // BUSQUEDA POR IMAGEN (CLIP)
  // ============================================
  //
  // Recibe una imagen via multipart, calcula su embedding SigLIP-2 y devuelve
  // los top-N archivos mas similares del corpus (dot product en espacio CLIP).
  router.post('/search/by-image', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'falta archivo (field "image")' });

    const maxResults = parseInt(req.query.max, 10);
    const minSim = parseFloat(req.query.minSimilarity);
    const limit = isFinite(maxResults) && maxResults > 0 ? maxResults : 100;
    const thr = isFinite(minSim) ? minSim : 0;

    // Guardar la imagen subida a un temp y calcular embedding
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pensadero-imgsearch-'));
    const ext = path.extname(req.file.originalname || '.jpg').toLowerCase() || '.jpg';
    const tmpPath = path.join(tmpDir, `q${ext}`);
    let cleanup = async () => {
      try { await fs.unlink(tmpPath); } catch {}
      try { await fs.rmdir(tmpDir); } catch {}
    };

    try {
      await fs.writeFile(tmpPath, req.file.buffer);

      const clipSvc = getClipService();
      const ready = await clipSvc.init();
      if (!ready) {
        return res.status(503).json({
          success: false,
          error: clipSvc.getStatus().lastError || 'CLIP service no disponible',
        });
      }

      const queryEmb = await clipSvc.embedImage(tmpPath);
      if (!queryEmb) {
        return res.status(500).json({ success: false, error: 'no se pudo calcular embedding de la imagen' });
      }

      if (clipIndex.size() === 0) {
        return res.json({
          success: true,
          data: [],
          count: 0,
          message: 'El indice CLIP esta vacio. Escanea con IA para indexar archivos.',
        });
      }

      const results = clipIndex.searchNearest(queryEmb, limit);
      const filtered = thr > 0 ? results.filter(r => r.similarity >= thr) : results;
      // Cruzar con mediaFiles para devolver datos basicos (name, type)
      const files = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
      const byId = new Map(files.map(f => [f.id, f]));
      const enriched = filtered.map(r => {
        const f = byId.get(r.fileId);
        return {
          fileId: r.fileId,
          similarity: r.similarity,
          name: f ? f.name : null,
          type: f ? f.type : null,
        };
      }).filter(r => r.name !== null); // filtrar IDs huerfanos

      res.json({
        success: true,
        data: enriched,
        count: enriched.length,
        totalIndexed: clipIndex.size(),
      });
    } catch (err) {
      console.error('[search-by-image]', err);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      await cleanup();
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

      const results = clipIndex.searchNearest(queryEmb, limit);
      const filtered = thr > 0 ? results.filter(r => r.similarity >= thr) : results;
      const files = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
      const byId = new Map(files.map(f => [f.id, f]));
      const enriched = filtered.map(r => {
        const f = byId.get(r.fileId);
        return {
          fileId: r.fileId,
          similarity: r.similarity,
          name: f ? f.name : null,
          type: f ? f.type : null,
        };
      }).filter(r => r.name !== null);

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
