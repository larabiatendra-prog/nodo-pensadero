// Version ligera de un video con giro (camara en vertical): tiene que salir
// en vertical y con pixeles cuadrados, no aplastada en un cuadro apaisado
// (P1004601, 12/10/2026). Trabaja en una carpeta temporal.
process.env.VIDEO_PROXY_MAX_HEIGHT = '180';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const vps = require('../services/videoProxyService');

test('las medidas de salida van ya giradas y limitan el lado corto', () => {
  // 4096x2160 con giro 90 se ve 2160x4096: el lado corto (2160) baja a 180.
  assert.deepStrictEqual(vps._outputDims(4096, 2160, 90), { outW: 180, outH: 342, downscaled: true });
  assert.deepStrictEqual(vps._outputDims(4096, 2160, 0), { outW: 342, outH: 180, downscaled: true });
  // Pequeño: ni se toca.
  assert.deepStrictEqual(vps._outputDims(320, 180, 90), { outW: 180, outH: 320, downscaled: false });
});

test('una version ligera girada y reducida con la regla vieja se rehace', () => {
  assert.strictEqual(vps._malGirado({ status: 'ready', downscaled: true, rot: 90 }), true);
  assert.strictEqual(vps._malGirado({ status: 'ready', downscaled: true, rot: 90, giroBien: true }), false);
  assert.strictEqual(vps._malGirado({ status: 'ready', downscaled: true, rot: 0 }), false);
  assert.strictEqual(vps._malGirado({ status: 'ready', downscaled: false, rot: 90 }), false);
});

test('ffmpeg: un video con giro 90 sale en vertical y con pixeles cuadrados', async (t) => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { t.skip('sin ffmpeg'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pensadero-giro-'));
  try {
    const plano = path.join(dir, 'plano.mp4');
    const girado = path.join(dir, 'girado.mp4');
    const salida = path.join(dir, 'ligera.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '1', '-pix_fmt', 'yuv420p', plano]);
    // Lo que hace la camara: guarda apaisado y apunta "gira 90".
    execFileSync('ffmpeg', ['-v', 'error', '-display_rotation', '90', '-i', plano, '-c', 'copy', girado]);
    const info = await vps.probe(girado);
    assert.ok(info.rotacion === 90 || info.rotacion === 270, `giro leido: ${info.rotacion}`);
    const dims = vps._outputDims(info.width, info.height, info.rotacion);
    execFileSync('ffmpeg', vps._buildArgs({ kind: 'transcode', input: girado, output: salida, dims, modo: 'cpu' }), { stdio: 'ignore' });
    const r = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,sample_aspect_ratio', '-of', 'json', salida]).toString());
    const v = r.streams[0];
    assert.strictEqual(v.width, 180);
    assert.strictEqual(v.height, 320);
    assert.ok(!v.sample_aspect_ratio || v.sample_aspect_ratio === '1:1', `SAR ${v.sample_aspect_ratio}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
