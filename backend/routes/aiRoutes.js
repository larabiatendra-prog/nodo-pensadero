/**
 * AI Routes — Pensadero
 *
 * Rutas:
 * - GET  /api/search       — Búsqueda básica con filtros (texto, tipo, tags, fecha)
 * - POST /api/ai/search    — Búsqueda en lenguaje natural (Ollama)
 * - GET  /api/ai/health    — Health check del LLM
 */

const express = require('express');
const router = express.Router();

const aiSearchService = require('../aiSearchService');
const peopleRegistry = require('../peopleRegistry');

module.exports = function createAiRoutes(deps) {
  const { getMediaFiles, getPeopleHints } = deps;

  // peopleHints: lista de {person_id, display_name, aliases} para el LLM.
  // Origen: registry + aggregate de mediaFiles. El backend la inyecta como
  // dependencia (ver server.js). Si no está disponible, devuelve [].
  const safePeopleHints = () => {
    if (typeof getPeopleHints === 'function') {
      try { return getPeopleHints() || []; } catch { return []; }
    }
    return [];
  };

  // ============================================
  // BÚSQUEDA BÁSICA
  // ============================================

  // Normaliza acentos + minúsculas para búsqueda case/diacritics-insensitive.
  const normalize = (s) => (s == null ? '' : String(s))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  router.get('/search', (req, res) => {
    const { q, type, tags, dateFrom, dateTo, year, month, exports, person_ids } = req.query;
    const mediaFiles = getMediaFiles();
    let results = [...mediaFiles];

    // Texto sobre nombre + tags + descripción visual + OCR + composición + caras + espacios.
    // Combina AND con el resto de filtros (tags, type, fechas, etc.).
    // Para faces/spaces se usa el schema canónico normalizado (display_name + ids).
    // En faces también se busca por person_id y por aliases del registry.
    if (q) {
      const query = normalize(q);
      // nameOf devuelve el "nombre legible" de un face/space normalizado.
      const faceText = (f) => {
        if (!f || typeof f !== 'object') return '';
        return [f.display_name, f.person_id].filter(Boolean).join(' ');
      };
      const spaceText = (s) => {
        if (!s || typeof s !== 'object') return '';
        return [s.display_name, s.space_id].filter(Boolean).join(' ');
      };
      results = results.filter(file => {
        if (normalize(file.name).includes(query)) return true;
        if ((file.tags || []).some(tag => normalize(tag).includes(query))) return true;
        if (normalize(file.visual_description).includes(query)) return true;
        if (normalize(file.ocr_text).includes(query)) return true;
        if (file.composition) {
          if (normalize(file.composition.shot_type).includes(query)) return true;
          if (normalize(file.composition.people_framing).includes(query)) return true;
        }
        if ((file.faces || []).some(f => {
          if (normalize(faceText(f)).includes(query)) return true;
          // Buscar también en aliases del registry para ese person_id
          const aliases = peopleRegistry.getAliases(f && f.person_id);
          if (aliases.some(a => normalize(a).includes(query))) return true;
          return false;
        })) return true;
        if ((file.spaces || []).some(s => normalize(spaceText(s)).includes(query))) return true;
        return false;
      });
    }

    // Filtro por person_ids (OR entre los listados, AND con el resto).
    // Un archivo matchea si tiene al menos uno en file.faces[].person_id.
    if (person_ids) {
      const idList = String(person_ids).split(',').map(s => s.trim()).filter(Boolean);
      if (idList.length > 0) {
        const idSet = new Set(idList);
        results = results.filter(file =>
          Array.isArray(file.faces) &&
          file.faces.some(f => f && f.person_id && idSet.has(f.person_id))
        );
      }
    }

    // Tipo (uno o varios separados por coma)
    if (type && type !== 'all') {
      const typeList = type.split(',').map(t => t.trim());
      results = results.filter(file => typeList.includes(file.type));
    }

    // Tags concretos (todos deben estar) — match accent-insensitive.
    if (tags) {
      const tagList = tags.split(',').map(t => normalize(t)).filter(Boolean);
      results = results.filter(file =>
        tagList.every(tag =>
          (file.tags || []).some(fileTag => normalize(fileTag).includes(tag))
        )
      );
    }

    // Año extraído
    if (year) {
      results = results.filter(file =>
        (file.tags || []).some(tag => tag === year || tag.includes(year))
      );
    }

    // Mes extraído (accent-insensitive: "Abril" == "abril")
    if (month) {
      const m = normalize(month);
      results = results.filter(file =>
        (file.tags || []).some(tag => normalize(tag) === m)
      );
    }

    // Rango de fechas
    if (dateFrom || dateTo) {
      results = results.filter(file => {
        if (!file.extractedDate) return false;
        const fileDate = new Date(file.extractedDate);
        if (dateFrom && fileDate < new Date(dateFrom)) return false;
        if (dateTo && fileDate > new Date(dateTo)) return false;
        return true;
      });
    }

    // Filtro exports legacy (archivos con "edit" en el nombre)
    if (exports === 'true') {
      results = results.filter(file => file.name.toLowerCase().includes('edit'));
    }

    res.json({
      success: true,
      data: results,
      count: results.length,
      filters: { q, type, tags, dateFrom, dateTo, year, month, exports, person_ids }
    });
  });

  // ============================================
  // BÚSQUEDA EN LENGUAJE NATURAL (LLM)
  // ============================================

  router.post('/ai/search', async (req, res) => {
    try {
      const { query } = req.body;

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Query vacía o inválida'
        });
      }

      console.log(`🤖 AI Search: "${query}"`);

      const mediaFiles = getMediaFiles();
      const peopleHints = safePeopleHints();
      const result = await aiSearchService.parseNaturalQuery(query, mediaFiles, peopleHints);

      // Contrato del frontend: results con { fileId, score, matchedIn }
      // (sin el `file` completo embebido — el frontend ya tiene los archivos
      // en su lista local). intent y metadata en raíz.
      const compactResults = (result.results || []).map(r => ({
        fileId: r.fileId,
        score: r.score,
        matchedIn: r.matchedIn,
        tier: r.tier || 'primary'  // 'primary' (resultados claros) o 'secondary' (menos probables)
      }));

      res.json({
        success: true,
        results: compactResults,
        intent: result.intent,
        metadata: result.metadata,
        // Mantener `data` con el resultado completo por compatibilidad legacy
        data: result
      });

    } catch (error) {
      console.error('❌ Error en AI Search:', error);

      if (error.message.includes('Ollama') || error.message.includes('ECONNREFUSED')) {
        return res.status(503).json({
          success: false,
          error: 'Ollama no disponible. Comprueba que está corriendo.',
          details: error.message
        });
      }

      if (error.message.includes('Timeout')) {
        return res.status(504).json({
          success: false,
          error: 'El modelo tardó demasiado en responder.',
          details: error.message
        });
      }

      res.status(500).json({
        success: false,
        error: 'Error procesando la búsqueda',
        details: error.message
      });
    }
  });

  router.get('/ai/health', async (req, res) => {
    try {
      const health = await aiSearchService.healthCheck();
      res.json({ success: true, data: health });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Error verificando estado del LLM',
        details: error.message
      });
    }
  });

  return router;
};
