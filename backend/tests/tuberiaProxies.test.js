// Los niveles de la preparacion de proxies (services/videoProxyService.js):
// del mas rapido (todo en la grafica NVIDIA) al que vale en cualquier equipo,
// pasando por AMD e Intel.
const test = require('node:test');
const assert = require('node:assert');
const vps = require('../services/videoProxyService');

const cuatroK = { rotacion: 0, width: 4096, height: 2160, vcodec: 'h264', pixfmt: 'yuv422p10le' };
const movil = { rotacion: 90, width: 1920, height: 1080, vcodec: 'hevc', pixfmt: 'yuv420p' };
const TODOS = ['gpu', 'gpu-lee', 'nvenc', 'amf-lee', 'amf', 'qsv-lee', 'qsv', 'cpu'];

// Simula ffmpeg: cada modo sale o falla segun el equipo.
const equipo = (salen) => async (modo) => ({ code: salen.includes(modo) ? 0 : 1 });

async function primerVideo(salen, info = cuatroK) {
  vps._reiniciarAprendido();
  const intentos = [];
  const { modo } = await vps._conRespaldo(info, async (m) => { intentos.push(m); return equipo(salen)(m); });
  return { modo, intentos, despues: vps._modosPara(info) };
}

test('sin saber nada del equipo: NVIDIA, AMD, Intel y el procesador, del mas rapido al de siempre', () => {
  vps._reiniciarAprendido();
  assert.deepStrictEqual(vps._modosPara(cuatroK), TODOS);
});

test('un video girado (o sin saber su giro) nunca va entero por la grafica NVIDIA: saldria tumbado', () => {
  vps._reiniciarAprendido();
  assert.deepStrictEqual(vps._modosPara(movil), TODOS.slice(1));
  assert.deepStrictEqual(vps._modosPara({ width: 1920, height: 1080 }), TODOS.slice(1));
});

test('sin ninguna grafica: el primer video paga los intentos y los demas van directos al procesador', async () => {
  const { modo, intentos, despues } = await primerVideo(['cpu']);
  assert.strictEqual(modo, 'cpu');
  assert.deepStrictEqual(intentos, TODOS);
  assert.deepStrictEqual(despues, ['cpu']);
});

test('con NVIDIA que funciona entera, lo demas ni se intenta', async () => {
  const { modo, intentos } = await primerVideo(TODOS);
  assert.strictEqual(modo, 'gpu');
  assert.deepStrictEqual(intentos, ['gpu']);
});

test('una grafica NVIDIA que no lee ese formato: deja todo-en-grafica solo para ese tipo', async () => {
  // Como una GTX 1050 con el 4:2:2 de camara: 'gpu' falla, 'gpu-lee' sale (lee el procesador).
  const { modo, despues } = await primerVideo(TODOS.filter(m => m !== 'gpu'));
  assert.strictEqual(modo, 'gpu-lee');
  assert.strictEqual(despues[0], 'gpu-lee');
  assert.strictEqual(vps._modosPara({ ...cuatroK, vcodec: 'hevc', pixfmt: 'yuv420p10le' })[0], 'gpu');
});

test('NVIDIA que codifica pero no lee: se queda en nvenc', async () => {
  const { modo, despues } = await primerVideo(['nvenc', 'cpu']);
  assert.strictEqual(modo, 'nvenc');
  assert.strictEqual(despues[0], 'nvenc');
  assert.ok(!despues.includes('gpu-lee'));
});

test('solo AMD: NVIDIA se descarta y se queda en AMD leyendo y codificando', async () => {
  const { modo, despues } = await primerVideo(['amf-lee', 'amf', 'cpu']);
  assert.strictEqual(modo, 'amf-lee');
  assert.deepStrictEqual(despues, ['amf-lee', 'amf', 'qsv-lee', 'qsv', 'cpu']);
});

test('dos graficas (la lectura cae en la que no es): AMD solo codifica', async () => {
  const { modo, despues } = await primerVideo(['amf', 'cpu']);
  assert.strictEqual(modo, 'amf');
  assert.deepStrictEqual(despues, ['amf', 'qsv-lee', 'qsv', 'cpu']);
});

test('solo Intel: se descartan NVIDIA y AMD', async () => {
  const { modo, despues } = await primerVideo(['qsv-lee', 'qsv', 'cpu']);
  assert.strictEqual(modo, 'qsv-lee');
  assert.deepStrictEqual(despues, ['qsv-lee', 'qsv', 'cpu']);
});

test('un archivo roto (falla todo) no apaga ninguna grafica', async () => {
  const { modo, despues } = await primerVideo([]);
  assert.strictEqual(modo, null);
  assert.deepStrictEqual(despues, TODOS);
});

const dims = { outW: 2048, outH: 1080, downscaled: true };
const args = (modo) => vps._buildArgs({ kind: 'transcode', input: 'in.mov', output: 'out.mp4', dims, modo });

test('argumentos NVIDIA: todo en la grafica reduce con scale_cuda y sin -pix_fmt', () => {
  const gpu = args('gpu');
  assert.deepStrictEqual(gpu.slice(0, 6), ['-y', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i']);
  assert.ok(gpu.includes('scale_cuda=2048:1080:format=nv12'));
  assert.ok(!gpu.includes('-pix_fmt'));
  assert.ok(gpu.includes('h264_nvenc'));
  const lee = args('gpu-lee');
  assert.deepStrictEqual(lee.slice(0, 4), ['-y', '-hwaccel', 'cuda', '-i']);
  assert.ok(lee.includes('scale=2048:1080') && lee.includes('yuv420p'));
});

test('argumentos AMD e Intel: su codificador, nv12, objetivo 4M con techo 5M; leer con d3d11va', () => {
  for (const [modo, codec, lee] of [['amf-lee', 'h264_amf', true], ['amf', 'h264_amf', false], ['qsv-lee', 'h264_qsv', true], ['qsv', 'h264_qsv', false]]) {
    const a = args(modo);
    assert.ok(a.includes(codec), modo);
    assert.strictEqual(a[a.indexOf('-pix_fmt') + 1], 'nv12', modo);
    assert.strictEqual(a[a.indexOf('-b:v') + 1], '4M', modo);
    assert.strictEqual(a[a.indexOf('-maxrate') + 1], '5M', modo);
    assert.strictEqual(a.includes('d3d11va'), lee, modo);
    assert.ok(a.includes('scale=2048:1080'), modo);
  }
});

test('argumentos del procesador: libx264, sin grafica', () => {
  const cpu = args('cpu');
  assert.ok(!cpu.includes('-hwaccel'));
  assert.ok(cpu.includes('libx264') && !cpu.includes('h264_nvenc'));
});

test('sin reducir, un 10 bits igual pasa por scale_cuda para quedarse en 8 bits', () => {
  const gpu = vps._buildArgs({ kind: 'transcode', input: 'in.mov', output: 'out.mp4', dims: { outW: 1919, outH: 1081, downscaled: false }, modo: 'gpu' });
  assert.ok(gpu.includes('scale_cuda=1918:1080:format=nv12'), 'medidas pares');
});
