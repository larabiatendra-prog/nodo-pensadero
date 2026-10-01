// Formatos (utils/formatos.js) y version JPG de lo que el navegador no muestra
// (utils/vistaImagen.js). Trabaja en una carpeta temporal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { tipoPorExtension, NO_LEIDOS, IMAGEN_NO_NATIVA } = require('../utils/formatos');
const { vistaJpg } = require('../utils/vistaImagen');

test('MXF es video; RAW se reconoce como no leido; PSD no entra ahi', () => {
  assert.strictEqual(tipoPorExtension('.MXF'), 'video');
  assert.strictEqual(tipoPorExtension('.heic'), 'image');
  assert.strictEqual(tipoPorExtension('.cr3'), null);
  assert.strictEqual(NO_LEIDOS.get('.cr3'), 'RAW de cámara');
  assert.strictEqual(NO_LEIDOS.get('.braw'), 'RAW de cine');
  assert.strictEqual(NO_LEIDOS.has('.psd'), false);
  assert.ok(IMAGEN_NO_NATIVA.has('.tif') && IMAGEN_NO_NATIVA.has('.heic') && !IMAGEN_NO_NATIVA.has('.jpg'));
});

test('un TIFF de 16 bits sale como JPG junto a sus miniaturas, y se reutiliza', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pensadero-vista-'));
  try {
    const tif = path.join(dir, 'maestro.tif');
    await sharp({ create: { width: 3200, height: 2000, channels: 3, background: { r: 120, g: 80, b: 40 } } })
      .toColourspace('rgb16').tiff().toFile(tif);
    const jpg = await vistaJpg(tif, 'abc123');
    assert.strictEqual(jpg, path.join(dir, '.pensadero', 'vistas', 'abc123.jpg'));
    const meta = await sharp(jpg).metadata();
    assert.deepStrictEqual([meta.format, meta.width], ['jpeg', 2560]);
    const antes = fs.statSync(jpg).mtimeMs;
    assert.strictEqual(await vistaJpg(tif, 'abc123'), jpg);
    assert.strictEqual(fs.statSync(jpg).mtimeMs, antes, 'no se rehace si el original no cambio');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
