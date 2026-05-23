/**
 * Folder Context — Pensadero
 *
 * Lee, escribe y compone el archivo `_contexto.md` que vive dentro de cada
 * carpeta de material. Su propósito es darle al VLM contexto humano sobre
 * qué es ese material (viaje, evento, personas presentes, qué priorizar,
 * etc.) para que la descripción que extraiga sea más precisa que la del
 * prompt genérico.
 *
 * Formato del archivo:
 *
 *   ---
 *   tipo: viaje
 *   lugar: París
 *   personas: [Carlos, Sara]
 *   fecha: 2024-03
 *   ---
 *   Fin de semana en París. Priorizar momentos de grupo sobre arquitectura.
 *   Ignorar planos de relleno sin interés narrativo.
 *
 * Front matter YAML mínimo (sólo strings y arrays planos) + cuerpo libre.
 * El parser es deliberadamente simple — no usamos `js-yaml` para evitar
 * añadir una dependencia por un caso de uso tan acotado.
 *
 * Herencia: el contexto de una subcarpeta se compone con el de sus padres,
 * de raíz a hoja, dentro del ámbito del scanRoot. Así, un `_contexto.md`
 * en la raíz de la biblioteca aplica a todas las subcarpetas, y cada
 * subcarpeta puede añadir matices propios.
 */

const fs = require('fs').promises;
const path = require('path');

const CONTEXT_FILENAME = '_contexto.md';

/**
 * Parsea el contenido textual de un `_contexto.md`.
 * Devuelve `{ meta, body, raw }`.
 *   - meta: objeto con los campos del front matter (strings y arrays).
 *   - body: texto libre tras el front matter (string, posiblemente vacío).
 *   - raw:  contenido textual completo, sin tocar.
 *
 * Si no hay front matter, se asume todo el archivo como `body`.
 */
function parseContextText(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const fmMatch = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { meta: {}, body: text.trim(), raw: text };
  }
  const meta = {};
  for (const line of fmMatch[1].split(/\r?\n/)) {
    const m = line.match(/^([\w\-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let value = m[2].trim();
    // Array inline tipo [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    meta[key] = value;
  }
  return { meta, body: (fmMatch[2] || '').trim(), raw: text };
}

/**
 * Lee `_contexto.md` de un directorio. Si no existe o falla, devuelve
 * `{ exists: false, meta: {}, body: '', raw: '' }` — nunca lanza.
 */
async function readFolderContext(dir) {
  const fp = path.join(dir, CONTEXT_FILENAME);
  try {
    const raw = await fs.readFile(fp, 'utf-8');
    const parsed = parseContextText(raw);
    return { exists: true, ...parsed };
  } catch {
    return { exists: false, meta: {}, body: '', raw: '' };
  }
}

/**
 * Compone un único string de contexto para inyectar al prompt del VLM,
 * concatenando los `_contexto.md` desde `scanRoot` hasta el directorio
 * del archivo. Los más generales primero, los más específicos después.
 *
 * @param {string} fileDir   directorio del archivo siendo escaneado
 * @param {string} scanRoot  directorio raíz desde el que se lanzó el scan
 * @param {Map} cache        mapa dir → parsedContext para no releer
 * @returns {Promise<string>} texto listo para inyectar, o '' si no hay contexto
 */
async function buildContextStringForFile(fileDir, scanRoot, cache) {
  const chain = [];
  // Construir la cadena de directorios desde scanRoot hasta fileDir.
  // Si fileDir no está bajo scanRoot, sólo usamos fileDir.
  const normRoot = path.resolve(scanRoot);
  const normFile = path.resolve(fileDir);
  if (normFile === normRoot || normFile.startsWith(normRoot + path.sep)) {
    let cur = normRoot;
    chain.push(cur);
    if (normFile !== normRoot) {
      const rel = path.relative(normRoot, normFile);
      const segments = rel.split(path.sep).filter(Boolean);
      for (const seg of segments) {
        cur = path.join(cur, seg);
        chain.push(cur);
      }
    }
  } else {
    chain.push(normFile);
  }

  const blocks = [];
  for (const dir of chain) {
    let ctx = cache.get(dir);
    if (!ctx) {
      ctx = await readFolderContext(dir);
      cache.set(dir, ctx);
    }
    if (!ctx.exists) continue;
    blocks.push(formatContextBlock(ctx, dir, scanRoot));
  }

  if (blocks.length === 0) return '';
  return blocks.join('\n\n');
}

/**
 * Da formato a un único bloque de contexto para que el VLM lo lea como
 * texto natural. Convierte el front matter en frases sencillas y añade el
 * cuerpo libre tal cual.
 */
function formatContextBlock(ctx, dir, scanRoot) {
  const lines = [];
  const rel = scanRoot && dir.startsWith(scanRoot) ? path.relative(scanRoot, dir) || '.' : path.basename(dir);
  lines.push(`[Contexto de la carpeta "${rel}"]`);

  const m = ctx.meta || {};
  const metaLines = [];
  if (m.tipo) metaLines.push(`Tipo de material: ${m.tipo}.`);
  if (m.lugar) metaLines.push(`Lugar: ${m.lugar}.`);
  if (m.fecha) metaLines.push(`Fecha: ${m.fecha}.`);
  if (Array.isArray(m.personas) && m.personas.length > 0) {
    metaLines.push(`Personas que pueden aparecer: ${m.personas.join(', ')}.`);
  } else if (typeof m.personas === 'string' && m.personas.trim()) {
    metaLines.push(`Personas que pueden aparecer: ${m.personas}.`);
  }
  if (m.priorizar) metaLines.push(`Priorizar: ${m.priorizar}.`);
  if (m.ignorar) metaLines.push(`Ignorar: ${m.ignorar}.`);

  // Otros campos personalizados que el usuario haya añadido (clave: valor)
  for (const [k, v] of Object.entries(m)) {
    if (['tipo', 'lugar', 'fecha', 'personas', 'priorizar', 'ignorar'].includes(k)) continue;
    if (Array.isArray(v)) metaLines.push(`${k}: ${v.join(', ')}.`);
    else if (typeof v === 'string' && v) metaLines.push(`${k}: ${v}.`);
  }

  if (metaLines.length > 0) lines.push(metaLines.join(' '));
  if (ctx.body) lines.push(ctx.body);

  return lines.join('\n');
}

/**
 * Serializa un objeto de contexto a texto markdown válido (frontmatter +
 * cuerpo). Pensado para el endpoint `POST /api/scan/context`.
 *
 * `data` puede contener cualquier subconjunto de:
 *   tipo, lugar, fecha, personas (string | string[]), priorizar, ignorar,
 *   notas (string — se usa como cuerpo libre).
 *
 * Cualquier clave extra a nivel raíz se serializa también en el front
 * matter (excepto 'notas', que va al cuerpo).
 */
function serializeContext(data) {
  const obj = data && typeof data === 'object' ? data : {};
  const fmEntries = [];
  const reservedBodyKeys = new Set(['notas', 'body']);

  const orderedKeys = ['tipo', 'lugar', 'fecha', 'personas', 'priorizar', 'ignorar'];
  const seen = new Set();

  const fmtVal = (v) => {
    if (Array.isArray(v)) {
      return `[${v.map((x) => String(x).trim()).filter(Boolean).join(', ')}]`;
    }
    return String(v);
  };

  for (const key of orderedKeys) {
    if (obj[key] == null || obj[key] === '') continue;
    fmEntries.push(`${key}: ${fmtVal(obj[key])}`);
    seen.add(key);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (seen.has(k) || reservedBodyKeys.has(k)) continue;
    if (v == null || v === '') continue;
    fmEntries.push(`${k}: ${fmtVal(v)}`);
  }

  const body = typeof obj.notas === 'string' ? obj.notas.trim()
              : typeof obj.body === 'string' ? obj.body.trim()
              : '';

  const out = [];
  if (fmEntries.length > 0) {
    out.push('---');
    out.push(...fmEntries);
    out.push('---');
  }
  if (body) {
    if (out.length > 0) out.push('');
    out.push(body);
  }
  // Asegurar newline final
  return out.join('\n') + '\n';
}

/**
 * Escribe `_contexto.md` en `dir` con los datos proporcionados.
 * Si el directorio no existe, lanza. Si el archivo ya existe, lo sobrescribe.
 */
async function writeFolderContext(dir, data) {
  const fp = path.join(dir, CONTEXT_FILENAME);
  const text = serializeContext(data);
  await fs.writeFile(fp, text, 'utf-8');
  return { path: fp, bytes: Buffer.byteLength(text, 'utf-8') };
}

module.exports = {
  CONTEXT_FILENAME,
  parseContextText,
  readFolderContext,
  buildContextStringForFile,
  serializeContext,
  writeFolderContext,
};
