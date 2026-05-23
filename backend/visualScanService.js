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
const sharp = require('sharp');

const DEFAULT_VLM_MODEL = 'qwen2.5vl:7b';
const PER_IMAGE_TIMEOUT_MS = parseInt(process.env.VLM_TIMEOUT_MS || '180000', 10); // 180s por imagen (margen para fotos grandes + modelos grandes en cold-start)
const VIDEO_FRAMES_PER_SCAN = parseInt(process.env.VLM_VIDEO_FRAMES || '3', 10); // 3 frames es buen balance calidad/coste
const VIDEO_MAX_FRAMES = 6;
// Lado mayor objetivo al pre-redimensionar la imagen antes de enviarla al VLM.
// La mayoria de encoders de vision aceptan hasta ~1568px y reescalan internamente
// con perdida si reciben mas. Controlandolo nosotros con sharp (Lanczos) preservamos
// detalle de forma mas predecible que dejarselo al pipeline del modelo.
const VLM_IMAGE_MAX_SIDE = parseInt(process.env.VLM_IMAGE_MAX_SIDE || '1568', 10);

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
    // Pre-resize con sharp: encoders de vision esperan ~1024-1568px lado mayor.
    // Mejor controlar el resize nosotros (Lanczos) que dejar al modelo aplicar
    // un downscale agresivo que pierde detalle. Si falla (formato raro), caemos
    // al buffer original para no abortar el archivo.
    let base64;
    try {
      const resized = await sharp(filePath, { failOn: 'none' })
        .rotate() // respetar orientacion EXIF
        .resize({
          width: VLM_IMAGE_MAX_SIDE,
          height: VLM_IMAGE_MAX_SIDE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
      base64 = resized.toString('base64');
    } catch (err) {
      try {
        const buffer = await fs.readFile(filePath);
        base64 = buffer.toString('base64');
      } catch (err2) {
        throw new Error(`No se pudo leer ${filePath}: ${err2.message}`);
      }
    }

    const systemPrompt = this._buildSystemPrompt();
    const userPrompt = this._buildUserPrompt(opts.folderContext);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_IMAGE_TIMEOUT_MS);

    let response;
    try {
      response = await this.ollama.chat({
        model: this.model,
        // format:'json' fuerza al modelo a emitir JSON sintacticamente valido
        // via constrained decoding. Elimina la mayoria de errores de parsing
        // y libera al modelo de "preocuparse por el formato", invirtiendo mas
        // capacidad en el contenido. _extractJson queda como red de seguridad.
        format: 'json',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: userPrompt,
            images: [base64],
          },
        ],
        stream: false,
        options: {
          temperature: 0.2,
          // 900 da margen al few-shot + descripciones ricas + todos los enums.
          // Con 600 el modelo a veces truncaba el JSON antes de cerrar.
          num_predict: 900,
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

  /**
   * Lista solo modelos con capacidad de vision (multimodales). Filtra por
   * nombre porque las familias VLM tienen nombres estandar:
   *   - qwen*-vl, qwen2.5vl, qwen-vl
   *   - gemma3 (todos los gemma3 son multimodales)
   *   - llava, bakllava
   *   - moondream
   *   - minicpm-v (y variantes)
   *   - llama3.2-vision, mllama
   *   - internvl3, internvl (familia InternVL — fuerte en NODO con 14B en 16GB VRAM)
   *
   * Evita modelos de solo texto (llama3.1:8b, qwen2.5:14b-instruct,
   * dolphin-llama3...) y embedders (nomic-embed-text...) que en el scan
   * fallarian foto a foto. Esto es lo que el usuario ve en el selector.
   *
   * Heuristica por nombre en vez de ollama.show() porque show() puede
   * tardar 1-2s por modelo y aqui solo nos interesa la fiabilidad: las
   * familias VLM conocidas tienen patrones estables.
   */
  async listVisionModels() {
    const list = await this.ollama.list();
    const all = (list.models || []).map(m => m.name).filter(Boolean);
    const visionNameRegex = /(qwen.*vl|gemma3(:|$)|llava|bakllava|moondream|minicpm-v|llama3\.2-vision|mllama|internvl)/i;
    return all.filter(name => visionNameRegex.test(name));
  }

  /**
   * Prompt de sistema: identidad, schema, reglas y un ejemplo few-shot.
   * Se envia una sola vez por turno y el modelo lo "absorbe" mejor en system
   * que en user. Incluye definiciones operativas de los enums mas confusos
   * (shot_type) y un ejemplo concreto input->output esperado para subir
   * cobertura en modelos pequenos (gemma3:4b, qwen2.5vl:7b).
   */
  _buildSystemPrompt() {
    return `Eres un asistente experto en describir fotografias y frames de video para un archivo personal indexable y buscable en lenguaje natural espanol. Tu trabajo es extraer metadata RICA, ESPECIFICA y FIEL a lo que ves — nunca generica.

ESQUEMA EXACTO (debes rellenar TODOS los campos; usa null en los enums solo si realmente no aplica):
{
  "description_what": "frase en ESPAÑOL describiendo QUE se ve (sujetos concretos, verbos, objetos, lugar). Rica en sustantivos y verbos. Evita palabras vacias como 'imagen', 'foto', 'escena'.",
  "description_mood": "frase en ESPAÑOL describiendo el AMBIENTE (luz, atmosfera, sensacion). Concisa pero evocadora.",
  "shot_type": uno de los valores listados abajo o null,
  "camera_angle": "normal" | "picado" | "contrapicado" | "cenital" | "nadir" | null,
  "camera_movement": "fijo" | "panoramica" | "travelling" | "dolly" | "zoom_in" | "zoom_out" | "handheld" | "steady" | null,
  "people_framing": "ninguno" | "individual" | "pareja" | "grupo" | "multitud",
  "mood": "alegre" | "neutro" | "serio" | "intimo" | "festivo" | "melancolico" | "energico" | "formal" | "contemplativo" | null,
  "lighting": "luz_natural" | "luz_dorada" | "contraluz" | "interior" | "neon" | "nocturna" | "mixta" | null,
  "space_type": "interior" | "exterior" | "urbano" | "naturaleza" | "oficina" | "escenario" | "hogar" | "transito" | null,
  "time_of_day": "amanecer" | "manana" | "mediodia" | "tarde" | "atardecer" | "noche" | "indeterminado" | null,
  "style": "documental" | "retrato" | "paisaje" | "accion" | "producto" | "ambiente" | "abstracto" | null,
  "objects": ["sustantivos simples en español", max 10],
  "actions": ["verbos en infinitivo o sustantivos en español", max 5],
  "expressions": ["sonrisa","serio","neutro","sorpresa",...], max 5, vacio si nadie,
  "ocr_text": ["texto visible legible",...], max 10, vacio si nada
}

DEFINICIONES de shot_type (siempre intentar rellenar — solo null si es imposible decidir):
- plano_general: encuadre muy amplio, sujeto pequeno respecto al entorno (paisaje, multitud)
- plano_conjunto: varias personas o sujeto entero con su entorno cercano
- plano_americano: persona de las rodillas para arriba
- plano_medio: persona de la cintura para arriba
- plano_medio_corto: persona del pecho para arriba
- primer_plano: cara y hombros (la cara llena el encuadre)
- plano_detalle: parte concreta de un objeto o cuerpo (mano, ojo, textura)

REGLAS:
1. description_what y description_mood: 2 frases concisas en español. Cada una rica en informacion concreta y NO redundante con la otra. NO inventes lo que no veas.
2. NO inferir edad ni genero de las personas — otro modulo lo hace con mas precision. Solo people_framing como conteo aproximado.
3. camera_movement: solo si es un VIDEO (frame de video); en fotos devuelve null.
4. ocr_text: solo si hay texto legible visible. NO inventes texto.
5. NO incluyas el campo palette/dominant_colors — el color lo extrae otro modulo.
6. Si recibes CONTEXTO DE LA CARPETA en el mensaje del usuario, usalo para precisar (lugar, evento, personas que pueden aparecer). NUNCA inventes nombres que el contexto no proporcione.
7. NO empieces description_what con "Una imagen de" / "Una foto que muestra" / "Se ve". Ve directo al sujeto y verbo.
8. Devuelve UNICAMENTE el JSON valido, sin texto antes ni despues, sin markdown.

EJEMPLO de salida bien hecha (input: foto de un grupo de amigos brindando en la terraza de un bar al atardecer):
{
  "description_what": "Cuatro amigos brindan con copas de cerveza sentados alrededor de una mesa de madera en la terraza de un bar urbano",
  "description_mood": "Atmosfera relajada y festiva con luz calida de atardecer que tine las caras de naranja",
  "shot_type": "plano_conjunto",
  "camera_angle": "normal",
  "camera_movement": null,
  "people_framing": "grupo",
  "mood": "festivo",
  "lighting": "luz_dorada",
  "space_type": "urbano",
  "time_of_day": "atardecer",
  "style": "documental",
  "objects": ["copas de cerveza","mesa de madera","sillas","farolas","plantas"],
  "actions": ["brindar","reir","conversar"],
  "expressions": ["sonrisa","risa"],
  "ocr_text": []
}`;
  }

  /**
   * Prompt de usuario: instruccion concreta + contexto opcional de la carpeta.
   * Corto a proposito — el "que" (schema, reglas, ejemplo) vive en el system.
   */
  _buildUserPrompt(folderContext) {
    const ctx = typeof folderContext === 'string' ? folderContext.trim() : '';
    if (!ctx) {
      return 'Describe esta imagen siguiendo el esquema. Devuelve solo el JSON.';
    }
    return `CONTEXTO DE LA CARPETA (usalo para acotar y precisar; NO inventes nada que no veas):
${ctx}

Describe esta imagen siguiendo el esquema. Devuelve solo el JSON.`;
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

  // description_what: del frame con mas senal semantica (mas entidades unicas
  // entre objects+actions+expressions). Longitud sola enganaba: una frase
  // larga llena de muletillas perdia frente a una corta y densa. En empate
  // de senal, desempata por longitud (mas detalle).
  // description_mood: la mas larga (no tiene contadores de entidades asociados).
  const signalOf = (f) => {
    const s = new Set();
    for (const arr of [f?.semantics?.objects, f?.semantics?.actions, f?.semantics?.expressions]) {
      if (Array.isArray(arr)) for (const v of arr) if (typeof v === 'string' && v.trim()) s.add(v.trim().toLowerCase());
    }
    return s.size;
  };
  const bestByDensity = (arr) => arr
    .filter(f => typeof f?.description_what === 'string' && f.description_what.trim())
    .sort((a, b) => (signalOf(b) - signalOf(a)) || (b.description_what.length - a.description_what.length))[0];
  const longest = (arr) => arr
    .map(v => v || '')
    .sort((a, b) => b.length - a.length)[0] || '';
  const best = bestByDensity(frames);
  const descWhat = best ? best.description_what : longest(frames.map(f => f?.description_what));
  const descMood = longest(frames.map(f => f?.description_mood));

  // Moda (entrada mas frecuente, ignora nulls/vacios)
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

  // Composición: moda de cada campo entre los frames
  const shotType = mode(frames.map(f => f.composition?.shot_type)) || null;
  const cameraAngle = mode(frames.map(f => f.composition?.camera_angle)) || null;
  // camera_movement SÍ aplica en video (a diferencia de fotos). Moda de lo que diga el VLM
  const cameraMovement = mode(frames.map(f => f.composition?.camera_movement)) || null;
  const peopleFraming = mode(frames.map(f => f.composition?.people_framing)) || 'ninguno';

  // Atmósfera: moda de cada campo
  const mood = mode(frames.map(f => f.atmosphere?.mood)) || null;
  const lighting = mode(frames.map(f => f.atmosphere?.lighting)) || null;
  const spaceType = mode(frames.map(f => f.atmosphere?.space_type)) || null;
  const timeOfDay = mode(frames.map(f => f.atmosphere?.time_of_day)) || null;
  const style = mode(frames.map(f => f.atmosphere?.style)) || null;

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

  // Paleta: del primer frame que tenga datos
  const firstWithPalette = frames.find(f => Array.isArray(f.colors?.palette) && f.colors.palette.length > 0);
  const palette = firstWithPalette ? firstWithPalette.colors.palette : [];

  // movement_type heurístico (legacy field). Mantener por compat.
  const movementType = actions.length > 0 ? 'moving' : 'estatico';

  return {
    schema_version: 2,
    description_what: descWhat,
    description_mood: descMood,
    description: [descWhat, descMood].filter(Boolean).join(' '),
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
    composition: {
      shot_type: shotType,
      camera_angle: cameraAngle,
      camera_movement: cameraMovement,
      people_framing: peopleFraming,
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

// Singleton para reusar la conexión Ollama
let _instance = null;
function getInstance() {
  if (!_instance) _instance = new VisualScanService();
  return _instance;
}

module.exports = { VisualScanService, getInstance };
