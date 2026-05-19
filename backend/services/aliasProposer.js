/**
 * Alias Proposer — Pensadero
 *
 * Le pide al LLM local (Ollama) que agrupe una lista de tags por significado
 * y proponga una forma canonica para cada grupo. La salida es una lista de
 * sugerencias que el usuario revisa/acepta/edita en la UI antes de persistir
 * en alias_table.json.
 *
 * Diseño:
 *  - Single-shot al LLM con prompt restrictivo (output solo JSON)
 *  - Solo se envian tags AUN NO mapeados (los que ya estan en alias_table
 *    se filtran fuera para no spamear al LLM)
 *  - Si la lista es grande (>200 tags), se trunca para no saturar contexto.
 *    Las restantes se proponen en una segunda llamada.
 */

const { Ollama } = require('ollama');

const DEFAULT_MODEL = 'qwen2.5:14b-instruct';
const MAX_TAGS_PER_CALL = 200;
const TIMEOUT_MS = 60_000;

class AliasProposer {
  constructor() {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.ollama = new Ollama({ host });
    this.model = process.env.OLLAMA_MODEL || DEFAULT_MODEL;
  }

  /**
   * Propone agrupaciones de la lista de tags dada. Devuelve un array de
   * grupos { canonical, aliases } (puede estar vacio si el LLM no encuentra
   * agrupaciones).
   *
   * Tags ya cubiertos por alias_table se ignoran — pasarselos al LLM
   * solo añadiria ruido.
   */
  async propose(tags, alreadyMapped = new Set()) {
    if (!Array.isArray(tags) || tags.length === 0) return [];
    // Filtrar duplicados y ya-mapeados
    const seen = new Set();
    const candidates = [];
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      const norm = t.trim().toLowerCase();
      if (!norm || seen.has(norm) || alreadyMapped.has(norm)) continue;
      seen.add(norm);
      candidates.push(t.trim());
    }
    if (candidates.length === 0) return [];

    const trimmed = candidates.slice(0, MAX_TAGS_PER_CALL);
    const prompt = this._buildPrompt(trimmed);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await this.ollama.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0.1, num_predict: 1500 },
        signal: controller.signal,
      });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (controller.signal.aborted) throw new Error(`Ollama timeout tras ${TIMEOUT_MS}ms`);
      throw new Error(`Ollama: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const text = (resp && resp.message && resp.message.content || '').trim();
    return this._parseGroups(text, new Set(trimmed.map(t => t.toLowerCase())));
  }

  _buildPrompt(tags) {
    return `Eres un experto en lexico en español. Te paso una lista de etiquetas que aparecen en una biblioteca multimedia personal. Tu tarea: AGRUPAR las etiquetas que sean variantes lexicas o sinonimos cercanos del MISMO concepto.

REGLAS ESTRICTAS:
1. Solo agrupa palabras que claramente son la misma idea (ej: saltar/salto/saltito/brincar; correr/corriendo/carrera).
2. NO agrupes palabras que pertenecen a categorias relacionadas pero distintas (ej: NO mezcles "perro" con "labrador" — son padre/hijo, no sinonimos).
3. NO inventes nuevas palabras. Solo usa las del input.
4. El canonical debe ser la forma mas neutra/comun del grupo.
5. Si una palabra no tiene sinonimos en la lista, NO la incluyas (no merece grupo).
6. Devuelve SOLO un JSON sin explicaciones ni markdown.

FORMATO EXACTO:
{
  "groups": [
    { "canonical": "saltar", "aliases": ["salto", "saltito", "brincar"] },
    { "canonical": "correr", "aliases": ["corriendo", "carrera"] }
  ]
}

ETIQUETAS A AGRUPAR:
${tags.join(', ')}

JSON:`;
  }

  _parseGroups(text, candidateSet) {
    if (!text) return [];
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    let parsed;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      try {
        const cleaned = m[0].replace(/,(\s*[}\]])/g, '$1').replace(/[""]/g, '"').replace(/['']/g, "'");
        parsed = JSON.parse(cleaned);
      } catch {
        return [];
      }
    }
    if (!parsed || !Array.isArray(parsed.groups)) return [];

    const out = [];
    for (const g of parsed.groups) {
      if (!g || typeof g.canonical !== 'string') continue;
      const canonical = g.canonical.trim();
      if (!canonical) continue;
      // Validacion: el canonical y los aliases deben venir de la lista que mandamos
      // (defensa contra inventos del LLM)
      const aliases = Array.isArray(g.aliases)
        ? g.aliases.filter(a => typeof a === 'string' && a.trim() && a.trim().toLowerCase() !== canonical.toLowerCase())
            .map(a => a.trim())
        : [];
      // Filtrar items que no esten en candidateSet (anti-invento)
      const validCanonical = candidateSet.has(canonical.toLowerCase()) ? canonical : null;
      const validAliases = aliases.filter(a => candidateSet.has(a.toLowerCase()));
      // Aceptar solo grupos con >=1 alias real
      if (validCanonical && validAliases.length > 0) {
        out.push({ canonical: validCanonical, aliases: validAliases });
      }
    }
    return out;
  }
}

let _instance = null;
function getInstance() {
  if (!_instance) _instance = new AliasProposer();
  return _instance;
}

module.exports = { AliasProposer, getInstance };
