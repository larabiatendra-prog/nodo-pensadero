/**
 * Smart Folder Evaluator — Pensadero
 *
 * Evalua si un mediaFile cumple un conjunto de reglas. Usado por las
 * Smart Folders (colecciones dinamicas) para resolver su contenido al vuelo
 * sin tener que mantener una lista estatica de fileIds.
 *
 * Estructura de una regla:
 *   { field: string, op: string, value: any }
 *
 * Combinator a nivel de coleccion: 'AND' | 'OR'.
 *
 * Campos soportados (cualquier path navegable en el mediaFile):
 *   type, isFavorite, createdAt, extractedDate, name, tags,
 *   visual_description, ocr_text,
 *   composition.{shot_type, camera_angle, camera_movement, people_framing},
 *   atmosphere.{mood, lighting, space_type, time_of_day, style},
 *   demographics.{age_ranges, genders},
 *   faces.person_id (atajo: has_person sin el field path),
 *   colors.palette (con op `color_similar`),
 *
 * Operadores:
 *   eq, neq, in, not_in, contains, not_contains,
 *   gt, gte, lt, lte, between (numeros y fechas ISO),
 *   has_person (value=personId o array),
 *   color_similar (value={hex, threshold}).
 */

const { hexToLab, deltaE76 } = require('./colorUtils');
const aliasTable = require('./aliasTable');

function normalize(s) {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Recoge un valor del file siguiendo el path con dot notation. Si en algun
// nivel el valor es array, no entra dentro — eso se maneja con ops especificos.
function getField(file, path) {
  if (!file || !path) return undefined;
  const parts = path.split('.');
  let cur = file;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// has_person: el archivo tiene al menos una de las personas indicadas en faces
function evalHasPerson(file, value) {
  if (!Array.isArray(file?.faces)) return false;
  const target = Array.isArray(value) ? value : [value];
  const targetSet = new Set(target.filter(x => typeof x === 'string'));
  return file.faces.some(f => f && targetSet.has(f.person_id));
}

// color_similar: alguna entry de file.colors.palette esta a distancia <= threshold del hex
function evalColorSimilar(file, value) {
  const hex = value?.hex;
  const threshold = typeof value?.threshold === 'number' ? value.threshold : 30;
  const targetLab = hexToLab(hex);
  if (!targetLab) return false;
  const palette = file?.colors?.palette;
  if (!Array.isArray(palette)) return false;
  for (const p of palette) {
    const lab = hexToLab(p?.hex);
    if (!lab) continue;
    if (deltaE76(targetLab, lab) <= threshold) return true;
  }
  return false;
}

// Evalua una regla individual contra el file. Devuelve bool.
function evaluateRule(file, rule) {
  if (!rule || typeof rule !== 'object') return false;
  const { field, op, value } = rule;

  // Atajos especificos sin path tradicional
  if (op === 'has_person') return evalHasPerson(file, value);
  if (op === 'color_similar') return evalColorSimilar(file, value);

  const actual = getField(file, field);

  // Helpers para comparacion sensible a tipo
  const arrIncludes = (haystack, needle) => {
    if (!Array.isArray(haystack)) return false;
    const n = normalize(String(needle));
    // Tambien expandir con alias table (si el needle es "salto" matchea "saltar")
    const variants = new Set([n, ...aliasTable.expandTerm(String(needle)).map(normalize)]);
    return haystack.some(h => {
      const hn = normalize(String(h));
      for (const v of variants) {
        if (hn === v || hn.includes(v)) return true;
      }
      return false;
    });
  };

  const scalarEq = (a, b) => {
    if (a == null || b == null) return a === b;
    return normalize(String(a)) === normalize(String(b));
  };

  const toNumOrDate = (v) => {
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!isNaN(t)) return t;
      const n = parseFloat(v);
      return isNaN(n) ? null : n;
    }
    return null;
  };

  switch (op) {
    case 'eq':
      // Si el campo es array, eq significa "contiene este valor"
      if (Array.isArray(actual)) return arrIncludes(actual, value);
      return scalarEq(actual, value);

    case 'neq':
      if (Array.isArray(actual)) return !arrIncludes(actual, value);
      return !scalarEq(actual, value);

    case 'in':
      // value es array de valores aceptables
      if (!Array.isArray(value)) return false;
      if (Array.isArray(actual)) {
        return value.some(v => arrIncludes(actual, v));
      }
      return value.some(v => scalarEq(actual, v));

    case 'not_in':
      if (!Array.isArray(value)) return true;
      if (Array.isArray(actual)) {
        return !value.some(v => arrIncludes(actual, v));
      }
      return !value.some(v => scalarEq(actual, v));

    case 'contains':
      // Para strings: substring; para arrays: arrIncludes
      if (Array.isArray(actual)) return arrIncludes(actual, value);
      if (typeof actual === 'string') {
        const n = normalize(actual);
        // expandir value via alias table
        const variants = aliasTable.expandTerm(String(value)).map(normalize);
        return variants.some(v => v && n.includes(v));
      }
      return false;

    case 'not_contains':
      if (Array.isArray(actual)) return !arrIncludes(actual, value);
      if (typeof actual === 'string') {
        const n = normalize(actual);
        const variants = aliasTable.expandTerm(String(value)).map(normalize);
        return !variants.some(v => v && n.includes(v));
      }
      return true;

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumOrDate(actual);
      const b = toNumOrDate(value);
      if (a === null || b === null) return false;
      switch (op) {
        case 'gt': return a > b;
        case 'gte': return a >= b;
        case 'lt': return a < b;
        case 'lte': return a <= b;
      }
      return false;
    }

    case 'between': {
      // value = [min, max]
      if (!Array.isArray(value) || value.length !== 2) return false;
      const a = toNumOrDate(actual);
      const min = toNumOrDate(value[0]);
      const max = toNumOrDate(value[1]);
      if (a === null) return false;
      if (min !== null && a < min) return false;
      if (max !== null && a > max) return false;
      return true;
    }

    case 'is_true':
      return actual === true;

    case 'is_false':
      return actual === false || actual == null;

    default:
      console.warn(`[smartFolder] operador desconocido: ${op}`);
      return false;
  }
}

/**
 * Evalua todas las reglas de una collection contra un file. Combinator
 * decide AND (todas) u OR (al menos una). Lista vacia → true (collection sin
 * reglas matchea todo, util para preview).
 */
function evaluateFile(file, rules, combinator) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const combinatorUp = (combinator || 'AND').toUpperCase();
  if (combinatorUp === 'OR') {
    return rules.some(r => evaluateRule(file, r));
  }
  return rules.every(r => evaluateRule(file, r));
}

/**
 * Filtra una lista de mediaFiles segun reglas.
 */
function filterFiles(files, rules, combinator) {
  if (!Array.isArray(files)) return [];
  if (!Array.isArray(rules) || rules.length === 0) return [];
  return files.filter(f => evaluateFile(f, rules, combinator));
}

module.exports = {
  evaluateRule,
  evaluateFile,
  filterFiles,
};
