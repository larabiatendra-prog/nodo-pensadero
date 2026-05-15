const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

/**
 * Analiza la paleta de colores de una imagen con enfoque en protagonismo visual
 * @param {string} imagePath - Ruta a la imagen (preferiblemente thumbnail)
 * @returns {Promise<Object>} Objeto con información de colores
 */
async function analyzeImageColors(imagePath) {
  try {
    const image = sharp(imagePath);
    const { data, info } = await image
      .resize(128, 128, { fit: 'cover' }) // Mayor resolución para mejor análisis perceptual
      .raw()
      .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const totalPixels = width * height;
    
    // Mapa de colores con información de posición para análisis perceptual
    const colorAnalysis = new Map();
    
    // Procesar cada pixel con información espacial
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * width + x) * 3;
        const r = data[pixelIndex];
        const g = data[pixelIndex + 1];
        const b = data[pixelIndex + 2];
        
        // Cuantizar con mayor precisión para colores similares
        const quantizedR = Math.round(r / 16) * 16;
        const quantizedG = Math.round(g / 16) * 16;
        const quantizedB = Math.round(b / 16) * 16;
        
        const colorKey = `${quantizedR},${quantizedG},${quantizedB}`;
        
        if (!colorAnalysis.has(colorKey)) {
          colorAnalysis.set(colorKey, {
            count: 0,
            positions: [],
            r: quantizedR,
            g: quantizedG,
            b: quantizedB
          });
        }
        
        const colorInfo = colorAnalysis.get(colorKey);
        colorInfo.count++;
        
        // Calcular peso basado en posición (centro tiene más peso)
        const centerX = width / 2;
        const centerY = height / 2;
        const distanceFromCenter = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
        const maxDistance = Math.sqrt(Math.pow(centerX, 2) + Math.pow(centerY, 2));
        const positionWeight = 1 + (1 - distanceFromCenter / maxDistance) * 0.5; // Peso 1.0-1.5x
        
        colorInfo.positions.push({ x, y, weight: positionWeight });
      }
    }

    // Filtrar colores insignificantes (menos del 1% de la imagen)
    const significantColors = Array.from(colorAnalysis.entries())
      .filter(([_, info]) => (info.count / totalPixels) > 0.01)
      .map(([colorKey, info]) => {
        // Calcular score de protagonismo perceptual
        const frequency = info.count / totalPixels;
        
        // Peso por posición (píxeles centrales valen más)
        const averageWeight = info.positions.reduce((sum, pos) => sum + pos.weight, 0) / info.positions.length;
        
        // Peso por saturación (colores más saturados son más notables)
        const { r, g, b } = info;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max === 0 ? 0 : (max - min) / max;
        const saturationWeight = 1 + saturation * 0.5; // Peso 1.0-1.5x
        
        // Peso por brillo (evitar colores demasiado oscuros o claros)
        const brightness = (r + g + b) / (3 * 255);
        const brightnessWeight = brightness > 0.1 && brightness < 0.9 ? 1.2 : 1.0;
        
        // Score final de protagonismo
        const prominenceScore = frequency * averageWeight * saturationWeight * brightnessWeight;
        
        return {
          r, g, b,
          hex: rgbToHex(r, g, b),
          frequency: Math.round(frequency * 10000) / 100, // Porcentaje con 2 decimales
          prominenceScore,
          saturation,
          brightness
        };
      })
      .sort((a, b) => b.prominenceScore - a.prominenceScore) // Ordenar por protagonismo
      .slice(0, 8); // Top 8 colores más prominentes

    // El color más prominente es el que tiene mayor score, no necesariamente el más frecuente
    const dominant = significantColors[0];

    // Crear paleta final
    const palette = significantColors.map(color => color.hex);
    
    // Calcular métricas globales
    const avgBrightness = significantColors.reduce((sum, c) => sum + c.brightness, 0) / significantColors.length;
    const avgSaturation = significantColors.reduce((sum, c) => sum + c.saturation, 0) / significantColors.length;

    return {
      dominant: dominant.hex,
      palette: palette,
      paletteDetailed: significantColors,
      brightness: Math.round(avgBrightness * 100) / 100,
      saturation: Math.round(avgSaturation * 100) / 100,
      lastAnalyzed: new Date(),
      analysisType: 'perceptual_prominence' // Indicar el tipo de análisis
    };

  } catch (error) {
    console.error('Error analyzing image colors:', error);
    return null;
  }
}

/**
 * Convierte RGB a formato hexadecimal
 */
function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("");
}

/**
 * Calcula el brightness promedio de una paleta
 */
function calculateAverageBrightness(palette) {
  const totalBrightness = palette.reduce((sum, color) => {
    const { r, g, b } = color.rgb;
    // Fórmula de luminancia relativa
    const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return sum + brightness * color.percentage;
  }, 0);
  
  const totalPercentage = palette.reduce((sum, color) => sum + color.percentage, 0);
  return Math.round((totalBrightness / totalPercentage) * 100) / 100;
}

/**
 * Calcula la saturación promedio de una paleta
 */
function calculateAverageSaturation(palette) {
  const totalSaturation = palette.reduce((sum, color) => {
    const { r, g, b } = color.rgb;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    return sum + saturation * color.percentage;
  }, 0);
  
  const totalPercentage = palette.reduce((sum, color) => sum + color.percentage, 0);
  return Math.round((totalSaturation / totalPercentage) * 100) / 100;
}

/**
 * Analiza colores de un archivo multimedia usando su thumbnail
 * @param {string} thumbnailPath - Ruta al thumbnail
 * @param {string} fileType - Tipo de archivo (image, video, audio, export)
 * @returns {Promise<Object>} Datos de color o null
 */
async function analyzeFileColors(thumbnailPath, fileType) {
  // Solo analizar archivos visuales
  if (fileType === 'audio') {
    return null;
  }

  try {
    // Verificar si el thumbnail existe
    await fs.access(thumbnailPath);
    
    // Si el thumbnail es SVG (placeholder), no analizar
    if (thumbnailPath.includes('data:image/svg+xml')) {
      return null;
    }

    return await analyzeImageColors(thumbnailPath);
    
  } catch (error) {
    console.error(`Error accessing thumbnail for color analysis: ${thumbnailPath}`, error);
    return null;
  }
}

/**
 * Calcula la similitud perceptual entre dos colores en formato hex
 * @param {string} color1 - Color hex (ej: "#FF0000")
 * @param {string} color2 - Color hex (ej: "#FF3333")
 * @returns {number} Similitud de 0 a 1 (1 = idénticos)
 */
function colorSimilarity(color1, color2) {
  if (!color1 || !color2) return 0;
  
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);
  
  if (!rgb1 || !rgb2) return 0;
  
  // Convertir a HSV para comparación perceptual
  const hsv1 = rgbToHsv(rgb1.r, rgb1.g, rgb1.b);
  const hsv2 = rgbToHsv(rgb2.r, rgb2.g, rgb2.b);
  
  // Calcular diferencias en cada componente
  let hueDiff = Math.abs(hsv1.h - hsv2.h);
  if (hueDiff > 180) hueDiff = 360 - hueDiff; // Manejar wrap-around del hue
  hueDiff = hueDiff / 180; // Normalizar a 0-1
  
  const satDiff = Math.abs(hsv1.s - hsv2.s) / 100; // Ya está en 0-100
  const valDiff = Math.abs(hsv1.v - hsv2.v) / 100; // Ya está en 0-100
  
  // Pesos perceptuales: el hue es más importante para la percepción de color
  const hueWeight = 0.6;
  const satWeight = 0.3;
  const valWeight = 0.1;
  
  // Calcular similitud ponderada
  const weightedDiff = (hueDiff * hueWeight) + (satDiff * satWeight) + (valDiff * valWeight);
  
  return Math.max(0, 1 - weightedDiff);
}

/**
 * Convierte RGB a HSV para análisis perceptual
 */
function rgbToHsv(r, g, b) {
  r = r / 255;
  g = g / 255;
  b = b / 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const diff = max - min;
  
  let h = 0;
  let s = max === 0 ? 0 : (diff / max) * 100;
  let v = max * 100;
  
  if (diff !== 0) {
    switch (max) {
      case r:
        h = ((g - b) / diff + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / diff + 2) * 60;
        break;
      case b:
        h = ((r - g) / diff + 4) * 60;
        break;
    }
  }
  
  return { h: h, s: s, v: v };
}

/**
 * Convierte hex a RGB
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Extrae colores globales de todos los archivos para el color picker
 * @param {Array} mediaFiles - Array de archivos media con colorData
 * @returns {Array} Array de colores únicos ordenados por frecuencia
 */
function extractGlobalPalette(mediaFiles) {
  const colorFrequency = new Map();
  
  mediaFiles.forEach(file => {
    if (file.colorData && file.colorData.palette) {
      file.colorData.palette.forEach((color, index) => {
        // Dar más peso a colores dominantes
        const weight = Math.max(1, 10 - index);
        colorFrequency.set(color, (colorFrequency.get(color) || 0) + weight);
      });
    }
  });
  
  // Ordenar por frecuencia y devolver top colores
  return Array.from(colorFrequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50) // Top 50 colores más comunes
    .map(([color, frequency]) => ({
      color,
      frequency,
      usage: Math.min(100, Math.round((frequency / mediaFiles.length) * 100))
    }));
}

module.exports = {
  analyzeImageColors,
  analyzeFileColors,
  colorSimilarity,
  extractGlobalPalette,
  rgbToHex,
  hexToRgb
};