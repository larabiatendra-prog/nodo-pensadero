#!/usr/bin/env node
/**
 * Limpieza de proxies de video — Pensadero
 *
 * Recorre las bibliotecas y mira cada proxy (`.pensadero\proxies\<id>.mp4`)
 * con la regla ACTUAL de videoProxyService:
 *
 *   - Su original ya es reproducible en el navegador (p.ej. H.264 con audio
 *     PCM de camara)          -> el proxy sobra.
 *   - Es una copia del original (pesa mas del 30 % de lo que pesa el original:
 *     un "remux" de la regla vieja) -> sobra; si el video lo necesita, al
 *     abrirlo se prepara una version ligera.
 *   - Su original ya no existe -> huerfano.
 *   - Restos `.tmp.mp4` de una generacion cortada -> basura.
 *
 * Existe por lo medido el 17/09/2026: 1,5 TB de proxies que eran copias casi
 * exactas de sus originales (93-99 % del tamaño), la mayoria solo por el audio
 * PCM, que el navegador reproduce sin ayuda. El disco F: se habia quedado con
 * 17 GB libres.
 *
 * Todo proxy es regenerable: borrar uno de mas solo cuesta volver a prepararlo
 * la proxima vez que se abra ese video.
 *
 * Uso:
 *   node tools/limpiar-proxies.js                 → SIMULACION: dice que borraria
 *   node tools/limpiar-proxies.js --apply         → borra lo que sobra
 *   node tools/limpiar-proxies.js --todo --apply  → borra TODOS los proxies
 *   node tools/limpiar-proxies.js --root "D:\(1) WORKS"   → acota a una raiz
 *   node tools/limpiar-proxies.js --verbose       → lista archivo por archivo
 *
 * Solo mira discos conectados. Lo que viva en uno desconectado se queda como
 * esta hasta que lo conectes y lo vuelvas a pasar.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { esCarpetaExcluida } = require('../utils/carpetasExcluidas');
const videoProxy = require('../services/videoProxyService');

const BACKEND_DIR = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const TODO = process.argv.includes('--todo');
const VERBOSE = process.argv.includes('--verbose');
const rootFlag = process.argv.indexOf('--root');
const ROOT_OVERRIDE = rootFlag !== -1 ? process.argv[rootFlag + 1] : null;
const UMBRAL_COPIA = 0.3;
const PARALELO = 6;

const gb = (b) => `${(b / 1073741824).toFixed(1)} GB`;
const idDe = (ruta) => crypto.createHash('md5').update(ruta).digest('hex');

function raices() {
  if (ROOT_OVERRIDE) return [ROOT_OVERRIDE];
  try {
    const rutas = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'scan_paths.json'), 'utf-8'));
    return rutas.filter(r => r && r.path).map(r => r.path);
  } catch {
    return [];
  }
}

/** Todas las carpetas `.pensadero\proxies` bajo una raiz. */
async function buscarCarpetasProxies(raiz, salida) {
  let entradas;
  try { entradas = await fsp.readdir(raiz, { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    if (!e.isDirectory()) continue;
    const ruta = path.join(raiz, e.name);
    if (e.name === '.pensadero') {
      const prox = path.join(ruta, 'proxies');
      if (fs.existsSync(prox)) salida.push(prox);
      continue;
    }
    if (e.name.startsWith('.') || esCarpetaExcluida(e.name)) continue;
    await buscarCarpetasProxies(ruta, salida);
  }
}

async function enParalelo(items, n, fn) {
  let i = 0;
  const trabajadores = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(trabajadores);
}

(async () => {
  const lista = raices();
  const conectadas = lista.filter(r => fs.existsSync(r));
  console.log(`\nLimpieza de proxies ${APPLY ? '(BORRANDO)' : '(simulacion: no se borra nada)'}${TODO ? ' · modo --todo' : ''}`);
  for (const r of lista) console.log(`  ${fs.existsSync(r) ? '·' : '✗'} ${r}${fs.existsSync(r) ? '' : '  (no conectada: se salta)'}`);

  const carpetas = [];
  for (const r of conectadas) await buscarCarpetasProxies(r, carpetas);
  const legacy = path.join(BACKEND_DIR, 'proxies');
  if (fs.existsSync(legacy)) carpetas.push(legacy);

  // Cada proxy con su original (misma carpeta que contiene .pensadero).
  const tareas = [];
  for (const dirProxies of carpetas) {
    const dirOriginales = path.dirname(path.dirname(dirProxies));
    const esLegacy = dirProxies === legacy;
    const porId = new Map();
    if (!esLegacy) {
      try {
        for (const e of await fsp.readdir(dirOriginales, { withFileTypes: true })) {
          if (e.isFile()) { const ruta = path.join(dirOriginales, e.name); porId.set(idDe(ruta), ruta); }
        }
      } catch { /* carpeta ilegible: sus proxies saldran huerfanos */ }
    }
    let archivos = [];
    try { archivos = await fsp.readdir(dirProxies); } catch { continue; }
    for (const nombre of archivos) {
      if (!nombre.toLowerCase().endsWith('.mp4')) continue;
      tareas.push({ proxy: path.join(dirProxies, nombre), nombre, original: porId.get(nombre.replace(/\.tmp\.mp4$|\.mp4$/i, '')) || null, esLegacy });
    }
  }
  console.log(`\n${tareas.length} proxies en ${carpetas.length} carpetas. Analizando originales…`);

  const resumen = new Map(); // disco -> { motivo -> { n, bytes } }
  const anotar = (proxy, motivo, bytes) => {
    const disco = path.parse(proxy).root.toUpperCase();
    const d = resumen.get(disco) || new Map();
    const m = d.get(motivo) || { n: 0, bytes: 0 };
    m.n++; m.bytes += bytes;
    d.set(motivo, m); resumen.set(disco, d);
  };

  let hechos = 0;
  let borrados = 0;
  let liberado = 0;
  const fallidos = [];
  await enParalelo(tareas, PARALELO, async (t) => {
    let tam = 0;
    try { tam = (await fsp.stat(t.proxy)).size; } catch { return; }
    let motivo = null;
    if (/\.tmp\.mp4$/i.test(t.nombre)) motivo = 'resto de una generación cortada';
    else if (TODO) motivo = 'modo --todo';
    else if (t.esLegacy) motivo = null; // sin original conocido: los decide el propio servicio
    else if (!t.original) motivo = 'original ya no existe';
    else {
      const info = await videoProxy.probe(t.original);
      let tamOriginal = 0;
      try { tamOriginal = (await fsp.stat(t.original)).size; } catch { /* sin tamaño */ }
      if (info && videoProxy.classify(info) === 'native') motivo = 'el navegador ya abre el original';
      else if (tamOriginal > 0 && tam > tamOriginal * UMBRAL_COPIA) motivo = 'copia del original (pesa más del 30 %)';
    }
    hechos++;
    if (hechos % 250 === 0) process.stdout.write(`  ${hechos}/${tareas.length}\n`);
    if (!motivo) { anotar(t.proxy, 'se conserva (versión ligera necesaria)', tam); return; }
    anotar(t.proxy, motivo, tam);
    if (VERBOSE) console.log(`  ${APPLY ? 'borra' : 'borraría'} ${gb(tam).padStart(8)}  ${t.proxy}  ← ${motivo}`);
    if (APPLY) {
      try { await fsp.unlink(t.proxy); borrados++; liberado += tam; }
      catch (err) { fallidos.push(`${t.proxy}: ${err.message}`); }
    }
  });

  console.log('');
  let totalSobra = 0;
  for (const [disco, motivos] of resumen) {
    console.log(`${disco}`);
    for (const [motivo, m] of Array.from(motivos).sort((a, b) => b[1].bytes - a[1].bytes)) {
      const conserva = motivo.startsWith('se conserva');
      if (!conserva) totalSobra += m.bytes;
      console.log(`  ${conserva ? '=' : '−'} ${String(m.n).padStart(6)} proxies ${gb(m.bytes).padStart(10)}   ${motivo}`);
    }
  }
  console.log('');
  if (APPLY) {
    console.log(`Borrados ${borrados} proxies: ${gb(liberado)} liberados.`);
    if (fallidos.length) {
      console.log(`${fallidos.length} no se pudieron borrar (¿en uso por Pensadero?):`);
      fallidos.slice(0, 10).forEach(f => console.log('  ' + f));
    }
  } else {
    console.log(`Liberaría ${gb(totalSobra)}. Para hacerlo: node tools/limpiar-proxies.js --apply`);
  }
})().catch(err => {
  console.error('Fallo inesperado:', err);
  process.exit(1);
});
