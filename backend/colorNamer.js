/**
 * Color Namer — Pensadero
 *
 * Asigna un nombre humano en español a un hex usando una tabla de referencia
 * y busqueda por distancia perceptual (Delta E sobre CIELAB).
 *
 * Pensado para enriquecer la palette algoritmica (extraida por colorAnalyzer
 * con sharp) con nombres consistentes que el usuario puede buscar:
 *   #1a3a8f → "azul marino"
 *   #e8c184 → "ocre"
 *   #404040 → "gris oscuro"
 *
 * Vocabulario controlado (~35 colores). Evita los inventos semanticos del
 * VLM, que a veces decia "rojo" pero el hex tiraba a marron.
 */

const { hexToLab, deltaE76 } = require('./colorUtils');

// Tabla de referencia. Cada color cubre una zona del espacio LAB.
// Los hex son representativos del centro del concepto en español.
const COLOR_REFERENCE = [
  // Acromaticos
  { hex: '#000000', name: 'negro' },
  { hex: '#2c2c2c', name: 'gris muy oscuro' },
  { hex: '#555555', name: 'gris oscuro' },
  { hex: '#888888', name: 'gris' },
  { hex: '#bbbbbb', name: 'gris claro' },
  { hex: '#e0e0e0', name: 'gris muy claro' },
  { hex: '#ffffff', name: 'blanco' },

  // Rojos / rosas
  { hex: '#7a1f1f', name: 'granate' },
  { hex: '#c0392b', name: 'rojo intenso' },
  { hex: '#e74c3c', name: 'rojo' },
  { hex: '#ff8888', name: 'rojo claro' },
  { hex: '#ff9999', name: 'salmon' },
  { hex: '#ffb6c1', name: 'rosa pastel' },
  { hex: '#ff69b4', name: 'rosa' },
  { hex: '#c71585', name: 'magenta' },

  // Naranjas / ocres
  { hex: '#ff6600', name: 'naranja' },
  { hex: '#ffa500', name: 'naranja claro' },
  { hex: '#cc7722', name: 'ocre' },
  { hex: '#b8860b', name: 'mostaza' },

  // Amarillos
  { hex: '#ffd700', name: 'dorado' },
  { hex: '#ffff66', name: 'amarillo claro' },
  { hex: '#f0e68c', name: 'beige' },
  { hex: '#fff8dc', name: 'crema' },

  // Verdes
  { hex: '#228b22', name: 'verde' },
  { hex: '#90ee90', name: 'verde claro' },
  { hex: '#006400', name: 'verde oscuro' },
  { hex: '#808000', name: 'verde oliva' },
  { hex: '#40e0d0', name: 'turquesa' },

  // Azules
  { hex: '#000080', name: 'azul marino' },
  { hex: '#1e90ff', name: 'azul' },
  { hex: '#87ceeb', name: 'azul claro' },
  { hex: '#00bfff', name: 'celeste' },
  { hex: '#00ffff', name: 'cian' },

  // Morados / lavandas
  { hex: '#8b00ff', name: 'morado' },
  { hex: '#c8b6ff', name: 'lavanda' },
  { hex: '#4b0082', name: 'indigo' },

  // Marrones
  { hex: '#5d4037', name: 'marron oscuro' },
  { hex: '#8b4513', name: 'marron' },
  { hex: '#d2b48c', name: 'marron claro' },

  // Tonos piel (utiles para fotos)
  { hex: '#f5deb3', name: 'piel clara' },
  { hex: '#a0522d', name: 'piel oscura' },
];

// Pre-cachear LAB de cada referencia (calc una vez al cargar el modulo)
const REF_LAB = COLOR_REFERENCE.map(c => ({
  ...c,
  lab: hexToLab(c.hex),
}));

/**
 * Devuelve el nombre del color de referencia mas cercano al hex dado.
 * Si el hex es invalido devuelve ''.
 */
function nameForHex(hex) {
  const lab = hexToLab(hex);
  if (!lab) return '';
  let best = null;
  let bestDist = Infinity;
  for (const ref of REF_LAB) {
    if (!ref.lab) continue;
    const d = deltaE76(lab, ref.lab);
    if (d < bestDist) {
      bestDist = d;
      best = ref;
    }
  }
  return best ? best.name : '';
}

/**
 * Toma un array de hex y devuelve [{hex, name}, ...] con el nombre asignado.
 * Deduplica nombres consecutivos para evitar "gris, gris, gris" cuando los
 * tres dominantes caen en el mismo bucket (en ese caso se queda solo el primero).
 */
function enrichPalette(hexArray, { dedupeNames = true } = {}) {
  if (!Array.isArray(hexArray)) return [];
  const seen = new Set();
  const out = [];
  for (const hex of hexArray) {
    if (typeof hex !== 'string') continue;
    const cleanHex = hex.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(cleanHex)) continue;
    const name = nameForHex(cleanHex);
    if (dedupeNames && name && seen.has(name)) continue;
    if (name) seen.add(name);
    out.push({ hex: cleanHex, name });
  }
  return out;
}

module.exports = {
  nameForHex,
  enrichPalette,
  COLOR_REFERENCE,
};
