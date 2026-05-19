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
   *
   * @param {string} filePath
   * @param {object} [opts]
   * @param {string} [opts.folderContext] Texto a inyectar antes del esquema
   *   para acotar el dominio (qué es la carpeta, quién aparece, etc.).
   */
  async scanImage(filePath, opts = {}) {
    let buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch (err) {
      throw new Error(`No se pudo leer ${filePath}: ${err.message}`);
    }

    const base64 = buffer.toString('base64');
    const prompt = this._buildPrompt(opts.folderContext);

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
   *
   * @param {string} filePath
   * @param {object} [opts]
   * @param {string} [opts.folderContext] Contexto opcional inyectado en el
   *   prompt al describir cada frame.
   */
  async scanVideo(filePath, opts = {}) {
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

      // 3. Escanear cada frame con el VLM (pasando el mismo contexto de carpeta)
      const frameResults = [];
      for (const fp of framePaths) {
        try {
          const entry = await this.scanImage(fp, { folderContext: opts.folderContext });
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

  _buildPrompt(folderContext) {
    const ctx = typeof folderContext === 'string' ? folderContext.trim() : '';
    const contextSection = ctx
      ? `CONTEXTO DE LA CARPETA (úsalo para acotar y precisar; NO inventes nada que no veas en la imagen):
${ctx}

`
      : '';

    return `Eres un asistente experto en describir fotografias y videos para un archivo personal indexable y buscable en lenguaje natural. Devuelve SOLO un JSON sin explicaciones ni markdown.

${contextSection}ESQUEMA EXACTO:
{
  "description_what": "frase en ESPAÑOL describiendo QUE se ve (sujetos, verbos, objetos, lugar) — concisa pero rica en sustantivos y verbos",
  "description_mood": "frase en ESPAÑOL describiendo el AMBIENTE (luz, atmosfera, estilo) — concisa",
  "shot_type": "plano_general" | "plano_conjunto" | "plano_americano" | "plano_medio" | "plano_medio_corto" | "primer_plano" | "plano_detalle" | null,
  "camera_angle": "normal" | "picado" | "contrapicado" | "cenital" | "nadir" | null,
  "camera_movement": "fijo" | "panoramica" | "travelling" | "dolly" | "zoom_in" | "zoom_out" | "handheld" | "steady" | null,
  "people_framing": "ninguno" | "individual" | "pareja" | "grupo" | "multitud",
  "mood": "alegre" | "neutro" | "serio" | "intimo" | "festivo" | "melancolico" | "energico" | "formal" | "contemplativo" | null,
  "lighting": "luz_natural" | "luz_dorada" | "contraluz" | "interior" | "neon" | "nocturna" | "mixta" | null,
  "space_type": "interior" | "exterior" | "urbano" | "naturaleza" | "oficina" | "escenario" | "hogar" | "transito" | null,
  "time_of_day": "amanecer" | "manana" | "mediodia" | "tarde" | "atardecer" | "noche" | "indeterminado" | null,
  "style": "documental" | "retrato" | "paisaje" | "accion" | "producto" | "ambiente" | "abstracto" | null,
  "objects": ["objeto1","objeto2",...] (max 10, sustantivos simples en español),
  "actions": ["accion1",...] (max 5, verbos en infinitivo o sustantivos en español),
  "expressions": ["sonrisa","serio","neutro","sorpresa",...] (max 5, vacio si nadie),
  "ocr_text": ["texto visible",...] (max 10 fragmentos legibles, vacio si nada),
  "palette": [{"hex":"#RRGGBB","name":"nombre en español"}, ...] (3 colores dominantes con nombre humano)
}

REGLAS:
1. description_what y description_mood: 2 frases concisas en español. NO inventes lo que no veas en la imagen.
2. NO inferir edad ni genero de las personas — eso lo hace otro modulo con mas precision. Solo people_framing como conteo aproximado.
3. camera_movement: solo si es un VIDEO (frame de video); en fotos devuelve null.
4. ocr_text: solo si hay texto legible. NO inventes texto.
5. palette: 3 colores principales con nombre humano en español (ejemplos validos: azul marino, ocre, dorado, blanco, gris claro, verde oliva, rojo intenso, rosa pastel, negro, marron, lavanda, turquesa, salmon, beige, naranja, amarillo mostaza).
6. Si hay CONTEXTO DE LA CARPETA, usalo para precisar — incluyendo nombres de personas mencionadas si aparecen claramente en la imagen. NUNCA inventes nombres que el contexto no proporcione.
7. Devuelve SOLO el JSON, sin texto antes ni despues.`;
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
   *
   * Schema v2 (2026-05-19):
   *  - description_what + description_mood (2 frases)
   *  - shot_type / camera_angle / camera_movement
   *  - mood / lighting / space_type / time_of_day / style
   *  - palette: [{hex, name}] (con nombre humano)
   *  - YA NO: age_ranges, genders, attire (los aporta InsightFace via identity.detections)
   *  - YA NO: description (sustituido por description_what + description_mood)
   *  - YA NO: dominant_colors hex sueltos (ahora palette con nombre)
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

    // Descripcion: 2 frases. Compat con scans v1 que solo tienen `description`.
    const descWhat = str(r.description_what) || str(r.description);
    const descMood = str(r.description_mood);

    // Composicion
    const shotType = enumVal(r.shot_type, [
      'plano_general','plano_conjunto','plano_americano','plano_medio','plano_medio_corto','primer_plano','plano_detalle'
    ]);
    const cameraAngle = enumVal(r.camera_angle, ['normal','picado','contrapicado','cenital','nadir']);
    const cameraMovement = enumVal(r.camera_movement, ['fijo','panoramica','travelling','dolly','zoom_in','zoom_out','handheld','steady']);
    const framing = enumVal(r.people_framing, ['ninguno','individual','pareja','grupo','multitud'], 'ninguno');

    // Atmosfera (nuevos enums buscables en lenguaje natural)
    const mood = enumVal(r.mood, ['alegre','neutro','serio','intimo','festivo','melancolico','energico','formal','contemplativo']);
    const lighting = enumVal(r.lighting, ['luz_natural','luz_dorada','contraluz','interior','neon','nocturna','mixta']);
    const spaceType = enumVal(r.space_type, ['interior','exterior','urbano','naturaleza','oficina','escenario','hogar','transito']);
    const timeOfDay = enumVal(r.time_of_day, ['amanecer','manana','mediodia','tarde','atardecer','noche','indeterminado']);
    const style = enumVal(r.style, ['documental','retrato','paisaje','accion','producto','ambiente','abstracto']);

    // Listas libres
    const objects = arrStr(r.objects, 10);
    const actions = arrStr(r.actions, 5);
    const expressions = arrStr(r.expressions, 5);
    const ocrText = arrStr(r.ocr_text, 10);

    // Paleta: [{hex, name}]. Tolera tambien el legacy dominant_colors (array de hex).
    let palette = [];
    if (Array.isArray(r.palette)) {
      palette = r.palette
        .filter(p => p && typeof p === 'object')
        .map(p => {
          const hex = typeof p.hex === 'string' ? p.hex.replace(/[^#0-9a-fA-F]/g, '') : '';
          const name = typeof p.name === 'string' ? p.name.trim() : '';
          return { hex, name };
        })
        .filter(p => /^#[0-9a-fA-F]{6}$/.test(p.hex))
        .slice(0, 5);
    } else if (Array.isArray(r.dominant_colors)) {
      palette = r.dominant_colors
        .filter(c => typeof c === 'string')
        .map(c => ({ hex: c.replace(/[^#0-9a-fA-F]/g, ''), name: '' }))
        .filter(p => /^#[0-9a-fA-F]{6}$/.test(p.hex))
        .slice(0, 5);
    }

    return {
      schema_version: 2,
      description_what: descWhat,
      description_mood: descMood,
      // Compat: `description` se sigue exponiendo como concatenacion para que
      // catalogReader/aiSearch existentes sigan funcionando hasta migrar.
      description: [descWhat, descMood].filter(Boolean).join(' '),
      technical: {
        // El orquestador rellena resolution/aspect_ratio leyendo el archivo.
      },
      identity: {
        faces: [],       // se rellenan via InsightFace en scanOrchestrator
        face_count: 0,
        spaces: [],
      },
      composition: {
        shot_type: shotType,
        camera_angle: cameraAngle,
        camera_movement: cameraMovement,
        people_framing: framing,
      },
      atmosphere: {
        mood,
        lighting,
        space_type: spaceType,
        time_of_day: timeOfDay,
        style,
      },
      semantics: {
        objects,
        expressions,
        actions,
        text: ocrText,
      },
      colors: {
        palette,
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
