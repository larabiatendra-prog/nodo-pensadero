/**
 * Face Service — Pensadero NODO
 *
 * Wrapper Node sobre el script Python `face_detector.py` (InsightFace).
 * Mantiene un proceso Python persistente en "modo stream" para no recargar
 * el modelo en cada imagen (carga ~3-5s).
 *
 * API:
 *   await faceService.init()                  → arranca el daemon Python y
 *                                               CARGA el modelo (warmup); solo
 *                                               entonces `ready` es cierto
 *   await faceService.detectFaces(imagePath)  → [{ bbox, embedding, det_score, age, gender }, ...]
 *   await faceService.trainPerson(personDir)  → { centroid, count, photos_used, ... }
 *   faceService.shutdown()                    → cierra el daemon
 *
 * Cache en memoria de embeddings del registry para que el matching contra
 * caras conocidas no toque disco. Se invalida al re-entrenar una persona.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { atomicWriteFile } = require('../utils/jsonStore');
const peopleRegistry = require('../peopleRegistry');
const fallos = require('../utils/failureReason');

const PYTHON_DIR = path.join(__dirname, '..', 'python');
const PYTHON_EXE_WIN = path.join(PYTHON_DIR, '.venv', 'Scripts', 'python.exe');
const PYTHON_EXE_NIX = path.join(PYTHON_DIR, '.venv', 'bin', 'python');
const SCRIPT_PATH = path.join(PYTHON_DIR, 'face_detector.py');

// Pista de diagnostico para el fallo tipico al migrar entre PCs: el shim
// .venv/Scripts/python.exe guarda en pyvenv.cfg la ruta ABSOLUTA del
// interprete base (home=C:\Users\<user>\...\PythonXY). Si el venv se copio
// de otro PC, esa ruta no existe en destino y Python sale con codigo 103
// ("No Python at ..."). La cura no es tocar Node sino recrear el venv en
// local. Ver Pensadero_Doctor.bat / Pensadero_Install.bat.
const VENV_BROKEN_HINT = ' — el venv puede estar roto o copiado de otro PC '
  + '(pyvenv.cfg apunta a un Python que no existe aqui). Recrea '
  + 'backend/python/.venv ejecutando Pensadero_Install.bat.';

function looksLikeBrokenVenv(msg) {
  return /exited with code|No Python at|cannot find|no such file|ENOENT/i.test(msg || '');
}

// Umbral de coincidencia coseno por defecto. Conservador para minimizar
// falsos positivos. InsightFace ArcFace: same person típicamente >0.5,
// different person <0.3.
const DEFAULT_MATCH_THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.5');

// Embeddings de 512 floats: serializados como base64 de Float32Array para
// reducir tamaño ~60% vs JSON array y permitir re-identificacion retroactiva
// (recalcular matches sin re-detectar) cuando se añaden personas nuevas.
function encodeEmbedding(arr) {
  if (!arr || arr.length !== 512) return null;
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

function decodeEmbedding(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 2048) return null; // 512 × 4 bytes
  return new Float32Array(buf.buffer, buf.byteOffset, 512);
}

class FaceService {
  constructor() {
    this.proc = null;
    this.queue = [];           // peticiones pendientes
    this.current = null;       // promesa actual en vuelo
    this.reqSeq = 0;           // contador de id de correlacion peticion↔respuesta
    this.stdoutBuffer = '';
    this.starting = null;      // promesa de inicialización en curso
    this.ready = false;
    this.unavailable = false;
    this.lastError = null;
    this.providers = [];       // providers reales de onnxruntime tras el warmup
    this.embeddingsCache = new Map(); // person_id → { centroid: Float32Array, count }
  }

  /**
   * Arranca el daemon Python si no está vivo. Idempotente: múltiples llamadas
   * comparten la misma inicialización.
   */
  async init() {
    if (this.ready) return true;
    if (this.unavailable) return false;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const pythonExe = fs.existsSync(PYTHON_EXE_WIN) ? PYTHON_EXE_WIN
                       : fs.existsSync(PYTHON_EXE_NIX) ? PYTHON_EXE_NIX
                       : null;
      if (!pythonExe) {
        this.unavailable = true;
        this.lastError = 'Python venv no encontrado en backend/python/.venv. Ejecuta install.';
        console.warn('[faceService]', this.lastError);
        return false;
      }
      if (!fs.existsSync(SCRIPT_PATH)) {
        this.unavailable = true;
        this.lastError = `Script no encontrado: ${SCRIPT_PATH}`;
        console.warn('[faceService]', this.lastError);
        return false;
      }

      try {
        this.proc = spawn(pythonExe, [SCRIPT_PATH, '--stream'], {
          cwd: PYTHON_DIR,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            // Forzar UTF-8 en stdin/stdout/stderr del proceso Python para
            // que paths con acentos/eñes/parentesis lleguen intactos.
            // En Windows, sin esto Python usa cp1252 y los UTF-8 multibyte
            // chars se corrompen.
            PYTHONIOENCODING: 'utf-8',
          },
        });
      } catch (err) {
        this.unavailable = true;
        this.lastError = `No se pudo arrancar Python: ${err.message}`
          + (looksLikeBrokenVenv(err.message) ? VENV_BROKEN_HINT : '');
        return false;
      }

      this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      this.proc.stderr.on('data', (chunk) => {
        // Logs del daemon Python — útil para diagnosticar carga del modelo
        const s = chunk.toString();
        if (s.trim()) console.log('[faceService-py]', s.trim().split('\n')[0]);
      });
      this.proc.on('exit', (code) => {
        console.warn(`[faceService] proceso Python terminó (code=${code})`);
        this._rejectAllPending(`python exited with code ${code}`);
        this.proc = null;
        this.ready = false;
        this.providers = [];
      });
      this.proc.on('error', (err) => {
        console.error('[faceService] error de proceso:', err.message);
        this._rejectAllPending(err.message);
      });

      // Warmup (NO ping) para confirmar que el modelo cargó de verdad. El ping
      // solo prueba que el proceso Python vive: con la carga perezosa del
      // modelo en el primer `detect`, un InsightFace roto (pesos ausentes, OOM
      // de VRAM compartiendo GPU con el VLM, onnxruntime mal instalado) dejaba
      // `ready = true`, el escaneo se declaraba NO degradado y cada archivo se
      // catalogaba con cero caras en silencio. Mismo criterio que el warmup de
      // CLIP. Damos 60s de margen (cold start real medido: ~3s).
      try {
        const warm = await this._sendCommand({ op: 'warmup' }, 60_000);
        if (warm && warm.loaded) {
          this.ready = true;
          this.providers = Array.isArray(warm.providers) ? warm.providers : [];
          console.log(`[faceService] InsightFace daemon listo (providers=${this.providers.join(', ') || 'desconocidos'})`);
          return true;
        }
        this.unavailable = true;
        this.lastError = 'warmup no confirmó la carga del modelo';
        return false;
      } catch (err) {
        this.unavailable = true;
        this.lastError = `init falló: ${err.message}`
          + (looksLikeBrokenVenv(err.message) ? VENV_BROKEN_HINT : '');
        return false;
      }
    })();

    const result = await this.starting;
    this.starting = null;
    return result;
  }

  /**
   * Envía un comando al daemon Python y devuelve el resultado parseado.
   * Las peticiones se serializan (cola FIFO) porque Python responde una
   * línea JSON por petición.
   */
  _sendCommand(req, timeoutMs = 90_000) {
    return new Promise((resolve, reject) => {
      const entry = { req, resolve, reject, timeoutMs };
      this.queue.push(entry);
      this._pump();
    });
  }

  _pump() {
    if (this.current) return;
    if (this.queue.length === 0) return;
    if (!this.proc || !this.proc.stdin.writable) {
      this._rejectAllPending('python no disponible');
      return;
    }
    const entry = this.queue.shift();
    entry.id = ++this.reqSeq;
    this.current = entry;
    entry.timer = setTimeout(() => {
      this.current = null;
      entry.reject(new Error(`timeout tras ${entry.timeoutMs}ms`));
      this._pump();
    }, entry.timeoutMs);
    try {
      // Adjuntar el id de correlacion. El daemon lo devuelve en su respuesta
      // para poder descartar respuestas tardias de peticiones ya expiradas.
      this.proc.stdin.write(JSON.stringify({ ...entry.req, id: entry.id }) + '\n');
    } catch (err) {
      clearTimeout(entry.timer);
      this.current = null;
      entry.reject(err);
      this._pump();
    }
  }

  _onStdout(chunk) {
    this.stdoutBuffer += chunk.toString();
    // Procesar líneas completas
    let nl;
    while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      this._handleResponseLine(line);
    }
  }

  _handleResponseLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // Línea no-JSON: no se puede correlacionar. Si hay petición en vuelo,
      // fallarla; si no, ignorar (ruido del daemon).
      if (this.current) {
        const entry = this.current;
        this.current = null;
        clearTimeout(entry.timer);
        entry.reject(new Error(`JSON parse: ${err.message} (line: ${line.slice(0, 200)})`));
        this._pump();
      } else {
        console.warn('[faceService] respuesta no-JSON sin petición:', line.slice(0, 100));
      }
      return;
    }

    // Correlación por id: descartar respuestas TARDÍAS de peticiones que ya
    // expiraron por timeout. Sin esto, la respuesta atrasada de A se emparejaría
    // posicionalmente con la siguiente petición B y le asignaría el resultado de
    // A — caras/identidad de la imagen equivocada, persistente y silencioso.
    const respId = parsed.id;
    if (!this.current || (respId !== undefined && this.current.id !== respId)) {
      console.warn(`[faceService] descartando respuesta huérfana (id=${respId})`);
      return;
    }

    const entry = this.current;
    this.current = null;
    clearTimeout(entry.timer);
    if (parsed.ok) {
      entry.resolve(parsed.result);
    } else {
      entry.reject(new Error(parsed.error || 'unknown error'));
    }
    this._pump();
  }

  _rejectAllPending(reason) {
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(new Error(reason));
      this.current = null;
    }
    while (this.queue.length > 0) {
      const e = this.queue.shift();
      e.reject(new Error(reason));
    }
  }

  /**
   * Detecta caras en una imagen. Devuelve array con bbox, embedding,
   * det_score, age, gender. Si el servicio no está disponible, devuelve
   * array vacío (no rompe el flujo de scan).
   */
  async detectFaces(imagePath) {
    const ok = await this.init();
    if (!ok) return [];
    try {
      const r = await this._sendCommand({ op: 'detect', path: imagePath });
      return Array.isArray(r?.faces) ? r.faces : [];
    } catch (err) {
      // Apuntarlo con su causa. Devolver [] a secas hacia indistinguible "no
      // hay caras en esta foto" de "el daemon se ha caido", y como el escaneo
      // salta lo ya catalogado, ese archivo quedaba congelado con 0 caras para
      // siempre. Ahora el fallo aparece en el resumen del job y en /api/health.
      fallos.record('detectar caras', err, { path: imagePath });
      return [];
    }
  }

  /**
   * Transcodifica una imagen (incl. HEIC, que sharp 0.32.x no decodifica) a un
   * JPEG orientado en `dstPath`, usando el daemon Python (pillow-heif/cv2). No
   * carga el modelo InsightFace. Lanza si el daemon no esta disponible.
   */
  async convertToJpeg(srcPath, dstPath) {
    const ok = await this.init();
    if (!ok) throw new Error(this.lastError || 'face service no disponible');
    return this._sendCommand({ op: 'convert', src: srcPath, dst: dstPath }, 60_000);
  }

  /**
   * Entrena los embeddings de una persona desde su carpeta de fotos.
   * Persiste el centroid + metadata en <personDir>/embeddings.json.
   */
  async trainPerson(personDir) {
    const ok = await this.init();
    if (!ok) throw new Error(this.lastError || 'face service no disponible');
    const result = await this._sendCommand({ op: 'train', dir: personDir }, 600_000); // 10 min para carpetas grandes
    // Persistir embeddings.json junto a las fotos
    if (result.ok && Array.isArray(result.centroid)) {
      const out = {
        person_id: result.person_id,
        version: 1,
        count: result.count,
        photos_used: result.photos_used || [],
        mean_similarity_to_centroid: result.mean_similarity_to_centroid,
        min_similarity_to_centroid: result.min_similarity_to_centroid,
        centroid: result.centroid,
        trained_at: new Date().toISOString(),
      };
      try {
        // backup: embeddings.json NO es regenerable sin re-correr InsightFace.
        await atomicWriteFile(path.join(personDir, 'embeddings.json'), JSON.stringify(out), { backup: true });
      } catch (err) {
        console.warn(`[faceService] no se pudo persistir embeddings: ${err.message}`);
      }
      // Refrescar el cache de ESTA persona con el centroide recien calculado.
      // Antes aqui se hacia un delete "se recarga la proxima vez", pero no hay
      // recarga perezosa: identifyFaces solo mira el cache, y este solo se
      // rellena entero en loadAllEmbeddings (inicio de escaneo, re-id o
      // promote). Resultado: entrenar a alguien —o subirle una foto, que
      // dispara auto-train— la dejaba SIN reconocer hasta la siguiente recarga
      // completa; con un escaneo en marcha, durante el resto del lote y en
      // silencio. Ya tenemos el centroide en memoria, asi que no hace falta
      // tocar disco para taparlo.
      if (result.centroid.length === 512) {
        this.embeddingsCache.set(result.person_id, {
          centroid: Float32Array.from(result.centroid),
          count: result.count || 0,
        });
      } else {
        // Centroide con forma inesperada: mejor sin entrada que con una mala.
        this.embeddingsCache.delete(result.person_id);
      }
    }
    return result;
  }

  /**
   * Carga los embeddings de todas las personas registradas en memoria.
   * Devuelve mapa person_id → { centroid: Float32Array(512), count }.
   *
   * Se llama una vez al inicio de cada escaneo. Tras cualquier cambio en
   * el registry (alta/baja, retrain), se invalida.
   */
  async loadAllEmbeddings(avatarsBase) {
    if (!avatarsBase) return this.embeddingsCache;
    const peopleDir = path.join(avatarsBase, 'people');
    let entries = [];
    try {
      entries = await fsp.readdir(peopleDir, { withFileTypes: true });
    } catch {
      return this.embeddingsCache;
    }
    this.embeddingsCache.clear();
    // Cargar guiado por el registry: una carpeta people/<id>/ cuyo id ya NO
    // esta registrado (borrado fallido en Windows, o promote a medias) es
    // huerfana y NO debe seguir matcheando — si no, reaparece como persona
    // fantasma en scans/re-id. Si el registry esta vacio (p.ej. mal
    // configurado), cargamos todo como antes para no romper el matching.
    const regIds = new Set(peopleRegistry.getState().personIds || []);
    const filterByRegistry = regIds.size > 0;
    let orphans = 0;
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const personId = ent.name;
      if (filterByRegistry && !regIds.has(personId)) {
        orphans++;
        continue;
      }
      const embFile = path.join(peopleDir, personId, 'embeddings.json');
      try {
        const raw = await fsp.readFile(embFile, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.centroid) && data.centroid.length === 512) {
          this.embeddingsCache.set(personId, {
            centroid: Float32Array.from(data.centroid),
            count: data.count || 0,
          });
        }
      } catch {
        // Sin embeddings.json: persona registrada pero no entrenada
      }
    }
    const orphanNote = orphans > 0 ? ` (${orphans} dir(s) huerfanos ignorados)` : '';
    console.log(`[faceService] embeddings cache: ${this.embeddingsCache.size} personas con entrenamiento${orphanNote}`);
    return this.embeddingsCache;
  }

  /**
   * Para cada cara detectada, busca la persona más cercana en el cache de
   * embeddings. Si la similitud coseno supera el umbral, retorna el
   * person_id correspondiente. Si no, deja la cara como desconocida.
   *
   * El resultado describe SOLO este matching: nunca hereda la identidad que
   * ya trajera la detección de entrada (ver `freshCopy`).
   *
   * @param {Array} detectedFaces - salida de detectFaces()
   * @param {number} threshold - similitud coseno mínima (default env o 0.5)
   * @returns {Array} mismas caras con `person_id` opcional + `similarity`, y
   *   `unverifiable: true` cuando no se ha podido evaluar (sin embedding usable
   *   o sin nadie entrenado) — que NO es lo mismo que "no es nadie".
   */
  identifyFaces(detectedFaces, threshold = DEFAULT_MATCH_THRESHOLD) {
    if (!Array.isArray(detectedFaces) || detectedFaces.length === 0) return [];

    // Copia SIN la identidad previa. Antes esto era un `{ ...face }` a secas y,
    // al identificar detecciones ya guardadas en un _pensadero.json, el
    // person_id viejo se colaba en el resultado: como abajo solo se ASIGNA
    // person_id (nunca se quita), una etiqueta obsoleta salia "confirmada" con
    // similitud 0.11. Consecuencias que esto arregla:
    //   - reidentifyEntry no podia limpiar etiquetas muertas (su rama de
    //     borrado era codigo muerto para toda deteccion ya etiquetada).
    //   - la verificacion del promote confirmaba lo que ya hubiera puesto.
    //   - el clusterer daba por conocida a gente ya borrada del registry.
    const freshCopy = (f) => {
      const c = { ...f };
      delete c.person_id;
      delete c.display_name;
      delete c.confidence;
      return c;
    };

    if (this.embeddingsCache.size === 0) {
      // Nadie entrenado: no se puede afirmar ni negar nada.
      return detectedFaces.map(f => ({ ...freshCopy(f), unverifiable: true }));
    }

    return detectedFaces.map(face => {
      // Aceptar tanto array crudo (recién detectada) como base64 (recuperada
      // de un _pensadero.json para re-identificación retroactiva).
      let emb = face.embedding;
      if (!emb && face.embedding_b64) emb = decodeEmbedding(face.embedding_b64);
      // Sin embedding usable no hay veredicto: marcarlo para que el llamador
      // conserve lo que hubiera en vez de borrarlo (no se puede recalcular sin
      // re-escanear la imagen).
      if (!emb || emb.length !== 512) return { ...freshCopy(face), unverifiable: true };

      // Embedding ya viene L2-normalizado de InsightFace (`normed_embedding`),
      // así que cosine = dot product.
      let bestId = null;
      let bestSim = -1;
      for (const [pid, data] of this.embeddingsCache.entries()) {
        let dot = 0;
        const c = data.centroid;
        for (let i = 0; i < 512; i++) dot += emb[i] * c[i];
        if (dot > bestSim) {
          bestSim = dot;
          bestId = pid;
        }
      }

      const out = freshCopy(face);
      out.similarity = bestSim;
      if (bestId && bestSim >= threshold) {
        out.person_id = bestId;
      }
      return out;
    });
  }

  shutdown() {
    if (this.proc) {
      try { this.proc.stdin.write(JSON.stringify({ op: 'exit' }) + '\n'); } catch {}
      try { this.proc.kill(); } catch {}
      this.proc = null;
      this.ready = false;
    }
  }

  getStatus() {
    return {
      ready: this.ready,
      unavailable: this.unavailable,
      lastError: this.lastError,
      threshold: DEFAULT_MATCH_THRESHOLD,
      trainedPersons: this.embeddingsCache.size,
      // Providers reales del modelo ya cargado. Sirve para ver en /api/health
      // si las caras cayeron a CPU (VRAM ocupada por el VLM) sin darse cuenta.
      providers: this.providers,
    };
  }
}

// Singleton
let _instance = null;
function getInstance() {
  if (!_instance) _instance = new FaceService();
  return _instance;
}

module.exports = { FaceService, getInstance, encodeEmbedding, decodeEmbedding };
