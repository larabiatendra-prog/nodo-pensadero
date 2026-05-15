/**
 * Visual Scan Service — Pensadero
 *
 * Describe imágenes locales usando un modelo VLM local (Ollama). Devuelve
 * un objeto estructurado compatible con el schema `_pensadero.json` / `_marina.json`
 * que ya consume Pensadero. Esto es la base del "escaneo visual" integrado
 * en NODO (Visión B): Pensadero deja de depender de pipelines externas y
 * genera su propia metadata.
 *
 * Llamada principal: scanImage(filePath) → objeto entry para photos[basename]
 *
 * Modelo por defecto: `qwen2.5vl:7b` (multimodal, ~6 GB VRAM, multilingüe).
 * Configurable vía VLM_MODEL en .env. Cualquier modelo de visión soportado
 * por Ollama vale (gemma3:12b, llava, etc.).
 */

const fs = require('fs').promises;
const path = require('path');
const { Ollama } = require('ollama');

const DEFAULT_VLM_MODEL = 'qwen2.5vl:7b';
const PER_IMAGE_TIMEOUT_MS = 90_000; // 90s por imagen (cold-start de modelo grande puede tardar)

class VisualScanService {
  constructor() {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.ollama = new Ollama({ host });
    this.model = process.env.VLM_MODEL || DEFAULT_VLM_MODEL;
  }

  /**
   * Llama al VLM con la imagen y devuelve el objeto entry.
   * Si el LLM falla o devuelve JSON no parseable, devuelve un entry mínimo
   * con sólo description="" (para que el orquestador pueda al menos registrar
   * que el archivo se intentó escanear).
   */
  async scanImage(filePath) {
    let buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch (err) {
      throw new Error(`No se pudo leer ${filePath}: ${err.message}`);
    }

    const base64 = buffer.toString('base64');
    const prompt = this._buildPrompt();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_IMAGE_TIMEOUT_MS);

    let response;
    try {
      response = await this.ollama.chat({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: prompt,
            images: [base64],
          },
        ],
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 600,
        },
        signal: controller.signal,
      });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (controller.signal.aborted || /aborted|timeout/i.test(msg)) {
        throw new Error(`VLM timeout (${PER_IMAGE_TIMEOUT_MS}ms) sobre ${path.basename(filePath)}`);
      }
      throw new Error(`VLM falló sobre ${path.basename(filePath)}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const text = (response && response.message && response.message.content || '').trim();
    const parsed = this._extractJson(text);
    return this._normalizeEntry(parsed, filePath);
  }

  /**
   * Health check: comprueba que Ollama corre y el VLM está disponible.
   */
  async healthCheck() {
    try {
      const list = await this.ollama.list();
      const available = (list.models || []).some(m =>
        (m.name || '').toLowerCase().startsWith(this.model.toLowerCase().split(':')[0])
      );
      return {
        ollamaRunning: true,
        modelAvailable: available,
        model: this.model,
      };
    } catch (err) {
      return {
        ollamaRunning: false,
        modelAvailable: false,
        model: this.model,
        error: err.message,
      };
    }
  }

  _buildPrompt() {
    return `Eres un asistente experto en describir fotografías para un archivo personal indexable. Devuelve SOLO un JSON sin explicaciones ni markdown.

ESQUEMA EXACTO:
{
  "description": "una sola frase en ESPAÑOL describiendo lo que se ve (qué, quién, dónde, ambiente)",
  "shot_type": "plano_general" | "plano_americano" | "plano_medio" | "plano_medio_corto" | "primer_plano" | "plano_detalle" | null,
  "people_framing": "ninguno" | "individual" | "pareja" | "grupo" | "multitud",
  "age_ranges": ["niño" | "joven" | "adulto" | "senior"],
  "genders": ["hombre" | "mujer"],
  "attire": "casual" | "formal" | "mixto" | "deportivo" | "elegante" | "" (vacío si no aplica),
  "objects": ["objeto1","objeto2",...] (máx 10, palabras simples en español),
  "actions": ["acción1",...] (máx 5, infinitivos o sustantivos en español),
  "expressions": ["sonrisa","serio","neutro","sorpresa",...] (máx 5, vacío si nadie),
  "ocr_text": ["texto visible","..."] (máx 10 fragmentos legibles, vacío si nada),
  "dominant_colors": ["#RRGGBB","#RRGGBB","#RRGGBB"] (3 colores dominantes en hex)
}

REGLAS:
1. description en español, una sola frase, evita imaginar lo que no ves.
2. age_ranges, genders, expressions sólo si hay personas claramente visibles. Si dudas, omite (array vacío).
3. ocr_text sólo si hay texto legible en la imagen. NO inventes.
4. dominant_colors: 3 colores principales aproximados.
5. Devuelve SOLO el JSON, sin texto antes ni después.`;
  }

  /**
   * Extrae el primer bloque JSON de la respuesta del LLM. Tolera texto
   * residual antes o después.
   */
  _extractJson(text) {
    if (!text || typeof text !== 'string') return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      // Intentar limpiar: a veces el modelo añade trailing comas o
      // comillas tipográficas. Best-effort.
      try {
        const cleaned = m[0]
          .replace(/,(\s*[}\]])/g, '$1') // trailing commas
          .replace(/[“”]/g, '"')
          .replace(/[‘’]/g, "'");
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    }
  }

  /**
   * Normaliza la salida del LLM al schema canónico de `_pensadero.json`.
   * Tolera campos faltantes y valores inesperados.
   */
  _normalizeEntry(raw, filePath) {
    const r = raw || {};
    const arrStr = (v, max) => {
      if (!Array.isArray(v)) return [];
      const out = v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
      return typeof max === 'number' ? out.slice(0, max) : out;
    };
    const str = (v) => typeof v === 'string' && v.trim() ? v.trim() : '';
    const enumVal = (v, allowed, fallback = null) => {
      const s = str(v).toLowerCase();
      return allowed.includes(s) ? s : fallback;
    };

    const description = str(r.description);
    const shotType = enumVal(r.shot_type, [
      'plano_general','plano_americano','plano_medio','plano_medio_corto','primer_plano','plano_detalle'
    ]);
    const framing = enumVal(r.people_framing, [
      'ninguno','individual','pareja','grupo','multitud'
    ], 'ninguno');

    const ageRanges = arrStr(r.age_ranges, 4).filter(x =>
      ['niño','joven','adulto','senior'].includes(x.toLowerCase())
    );
    const genders = arrStr(r.genders, 2).filter(x =>
      ['hombre','mujer'].includes(x.toLowerCase())
    );
    const attire = enumVal(r.attire, ['casual','formal','mixto','deportivo','elegante']) || '';

    const objects = arrStr(r.objects, 10);
    const actions = arrStr(r.actions, 5);
    const expressions = arrStr(r.expressions, 5);
    const ocrText = arrStr(r.ocr_text, 10);
    const dominantColors = arrStr(r.dominant_colors, 5)
      .map(c => c.replace(/[^#0-9a-fA-F]/g, ''))
      .filter(c => /^#[0-9a-fA-F]{6}$/.test(c));

    return {
      description,
      technical: {
        // El orquestador rellena resolution/aspect_ratio leyendo el archivo.
      },
      identity: {
        faces: [],       // sin detección automática por ahora
        face_count: 0,
        spaces: [],
      },
      demographics: {
        age_ranges: ageRanges,
        genders,
        attire,
      },
      composition: {
        shot_type: shotType,
        people_framing: framing,
      },
      semantics: {
        objects,
        expressions,
        actions,
        dominant_colors: dominantColors,
        text: ocrText,
      },
    };
  }
}

// Singleton para reusar la conexión Ollama
let _instance = null;
function getInstance() {
  if (!_instance) _instance = new VisualScanService();
  return _instance;
}

module.exports = { VisualScanService, getInstance };
