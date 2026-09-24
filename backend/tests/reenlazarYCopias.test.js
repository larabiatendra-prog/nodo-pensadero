// Archivos movidos y copias exactas: reglas puras, sin disco.
const test = require('node:test');
const assert = require('node:assert');
const reenlazar = require('../services/reenlazar');
const copias = require('../services/copiasExactas');

const f = (id, nombre, size, ms) => ({ id, name: nombre, fullPath: `E:\\${id}\\${nombre}`, size, modifiedAt: new Date(ms).toISOString() });

test('un archivo movido casa por nombre, tamaño y fecha', () => {
  const pares = reenlazar.emparejar([f('viejo', 'P1.MP4', 100, 1000)], [f('nuevo', 'P1.MP4', 100, 1000)]);
  assert.strictEqual(pares.length, 1);
  assert.strictEqual(pares[0].de.id, 'viejo');
  assert.strictEqual(pares[0].a.id, 'nuevo');
});

test('con dos candidatos no se casa nada (mejor no reenlazar que reenlazar mal)', () => {
  const pares = reenlazar.emparejar([f('viejo', 'P1.MP4', 100, 1000)], [f('n1', 'P1.MP4', 100, 1000), f('n2', 'P1.MP4', 100, 1000)]);
  assert.strictEqual(pares.length, 0);
});

test('otro tamaño u otra fecha no es el mismo archivo', () => {
  assert.strictEqual(reenlazar.emparejar([f('v', 'P1.MP4', 100, 1000)], [f('n', 'P1.MP4', 101, 1000)]).length, 0);
  assert.strictEqual(reenlazar.emparejar([f('v', 'P1.MP4', 100, 1000)], [f('n', 'P1.MP4', 100, 2000)]).length, 0);
});

test('copias exactas: se queda la que tiene algo tuyo, y si no, la que no es de backup', () => {
  const bibliotecas = new Map([
    ['orig', { orden: 0 }],
    ['backup', { orden: 1, copiaSeguridad: true }],
  ]);
  const a = { id: 'a', libraryId: 'orig', fullPath: 'E:\\a.jpg' };
  const b = { id: 'b', libraryId: 'backup', fullPath: 'F:\\b.jpg' };
  const nadaTuyo = () => ({});
  assert.strictEqual(copias._proponer([b, a], bibliotecas, nadaTuyo).file.id, 'a');
  const favoritoEnBackup = (x) => ({ favorito: x.id === 'b' });
  const r = copias._proponer([a, b], bibliotecas, favoritoEnBackup);
  assert.strictEqual(r.file.id, 'b');
  assert.match(r.motivo, /tiene algo tuyo/);
});
