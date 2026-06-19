/**
 * Camera Motion Service — Pensadero NODO
 *
 * Wrapper Node sobre `python/camera_motion.py`. Detecta el movimiento de camara
 * de un clip por optical-flow en CPU (sin GPU, sin modelo de IA). Sustituye al
 * VLM en el campo `camera_movement`, que un modelo de vision hace mal (es ciego
 * al zoom lento y a paneos sutiles: los marca "fijo").
 *
 * Daemon persistente en modo stream para no reimportar cv2/numpy (~0.5-1s) en
 * cada clip durante un batch. Mismo protocolo que faceService (linea JSON por
 * peticion, id de correlacion). Sin modelo que cargar, el arranque es casi
 * instantaneo.
 *
 * API:
 *   await cameraMotionService.init()           → arranca el daemon
 *   await cameraMotionService.analyze(clipPath) → { movement, scene_changes, ... } | null
 *   cameraMotionService.shutdown()             → cierra el daemon
 *
 * Si el servicio no esta disponible (venv roto, sin Python), analyze() devuelve
 * null y el orquestador conserva el camera_movement que diera el VLM (degradado
 * pero no roto).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PYTHON_DIR = path.join(__dirname, '..', 'python');
const PYTHON_EXE_WIN = path.join(PYTHON_DIR, '.venv', 'Scripts', 'python.exe');
const PYTHON_EXE_NIX = path.join(PYTHON_DIR, '.venv', 'bin', 'python');
const SCRIPT_PATH = path.join(PYTHON_DIR, 'camera_motion.py');

// Mismo diagnostico que faceService: venv copiado entre PCs apunta a un Python
// que no existe en destino.
const VENV_BROKEN_HINT = ' — el venv puede estar roto o copiado de otro PC. '
  + 'Recrea backend/python/.venv ejecutando Pensadero_Install.bat.';

function looksLikeBrokenVenv(msg) {
  return /exited with code|No Python at|cannot find|no such file|ENOENT/i.test(msg || '');
}

class CameraMotionService {
  constructor() {
    this.proc = null;
    this.queue = [];
    this.current = null;
    this.reqSeq = 0;
    this.stdoutBuffer = '';
    this.starting = null;
    this.ready = false;
    this.unavailable = false;
    this.lastError = null;
  }

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
        console.warn('[cameraMotion]', this.lastError);
        return false;
      }
      if (!fs.existsSync(SCRIPT_PATH)) {
        this.unavailable = true;
        this.lastError = `Script no encontrado: ${SCRIPT_PATH}`;
        console.warn('[cameraMotion]', this.lastError);
        return false;
      }

      try {
        this.proc = spawn(pythonExe, [SCRIPT_PATH, '--stream'], {
          cwd: PYTHON_DIR,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
      } catch (err) {
        this.unavailable = true;
        this.lastError = `No se pudo arrancar Python: ${err.message}`
          + (looksLikeBrokenVenv(err.message) ? VENV_BROKEN_HINT : '');
        return false;
      }

      this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      this.proc.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        if (s.trim()) console.log('[cameraMotion-py]', s.trim().split('\n')[0]);
      });
      this.proc.on('exit', (code) => {
        console.warn(`[cameraMotion] proceso Python terminó (code=${code})`);
        this._rejectAllPending(`python exited with code ${code}`);
        this.proc = null;
        this.ready = false;
      });
      this.proc.on('error', (err) => {
        console.error('[cameraMotion] error de proceso:', err.message);
        this._rejectAllPending(err.message);
      });

      try {
        const pong = await this._sendCommand({ op: 'ping' }, 30_000);
        if (pong === 'pong') {
          this.ready = true;
          console.log('[cameraMotion] daemon optical-flow listo');
          return true;
        }
        this.unavailable = true;
        this.lastError = 'ping no devolvió pong';
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

  _sendCommand(req, timeoutMs = 120_000) {
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
    entry.id = ++this.reqSeq;
    this.current = entry;
    entry.timer = setTimeout(() => {
      this.current = null;
      entry.reject(new Error(`timeout tras ${entry.timeoutMs}ms`));
      this._pump();
    }, entry.timeoutMs);
    try {
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
    let nl;
    while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line) this._handleResponseLine(line);
    }
  }

  _handleResponseLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      if (this.current) {
        const entry = this.current;
        this.current = null;
        clearTimeout(entry.timer);
        entry.reject(new Error(`JSON parse: ${err.message} (line: ${line.slice(0, 200)})`));
        this._pump();
      } else {
        console.warn('[cameraMotion] respuesta no-JSON sin petición:', line.slice(0, 100));
      }
      return;
    }
    const respId = parsed.id;
    if (!this.current || (respId !== undefined && this.current.id !== respId)) {
      console.warn(`[cameraMotion] descartando respuesta huérfana (id=${respId})`);
      return;
    }
    const entry = this.current;
    this.current = null;
    clearTimeout(entry.timer);
    if (parsed.ok) entry.resolve(parsed.result);
    else entry.reject(new Error(parsed.error || 'unknown error'));
    this._pump();
  }

  _rejectAllPending(reason) {
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(new Error(reason));
      this.current = null;
    }
    while (this.queue.length > 0) {
      this.queue.shift().reject(new Error(reason));
    }
  }

  /**
   * Analiza el movimiento de camara de un clip. Devuelve el objeto con
   * { movement, movements, scene_changes, zoom, pan_x, pan_y, jitter,
   *   cuts, confidence, frames_analyzed } o null si el servicio no esta
   *   disponible / falla (el caller conserva el valor del VLM).
   */
  async analyze(clipPath) {
    const ok = await this.init();
    if (!ok) return null;
    try {
      return await this._sendCommand({ op: 'analyze', path: clipPath });
    } catch (err) {
      console.warn(`[cameraMotion] analyze falló (${clipPath}):`, err.message);
      return null;
    }
  }

  shutdown() {
    if (this.proc) {
      try { this.proc.stdin.write(JSON.stringify({ op: 'exit' }) + '\n'); } catch {}
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
    this.ready = false;
  }
}

let _instance = null;
function getInstance() {
  if (!_instance) _instance = new CameraMotionService();
  return _instance;
}

module.exports = { CameraMotionService, getInstance };
