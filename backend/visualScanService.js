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
// num_predict para la llamada multi-imagen de video: mas alto que el de foto
// (900) porque la descripcion temporal (que ocurre a lo largo del clip) + todos
// los campos del schema necesitan mas tokens antes de cerrar el JSON.
const VIDEO_NUM_PREDICT = parseInt(process.env.VLM_VIDEO_NUM_PREDICT || '1400', 10);
// Lado mayor objetivo al pre-redimensionar la imagen antes de enviarla al VLM.
// La mayoria de encoders de vision aceptan hasta ~1568px y reescalan internamente
// con perdida si reciben mas. Controlandolo nosotros con sharp (Lanczos) preservamos
// detalle de forma mas predecible que dejarselo al pipeline del modelo.
const VLM_IMAGE_MAX_SIDE = parseInt(process.env.VLM_IMAGE_MAX_SIDE || '1568', 10);

// Formatos que un VLM acepta como bytes crudos sin transcodificar. Solo para
// estos es seguro el fallback "leer el archivo tal cual" si sharp falla. HEIC/
// HEIF/AVIF/TIFF NO entran: mandar sus bytes crudos al modelo produce basura
// silenciosa (el VLM no los decodifica). Para esos, mejor fallar visible.
const VLM_RAW_SAFE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

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
  /**
   * Pre-resize con sharp + base64. Encoders de vision esperan ~1024-1568px
   * lado mayor; controlar el resize nosotros (Lanczos) preserva mas detalle
   * que dejar al modelo aplicar un downscale agresivo. Si sharp falla (formato
   * raro), cae al buffer original para no abortar el archivo.
   */
  async _imageToBase64(filePath) {
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
      return resized.toString('base64');
    } catch (err) {
      // sharp no pudo decodificar (formato sin soporte en esta build, p.ej.
      // HEIC/AVIF sin libheif, o archivo corrupto). Solo caemos a bytes crudos
      // si el formato es uno que el VLM lee nativo; si no, fallamos visible para
      // no catalogar el archivo con una descripcion basura silenciosa.
      const ext = path.extname(filePath).toLowerCase();
      if (VLM_RAW_SAFE_EXTS.has(ext)) {
        const buffer = await fs.readFile(filePath);
        return buffer.toString('base64');
      }
      throw new Error(
        `sharp no pudo decodificar ${path.basename(filePath)} (${ext}): ${err.message}. ` +
        `Formato no soportado por esta build de sharp (¿falta libheif para HEIC/AVIF?); ` +
        `se omite para no generar metadata invalida.`
      );
    }
  }

  async scanImage(filePath, opts = {}) {
    let base64;
    try {
      base64 = await this._imageToBase64(filePath);
    } catch (err2) {
      throw new Error(`No se pudo leer ${filePath}: ${err2.message}`);
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
    // El orquestador reutiliza estos frames (InsightFace, color, CLIP) y luego
    // llama a cleanup(). NO borramos aqui salvo que falle la extraccion.
    const cleanup = async () => {
      try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    };

    const frames = []; // [{ path, timestamp }]
    try {
      for (let i = 0; i < timestamps.length; i++) {
        const out = path.join(tempDir, `frame_${i}.jpg`);
        const ok = await extractFrame(filePath, timestamps[i], out);
        if (ok) frames.push({ path: out, timestamp: timestamps[i] });
      }

      if (frames.length === 0) {
        throw new Error('No se pudo extraer ningún frame del vídeo');
      }

      // 3. VLM: UNA sola llamada multi-imagen con todos los frames en orden
      //    cronológico. Esto permite al modelo razonar sobre la SECUENCIA
      //    (movimiento de cámara, acciones a lo largo del clip, cambios de
      //    escena) en vez de describir cada frame como foto aislada.
      let entry = null;
      try {
        entry = await this._scanVideoFrames(frames.map(f => f.path), {
          folderContext: opts.folderContext,
          durationSec: probe.duration,
        });
      } catch (err) {
        console.warn(`[scanVideo] multi-imagen falló (${path.basename(filePath)}): ${err.message}. Fallback per-frame.`);
      }

      // 4. Fallback: si la llamada multi-imagen falló o devolvió vacío (modelo
      //    que no soporta multi-imagen), escanear frame a frame y agregar.
      if (!entry || !entry.description_what) {
        const frameResults = [];
        for (const f of frames) {
          try {
            const e = await this.scanImage(f.path, { folderContext: opts.folderContext });
            frameResults.push(e);
          } catch (err) {
            console.warn(`[scanVideo] frame ${path.basename(f.path)}: ${err.message}`);
          }
        }
        if (frameResults.length === 0) {
          throw new Error('Ningún frame pudo ser descrito por el VLM');
        }
        entry = aggregateFrameEntries(frameResults, probe);
      } else {
        // technical lo aporta ffprobe (el VLM no conoce duración/fps/codec).
        entry.technical = {
          ...(entry.technical || {}),
          duration: probe.duration || null,
          resolution: `${probe.width}x${probe.height}`,
          fps: probe.fps || null,
          codec: probe.codec || null,
          // movement_type heurístico legacy: hay accion si el VLM listo acciones.
          movement_type: (entry.semantics?.actions?.length > 0) ? 'moving' : 'estatico',
        };
      }

      return { entry, frames, cleanup };
    } catch (err) {
      await cleanup();
      throw err;
    }
  }

  /**
   * Una sola llamada al VLM con N frames de un vídeo en orden cronológico.
   * Devuelve un entry normalizado describiendo el clip como un todo temporal.
   * Requiere un modelo que soporte multi-imagen (qwen2.5vl, internvl3, gemma3,
   * minicpm-v...). Si el modelo no lo soporta, la respuesta será pobre o fallará
   * y scanVideo cae al modo per-frame.
   */
  async _scanVideoFrames(framePaths, opts = {}) {
    const images = [];
    for (const fp of framePaths) {
      images.push(await this._imageToBase64(fp));
    }

    const systemPrompt = this._buildVideoSystemPrompt();
    const userPrompt = this._buildVideoUserPrompt(opts.folderContext, framePaths.length, opts.durationSec);

    // Timeout escalado: procesar N imágenes en una llamada tarda ~N veces más
    // que una sola. Cap a 600s para no colgar el batch indefinidamente.
    const timeoutMs = Math.min(PER_IMAGE_TIMEOUT_MS * framePaths.length, 600_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await this.ollama.chat({
        model: this.model,
        format: 'json',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt, images },
        ],
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: VIDEO_NUM_PREDICT,
        },
        signal: controller.signal,
      });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (controller.signal.aborted || /aborted|timeout/i.test(msg)) {
        throw new Error(`VLM timeout (${timeoutMs}ms) en vídeo multi-frame`);
      }
      throw new Error(`VLM multi-frame falló: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const text = (response && response.message && response.message.content || '').trim();
    const parsed = this._extractJson(text);
    return this._normalizeEntry(parsed, framePaths[0]);
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
   * Prompt de sistema para VIDEO multi-frame. Igual schema que fotos pero la
   * tarea cambia: recibes varios frames CRONOLOGICOS del MISMO clip y debes
   * describir el video como un TODO TEMPORAL — que ocurre a lo largo del clip,
   * como se mueve la camara (comparando frames), que acciones suceden, y si hay
   * cambios de escena. Anade el campo booleano scene_changes.
   */
  _buildVideoSystemPrompt() {
    return `Eres un asistente experto en describir VIDEOS para un archivo personal indexable y buscable en lenguaje natural espanol. Recibes VARIOS frames extraidos en ORDEN CRONOLOGICO del MISMO clip (el primer frame es el inicio, el ultimo es el final). NO los describas por separado: razona sobre la SECUENCIA y describe el video como un todo.

CLAVE — lo que solo se puede deducir viendo varios frames juntos:
- camera_movement: compara la posicion de los objetos/encuadre entre frames. Si el encuadre se desplaza lateralmente es "panoramica"/"travelling"; si se acerca/aleja es "zoom_in"/"zoom_out"; si tiembla es "handheld"; si todo queda igual es "fijo".
- actions: que ACCIONES ocurren a lo largo del clip (no lo que hay en un frame). Ej: "entrar por la puerta", "abrazarse", "caminar".
- scene_changes: true si el clip salta entre escenas/planos distintos (cambio brusco de lugar o encuadre entre frames); false si es una toma continua.
- description_what: NARRA lo que sucede en el clip de principio a fin, no un instante congelado.

ESQUEMA EXACTO (rellena TODOS los campos; usa null en los enums solo si realmente no aplica):
{
  "description_what": "frase en ESPAÑOL narrando QUE ocurre en el clip (sujetos concretos, verbos de accion, evolucion). Rica en sustantivos y verbos. Evita 'video', 'clip', 'escena' como muletilla.",
  "description_mood": "frase en ESPAÑOL describiendo el AMBIENTE (luz, atmosfera, sensacion). Concisa pero evocadora.",
  "shot_type": uno de los valores listados abajo o null,
  "camera_angle": "normal" | "picado" | "contrapicado" | "cenital" | "nadir" | null,
  "camera_movement": "fijo" | "panoramica" | "travelling" | "dolly" | "zoom_in" | "zoom_out" | "handheld" | "steady" | null,
  "scene_changes": true | false,
  "people_framing": "ninguno" | "individual" | "pareja" | "grupo" | "multitud",
  "mood": "alegre" | "neutro" | "serio" | "intimo" | "festivo" | "melancolico" | "energico" | "formal" | "contemplativo" | null,
  "lighting": "luz_natural" | "luz_dorada" | "contraluz" | "interior" | "neon" | "nocturna" | "mixta" | null,
  "space_type": "interior" | "exterior" | "urbano" | "naturaleza" | "oficina" | "escenario" | "hogar" | "transito" | null,
  "time_of_day": "amanecer" | "manana" | "mediodia" | "tarde" | "atardecer" | "noche" | "indeterminado" | null,
  "style": "documental" | "retrato" | "paisaje" | "accion" | "producto" | "ambiente" | "abstracto" | null,
  "objects": ["sustantivos simples en español", max 10],
  "actions": ["verbos en infinitivo o sustantivos en español describiendo lo que pasa en el clip", max 5],
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
1. description_what y description_mood: 2 frases concisas en español. NO inventes lo que no veas.
2. NO inferir edad ni genero de las personas — otro modulo lo hace. Solo people_framing como conteo aproximado.
3. camera_movement: dedúcelo COMPARANDO frames. Si solo hubiera un frame, devuelve "fijo".
4. scene_changes: true solo si ves un salto claro de escena/plano entre frames.
5. ocr_text: solo texto legible visible. NO inventes texto.
6. NO incluyas palette/dominant_colors — el color lo extrae otro modulo.
7. Si recibes CONTEXTO DE LA CARPETA, usalo para precisar. NUNCA inventes nombres que el contexto no proporcione.
8. NO empieces description_what con "Un video de" / "Se ve". Ve directo al sujeto y la accion.
9. Devuelve UNICAMENTE el JSON valido, sin texto antes ni despues, sin markdown.

EJEMPLO de salida bien hecha (input: 3 frames de una mujer que entra en un salon, se sienta en el sofa y abre un portatil; la camara la sigue):
{
  "description_what": "Una mujer entra en el salon, cruza la habitacion y se sienta en el sofa donde abre un portatil para ponerse a trabajar",
  "description_mood": "Ambiente domestico y tranquilo con luz natural suave entrando por la ventana",
  "shot_type": "plano_conjunto",
  "camera_angle": "normal",
  "camera_movement": "panoramica",
  "scene_changes": false,
  "people_framing": "individual",
  "mood": "contemplativo",
  "lighting": "luz_natural",
  "space_type": "hogar",
  "time_of_day": "manana",
  "style": "documental",
  "objects": ["sofa","portatil","ventana","mesa","cojines"],
  "actions": ["entrar","caminar","sentarse","abrir portatil"],
  "expressions": ["neutro"],
  "ocr_text": []
}`;
  }

  /**
   * Prompt de usuario para video: indica cuantos frames hay y en que orden,
   * mas el contexto opcional de la carpeta.
   */
  _buildVideoUserPrompt(folderContext, frameCount, durationSec) {
    const ctx = typeof folderContext === 'string' ? folderContext.trim() : '';
    const dur = (typeof durationSec === 'number' && durationSec > 0)
      ? ` El clip dura ~${Math.round(durationSec)}s.`
      : '';
    const head = `Estos son ${frameCount} frames extraidos en orden cronologico del mismo video (frame 1 = inicio, frame ${frameCount} = final).${dur} Describe el video COMPLETO como secuencia temporal siguiendo el esquema. Devuelve solo el JSON.`;
    if (!ctx) return head;
    return `CONTEXTO DE LA CARPETA (usalo para acotar y precisar; NO inventes nada que no veas):
${ctx}

${head}`;
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
    // scene_changes: solo aplica a video (multi-frame). En fotos queda null.
    const sceneChanges = typeof r.scene_changes === 'boolean' ? r.scene_changes : null;

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
        scene_changes: sceneChanges,
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
