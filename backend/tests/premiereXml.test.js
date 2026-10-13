// XML para Premiere (services/premiereXml.js) y la medida con ffprobe de
// routes/premiereRoutes.js. Trabaja en una carpeta temporal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const px = require('../services/premiereXml');
const { ffprobe } = require('../routes/premiereRoutes');

// Comprueba que las etiquetas abren y cierran bien (no hay parser en el proyecto).
function bienFormado(xml) {
  const cuerpo = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '');
  const pila = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(cuerpo))) {
    const [, cierra, nombre, , sola] = m;
    if (sola) continue;
    if (cierra) {
      const abierta = pila.pop();
      if (abierta !== nombre) throw new Error(`</${nombre}> cierra <${abierta}>`);
    } else {
      pila.push(nombre);
    }
  }
  if (pila.length) throw new Error(`sin cerrar: ${pila.join(' > ')}`);
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(cuerpo)) throw new Error('& sin escapar');
  return true;
}

const cuenta = (xml, re) => (xml.match(re) || []).length;

const clips = [
  { nombre: 'P1248495.MP4', ruta: 'W:\\(1) WORKS\\260614_Boda Ana & Pablo\\P1248495.MP4', tipo: 'video',
    duracionS: 10, fps: 59.94, ancho: 3840, alto: 2160, audio: true, canales: 2, frecuencia: 48000,
    dia: 20260614, minuto: 700, carpeta: '260614_Boda Ana & Pablo', personas: ['Ana', 'Pablo'],
    descripcion: 'Los novios salen de la iglesia <entre arroz>', nota: 'La buena', favorito: true },
  { nombre: 'P1248496.MP4', ruta: 'W:\\(1) WORKS\\260614_Boda Ana & Pablo\\P1248496.MP4', tipo: 'video',
    duracionS: 4, fps: 25, ancho: 3840, alto: 2160, audio: false,
    dia: 20260614, minuto: 650, carpeta: '260614_Boda Ana & Pablo', personas: [], descripcion: '', nota: '' },
  { nombre: 'IMG_0001.JPG', ruta: 'C:\\Fotos\\IMG_0001.JPG', tipo: 'image', ancho: 4000, alto: 3000,
    dia: 20260615, carpeta: 'Fotos', personas: ['Ana'] },
  { nombre: 'nota de voz.m4a', ruta: 'C:\\Audio\\nota de voz.m4a', tipo: 'audio', duracionS: 30, audio: true,
    canales: 1, frecuencia: 44100, dia: null, carpeta: 'Audio' },
];

test('cadencias: NTSC a 1000/1001 y enteras tal cual', () => {
  assert.deepStrictEqual(px.rateDe(59.94).timebase, 60);
  assert.strictEqual(px.rateDe(59.94).ntsc, true);
  assert.strictEqual(px.rateDe(29.97002997).ntsc, true);
  assert.deepStrictEqual(px.rateDe(25), { timebase: 25, ntsc: false, real: 25 });
  assert.strictEqual(px.rateDe(0).timebase, 25);
});

test('pathurl escapa cada tramo y conserva la unidad', () => {
  assert.strictEqual(px.pathurl('C:\\Videos\\Año 1 & #2\\a b.mp4'),
    'file://localhost/C%3a/Videos/A%C3%B1o%201%20%26%20%232/a%20b.mp4');
  assert.strictEqual(px.pathurl('\\\\NAS\\video\\x.mov'), 'file://NAS/video/x.mov');
});

test('por día: una bandeja por día, ordenadas, y lo sin fecha al final', () => {
  const b = px.agrupar(clips, 'dia');
  assert.deepStrictEqual(b.map(x => x.nombre), ['14 jun 2026', '15 jun 2026', 'Sin fecha']);
  // Dentro del día, por la hora.
  assert.deepStrictEqual(b[0].clips.map(c => c.nombre), ['P1248496.MP4', 'P1248495.MP4']);
});

test('por persona: un clip con dos personas sale en las dos, y «Sin nadie»', () => {
  const b = px.agrupar(clips, 'persona');
  assert.deepStrictEqual(b.map(x => x.nombre), ['Ana', 'Pablo', 'Sin nadie']);
  assert.strictEqual(b[0].clips.length, 2);
});

test('el XML está bien formado, escapa lo que hay que escapar y cita cada archivo una vez', () => {
  const xml = px.construirXml({ nombre: 'Boda <Ana & Pablo>', ordenar: 'persona', marcadores: true, secuencia: true }, clips);
  assert.ok(bienFormado(xml));
  assert.match(xml, /<xmeml version="4">/);
  assert.match(xml, /<name>Boda &lt;Ana &amp; Pablo&gt;<\/name>/);
  // 4 archivos, cada uno definido una sola vez (con su pathurl).
  assert.strictEqual(cuenta(xml, /<pathurl>/g), 4);
  // La principal y dentro Ana, Pablo, Sin nadie.
  assert.strictEqual(cuenta(xml, /<bin>/g), 4);
  // La forma que Premiere 26.2 importa entera: una sola <bin> y sin <project>.
  assert.match(xml, /<xmeml version="4"><bin><name>Boda &lt;Ana &amp; Pablo&gt;<\/name><children>/);
  assert.ok(xml.trimEnd().endsWith('</children></bin></xmeml>'));
  assert.ok(!xml.includes('<project>'));
  // El favorito lleva etiqueta de color y la nota va como marcador.
  assert.match(xml, /<label2>Mango<\/label2>/);
  assert.match(xml, /<marker><name>Nota<\/name><comment>La buena<\/comment>/);
  assert.match(xml, /<lognote>Ana, Pablo<\/lognote>/);
  // 10 s a 59,94 = 599 fotogramas en base 60 NTSC.
  assert.match(xml, /<duration>599<\/duration><rate><timebase>60<\/timebase><ntsc>TRUE<\/ntsc><\/rate>/);
  // El video sin sonido no tiene pista de audio en su clip.
  const sinSonido = xml.slice(xml.indexOf('<name>P1248496.MP4</name><media>'));
  assert.ok(!sinSonido.slice(0, sinSonido.indexOf('</media>')).includes('<audio>'));
});

test('la secuencia toma el formato más común y pone los clips seguidos', () => {
  const xml = px.construirXml({ nombre: 'S', ordenar: 'todo', secuencia: true }, clips);
  assert.ok(bienFormado(xml));
  const seq = xml.slice(xml.indexOf('<sequence'));
  assert.match(seq, /<width>3840<\/width><height>2160<\/height>/);
  // Video 10 s + video 4 s + foto 5 s en la pista de video (base 60 NTSC).
  assert.match(seq, /<start>0<\/start><end>599<\/end>/);
  assert.match(seq, /<start>599<\/start><end>839<\/end>/);
  assert.match(seq, /<start>839<\/start><end>1139<\/end>/);
  // Con «todo junto», solo la principal, sin sub-bandejas.
  assert.strictEqual(cuenta(xml, /<bin>/g), 1);
});

test('sin marcadores no hay <marker>; sin secuencia no hay <sequence>', () => {
  const xml = px.construirXml({ nombre: 'S', ordenar: 'dia', marcadores: false, secuencia: false }, clips);
  assert.strictEqual(cuenta(xml, /<marker>/g), 0);
  assert.strictEqual(cuenta(xml, /<sequence/g), 0);
});

test('avisa de cadencias mezcladas y limpia el nombre de archivo', () => {
  assert.deepStrictEqual(px.cadenciasDistintas(clips), [25, 59.94]);
  assert.strictEqual(px.nombreDeArchivo('Boda: Ana/Pablo?'), 'Boda_ Ana_Pablo_.xml');
  assert.strictEqual(px.nombreDeArchivo('  '), 'Pensadero.xml');
});

test('ffprobe mide un video real: duración, cadencia, tamaño y sonido', async (t) => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { t.skip('sin ffmpeg'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pensadero-premiere-'));
  try {
    const v = path.join(dir, 'prueba ñ.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30000/1001',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-pix_fmt', 'yuv420p', '-shortest', v]);
    const m = await ffprobe(v);
    assert.strictEqual(m.ancho, 320);
    assert.strictEqual(m.alto, 240);
    assert.ok(Math.abs(m.fps - 29.97) < 0.01);
    assert.ok(m.duracionS > 1.9 && m.duracionS < 2.2);
    assert.strictEqual(m.audio, true);
    assert.strictEqual(await ffprobe(path.join(dir, 'no-existe.mp4')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ffprobe da las medidas como se ven: un video con giro 90 sale vertical', async (t) => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { t.skip('sin ffmpeg'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pensadero-premiere-giro-'));
  try {
    const plano = path.join(dir, 'plano.mp4');
    const girado = path.join(dir, 'girado.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '1', '-pix_fmt', 'yuv420p', plano]);
    execFileSync('ffmpeg', ['-v', 'error', '-display_rotation', '90', '-i', plano, '-c', 'copy', girado]);
    const m = await ffprobe(girado);
    assert.strictEqual(m.ancho, 360);
    assert.strictEqual(m.alto, 640);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prevision: la secuencia toma la forma de la mayoria y cuenta lo que no encaja', () => {
  const { prevision } = require('../services/premierePlan');
  const p = prevision([
    { tipo: 'video', ancho: 2160, alto: 3840, fps: 59.94 },
    { tipo: 'video', ancho: 3840, alto: 2160, fps: 29.97 },
    { tipo: 'video', ancho: 3840, alto: 2160, fps: 29.97 },
    { tipo: 'image', ancho: 4000, alto: 3000 },
  ], true);
  assert.strictEqual(p.forma, 'horizontal');
  assert.strictEqual(p.ancho, 3840);
  assert.strictEqual(p.otraForma, 1);
  assert.strictEqual(p.otroTamano, 1);
  assert.strictEqual(p.otraCadencia, 1);
  assert.strictEqual(p.fpsTexto, '29,97');
  assert.strictEqual(prevision([{ tipo: 'video', ancho: 1, alto: 1, fps: 25 }], false), null);
});

test('cadencias: dice a cuanto esta grabado cada grupo y si hay que hacer algo', () => {
  const { avisosDeCadencia } = require('../services/premierePlan');
  const v = (fps) => ({ tipo: 'video', fps });
  // Lo del 13/10/2026: secuencia a 59,94 y clips a 29,97 y 25 -> nada que hacer.
  const lentos = avisosDeCadencia([v(59.94), v(29.97), v(29.97), v(25)], 59.94);
  assert.deepStrictEqual(lentos, ['3 clips están grabados a 29,97 y 25 fps y la secuencia va a 59,94: se ven a velocidad normal (Premiere repite fotogramas). No hace falta hacer nada.']);
  // Al reves: 60 en una de 30 -> como hacer camara lenta.
  const rapidos = avisosDeCadencia([v(29.97), v(59.94)], 29.97);
  assert.strictEqual(rapidos.length, 1);
  assert.match(rapidos[0], /^1 clip está grabado a 59,94 fps y la secuencia va a 29,97: se ve a velocidad normal\. Si lo quieres a cámara lenta: clic derecho › Modificar › Interpretar material, a 29,97 fps\.$/);
  // Todo a la misma cadencia: nada que decir.
  assert.deepStrictEqual(avisosDeCadencia([v(25), v(25)], 25), []);
});
