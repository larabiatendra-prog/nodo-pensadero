/**
 * Color Search Routes — Pensadero
 *
 * Filtrado de mediaFiles por similitud cromatica usando la paleta del schema v2
 * (colors.palette: [{hex,name}]). El frontend manda un hex objetivo y un
 * threshold; el backend devuelve los archivos cuyo color dominante esta
 * mas cerca de ese hex en espacio CIELAB (Delta E 76).
 *
 * Endpoints:
 *  - GET /api/search/by-color?hex=%23ff6600&threshold=30&max=200
 *
 *      Devuelve los archivos ordenados por distancia ascendente.
 *      threshold: distancia maxima Delta E (default 30). Mas bajo = mas estricto.
 *      max: limite de resultados (default 500).
 *
 * Pensado para alimentar la "rueda de colores" del frontend pero usable
 * directamente con curl. Es O(N) sobre los mediaFiles cargados en memoria.
 */

const express = require('express');
const { hexToLab, paletteMinDistance } = require('../colorUtils');

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

  return router;
};
