/**
 * CLIP Service — Pensadero NODO
 *
 * Wrapper Node sobre el daemon Python `clip_extractor.py` (M-CLIP).
 * Mantiene un proceso Python persistente en stream mode para no recargar
 * el modelo en cada peticion (cold start ~15-20s).
 *
 * API:
 *   await clipService.init()                  → arranca el daemon
 *   await clipService.embedImage(filePath)    → Float32Array(512) L2-normalizado
 *   await clipService.embedText(text)         → idem
 *   clipService.shutdown()                    → cierra el daemon
 *   clipService.getStatus()                   → {ready, unavailable, lastError}
 *
 * Inicio LAZY: el daemon solo arranca cuando alguien pide un embedding.
 * Asi reiniciar el backend no carga 2.5 GB en VRAM sin necesidad.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PYTHON_DIR = path.join(__dirname, '..', 'python');
const PYTHON_EXE_WIN = path.join(PYTHON_DIR, '.venv', 'Scripts', 'python.exe');
const PYTHON_EXE_NIX = path.join(PYTHON_DIR, '.venv', 'bin', 'python');
const SCRIPT_PATH = path.join(PYTHON_DIR, 'clip_extractor.py');

// SigLIP-2 base usa 768 dims (cambio desde CLIP base ViT-B-32 que era 512).
// Si cambias de modelo en CLIP_MODEL env var, actualiza esta constante.
const EMBEDDING_DIM = 768;
const COLD_START_TIMEOUT_MS = 120_000; // 2 min para cargar XLM-RoBERTa-Large
const PER_REQUEST_TIMEOUT_MS = 60_000;

class ClipService {
  constructor() {
    this.proc = null;
    this.queue = [];
    this.current = null;
    this.stdoutBuffer = '';
    this.starting = null;
    this.ready = false;
    this.unavailable = false;
    this.lastError = null;
  }

  /**
   * Arranca el daemon Python si no esta vivo. Idempotente.
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
        this.lastError = 'Python venv no encontrado en backend/python/.venv';
        console.warn('[clipService]', this.lastError);
        return false;
      }
      if (!fs.existsSync(SCRIPT_PATH)) {
        this.unavailable = true;
        this.lastError = `Script no encontrado: ${SCRIPT_PATH}`;
        console.warn('[clipService]', this.lastError);
        return false;
      }

      try {
        this.proc = spawn(pythonExe, [SCRIPT_PATH, '--stream'], {
          cwd: PYTHON_DIR,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
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
        const s = chunk.toString();
        if (s.trim()) console.log('[clipService-py]', s.trim().split('\n').pop());
      });
      this.proc.on('exit', (code) => {
        console.warn(`[clipService] proceso Python terminó (code=${code})`);
        this._rejectAllPending(`python exited with code ${code}`);
        this.proc = null;
        this.ready = false;
      });
      this.proc.on('error', (err) => {
        console.error('[clipService] error de proceso:', err.message);
        this._rejectAllPending(err.message);
      });

      try {
        const pong = await this._sendCommand({ op: 'ping' }, COLD_START_TIMEOUT_MS);
        if (pong === 'pong') {
          this.ready = true;
          console.log('[clipService] M-CLIP daemon listo');
          return true;
        }
        this.unavailable = true;
        this.lastError = 'ping no devolvio pong';
        return false;
      } catch (err) {
        this.unavailable = true;
        this.lastError = `init fallo: ${err.message}`;
        return false;
      }
    })();

    const result = await this.starting;
    this.starting = null;
    return result;
  }

  _sendCommand(req, timeoutMs = PER_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      this.queue.push({ req, resolve, reject, timeoutMs });
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
      console.warn('[clipService] respuesta sin peticion pendiente:', line.slice(0, 100));
      return;
    }
    const entry = this.current;
    this.current = null;
    clearTimeout(entry.timer);

    try {
      const parsed = JSON.parse(line);
      if (parsed.ok) entry.resolve(parsed.result);
      else entry.reject(new Error(parsed.error || 'unknown error'));
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
   * Decodifica base64 → Float32Array(512). Si la longitud es invalida, null.
   */
  _decode(b64) {
    if (typeof b64 !== 'string' || !b64) return null;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== EMBEDDING_DIM * 4) return null;
    return new Float32Array(buf.buffer, buf.byteOffset, EMBEDDING_DIM);
  }

  /**
   * Calcula el embedding de una imagen (path local). Devuelve Float32Array(512)
   * L2-normalizado para comparacion via dot product.
   */
  async embedImage(filePath) {
    const ok = await this.init();
    if (!ok) return null;
    try {
      const r = await this._sendCommand({ op: 'embed_image', path: filePath });
      return this._decode(r && r.embedding_b64);
    } catch (err) {
      console.warn(`[clipService] embedImage fallo (${filePath}):`, err.message);
      return null;
    }
  }

  /**
   * Calcula el embedding de un texto en español/ingles/multilingue.
   * Devuelve Float32Array(512) L2-normalizado.
   */
  async embedText(text) {
    const ok = await this.init();
    if (!ok) return null;
    try {
      const r = await this._sendCommand({ op: 'embed_text', text });
      return this._decode(r && r.embedding_b64);
    } catch (err) {
      console.warn(`[clipService] embedText fallo:`, err.message);
      return null;
    }
  }

  /**
   * Convierte un Float32Array(512) a base64 string para persistir en sidecars.
   */
  encodeEmbedding(arr) {
    if (!arr || arr.length !== EMBEDDING_DIM) return null;
    const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
  }

  decodeEmbedding(b64) {
    return this._decode(b64);
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
      embeddingDim: EMBEDDING_DIM,
    };
  }
}

let _instance = null;
function getInstance() {
  if (!_instance) _instance = new ClipService();
  return _instance;
}

module.exports = { ClipService, getInstance, EMBEDDING_DIM };
