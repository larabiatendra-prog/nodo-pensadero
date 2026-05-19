/**
 * Alias Table — Pensadero
 *
 * Tabla de sinonimos para expandir queries de busqueda Stage 1. Resuelve el
 * problema de que "saltar"/"salto"/"brincar" sean distintos para el sistema
 * pero el usuario espera que se encuentren al buscar uno cualquiera.
 *
 * Formato persistido (data/alias_table.json):
 *   {
 *     "version": 1,
 *     "groups": [
 *       { "canonical": "saltar", "aliases": ["salto","saltito","brincar"] }
 *     ],
 *     "updated_at": "ISO8601"
 *   }
 *
 * Lookup: O(1) via Map. expandTerm("salto") → ["saltar","salto","saltito","brincar"]
 * Si el termino no esta en ningun grupo, devuelve [term] (sin expansion).
 *
 * La tabla se construye incrementalmente con LLM-proposed groups que el
 * usuario revisa y aprueba (ver aliasProposer.js).
 */

const fs = require('fs').promises;
const path = require('path');

const ALIAS_FILE = path.join(__dirname, 'data', 'alias_table.json');

let _data = { version: 1, groups: [], updated_at: null };
// term_normalizado → array completo del grupo (canonical + aliases)
let _index = new Map();
let _loaded = false;

function normalize(s) {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function rebuildIndex() {
  _index = new Map();
  for (const g of _data.groups || []) {
    if (!g || typeof g.canonical !== 'string') continue;
    const full = [g.canonical, ...(Array.isArray(g.aliases) ? g.aliases : [])]
      .filter(t => typeof t === 'string' && t.trim());
    for (const t of full) {
      _index.set(normalize(t), full);
    }
  }
}

async function load() {
  try {
    const raw = await fs.readFile(ALIAS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.groups)) {
      _data = {
        version: parsed.version || 1,
        groups: parsed.groups,
        updated_at: parsed.updated_at || null,
      };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[aliasTable] no se pudo leer:', err.message);
    }
    _data = { version: 1, groups: [], updated_at: null };
  }
  rebuildIndex();
  _loaded = true;
  console.log(`📚 Alias table: ${_data.groups.length} grupos, ${_index.size} terminos indexados`);
}

async function save() {
  _data.updated_at = new Date().toISOString();
  try {
    await fs.mkdir(path.dirname(ALIAS_FILE), { recursive: true });
    await fs.writeFile(ALIAS_FILE, JSON.stringify(_data, null, 2), 'utf-8');
    rebuildIndex();
  } catch (err) {
    console.error('[aliasTable] error guardando:', err.message);
    throw err;
  }
}

/**
 * Devuelve los grupos actuales (copia defensiva).
 */
function getGroups() {
  return _data.groups.map(g => ({
    canonical: g.canonical,
    aliases: Array.isArray(g.aliases) ? [...g.aliases] : [],
  }));
}

/**
 * Sustituye toda la tabla con nuevos grupos. Util para guardado masivo
 * tras la pantalla de revision.
 */
async function setGroups(groups) {
  if (!Array.isArray(groups)) throw new Error('groups debe ser array');
  // Normalizar: descartar grupos sin canonical o vacios; dedup de aliases
  const clean = groups
    .filter(g => g && typeof g.canonical === 'string' && g.canonical.trim())
    .map(g => {
      const canonical = g.canonical.trim();
      const aliasSet = new Set();
      for (const a of (g.aliases || [])) {
        if (typeof a !== 'string') continue;
        const t = a.trim();
        if (!t || t === canonical) continue;
        aliasSet.add(t);
      }
      return { canonical, aliases: Array.from(aliasSet) };
    });
  _data.groups = clean;
  await save();
}

/**
 * Añade o actualiza un grupo concreto. Si ya existe (mismo canonical), se
 * mergean los aliases.
 */
async function upsertGroup(group) {
  if (!group || typeof group.canonical !== 'string') {
    throw new Error('canonical requerido');
  }
  const canonical = group.canonical.trim();
  const existing = _data.groups.find(g => g.canonical === canonical);
  if (existing) {
    const set = new Set(existing.aliases || []);
    for (const a of (group.aliases || [])) {
      if (typeof a === 'string' && a.trim() && a.trim() !== canonical) set.add(a.trim());
    }
    existing.aliases = Array.from(set);
  } else {
    _data.groups.push({
      canonical,
      aliases: (group.aliases || []).filter(a => typeof a === 'string' && a.trim() && a.trim() !== canonical),
    });
  }
  await save();
}

async function deleteGroup(canonical) {
  const before = _data.groups.length;
  _data.groups = _data.groups.filter(g => g.canonical !== canonical);
  if (_data.groups.length !== before) await save();
}

/**
 * Para un termino dado, devuelve todos los terminos del grupo al que
 * pertenece. Si no esta mapeado, devuelve [term] tal cual.
 * Insensible a mayusculas/acentos.
 */
function expandTerm(term) {
  if (typeof term !== 'string' || !term.trim()) return [];
  if (!_loaded) {
    // No cargado: devolver el termino tal cual (busqueda funciona, sin expansion)
    return [term];
  }
  const norm = normalize(term);
  const group = _index.get(norm);
  if (group) return [...group];
  return [term];
}

/**
 * Para una lista de terminos, devuelve la union expandida (sin duplicados).
 */
function expandTerms(terms) {
  const set = new Set();
  for (const t of terms || []) {
    for (const e of expandTerm(t)) set.add(e);
  }
  return Array.from(set);
}

module.exports = {
  load,
  save,
  getGroups,
  setGroups,
  upsertGroup,
  deleteGroup,
  expandTerm,
  expandTerms,
  // Para testing/debug
  _normalize: normalize,
};
