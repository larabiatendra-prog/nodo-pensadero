// Los niveles de la preparacion de proxies (services/videoProxyService.js):
// del mas rapido (todo en la grafica) al que vale en cualquier equipo.
const test = require('node:test');
const assert = require('node:assert');
const vps = require('../services/videoProxyService');

const cuatroK = { rotacion: 0, width: 4096, height: 2160, vcodec: 'h264', pixfmt: 'yuv422p10le' };
const movil = { rotacion: 90, width: 1920, height: 1080, vcodec: 'hevc', pixfmt: 'yuv420p' };

// Simula ffmpeg: cada modo sale o falla segun el equipo.
const equipo = (salen) => async (modo) => ({ code: salen.includes(modo) ? 0 : 1 });

test('sin saber nada del equipo, del mas rapido al de siempre', () => {
  vps._reiniciarAprendido();
  assert.deepStrictEqual(vps._modosPara(cuatroK), ['gpu', 'gpu-lee', 'nvenc', 'cpu']);
});

test('un video girado (o sin saber su giro) nunca va entero por la grafica: saldria tumbado', () => {
  vps._reiniciarAprendido();
  assert.deepStrictEqual(vps._modosPara(movil), ['gpu-lee', 'nvenc', 'cpu']);
  assert.deepStrictEqual(vps._modosPara({ width: 1920, height: 1080 }), ['gpu-lee', 'nvenc', 'cpu']);
});

test('sin NVIDIA: el primer video paga los intentos y los demas van directos al procesador', async () => {
  vps._reiniciarAprendido();
  const intentos = [];
  const { modo } = await vps._conRespaldo(cuatroK, async (m) => { intentos.push(m); return equipo(['cpu'])(m); });
  assert.strictEqual(modo, 'cpu');
  assert.deepStrictEqual(intentos, ['gpu', 'gpu-lee', 'nvenc', 'cpu']);
  assert.deepStrictEqual(vps._modosPara(cuatroK), ['cpu']);
});

test('una grafica que no lee ese formato: se deja de intentar todo-en-grafica solo para ese tipo', async () => {
  vps._reiniciarAprendido();
  // Como una GTX 1050 con el 4:2:2 de camara: 'gpu' falla, 'gpu-lee' sale (lee el procesador).
  const { modo } = await vps._conRespaldo(cuatroK, equipo(['gpu-lee', 'nvenc', 'cpu']));
  assert.strictEqual(modo, 'gpu-lee');
  assert.deepStrictEqual(vps._modosPara(cuatroK), ['gpu-lee', 'nvenc', 'cpu']);
  const otro = { ...cuatroK, vcodec: 'hevc', pixfmt: 'yuv420p10le' };
  assert.strictEqual(vps._modosPara(otro)[0], 'gpu');
});

test('grafica que codifica pero no lee: se queda en nvenc', async () => {
  vps._reiniciarAprendido();
  const { modo } = await vps._conRespaldo(cuatroK, equipo(['nvenc', 'cpu']));
  assert.strictEqual(modo, 'nvenc');
  assert.deepStrictEqual(vps._modosPara(cuatroK), ['nvenc', 'cpu']);
});

test('un archivo roto (falla todo) no apaga la grafica', async () => {
  vps._reiniciarAprendido();
  const { modo } = await vps._conRespaldo(cuatroK, equipo([]));
  assert.strictEqual(modo, null);
  assert.deepStrictEqual(vps._modosPara(cuatroK), ['gpu', 'gpu-lee', 'nvenc', 'cpu']);
});

test('argumentos: todo en la grafica reduce con scale_cuda y sin -pix_fmt; los demas como siempre', () => {
  const dims = { outW: 2048, outH: 1080, downscaled: true };
  const gpu = vps._buildArgs({ kind: 'transcode', input: 'in.mov', output: 'out.mp4', dims, modo: 'gpu' });
  assert.deepStrictEqual(gpu.slice(0, 6), ['-y', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i']);
  assert.ok(gpu.includes('scale_cuda=2048:1080:format=nv12'));
  assert.ok(!gpu.includes('-pix_fmt'));
  assert.ok(gpu.includes('h264_nvenc'));

  const lee = vps._buildArgs({ kind: 'transcode', input: 'in.mov', output: 'out.mp4', dims, modo: 'gpu-lee' });
  assert.deepStrictEqual(lee.slice(0, 4), ['-y', '-hwaccel', 'cuda', '-i']);
  assert.ok(lee.includes('scale=2048:1080') && lee.includes('yuv420p'));

  const cpu = vps._buildArgs({ kind: 'transcode', input: 'in.mov', output: 'out.mp4', dims, modo: 'cpu' });
  assert.ok(!cpu.includes('-hwaccel'));
  assert.ok(cpu.includes('libx264') && !cpu.includes('h264_nvenc'));
});

test('sin reducir, un 10 bits igual pasa por scale_cuda para quedarse en 8 bits', () => {
  const dims = { outW: 1919, outH: 1081, downscaled: false };
  const gpu = vps._buildArgs({ kind: 'transcode', input: 'in.mov', output: 'out.mp4', dims, modo: 'gpu' });
  assert.ok(gpu.includes('scale_cuda=1918:1080:format=nv12'), 'medidas pares');
});
