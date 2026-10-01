/**
 * Etiquetas legibles — Pensadero
 *
 * Dos limpiezas, porque las etiquetas son lo que se ve en la ficha, en
 * «Acotar» y lo que casa la busqueda normal:
 *
 * 1. Los atributos del escaneo se guardan con su codigo ("plano_general",
 *    "grupo_pequeno", "ninguno", "normal"). Son utiles, asi que se quedan, pero
 *    escritos como se dicen ("plano general", "grupo pequeño", "sin personas",
 *    "ángulo normal"): asi se leen y se encuentran tecleando con espacios. La
 *    busqueda natural no usa estas etiquetas (lee `composition` y `atmosphere`
 *    directamente), asi que no pierde nada.
 *
 * 2. Lo que sale de trocear nombres de archivo y de carpeta y no describe
 *    nada: contadores de camara ("C0001", "WA0010", "ZOOM0001"), prefijos
 *    ("IMG", "DSC") y carpetas que crea la camara ("CLIP", "DCIM",
 *    "100MSDCF"). Fuera de las etiquetas; el nombre se sigue buscando como texto.
 */

const LEGIBLE = {
  shot_type: {
    plano_general: 'plano general', plano_americano: 'plano americano', plano_medio: 'plano medio',
    plano_medio_corto: 'plano medio corto', primer_plano: 'primer plano', plano_detalle: 'plano detalle',
    plano_conjunto: 'plano conjunto',
  },
  camera_angle: {
    normal: 'ángulo normal', picado: 'picado', contrapicado: 'contrapicado', cenital: 'cenital', nadir: 'nadir',
  },
  camera_movement: {
    fijo: 'cámara fija', paneo: 'paneo', cabeceo: 'cabeceo', acercamiento: 'acercamiento',
    alejamiento: 'alejamiento', inestable: 'cámara en mano',
  },
  people_framing: {
    ninguno: 'sin personas', individual: 'una persona', pareja: 'pareja', grupo_pequeno: 'grupo pequeño',
    grupo_grande: 'grupo grande', multitud: 'multitud',
  },
  lighting: {
    luz_natural: 'luz natural', luz_dorada: 'luz dorada', contraluz: 'contraluz', interior: 'luz interior',
    neon: 'neón', nocturna: 'luz nocturna', mixta: 'luz mixta',
  },
  space_type: {
    interior: 'interior', exterior: 'exterior', urbano: 'urbano', naturaleza: 'naturaleza', oficina: 'oficina',
    escenario: 'escenario', hogar: 'hogar', transito: 'tránsito',
  },
  time_of_day: {
    amanecer: 'amanecer', manana: 'mañana', mediodia: 'mediodía', tarde: 'tarde', atardecer: 'atardecer',
    noche: 'noche', indeterminado: null,
  },
  style: {
    documental: 'documental', retrato: 'retrato', paisaje: 'paisaje', accion: 'acción', producto: 'producto',
    ambiente: 'ambiente', abstracto: 'abstracto',
  },
};

/**
 * Como se dice un atributo del escaneo. Un valor que no esta en la tabla (un
 * modelo que se sale del guion) se deja legible quitando los guiones bajos;
 * `null` = no aporta nada ("indeterminado").
 */
function etiquetaDeEscaneo(clave, valor) {
  if (typeof valor !== 'string' || !valor.trim()) return null;
  const v = valor.trim();
  const tabla = LEGIBLE[clave];
  if (tabla && Object.prototype.hasOwnProperty.call(tabla, v.toLowerCase())) return tabla[v.toLowerCase()];
  return v.replace(/_/g, ' ');
}

/** Prefijos de camara y de movil que no dicen nada del material. */
const PREFIJOS = new Set(['img', 'vid', 'dsc', 'dscf', 'dscn', 'mvi', 'mov', 'gopr', 'gp', 'pxl', 'wa', 'pana', 'sam', 'clip', 'dji']);

/**
 * ¿Es un trozo de nombre que no describe nada? Contadores ("C0001", "WA0010",
 * "P1000001", "ZOOM0001": letras con dos cifras o mas), prefijos de camara y
 * letras sueltas (una etiqueta "V" casaba con todo lo que llevara una v).
 */
function esCodigoDeArchivo(trozo) {
  const t = String(trozo || '').trim();
  if (t.length <= 1) return true;
  if (PREFIJOS.has(t.toLowerCase())) return true;
  return /[a-z]/i.test(t) && /\d.*\d/.test(t) && !/^(\d+k|4k|8k|3d|360)$/i.test(t);
}

/**
 * Carpetas que crea la camara o el soporte, no el usuario. La misma lista que
 * los nombres de sesion del front (`esCarpetaTecnica` en filenameParser.ts).
 */
const CARPETA_TECNICA = /^(private|m4root|clip|dcim|avchd|bdmv|stream|xdroot|contents|video_ts|audio_ts|mp_root|thmbnl|general|\d{3}[a-z0-9_]{5}|\d+)$/i;
function esCarpetaTecnica(nombre) {
  return CARPETA_TECNICA.test(String(nombre || '').trim());
}

/**
 * Quita de las etiquetas DERIVADAS los codigos y las carpetas de camara. Va al
 * final de cada sincronizacion, antes de las etiquetas puestas a mano (que se
 * respetan aunque parezcan un codigo): lo ya indexado guarda en la cache las
 * etiquetas de nombre de antes, y sin esto "C0001" o "CLIP" seguian ahi hasta
 * reindexar el archivo.
 */
function limpiarEtiquetas(files) {
  if (!Array.isArray(files)) return files;
  for (const f of files) {
    if (!f || !Array.isArray(f.tags)) continue;
    // Un numero suelto ("2026") es un año, no una carpeta de camara: se queda.
    const limpias = f.tags.filter(t => typeof t === 'string'
      && !(!/\s/.test(t) && (esCodigoDeArchivo(t) || (esCarpetaTecnica(t) && !/^\d+$/.test(t)))));
    if (limpias.length !== f.tags.length) f.tags = limpias;
  }
  return files;
}

module.exports = { etiquetaDeEscaneo, esCodigoDeArchivo, esCarpetaTecnica, limpiarEtiquetas, LEGIBLE };
