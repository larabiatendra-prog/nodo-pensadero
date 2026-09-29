// Apuntes sin archivo tras un cambio de letra (utils/huerfanosPorLetra.js).
// Rutas y bibliotecas inventadas.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { paresParaHuerfanos, clasificar } = require('../utils/huerfanosPorLetra');

const idDe = (ruta) => crypto.createHash('md5').update(ruta).digest('hex');
const archivo = (fullPath, mediaKey, extra = {}) => ({
  id: idDe(fullPath), mediaKey, fullPath, name: fullPath.split('\\').pop(), size: 100, modifiedAt: '2024-01-01T00:00:00Z', ...extra,
});
const BIBLIOTECAS = { aaaa: 'W:\\Trabajos', bbbb: 'X:\\Trabajos', cccc: 'C:\\Fotos' };

test('un id de cuando el disco era D: va al archivo que ahora esta en X:', () => {
  const f = archivo('X:\\Trabajos\\a\\clip.mov', 'bbbb:a/clip.mov');
  const viejo = idDe('D:\\Trabajos\\a\\clip.mov');
  const pares = paresParaHuerfanos([f], [{ id: viejo }], idDe, BIBLIOTECAS);
  assert.deepStrictEqual(pares, [{ de: { id: viejo, mediaKey: null, fullPath: null }, a: { id: f.id, mediaKey: f.mediaKey, fullPath: f.fullPath, name: 'clip.mov' } }]);
});

test('lo que tiene su archivo (aunque el disco no este) no se toca', () => {
  const f = archivo('F:\\Otro\\clip.mov', 'dddd:clip.mov');
  const x = archivo('X:\\Otro\\clip.mov', 'bbbb:otro/clip.mov');
  assert.deepStrictEqual(paresParaHuerfanos([f, x], [{ id: f.id }, { mediaKey: f.mediaKey }], idDe, BIBLIOTECAS), []);
});

test('una nota apuntada a la biblioteca gemela va al archivo de la otra', () => {
  // Con las letras cruzadas, la biblioteca del disco de 6 TB leyo el de 10 TB.
  const f = archivo('X:\\Trabajos\\viaje\\video.mp4', 'bbbb:viaje/video.mp4');
  const pares = paresParaHuerfanos([f], [{ mediaKey: 'aaaa:viaje/video.mp4' }], idDe, BIBLIOTECAS);
  assert.strictEqual(pares.length, 1);
  assert.strictEqual(pares[0].a.id, f.id);
});

test('entre bibliotecas que no son gemelas no se empareja por nombre', () => {
  // Una camara repite nombres: P1000001.JPG en otra biblioteca es otra foto.
  const f = archivo('C:\\Fotos\\dcim\\p1000001.jpg', 'cccc:dcim/p1000001.jpg');
  assert.deepStrictEqual(paresParaHuerfanos([f], [{ mediaKey: 'aaaa:dcim/p1000001.jpg' }], idDe, BIBLIOTECAS), []);
});

test('una biblioteca que ya no existe no empareja por nombre', () => {
  const f = archivo('X:\\Trabajos\\video.mp4', 'bbbb:video.mp4');
  assert.deepStrictEqual(paresParaHuerfanos([f], [{ mediaKey: 'zzzz:video.mp4' }], idDe, BIBLIOTECAS), []);
});

test('dos candidatos que son copias identicas: a los dos', () => {
  const w = archivo('W:\\Trabajos\\botanic\\p1.jpg', 'aaaa:botanic/p1.jpg');
  const x = archivo('X:\\Trabajos\\botanic\\p1.jpg', 'bbbb:botanic/p1.jpg');
  const viejo = idDe('D:\\Trabajos\\botanic\\p1.jpg');
  const pares = paresParaHuerfanos([w, x], [{ id: viejo }], idDe, BIBLIOTECAS);
  assert.deepStrictEqual(pares.map(p => p.a.fullPath).sort(), [w.fullPath, x.fullPath]);
});

test('dos candidatos distintos: no se adivina', () => {
  const w = archivo('W:\\Trabajos\\p1.jpg', 'aaaa:p1.jpg', { size: 100 });
  const x = archivo('X:\\Trabajos\\p1.jpg', 'bbbb:p1.jpg', { size: 999 });
  assert.deepStrictEqual(paresParaHuerfanos([w, x], [{ id: idDe('D:\\Trabajos\\p1.jpg') }], idDe, BIBLIOTECAS), []);
});

test('un favorito antiguo guardado por ruta sigue a la otra letra', () => {
  const f = archivo('X:\\Trabajos\\clip.mov', 'bbbb:clip.mov');
  const pares = paresParaHuerfanos([f], [{ ruta: 'd:\\trabajos\\clip.mov' }], idDe, BIBLIOTECAS);
  assert.strictEqual(pares.length, 1);
  assert.strictEqual(pares[0].de.fullPath, 'd:\\trabajos\\clip.mov');
});

test('sin huerfanos no se calcula nada', () => {
  let llamadas = 0;
  const cuenta = (r) => { llamadas++; return idDe(r); };
  const f = archivo('X:\\Trabajos\\clip.mov', 'bbbb:clip.mov');
  assert.deepStrictEqual(paresParaHuerfanos([f], [{ id: f.id }], cuenta, BIBLIOTECAS), []);
  assert.strictEqual(llamadas, 0);
});

test('clasificar claves de los almacenes', () => {
  assert.deepStrictEqual(clasificar('f0c11bf81c3390fdf109740c5dc1a936'), { id: 'f0c11bf81c3390fdf109740c5dc1a936' });
  assert.deepStrictEqual(clasificar('c:\\video\\a.mp4'), { ruta: 'c:\\video\\a.mp4' });
  assert.deepStrictEqual(clasificar('2b882c4362d6397e:260202_lore/p1.mp4'), { mediaKey: '2b882c4362d6397e:260202_lore/p1.mp4' });
  assert.strictEqual(clasificar(''), null);
});
