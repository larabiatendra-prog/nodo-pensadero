// Reaprovechar el escaneo de una copia exacta (utils/reaprovecharCopias.js).
// Rutas y entradas inventadas.
const test = require('node:test');
const assert = require('node:assert');
const { reaprovechables, entradaCopiada, cubre } = require('../utils/reaprovecharCopias');

// Como trabajoHecho del escaneo: sin marca `escaneo`, se escaneo con todo.
const hecho = (e, cap) => (e && e.escaneo && typeof e.escaneo[cap] === 'boolean' ? e.escaneo[cap] : !!e);
const completa = { description_what: 'Dos personas en una playa', escaneo: { descripcion: true, caras: true, busquedaVisual: true }, clip_embedding_b64: 'AAA=' };
const PLAN_FOTO = { descripcion: true, caras: true, busquedaVisual: true, movimiento: false };

function deps(copias, entradas) {
  return {
    copiasDe: (r) => copias[r] || [],
    entradaDe: async (r) => entradas[r] || null,
    hecho,
  };
}

test('una copia ya escaneada se reaprovecha', async () => {
  const r = await reaprovechables(
    [{ ruta: 'W:\\T\\a.jpg', plan: PLAN_FOTO }],
    deps({ 'W:\\T\\a.jpg': ['X:\\T\\a.jpg'] }, { 'X:\\T\\a.jpg': completa }),
  );
  assert.deepStrictEqual([...r.keys()], ['W:\\T\\a.jpg']);
  assert.strictEqual(r.get('W:\\T\\a.jpg').de, 'X:\\T\\a.jpg');
});

test('lo que solo esta en un disco se escanea normal', async () => {
  const r = await reaprovechables([{ ruta: 'W:\\T\\solo.jpg', plan: PLAN_FOTO }], deps({}, {}));
  assert.strictEqual(r.size, 0);
});

test('si a la copia le falta algo de lo pedido, se escanea normal', async () => {
  const sinCaras = { ...completa, escaneo: { descripcion: true, caras: false, busquedaVisual: true } };
  const r = await reaprovechables(
    [{ ruta: 'W:\\a.jpg', plan: PLAN_FOTO }],
    deps({ 'W:\\a.jpg': ['X:\\a.jpg'] }, { 'X:\\a.jpg': sinCaras }),
  );
  assert.strictEqual(r.size, 0);
});

test('si lo pedido es menos, basta con que la copia tenga eso', async () => {
  const sinCaras = { ...completa, escaneo: { descripcion: true, caras: false, busquedaVisual: true } };
  const r = await reaprovechables(
    [{ ruta: 'W:\\a.jpg', plan: { descripcion: true, caras: false, busquedaVisual: true } }],
    deps({ 'W:\\a.jpg': ['X:\\a.jpg'] }, { 'X:\\a.jpg': sinCaras }),
  );
  assert.strictEqual(r.size, 1);
});

test('una copia marcada con descripcion pero sin texto no vale', async () => {
  const vacia = { escaneo: { descripcion: true, caras: true, busquedaVisual: true } };
  assert.strictEqual(cubre(vacia, PLAN_FOTO, hecho), false);
});

test('prueba la siguiente copia si la primera no vale', async () => {
  const r = await reaprovechables(
    [{ ruta: 'W:\\a.jpg', plan: PLAN_FOTO }],
    deps({ 'W:\\a.jpg': ['Y:\\a.jpg', 'X:\\a.jpg'] }, { 'Y:\\a.jpg': null, 'X:\\a.jpg': completa }),
  );
  assert.strictEqual(r.get('W:\\a.jpg').de, 'X:\\a.jpg');
});

test('la entrada copiada dice de donde viene y no hereda la fecha de escaneo', () => {
  const e = entradaCopiada({ ...completa, escaneado_en: '2026-09-01T00:00:00Z' }, 'X:\\T\\a.jpg');
  assert.strictEqual(e.escaneado_en, undefined);
  assert.strictEqual(e.reaprovechado_de.ruta, 'X:\\T\\a.jpg');
  assert.strictEqual(e.description_what, completa.description_what);
  e.description_what = 'cambiada';
  assert.strictEqual(completa.description_what, 'Dos personas en una playa', 'es una copia, no la misma entrada');
});

test('un plan sin nada que hacer no reaprovecha', () => {
  assert.strictEqual(cubre(completa, { descripcion: false, caras: false, busquedaVisual: false }, hecho), false);
});
