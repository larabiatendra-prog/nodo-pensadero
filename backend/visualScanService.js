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
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { Ollama } = require('ollama');

const DEFAULT_VLM_MODEL = 'qwen2.5vl:7b';
const PER_IMAGE_TIMEOUT_MS = 90_000; // 90s por imagen (cold-start de modelo grande puede tardar)
const VIDEO_FRAMES_PER_SCAN = parseInt(process.env.VLM_VIDEO_FRAMES || '3', 10); // 3 frames es buen balance calidad/coste
const VIDEO_MAX_FRAMES = 6;

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
   * Describe un vídeo extrayendo N frames con ffmpeg, pasándolos al VLM,
   * y agregando los resultados en un único entry compatible con el schema
   * de fotos. Los tags se unionan; la descripción se toma del frame con
   * más contenido; technical viene de ffprobe (duración, fps, codec).
   */
  async scanVideo(filePath) {
    // 1. ffprobe para duración + fps + codec + resolución
    const probe = await probeVideo(filePath);
    if (!probe) {
      throw new Error(`No se pudo leer metadata del vídeo: ${path.basename(filePath)}`);
    }

    // 2. Extraer N frames repartidos (skip 5% inicio/final para evitar negros)
    const frameCount = Math.min(VIDEO_MAX_FRAMES, Math.max(1, VIDEO_FRAMES_PER_SCAN));
    const timestamps = [];
    if (probe.duration > 1) {
      const start = probe.duration * 0.05;
      const end = probe.duration * 0.95;
      const step = (end - start) / Math.max(1, frameCount - 1);
      for (let i = 0; i < frameCount; i++) {
        timestamps.push(start + i * step);
      }
    } else {
      timestamps.push(0);
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pensadero-frames-'));
    const framePaths = [];
    try {
      for (let i = 0; i < timestamps.length; i++) {
        const out = path.join(tempDir, `frame_${i}.jpg`);
        const ok = await extractFrame(filePath, timestamps[i], out);
        if (ok) framePaths.push(out);
      }

      if (framePaths.length === 0) {
        throw new Error('No se pudo extraer ningún frame del vídeo');
      }

      // 3. Escanear cada frame con el VLM
      const frameResults = [];
      for (const fp of framePaths) {
        try {
          const entry = await this.scanImage(fp);
          frameResults.push(entry);
        } catch (err) {
          console.warn(`[scanVideo] frame ${path.basename(fp)}: ${err.message}`);
        }
      }

      if (frameResults.length === 0) {
        throw new Error('Ningún frame pudo ser descrito por el VLM');
      }

      return aggregateFrameEntries(frameResults, probe);
    } finally {
      // Limpieza de temporales (best-effort)
      try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
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

  setModel(model) {
    this.model = model;
  }

  async listModels() {
    const list = await this.ollama.list();
    return (list.models || []).map(m => m.name).filter(Boolean);
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

// ============================================================================
// Helpers para vídeo (ffmpeg/ffprobe)
// ============================================================================

/**
 * Ejecuta un comando spawn y devuelve { code, stdout, stderr }.
 */
function runCommand(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]', timedOut: true });
    }, timeoutMs);
    p.stdout.on('data', (c) => { stdout += c.toString(); });
    p.stderr.on('data', (c) => { stderr += c.toString(); });
    p.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * ffprobe a un fichero. Devuelve { duration, width, height, fps, codec } o null.
 */
async function probeVideo(filePath) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-select_streams', 'v:0',
    filePath,
  ];
  const r = await runCommand('ffprobe', args, 30_000);
  if (r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout);
    const stream = data.streams && data.streams[0];
    const format = data.format || {};
    if (!stream) return null;
    const duration = parseFloat(format.duration || stream.duration || '0') || 0;
    const width = stream.width || 0;
    const height = stream.height || 0;
    // fps puede venir como "30000/1001"
    let fps = 0;
    if (stream.r_frame_rate && stream.r_frame_rate.includes('/')) {
      const [a, b] = stream.r_frame_rate.split('/').map(parseFloat);
      if (b > 0) fps = a / b;
    } else if (stream.avg_frame_rate && stream.avg_frame_rate.includes('/')) {
      const [a, b] = stream.avg_frame_rate.split('/').map(parseFloat);
      if (b > 0) fps = a / b;
    }
    return {
      duration,
      width,
      height,
      fps: Math.round(fps * 100) / 100,
      codec: stream.codec_name || null,
    };
  } catch {
    return null;
  }
}

/**
 * Extrae un frame en `timestampSec` a `outPath` con ffmpeg.
 * Devuelve true si funcionó (archivo escrito y no vacío).
 */
async function extractFrame(filePath, timestampSec, outPath) {
  // Seeking pre-input (rápido), single frame de salida.
  const args = [
    '-y',
    '-ss', String(timestampSec),
    '-i', filePath,
    '-frames:v', '1',
    '-q:v', '3',
    outPath,
  ];
  const r = await runCommand('ffmpeg', args, 30_000);
  if (r.code !== 0) return false;
  try {
    const st = fsSync.statSync(outPath);
    return st.size > 100; // bytes mínimos para considerarlo válido
  } catch {
    return false;
  }
}

/**
 * Une las entries de varios frames en un único entry compatible con el
 * schema photos[basename]. Estrategia:
 *  - description: del frame con descripción más larga (más detallada).
 *  - shot_type / people_framing: moda (más frecuente).
 *  - tags (objects/actions/expressions): unión deduplicada, hasta 10/5/5.
 *  - dominant_colors: del primer frame con color.
 *  - demographics: unión.
 *  - technical: de ffprobe.
 *  - identity: vacío aquí; la integración de caras la hace scanOrchestrator.
 */
function aggregateFrameEntries(frames, probe) {
  if (!Array.isArray(frames) || frames.length === 0) return null;

  // description: la más larga (heurística de "más contenido")
  const description = frames
    .map(f => f.description || '')
    .sort((a, b) => b.length - a.length)[0] || '';

  // Moda de shot_type / people_framing
  const mode = (arr) => {
    const counts = new Map();
    for (const v of arr) {
      if (!v) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let best = null;
    let bestCount = 0;
    for (const [v, c] of counts.entries()) {
      if (c > bestCount) { best = v; bestCount = c; }
    }
    return best;
  };

  const shotType = mode(frames.map(f => f.composition?.shot_type)) || null;
  const peopleFraming = mode(frames.map(f => f.composition?.people_framing)) || 'ninguno';

  // Unión deduplicada respetando primer orden de aparición
  const unionLimit = (arrays, limit) => {
    const seen = new Set();
    const out = [];
    for (const arr of arrays) {
      if (!Array.isArray(arr)) continue;
      for (const v of arr) {
        if (typeof v !== 'string' || !v.trim()) continue;
        const key = v.trim();
        if (seen.has(key.toLowerCase())) continue;
        seen.add(key.toLowerCase());
        out.push(key);
        if (out.length >= limit) return out;
      }
    }
    return out;
  };

  const objects = unionLimit(frames.map(f => f.semantics?.objects), 10);
  const actions = unionLimit(frames.map(f => f.semantics?.actions), 5);
  const expressions = unionLimit(frames.map(f => f.semantics?.expressions), 5);
  const ocrText = unionLimit(frames.map(f => f.semantics?.text), 10);

  // Demographics: unión
  const ageRanges = unionLimit(frames.map(f => f.demographics?.age_ranges), 4);
  const genders = unionLimit(frames.map(f => f.demographics?.genders), 2);
  const attire = mode(frames.map(f => f.demographics?.attire).filter(Boolean)) || '';

  // Colores del primer frame con datos
  const dominantColors = (frames.find(f => f.semantics?.dominant_colors?.length)?.semantics?.dominant_colors) || [];

  // Detectar movimiento: si las descripciones mencionan acciones (correr,
  // caminar, etc.) o si los frames difieren mucho. Heurística simple:
  // si actions > 1, asumir movimiento.
  const movementType = actions.length > 0 ? 'moving' : 'estatico';

  return {
    description,
    technical: {
      duration: probe?.duration || null,
      resolution: probe ? `${probe.width}x${probe.height}` : null,
      fps: probe?.fps || null,
      codec: probe?.codec || null,
      movement_type: movementType,
    },
    identity: {
      faces: [],
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
      people_framing: peopleFraming,
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

// Singleton para reusar la conexión Ollama
let _instance = null;
function getInstance() {
  if (!_instance) _instance = new VisualScanService();
  return _instance;
}

module.exports = { VisualScanService, getInstance };
