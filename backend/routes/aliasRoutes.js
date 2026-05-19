/**
 * Alias Routes — Pensadero
 *
 * Endpoints para gestionar la tabla de sinonimos que expande queries de
 * busqueda en Stage 1.
 *
 * Rutas:
 *  - GET  /api/tags/all      — todos los tags unicos del corpus (con frecuencia)
 *  - GET  /api/tags/aliases  — lista de grupos { canonical, aliases } persistidos
 *  - POST /api/tags/aliases/propose
 *      body: { tags? }  — opcional, si se omite usa los del corpus
 *      llama al LLM y devuelve grupos sugeridos para revision humana
 *  - POST /api/tags/aliases/save
 *      body: { groups: [{ canonical, aliases }, ...] }
 *      sustituye la tabla con la lista provista
 *  - POST /api/tags/aliases/upsert
 *      body: { canonical, aliases }  — añade/merge un grupo concreto
 *  - DELETE /api/tags/aliases/:canonical
 */

const express = require('express');
const aliasTable = require('../aliasTable');
const { getInstance: getProposer } = require('../services/aliasProposer');

module.exports = function createAliasRoutes(deps) {
  const { getMediaFiles } = deps || {};
  const router = express.Router();

  // Recolectar tags unicos del corpus con frecuencia.
  function collectCorpusTags() {
    const files = typeof getMediaFiles === 'function' ? getMediaFiles() : [];
    const freq = new Map();
    for (const f of files) {
      if (!Array.isArray(f.tags)) continue;
      for (const t of f.tags) {
        if (typeof t !== 'string' || !t.trim()) continue;
        const key = t.trim();
        freq.set(key, (freq.get(key) || 0) + 1);
      }
    }
    // Ordenar por frecuencia desc, luego alfabetico
    return Array.from(freq.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  router.get('/tags/all', (req, res) => {
    try {
      const tags = collectCorpusTags();
      res.json({ success: true, data: tags, count: tags.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/tags/aliases', (req, res) => {
    try {
      res.json({ success: true, data: aliasTable.getGroups() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/tags/aliases/propose', async (req, res) => {
    try {
      let inputTags = Array.isArray(req.body?.tags) ? req.body.tags : null;
      if (!inputTags) {
        inputTags = collectCorpusTags().map(x => x.tag);
      }
      // Construir set de terminos ya mapeados para que el LLM no los procese de nuevo
      const mapped = new Set();
      for (const g of aliasTable.getGroups()) {
        mapped.add(g.canonical.toLowerCase());
        for (const a of g.aliases) mapped.add(a.toLowerCase());
      }
      const proposer = getProposer();
      const groups = await proposer.propose(inputTags, mapped);
      res.json({ success: true, data: groups, count: groups.length });
    } catch (err) {
      const msg = err.message || String(err);
      const status = /timeout|Ollama/.test(msg) ? 503 : 500;
      res.status(status).json({ success: false, error: msg });
    }
  });

  router.post('/tags/aliases/save', async (req, res) => {
    try {
      const groups = req.body?.groups;
      if (!Array.isArray(groups)) {
        return res.status(400).json({ success: false, error: 'body.groups debe ser array' });
      }
      await aliasTable.setGroups(groups);
      res.json({ success: true, data: aliasTable.getGroups() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/tags/aliases/upsert', async (req, res) => {
    try {
      await aliasTable.upsertGroup(req.body || {});
      res.json({ success: true, data: aliasTable.getGroups() });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.delete('/tags/aliases/:canonical', async (req, res) => {
    try {
      await aliasTable.deleteGroup(req.params.canonical);
      res.json({ success: true, data: aliasTable.getGroups() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
