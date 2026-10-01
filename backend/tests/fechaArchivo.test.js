// La fecha de un archivo: un solo sitio la decide (utils/fechaArchivo.js).
const test = require('node:test');
const assert = require('node:assert');
const fecha = require('../utils/fechaArchivo');

test('lee los formatos del archivo', () => {
  assert.strictEqual(fecha.deTexto('IMG_20190907_120000.jpg'), 20190907);
  assert.strictEqual(fecha.deTexto('IMG-20190907-WA0001.jpg'), 20190907);
  assert.strictEqual(fecha.deTexto('Captura 2025-03-06 15-40-25.png'), 20250306);
  assert.strictEqual(fecha.deTexto('240816_Cumpleaños Fer'), 20240816);
  assert.strictEqual(fecha.deTexto('EDEM_Bootcamp - 240617'), 20240617);
});

test('regla de siglo unica: AA > 50 es 19AA', () => {
  assert.strictEqual(fecha.deTexto('951225_Navidad'), 19951225);
  assert.strictEqual(fecha.deTexto('191225_Navidad'), 20191225);
});

test('un numero cualquiera no es una fecha', () => {
  assert.strictEqual(fecha.deTexto('Clip_123456.mp4'), 0);
  assert.strictEqual(fecha.deTexto('P1246646.MP4'), 0);
  assert.strictEqual(fecha.deTexto('261340_mes13'), 0); // mes 13
});

test('prioridad: nombre > carpeta > camara > disco', () => {
  const base = { fullPath: 'E:\\Archivo\\260811_Ondara\\P1000001.MP4', name: 'P1000001.MP4', modifiedAt: '2026-09-01T10:00:00Z' };
  assert.strictEqual(fecha.resolver(base).fuente, 'carpeta');
  assert.strictEqual(fecha.resolver(base).dia, 20260811);
  const conNombre = { ...base, name: 'IMG_20250101_120000.jpg' };
  assert.strictEqual(fecha.resolver(conNombre).fuente, 'nombre');
  const sinNada = { fullPath: 'E:\\Movil\\a1b2c3.jpg', name: 'a1b2c3.jpg', modifiedAt: '2026-09-01T10:00:00Z' };
  assert.strictEqual(fecha.resolver(sinNada).fuente, 'disco');
});

test('disco: la mas antigua de creacion y modificacion (una copia no es de hoy)', () => {
  // Volcado hoy: creacion = el dia de la copia, modificacion = la de origen.
  const copiado = { fullPath: 'E:\\TIFF\\scan_001.tif', name: 'scan_001.tif', createdAt: '2026-09-29T21:00:00', modifiedAt: '2019-11-05T10:00:00' };
  assert.deepStrictEqual([fecha.resolver(copiado).fuente, fecha.resolver(copiado).dia], ['disco', 20191105]);
  // Editado despues de crearlo: manda la creacion, que es la de origen.
  const editado = { ...copiado, createdAt: '2024-03-01T10:00:00', modifiedAt: '2025-06-01T10:00:00' };
  assert.strictEqual(fecha.resolver(editado).dia, 20240301);
  // Una fecha rota no tapa la buena.
  assert.strictEqual(fecha.resolver({ ...copiado, createdAt: 'no-es-fecha' }).dia, 20191105);
});

test('aplicar rellena fechaDia y extractedDate a medianoche local', () => {
  const [f] = fecha.aplicar([{ fullPath: 'E:\\A\\190907_Bioritme\\x.jpg', name: 'x.jpg' }]);
  assert.strictEqual(f.fechaDia, 20190907);
  assert.strictEqual(f.extractedDate.getFullYear(), 2019);
  assert.strictEqual(f.extractedDate.getMonth(), 8);
  assert.strictEqual(f.extractedDate.getDate(), 7);
  assert.strictEqual(f.extractedDate.getHours(), 0);
});
