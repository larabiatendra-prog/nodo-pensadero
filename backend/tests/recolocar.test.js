// Letras cruzadas entre bibliotecas (utils/recolocar.js). Discos inventados.
const test = require('node:test');
const assert = require('node:assert');
const { anotarCruces, planRecolocar } = require('../utils/recolocar');

// Donde esta ahora cada disco (serie -> ruta), como utils/volumen.buscarDisco.
const donde = (mapa) => async (serie) => mapa[serie] || null;

// El caso real: A (6TB) era "D:\(1) WORKS" y ahora esta en G:; B (10TB) era
// "E:\(1) WORKS" y ahora esta en D:.
const bibliotecas = () => [
  { id: 'a', path: 'D:\\(1) WORKS', displayName: '(1) WORKS', volumen: 6 },
  { id: 'b', path: 'E:\\(1) WORKS', displayName: '(1) WORKS', volumen: 10 },
];

test('letras cruzadas: la que ocupa la ruta NO es el mismo disco, y se dice donde esta el suyo', async () => {
  const todas = bibliotecas();
  todas[1].sugerencia = { ruta: 'D:\\(1) WORKS', ocupadaPor: { id: 'a', nombre: '(1) WORKS' } };
  await anotarCruces(todas, todas, donde({ 6: 'G:\\(1) WORKS', 10: 'D:\\(1) WORKS' }));
  assert.deepStrictEqual(todas[1].sugerencia.ocupadaPor, { id: 'a', nombre: '(1) WORKS', mismoDisco: false, suDisco: 'G:\\(1) WORKS' });
});

test('si el disco de la otra no esta conectado, se sabe (suDisco null)', async () => {
  const todas = bibliotecas();
  todas[1].sugerencia = { ruta: 'D:\\(1) WORKS', ocupadaPor: { id: 'a', nombre: '(1) WORKS' } };
  await anotarCruces(todas, todas, donde({ 10: 'D:\\(1) WORKS' }));
  assert.strictEqual(todas[1].sugerencia.ocupadaPor.mismoDisco, false);
  assert.strictEqual(todas[1].sugerencia.ocupadaPor.suDisco, null);
});

test('sin saber que disco es la otra, se da por el mismo (no se cruza a ciegas)', async () => {
  const todas = bibliotecas();
  delete todas[0].volumen;
  todas[1].sugerencia = { ruta: 'D:\\(1) WORKS', ocupadaPor: { id: 'a', nombre: '(1) WORKS' } };
  await anotarCruces(todas, todas, donde({ 10: 'D:\\(1) WORKS' }));
  assert.strictEqual(todas[1].sugerencia.ocupadaPor.mismoDisco, true);
});

test('poner cada disco en su sitio: primero sale la que ocupa, luego entra esta', async () => {
  const plan = await planRecolocar(bibliotecas(), 'b', donde({ 6: 'G:\\(1) WORKS', 10: 'D:\\(1) WORKS' }));
  assert.deepStrictEqual(plan.movimientos, [
    { id: 'a', de: 'D:\\(1) WORKS', a: 'G:\\(1) WORKS' },
    { id: 'b', de: 'E:\\(1) WORKS', a: 'D:\\(1) WORKS' },
  ]);
});

test('desde la otra biblioteca da lo mismo: solo se mueve ella', async () => {
  // A a G: esta libre; B sigue a la espera y ya podra entrar en D:.
  const plan = await planRecolocar(bibliotecas(), 'a', donde({ 6: 'G:\\(1) WORKS', 10: 'D:\\(1) WORKS' }));
  assert.deepStrictEqual(plan.movimientos, [{ id: 'a', de: 'D:\\(1) WORKS', a: 'G:\\(1) WORKS' }]);
});

test('con el disco de la otra desconectado no se hace nada y se explica', async () => {
  const plan = await planRecolocar(bibliotecas(), 'b', donde({ 10: 'D:\\(1) WORKS' }));
  assert.strictEqual(plan.movimientos, undefined);
  assert.strictEqual(plan.esperaOtra, true);
  assert.match(plan.error, /no está conectado/);
});

test('intercambio puro de letras (D por E): no se hace, se pide letra fija', async () => {
  const plan = await planRecolocar(bibliotecas(), 'b', donde({ 6: 'E:\\(1) WORKS', 10: 'D:\\(1) WORKS' }));
  assert.strictEqual(plan.intercambio, true);
  assert.match(plan.error, /Administración de discos/);
});

test('el mismo disco dos veces: el aviso de siempre', async () => {
  const todas = bibliotecas();
  todas[0].volumen = 10;
  const plan = await planRecolocar(todas, 'b', donde({ 10: 'D:\\(1) WORKS' }));
  assert.strictEqual(plan.mismoDisco, true);
});

test('si la ruta del otro disco tambien esta ocupada, se para', async () => {
  const todas = [...bibliotecas(), { id: 'c', path: 'G:\\(1) WORKS', volumen: 99 }];
  const plan = await planRecolocar(todas, 'b', donde({ 6: 'G:\\(1) WORKS', 10: 'D:\\(1) WORKS' }));
  assert.match(plan.error, /Resuelve esa primero/);
});

test('sin disco conectado o sin saber cual es, se dice', async () => {
  assert.strictEqual((await planRecolocar(bibliotecas(), 'b', donde({}))).status, 409);
  const sin = bibliotecas(); delete sin[1].volumen;
  assert.match((await planRecolocar(sin, 'b', donde({}))).error, /no se sabe/i);
  assert.strictEqual((await planRecolocar(bibliotecas(), 'x', donde({}))).status, 404);
});
