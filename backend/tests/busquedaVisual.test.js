// Indice visual: huella compacta, momentos de los videos y busqueda.
// Todo en memoria: no se llama a load() ni a save(), no se toca ningun archivo.
const test = require('node:test');
const assert = require('node:assert');
const clipIndex = require('../clipIndex');
const momentos = require('../services/momentosVideo');

const D = 768;
function huella(semilla) {
  // Vector normalizado reproducible
  const v = new Float32Array(D);
  let x = semilla;
  for (let i = 0; i < D; i++) { x = (x * 16807) % 2147483647; v[i] = (x / 2147483647) - 0.5; }
  const n = Math.hypot(...v);
  for (let i = 0; i < D; i++) v[i] /= n;
  return v;
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

test('la huella compacta (int8) casi no cambia el parecido', () => {
  const a = huella(1);
  const b = huella(2);
  const d = clipIndex.descomprimirHuella(clipIndex.comprimirHuella(a));
  assert.ok(d);
  const reconstruida = Array.from(d.q, x => x * d.escala);
  assert.ok(Math.abs(dot(reconstruida, a) - 1) < 0.01, 'consigo misma ~1');
  assert.ok(Math.abs(dot(reconstruida, b) - dot(a, b)) < 0.01, 'con otra, casi igual');
  assert.strictEqual(clipIndex.comprimirHuella(a).length, 1032);
});

test('un video se encuentra por cualquiera de sus momentos', () => {
  const medio = huella(10);
  const otroMomento = huella(11);
  const foto = huella(12);
  clipIndex.upsert('video-prueba', medio);
  clipIndex.upsert('foto-prueba', foto);
  // Sin momentos, la consulta "otro momento" no casa con el video
  let r = clipIndex.searchNearestAny([otroMomento], 5, id => id.endsWith('-prueba'));
  const antes = r.find(x => x.fileId === 'video-prueba').similarity;
  clipIndex.setMomentos('video-prueba', [{ t: 3, emb: otroMomento }]);
  r = clipIndex.searchNearestAny([otroMomento], 5, id => id.endsWith('-prueba'));
  assert.strictEqual(r[0].fileId, 'video-prueba');
  assert.ok(r[0].similarity > 0.99 && r[0].similarity > antes);
  assert.strictEqual(clipIndex.numMomentos('video-prueba'), 1);
  // Quitar el archivo se lleva sus momentos
  clipIndex.remove('video-prueba');
  clipIndex.remove('foto-prueba');
  assert.strictEqual(clipIndex.numMomentos('video-prueba'), 0);
});

test('el filtro se aplica dentro de la busqueda (no despues)', () => {
  clipIndex.upsert('visible-prueba', huella(20));
  clipIndex.upsert('oculto-prueba', huella(20));
  const r = clipIndex.searchNearestAny([huella(20)], 1, id => id === 'visible-prueba');
  assert.deepStrictEqual(r.map(x => x.fileId), ['visible-prueba']);
  clipIndex.remove('visible-prueba');
  clipIndex.remove('oculto-prueba');
});

test('calendario de momentos segun la duracion', () => {
  assert.deepStrictEqual(momentos.instantesPara(0.5), []);
  assert.deepStrictEqual(momentos.instantesPara(12), [0.6, 11.4]);          // 3 huellas contando el medio
  assert.strictEqual(momentos.instantesPara(60).length, 5);                   // 6 huellas
  assert.strictEqual(momentos.instantesPara(3600).length, 11);                // tope de 12
  // Lo que ya guardo el escaneo (5% y 95%) no se repite
  assert.deepStrictEqual(momentos.instantesQueFaltan(12, [{ t: 0.6 }, { t: 11.4 }]), []);
  assert.deepStrictEqual(momentos.instantesQueFaltan(60, [{ t: 3 }, { t: 57 }]), [13.8, 35.4, 46.2]);
});
