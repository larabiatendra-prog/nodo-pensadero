/**
 * Face Service — Pensadero NODO
 *
 * Wrapper Node sobre el script Python `face_detector.py` (InsightFace).
 * Mantiene un proceso Python persistente en "modo stream" para no recargar
 * el modelo en cada imagen (carga ~3-5s).
 *
 * API:
 *   await faceService.init()                  → arranca el daemon Python
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

const PYTHON_DIR = path.join(__dirname, '..', 'python');
const PYTHON_EXE_WIN = path.join(PYTHON_DIR, '.venv', 'Scripts', 'python.exe');
const PYTHON_EXE_NIX = path.join(PYTHON_DIR, '.venv', 'bin', 'python');
const SCRIPT_PATH = path.join(PYTHON_DIR, 'face_detector.py');

// Umbral de coincidencia coseno por defecto. Conservador para minimizar
// falsos positivos. InsightFace ArcFace: same person típicamente >0.5,
// different person <0.3.
const DEFAULT_MATCH_THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.5');

class FaceService {
  constructor() {
    this.proc = null;
    this.queue = [];           // peticiones pendientes
    this.current = null;       // promesa actual en vuelo
    this.stdoutBuffer = '';
    this.starting = null;      // promesa de inicialización en curso
    this.ready = false;
    this.unavailable = false;
    this.lastError = null;
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
        this.lastError = `No se pudo arrancar Python: ${err.message}`;
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
      });
      this.proc.on('error', (err) => {
        console.error('[faceService] error de proceso:', err.message);
        this._rejectAllPending(err.message);
      });

      // Ping para confirmar que el modelo cargó. Damos 60s de margen (cold
      // start de InsightFace puede tardar varios segundos).
      try {
        const pong = await this._sendCommand({ op: 'ping' }, 60_000);
        if (pong && pong === 'pong') {
          this.ready = true;
          console.log('[faceService] InsightFace daemon listo');
          return true;
        }
        this.unavailable = true;
        this.lastError = 'ping no devolvió pong';
        return false;
      } catch (err) {
        this.unavailable = true;
        this.lastError = `init falló: ${err.message}`;
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
    this.current = entry;
    entry.timer = setTimeout(() => {
      this.current = null;
      entry.reject(new Error(`timeout tras ${entry.timeoutMs}ms`));
      this._pump();
    }, entry.timeoutMs);
    try {
      this.proc.stdin.write(JSON.stringify(entry.req) + '\n');
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
    if (!this.current) {
      console.warn('[faceService] respuesta sin petición pendiente:', line.slice(0, 100));
      return;
    }
    const entry = this.current;
    this.current = null;
    clearTimeout(entry.timer);

    try {
      const parsed = JSON.parse(line);
      if (parsed.ok) {
        entry.resolve(parsed.result);
      } else {
        entry.reject(new Error(parsed.error || 'unknown error'));
      }
    } catch (err) {
      entry.reject(new Error(`JSON parse: ${err.message} (line: ${line.slice(0, 200)})`));
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
      console.warn(`[faceService] detect falló (${imagePath}):`, err.message);
      return [];
    }
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
        await fsp.writeFile(path.join(personDir, 'embeddings.json'), JSON.stringify(out));
      } catch (err) {
        console.warn(`[faceService] no se pudo persistir embeddings: ${err.message}`);
      }
      // Invalidar cache para esta persona — se recarga la próxima vez
      this.embeddingsCache.delete(result.person_id);
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
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const personId = ent.name;
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
    console.log(`[faceService] embeddings cache: ${this.embeddingsCache.size} personas con entrenamiento`);
    return this.embeddingsCache;
  }

  /**
   * Para cada cara detectada, busca la persona más cercana en el cache de
   * embeddings. Si la similitud coseno supera el umbral, retorna el
   * person_id correspondiente. Si no, deja la cara como desconocida.
   *
   * @param {Array} detectedFaces - salida de detectFaces()
   * @param {number} threshold - similitud coseno mínima (default env o 0.5)
   * @returns {Array} mismas caras con campo `person_id` opcional + `similarity`
   */
  identifyFaces(detectedFaces, threshold = DEFAULT_MATCH_THRESHOLD) {
    if (!Array.isArray(detectedFaces) || detectedFaces.length === 0) return [];
    if (this.embeddingsCache.size === 0) {
      // No hay personas entrenadas: devolver caras tal cual sin person_id
      return detectedFaces.map(f => ({ ...f }));
    }

    return detectedFaces.map(face => {
      const emb = face.embedding;
      if (!Array.isArray(emb) || emb.length !== 512) return { ...face };

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

      const out = { ...face };
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
    };
  }
}

// Singleton
let _instance = null;
function getInstance() {
  if (!_instance) _instance = new FaceService();
  return _instance;
}

module.exports = { FaceService, getInstance };
