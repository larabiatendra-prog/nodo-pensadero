/**
 * failureReason — por que ha fallado algo, en cristiano (Pensadero)
 *
 * Existe por el incidente del 09/09/2026: el disco F: se lleno y el backend
 * siguio como si nada. 9.460 escrituras fallaron (9.378 de un escaneo, 54 de
 * un re-id, 22 de un promote), cada una con su `console.warn` que no leyo
 * nadie. El escaneo dijo "completado", el promote dijo "persona guardada", y
 * el usuario descubrio el problema dias despues al ver que una persona recien
 * creada no aparecia en ningun archivo.
 *
 * Dos funciones:
 *
 *  1. explainFailure(err, ctx) — traduce un Error a { code, reason, hint }.
 *     Las causas van ordenadas de MAS a MENOS probable en este entorno (un PC
 *     de escritorio con discos externos), y al final hay una red que nunca
 *     deja un fallo sin explicacion: peor caso, "no pude X" + el mensaje crudo.
 *
 *  2. record(operacion, err, opts) — ademas de traducir, lo APUNTA. Los fallos
 *     se agregan por (operacion + causa + raiz), asi que 9.378 errores iguales
 *     son UNA incidencia con `veces: 9378` en vez de 9.378 lineas de log. Lo
 *     consumen /api/health, los payloads de los jobs y Doctor.
 *
 * Regla de uso: si escribes un `catch`, o relanzas, o llamas a record(). No
 * existe la tercera opcion de tragarselo.
 */

const fs = require('fs');
const path = require('path');

// ── Espacio libre, para que el aviso de disco lleno sea concreto ────────────
// Best-effort: si statfs no esta disponible o falla, se omite el dato en vez
// de romper el propio manejo de errores.
function freeBytes(p) {
  try {
    if (typeof fs.statfsSync !== 'function' || !p) return null;
    const st = fs.statfsSync(rootOf(p) || p);
    return st.bsize * st.bavail;
  } catch {
    return null;
  }
}

// Raiz del volumen: "F:\- Dani\x\_pensadero.json" → "F:\"
function rootOf(p) {
  if (!p || typeof p !== 'string') return null;
  const parsed = path.parse(path.resolve(p));
  return parsed.root || null;
}

function humanBytes(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Traduce un error a una causa entendible.
 *
 * @param {Error|any} err
 * @param {{ operacion?: string, path?: string }} [ctx]
 * @returns {{ code, reason, hint, raw, path, disco }}
 */
function explainFailure(err, ctx = {}) {
  const raw = (err && (err.message || String(err))) || 'error desconocido';
  const sys = (err && err.code) || null;
  const p = ctx.path || (err && (err.path || err.dest)) || null;
  const disco = rootOf(p);
  const enDisco = disco ? ` en ${disco}` : '';
  const out = (code, reason, hint) => ({ code, reason, hint, raw, path: p || null, disco });

  // ── 1. Disco lleno. Lo mas probable con bibliotecas en discos externos ────
  if (sys === 'ENOSPC') {
    const libre = freeBytes(p);
    const cuanto = libre != null ? ` Quedan ${humanBytes(libre)} libres.` : '';
    return out('DISCO_LLENO',
      `No hay espacio${enDisco}.${cuanto}`,
      `Libera espacio${disco ? ` en ${disco}` : ''} y repite la operacion. Hasta entonces NADA se guarda en ese disco.`);
  }

  // ── 2. Disco desconectado / ruta desaparecida ─────────────────────────────
  if (sys === 'ENOENT') {
    return out('NO_EXISTE',
      `La ruta ya no existe${p ? `: ${p}` : ''}.`,
      disco
        ? `¿Se ha desconectado ${disco}? Comprueba que la unidad esta enchufada y con la misma letra.`
        : 'Comprueba que el archivo o la carpeta siguen ahi.');
  }
  if (sys === 'ENODEV' || sys === 'ENXIO' || sys === 'EUNATCH') {
    return out('UNIDAD_CAIDA',
      `La unidad${enDisco} no responde.`,
      'Vuelve a conectar el disco (o la unidad de red) y reintenta.');
  }

  // ── 3. Permisos y solo-lectura ────────────────────────────────────────────
  if (sys === 'EACCES' || sys === 'EPERM') {
    return out('SIN_PERMISO',
      `Sin permiso para escribir${p ? ` en ${p}` : enDisco}.`,
      'Puede ser el antivirus, un disco protegido contra escritura, o el archivo abierto en otro programa.');
  }
  if (sys === 'EROFS') {
    return out('SOLO_LECTURA',
      `El disco${enDisco} esta en solo lectura.`,
      'Quita la proteccion de escritura de la unidad.');
  }

  // ── 4. Archivo ocupado ────────────────────────────────────────────────────
  if (sys === 'EBUSY' || sys === 'ETXTBSY') {
    return out('OCUPADO',
      `El archivo esta en uso por otro programa${p ? `: ${p}` : ''}.`,
      'Cierra el programa que lo tiene abierto (un editor, el explorador, un backup) y reintenta.');
  }

  // ── 5. Errores fisicos de E/S ─────────────────────────────────────────────
  if (sys === 'EIO' || sys === 'UNKNOWN') {
    return out('ERROR_DISCO',
      `Error de lectura/escritura${enDisco}.`,
      'Cable, unidad de red caida o disco con sectores dañados. Revisa la unidad antes de insistir.');
  }

  // ── 6. Limites del sistema ────────────────────────────────────────────────
  if (sys === 'EMFILE' || sys === 'ENFILE') {
    return out('DEMASIADOS_ARCHIVOS',
      'Demasiados archivos abiertos a la vez.',
      'Reinicia el backend; si se repite, baja la concurrencia del escaneo.');
  }
  if (sys === 'ENAMETOOLONG') {
    return out('RUTA_LARGA',
      `La ruta es demasiado larga${p ? `: ${p}` : ''}.`,
      'Acorta el nombre de las carpetas o activa las rutas largas de Windows.');
  }

  // ── 7. Datos corruptos ────────────────────────────────────────────────────
  if (err instanceof SyntaxError || /JSON|Unexpected token|no parsea/i.test(raw)) {
    return out('JSON_CORRUPTO',
      `Un archivo de datos no se puede leer${p ? `: ${p}` : ''} (JSON invalido).`,
      'Se pone en cuarentena como .corrupt-<fecha>. Si tiene .bak al lado, ese es el bueno.');
  }

  // ── 8. Se ha quedado sin tiempo ───────────────────────────────────────────
  if (sys === 'ETIMEDOUT' || sys === 'ABORT_ERR' || /timeout|timed out|abort/i.test(raw)) {
    return out('TIMEOUT',
      `La operacion tardo demasiado y se corto${ctx.operacion ? ` (${ctx.operacion})` : ''}.`,
      'Suele ser el modelo cargando en frio o un archivo enorme. Reintenta; si se repite, mira la GPU.');
  }

  // ── 9. Memoria ────────────────────────────────────────────────────────────
  if (/heap out of memory|allocation failed|ENOMEM/i.test(raw) || sys === 'ENOMEM') {
    return out('SIN_MEMORIA',
      'El proceso se quedo sin memoria.',
      'El backend arranca con 8 GB de limite; si se repite, reduce el lote o mira el informe en backend/logs.');
  }

  // ── 10. Piezas de IA que no levantan ──────────────────────────────────────
  if (/venv|pyvenv|No Python at|python exited|python no disponible/i.test(raw)) {
    return out('PYTHON_ROTO',
      'El entorno Python no arranca.',
      'Recrea backend/python/.venv con Pensadero_Install.bat (suele pasar al copiar el venv de otro PC).');
  }
  if (/insightface|onnxruntime|CUDA|cudnn|cublas/i.test(raw)) {
    return out('MODELO_CARAS',
      'No se pudo cargar el modelo de reconocimiento facial.',
      'Puede ser VRAM ocupada por el VLM (prueba FACE_PROVIDER=cpu) o los pesos de buffalo_l ausentes.');
  }
  if (sys === 'ECONNREFUSED' || /11434|ollama/i.test(raw)) {
    return out('OLLAMA_CAIDO',
      'Ollama no responde.',
      'Arrancalo con: ollama serve');
  }

  // ── 11. Red de seguridad: nunca devolvemos un fallo sin explicacion ───────
  // Aqui llega lo que no hemos previsto. Mejor "no pude X, esto es lo que dijo
  // el sistema" que un silencio o un codigo suelto.
  return out('DESCONOCIDO',
    `No se pudo ${ctx.operacion || 'completar la operacion'}${p ? ` (${p})` : ''}.`,
    `Motivo original: ${sys ? `[${sys}] ` : ''}${raw}`);
}

// ── Registro de incidencias ────────────────────────────────────────────────
// Agregado por (operacion + causa + disco): un fallo repetido 9.378 veces es
// UNA incidencia con su contador, no 9.378 lineas.

const MAX_INCIDENCIAS = 200;
const incidencias = new Map();
let seq = 0;

/**
 * Apunta un fallo y devuelve su explicacion.
 *
 * @param {string} operacion - que se estaba intentando, en cristiano
 *   ("escribir el catalogo", "detectar caras", "entrenar persona")
 * @param {Error} err
 * @param {{ path?: string, silencioso?: boolean }} [opts]
 */
function record(operacion, err, opts = {}) {
  const exp = explainFailure(err, { operacion, path: opts.path });
  const key = `${operacion}|${exp.code}|${exp.disco || '-'}`;
  const ahora = Date.now();
  const prev = incidencias.get(key);
  seq++;

  if (prev) {
    prev.veces++;
    prev.ultima = ahora;
    prev.ultimoPath = exp.path || prev.ultimoPath;
    prev.seq = seq;
  } else {
    // Tope: si se desborda, se tira la incidencia mas antigua. Un fallo nuevo
    // siempre entra — es el que aun no se ha visto.
    if (incidencias.size >= MAX_INCIDENCIAS) {
      const masVieja = [...incidencias.entries()].sort((a, b) => a[1].ultima - b[1].ultima)[0];
      if (masVieja) incidencias.delete(masVieja[0]);
    }
    incidencias.set(key, {
      operacion,
      code: exp.code,
      reason: exp.reason,
      hint: exp.hint,
      disco: exp.disco,
      ultimoPath: exp.path,
      raw: exp.raw,
      veces: 1,
      primera: ahora,
      ultima: ahora,
      seq,
    });
  }

  if (!opts.silencioso) {
    console.warn(`[fallo] ${operacion}: ${exp.reason} ${exp.hint ? `→ ${exp.hint}` : ''}`);
  }
  return exp;
}

/** Marca del contador, para preguntar luego "que ha fallado desde aqui". */
function mark() { return seq; }

/**
 * Incidencias registradas. Con `since` (una marca de mark()) devuelve solo las
 * tocadas despues — es lo que usan los jobs para contar SUS fallos.
 */
function list({ since = 0, limit = 50 } = {}) {
  return [...incidencias.values()]
    .filter(i => i.seq > since)
    .sort((a, b) => b.ultima - a.ultima)
    .slice(0, limit)
    .map(i => ({ ...i }));
}

/** Resumen corto para /api/health y para los payloads de los jobs. */
function summary({ since = 0 } = {}) {
  const items = list({ since, limit: MAX_INCIDENCIAS });
  const total = items.reduce((a, i) => a + i.veces, 0);
  const porCausa = {};
  for (const i of items) porCausa[i.code] = (porCausa[i.code] || 0) + i.veces;
  return {
    ok: items.length === 0,
    total,                       // nº de fallos individuales
    distintas: items.length,     // nº de causas distintas
    porCausa,
    // La peor: la que mas veces ha pasado. Es la que hay que contar primero.
    principal: items.length
      ? items.slice().sort((a, b) => b.veces - a.veces)[0]
      : null,
    items,
  };
}

function clear() { incidencias.clear(); }

module.exports = { explainFailure, record, mark, list, summary, clear };
