/**
 * Color Utils — Pensadero
 *
 * Conversion hex → CIELAB y distancia perceptual Delta E (CIEDE76).
 * Sin dependencias externas. Para la busqueda por color de la "rueda HSL"
 * y para futuras tareas (clustering de colores, paletas similares).
 *
 * Delta E reference:
 *  - ~0..1   : indistinguible
 *  - ~2..10  : misma familia cromatica
 *  - ~10..30 : color similar pero distinto
 *  - ~30+    : claramente distinto
 */

function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

// sRGB → linear RGB (gamma compensation)
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// linear RGB → XYZ (D65)
function rgbToXyz(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  return {
    x: lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375,
    y: lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750,
    z: lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041,
  };
}

// XYZ → LAB (D65)
function xyzToLab(x, y, z) {
  // D65 white point
  const Xn = 0.95047;
  const Yn = 1.00000;
  const Zn = 1.08883;
  const f = t => (t > 0.008856 ? Math.pow(t, 1/3) : (7.787 * t) + 16/116);
  const fx = f(x / Xn);
  const fy = f(y / Yn);
  const fz = f(z / Zn);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/**
 * Convierte un hex (#RRGGBB) al espacio CIELAB.
 * @param {string} hex
 * @returns {{L:number,a:number,b:number}|null}
 */
function hexToLab(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const xyz = rgbToXyz(rgb.r, rgb.g, rgb.b);
  return xyzToLab(xyz.x, xyz.y, xyz.z);
}

/**
 * Delta E 76 (euclidiana en LAB). Suficiente para filtrado por color en
 * Pensadero — CIEDE2000 seria mas preciso pero ~10x mas codigo. La diferencia
 * en UX para este caso es minima.
 */
function deltaE76(lab1, lab2) {
  if (!lab1 || !lab2) return Infinity;
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Distancia minima entre el color objetivo y cualquier color de una paleta.
 * Devuelve { distance, matchedHex } o null si la paleta esta vacia.
 *
 * @param {{L,a,b}} targetLab - color objetivo en LAB
 * @param {Array<{hex,name}>} palette - array de colores con campo `hex`
 */
function paletteMinDistance(targetLab, palette) {
  if (!Array.isArray(palette) || palette.length === 0) return null;
  let best = null;
  for (const p of palette) {
    if (!p || typeof p.hex !== 'string') continue;
    const lab = hexToLab(p.hex);
    if (!lab) continue;
    const d = deltaE76(targetLab, lab);
    if (best === null || d < best.distance) {
      best = { distance: d, matchedHex: p.hex, matchedName: p.name || '' };
    }
  }
  return best;
}

module.exports = {
  hexToRgb,
  hexToLab,
  deltaE76,
  paletteMinDistance,
};
