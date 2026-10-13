/**
 * El plan de un envio a Premiere: lo que la extension de Pensadero
 * (premiere/extension) hace dentro de Premiere, paso a paso, con las
 * funciones basicas de su API: crear bandejas, importar los ORIGINALES (los
 * lee Premiere con su propio lector: respeta giro, cadencia y tamaño, no hay
 * traduccion que pueda deformar nada), poner textos, marcadores y etiqueta, y
 * hacer la secuencia.
 *
 * Antes se le pasaba un XML de Final Cut para que lo tradujera, y Premiere
 * 26.2 lo rechazo con «el proyecto parece dañado» sin decir por que. El XML
 * sigue existiendo para guardarlo (DaVinci, importar a mano).
 *
 * Puro: recibe los clips ya medidos (services/premiereXml.js, mismo formato)
 * y devuelve datos.
 */

const { agrupar, rateDe } = require('./premiereXml');

const ETIQUETA_FAVORITO = 7; // Mango, en el orden de etiquetas de Premiere

/** La forma de un clip ya girado: horizontal, vertical o cuadrado. */
function formaDe(ancho, alto) {
  if (!ancho || !alto) return null;
  const r = ancho / alto;
  if (r > 1.05) return 'horizontal';
  if (r < 0.95) return 'vertical';
  return 'cuadrado';
}

const fpsTexto = (fps) => {
  const r = rateDe(fps);
  return r.ntsc ? (Math.round(r.real * 100) / 100).toLocaleString('es-ES') : String(r.timebase);
};

/**
 * El formato que tendra la secuencia: el del video mas comun (tamaño ya
 * girado y cadencia). Sin videos, el de la foto mas comun a 25.
 */
function formatoComun(clips) {
  const cuenta = new Map();
  const contar = (c, fps) => {
    if (!c.ancho || !c.alto) return;
    const r = rateDe(fps);
    const k = `${c.ancho}x${c.alto}@${r.timebase}${r.ntsc ? 'n' : ''}`;
    const e = cuenta.get(k) || { n: 0, ancho: c.ancho, alto: c.alto, fps: r.ntsc ? r.real : r.timebase };
    e.n++;
    cuenta.set(k, e);
  };
  for (const c of clips) if (c.tipo === 'video') contar(c, c.fps);
  if (cuenta.size === 0) for (const c of clips) if (c.tipo === 'image') contar(c, 25);
  const mejor = Array.from(cuenta.values()).sort((a, b) => b.n - a.n)[0];
  return mejor ? { ancho: mejor.ancho, alto: mejor.alto, fps: mejor.fps } : null;
}

/**
 * Lo que conviene saber ANTES de enviar, dicho para cualquiera: que formato
 * tendra la secuencia y cuantos clips no encajan en el. Premiere no deforma
 * nada (no estira): lo que tiene otra forma se ve con bandas o recortado.
 */
function prevision(clips, conSecuencia) {
  if (!conSecuencia) return null;
  const formato = formatoComun(clips);
  if (!formato) return null;
  const forma = formaDe(formato.ancho, formato.alto);
  const rf = rateDe(formato.fps);
  let otraForma = 0, otroTamano = 0, otraCadencia = 0;
  for (const c of clips) {
    if (c.tipo === 'audio') continue;
    const f = formaDe(c.ancho, c.alto);
    if (f && f !== forma) otraForma++;
    else if (c.ancho && c.alto && (c.ancho !== formato.ancho || c.alto !== formato.alto)) otroTamano++;
    if (c.tipo === 'video' && c.fps > 0) {
      const r = rateDe(c.fps);
      if (r.timebase !== rf.timebase || r.ntsc !== rf.ntsc) otraCadencia++;
    }
  }
  return {
    ...formato,
    forma,
    fpsTexto: fpsTexto(formato.fps),
    otraForma,
    otroTamano,
    otraCadencia,
  };
}

/**
 * construirPlan({ nombre, ordenar, marcadores, secuencia }, clips) -> plan
 * `clips` en el orden de la cesta (el de la secuencia).
 */
function construirPlan(opciones, clips) {
  const o = opciones || {};
  const nombre = String(o.nombre || 'Pensadero').trim() || 'Pensadero';
  const ordenar = ['dia', 'persona', 'carpeta', 'todo'].includes(o.ordenar) ? o.ordenar : 'dia';
  const lista = (clips || []).filter(c => c && c.ruta);
  const indice = new Map(lista.map((c, i) => [c, i]));
  const bandejas = agrupar(lista, ordenar).map(b => ({
    nombre: b.nombre || '',
    clips: b.clips.map(c => indice.get(c)),
  }));
  const conMarcadores = o.marcadores !== false;
  return {
    v: 1,
    nombre,
    marcadores: conMarcadores,
    secuencia: !!o.secuencia,
    // Sin esto, lo que el proyecto ya tiene se usa tal cual y no se importa otra vez.
    duplicar: !!o.duplicar,
    formato: o.secuencia ? formatoComun(lista) : null,
    // Lo que no se manda porque no se puede leer (se dice en el resumen).
    descartados: Array.isArray(o.descartados) ? o.descartados.slice() : [],
    bandejas,
    orden: lista.map((_, i) => i),
    clips: lista.map(c => {
      const personas = Array.from(new Set((c.personas || []).filter(Boolean)));
      return {
        ruta: c.ruta,
        nombre: c.nombre,
        tipo: c.tipo,
        conectado: c.conectado !== false,
        ancho: c.ancho || 0,
        alto: c.alto || 0,
        fps: c.fps || 0,
        // Textos para las columnas de Premiere: Descripcion y Nota de registro.
        descripcion: String(c.descripcion || '').trim(),
        notaRegistro: [personas.join(', '), String(c.nota || '').trim()].filter(Boolean).join(' · '),
        marcador: conMarcadores && (c.nota || c.descripcion)
          ? { nombre: String(c.nota || '').trim() ? 'Nota' : (personas.join(', ') || 'Pensadero'), texto: [String(c.nota || '').trim(), String(c.descripcion || '').trim()].filter(Boolean).join('\n\n') }
          : null,
        etiqueta: c.favorito ? ETIQUETA_FAVORITO : null,
      };
    }),
  };
}

/**
 * Los clips a otra cadencia que la secuencia, dicho segun el caso: los mas
 * lentos (30 en una de 60) no piden nada; los mas rapidos (60 en una de 30) se
 * ven a velocidad normal, y si se querian a camara lenta hay que interpretarlos.
 * Con la cadencia de cada grupo: «53 clips están grabados a 29,97 fps».
 */
function avisosDeCadencia(clips, fpsSecuencia) {
  const rs = rateDe(fpsSecuencia);
  const real = (r) => (r.ntsc ? r.timebase * 1000 / 1001 : r.timebase);
  const lentos = new Map();
  const rapidos = new Map();
  for (const c of clips) {
    if (c.tipo !== 'video' || !(c.fps > 0)) continue;
    const r = rateDe(c.fps);
    if (r.timebase === rs.timebase && r.ntsc === rs.ntsc) continue;
    const grupo = real(r) < real(rs) ? lentos : rapidos;
    const k = fpsTexto(c.fps);
    grupo.set(k, (grupo.get(k) || 0) + 1);
  }
  const contar = (grupo) => {
    const n = Array.from(grupo.values()).reduce((a, b) => a + b, 0);
    const cadencias = Array.from(grupo.keys());
    const lista = cadencias.length === 1 ? cadencias[0] : `${cadencias.slice(0, -1).join(', ')} y ${cadencias[cadencias.length - 1]}`;
    return { n, texto: `${n === 1 ? '1 clip está grabado' : `${n} clips están grabados`} a ${lista} fps` };
  };
  const sec = fpsTexto(fpsSecuencia);
  const avisos = [];
  if (lentos.size) {
    const { n, texto } = contar(lentos);
    avisos.push(`${texto} y la secuencia va a ${sec}: ${n === 1 ? 'se ve' : 'se ven'} a velocidad normal (Premiere repite fotogramas). No hace falta hacer nada.`);
  }
  if (rapidos.size) {
    const { n, texto } = contar(rapidos);
    avisos.push(`${texto} y la secuencia va a ${sec}: ${n === 1 ? 'se ve' : 'se ven'} a velocidad normal. Si ${n === 1 ? 'lo quieres' : 'los quieres'} a cámara lenta: clic derecho › Modificar › Interpretar material, a ${sec} fps.`);
  }
  return avisos;
}

/**
 * Lo que la extension cuenta al terminar, en frases para la cesta. `r` viene
 * de la extension: { importados, total, faltan: [nombre], noImportados: [nombre],
 * bandeja, secuencia: { nombre, ancho, alto, fps } | null, sinPoder: [texto] }
 */
function explicarResultado(r, plan) {
  const avisos = [];
  const lista = (xs) => xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` y ${xs.length - 3} más` : '');
  if (plan && plan.descartados && plan.descartados.length) {
    const d = plan.descartados;
    avisos.push(`${d.length === 1 ? 'No se envió 1 archivo que no se puede leer' : `No se enviaron ${d.length} archivos que no se pueden leer`} (¿dañado${d.length === 1 ? '' : 's'}?): ${lista(d)}.`);
  }
  if (r.faltan && r.faltan.length) {
    avisos.push(`${r.faltan.length === 1 ? 'No se encontró 1 archivo' : `No se encontraron ${r.faltan.length} archivos`} (¿disco desconectado?): ${lista(r.faltan)}.`);
  }
  if (r.noImportados && r.noImportados.length) {
    avisos.push(`Premiere no pudo importar ${r.noImportados.length === 1 ? '1 archivo' : `${r.noImportados.length} archivos`} (formato que no lee): ${lista(r.noImportados)}.`);
  }
  if (r.secuencia && plan) {
    const clips = plan.clips;
    const forma = formaDe(r.secuencia.ancho, r.secuencia.alto);
    const otra = clips.filter(c => c.tipo !== 'audio' && formaDe(c.ancho, c.alto) && formaDe(c.ancho, c.alto) !== forma).length;
    if (otra > 0) {
      avisos.push(`La secuencia es ${forma} (${r.secuencia.ancho}×${r.secuencia.alto}). ${otra === 1 ? '1 clip tiene otra forma: no se deforma, se ve con bandas o recortado' : `${otra} clips tienen otra forma: no se deforman, se ven con bandas o recortados`}. Para llenar el cuadro: clic derecho › Ajustar al tamaño del cuadro.`);
    }
    if (r.secuencia.fps > 0) {
      avisos.push(...avisosDeCadencia(clips, r.secuencia.fps));
    }
  }
  for (const t of r.sinPoder || []) avisos.push(t);
  return avisos;
}

module.exports = { construirPlan, prevision, formatoComun, formaDe, explicarResultado, avisosDeCadencia, ETIQUETA_FAVORITO };
