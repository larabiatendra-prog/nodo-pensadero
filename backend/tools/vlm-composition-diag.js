#!/usr/bin/env node
/**
 * Diagnostico de fiabilidad de los campos de COMPOSICION del VLM.
 *
 * Mide cuanto se puede confiar en shot_type / camera_angle / camera_movement /
 * people_framing SIN necesitar etiquetas verdad: via AUTO-CONSISTENCIA. Corre
 * el mismo archivo K veces a la temperatura real (0.2) y mira si cada campo
 * devuelve siempre lo mismo. Un campo que baila entre pasadas identicas es
 * ruido, no senal: el modelo esta adivinando. Un campo estable es al menos
 * PRECISO (que ademas ACIERTE lo juzgas tu mirando el clip junto al filename).
 *
 * Pensado para correr en NODO contra clips/fotos donde TU conoces la verdad.
 *
 * Uso:
 *   node tools/vlm-composition-diag.js <carpeta-o-archivo> [opciones]
 *
 * Opciones:
 *   --repeats N     pasadas por archivo (default 3). Mas = mejor medida, mas coste.
 *   --model NOMBRE  fuerza modelo VLM (default: VLM_MODEL del .env o gemma4:12b).
 *   --max N         tope de archivos a procesar (default 12).
 *   --json RUTA     vuelca resultados crudos a un JSON (default: tools/vlm-diag-<ts>.json).
 *
 * Ejemplo:
 *   node tools/vlm-composition-diag.js "K:\\Brutos\\boda" --repeats 4
 */

const fs = require('fs');
const path = require('path');
const { VisualScanService } = require('../visualScanService');

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif', '.tiff', '.tif']);
const VID_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg', '.wmv', '.flv']);

// Campos de composicion bajo escrutinio. Orden = orden de columnas.
const FIELDS = ['shot_type', 'camera_angle', 'camera_movement', 'people_framing'];

function parseArgs(argv) {
  const out = { target: null, repeats: 3, model: null, max: 12, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repeats') out.repeats = parseInt(argv[++i], 10);
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--max') out.max = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = argv[++i];
    else if (!a.startsWith('--') && !out.target) out.target = a;
  }
  return out;
}

function collectFiles(target, max) {
  const st = fs.statSync(target);
  let files = [];
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      const full = path.join(target, name);
      try { if (fs.statSync(full).isFile()) files.push(full); } catch {}
    }
  } else {
    files = [target];
  }
  files = files.filter(f => {
    const e = path.extname(f).toLowerCase();
    return IMG_EXTS.has(e) || VID_EXTS.has(e);
  });
  return files.slice(0, max);
}

function kindOf(file) {
  const e = path.extname(file).toLowerCase();
  return VID_EXTS.has(e) ? 'video' : 'image';
}

// Estabilidad de un campo sobre K valores: fraccion que coincide con la moda.
// Nulls cuentan como un valor mas ("null" es una respuesta del modelo). 1.0 =
// siempre lo mismo; ~1/K = todas distintas (ruido puro).
function stability(values) {
  const counts = new Map();
  for (const v of values) {
    const key = v == null ? '∅' : String(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let modeKey = null, modeCount = 0;
  for (const [k, c] of counts) if (c > modeCount) { modeKey = k; modeCount = c; }
  return { mode: modeKey, frac: modeCount / values.length, dist: Object.fromEntries(counts) };
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.target) {
    console.error('Falta la carpeta o archivo. Uso: node tools/vlm-composition-diag.js <ruta> [--repeats N]');
    process.exit(1);
  }
  if (opts.model) process.env.VLM_MODEL = opts.model;

  const files = collectFiles(opts.target, opts.max);
  if (files.length === 0) {
    console.error('No hay imagenes ni videos en:', opts.target);
    process.exit(1);
  }

  const svc = new VisualScanService();
  console.log(`\nModelo VLM: ${svc.model}   |   pasadas/archivo: ${opts.repeats}   |   archivos: ${files.length}\n`);
  console.log('Auto-consistencia: corre cada archivo K veces; si un campo cambia entre');
  console.log('pasadas identicas, el modelo adivina (no fiable). frac=1.0 estable, ~1/K azar.\n');

  const results = []; // [{ file, kind, runs:[{...fields}], frameGapSec }]

  for (const file of files) {
    const kind = kindOf(file);
    const runs = [];
    let frameGapSec = null;
    process.stdout.write(`  escaneando ${path.basename(file)} (${kind}) `);
    for (let r = 0; r < opts.repeats; r++) {
      try {
        let entry;
        if (kind === 'video') {
          const res = await svc.scanVideo(file, {});
          entry = res.entry;
          // Distancia temporal entre frames muestreados: evidencia directa de si
          // los frames estan lo bastante juntos para leer movimiento de camara.
          if (Array.isArray(res.frames) && res.frames.length > 1) {
            const ts = res.frames.map(f => f.timestamp).sort((a, b) => a - b);
            frameGapSec = (ts[ts.length - 1] - ts[0]) / (ts.length - 1);
          }
          if (res.cleanup) await res.cleanup();
        } else {
          entry = await svc.scanImage(file, {});
        }
        const comp = entry.composition || {};
        runs.push({
          shot_type: comp.shot_type ?? null,
          camera_angle: comp.camera_angle ?? null,
          camera_movement: comp.camera_movement ?? null,
          people_framing: comp.people_framing ?? null,
        });
        process.stdout.write('.');
      } catch (err) {
        runs.push({ error: err.message });
        process.stdout.write('x');
      }
    }
    process.stdout.write('\n');
    results.push({ file, kind, runs, frameGapSec });
  }

  // ---- Tabla por archivo ----
  console.log('\n=== POR ARCHIVO (moda + estabilidad) ===\n');
  console.log(pad('archivo', 28) + FIELDS.map(f => pad(f, 22)).join('') + 'gap');
  for (const row of results) {
    const cells = FIELDS.map(field => {
      const vals = row.runs.filter(r => !r.error).map(r => r[field]);
      if (vals.length === 0) return pad('ERROR', 22);
      const s = stability(vals);
      return pad(`${s.mode} (${(s.frac * 100).toFixed(0)}%)`, 22);
    });
    const gap = row.kind === 'video' && row.frameGapSec != null ? `${row.frameGapSec.toFixed(1)}s` : '-';
    console.log(pad(path.basename(row.file), 28) + cells.join('') + gap);
  }

  // ---- Resumen global por campo ----
  console.log('\n=== FIABILIDAD GLOBAL POR CAMPO ===\n');
  console.log('Estabilidad media = cuanto coincide consigo mismo entre pasadas. Baja = ruido.\n');
  for (const field of FIELDS) {
    // Solo videos para camera_movement (en fotos siempre es null por diseno).
    const rows = field === 'camera_movement'
      ? results.filter(r => r.kind === 'video')
      : results;
    const stabs = [];
    const valueDist = new Map();
    for (const row of rows) {
      const vals = row.runs.filter(r => !r.error).map(r => r[field]);
      if (vals.length === 0) continue;
      const s = stability(vals);
      stabs.push(s.frac);
      const key = s.mode;
      valueDist.set(key, (valueDist.get(key) || 0) + 1);
    }
    if (stabs.length === 0) { console.log(`${pad(field, 18)} sin datos`); continue; }
    const mean = stabs.reduce((a, b) => a + b, 0) / stabs.length;
    const verdict = mean >= 0.85 ? 'FIABLE' : mean >= 0.6 ? 'dudoso' : 'RUIDO';
    const distStr = [...valueDist.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}:${c}`).join(' ');
    console.log(`${pad(field, 18)} estab.media ${(mean * 100).toFixed(0)}%  [${verdict}]   valores: ${distStr}`);
  }

  if (results.some(r => r.kind === 'video' && r.frameGapSec != null)) {
    const gaps = results.filter(r => r.frameGapSec != null).map(r => r.frameGapSec);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    console.log(`\nNota video: frames muestreados a ${avg.toFixed(1)}s de media entre si.`);
    console.log('Cuanto mayor el gap, menos puede el VLM leer movimiento de camara (frames no contiguos).');
  }

  // ---- Volcado JSON ----
  const jsonPath = opts.json || path.join(__dirname, `vlm-diag-${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ model: svc.model, repeats: opts.repeats, results }, null, 2));
  console.log(`\nResultados crudos: ${jsonPath}\n`);
}

main().catch(err => { console.error('\nFallo:', err.message); process.exit(1); });
