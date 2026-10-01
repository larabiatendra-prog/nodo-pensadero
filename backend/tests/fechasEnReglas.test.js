// Carpetas inteligentes: "Fecha desde/hasta" mira la fecha resuelta del
// archivo, no la de copia en disco, y un dia escrito es un dia LOCAL.
// Se ejecuta con la zona de España para que el fallo de UTC se vea.
process.env.TZ = 'Europe/Madrid';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateRule } = require('../smartFolderEvaluator');

// Boda grabada el 14/06/2026 y copiada al disco el 29/09/2026.
const boda = { createdAt: new Date('2026-09-29T21:00:00'), extractedDate: new Date(2026, 5, 14) };

test('la regla de fecha usa la fecha resuelta, no la de copia', () => {
  assert.strictEqual(evaluateRule(boda, { field: 'createdAt', op: 'lte', value: '2026-06-30' }), true);
  assert.strictEqual(evaluateRule(boda, { field: 'createdAt', op: 'gte', value: '2026-09-01' }), false);
});

test('el propio dia entra por los dos extremos', () => {
  assert.strictEqual(evaluateRule(boda, { field: 'createdAt', op: 'gte', value: '2026-06-14' }), true);
  assert.strictEqual(evaluateRule(boda, { field: 'createdAt', op: 'lte', value: '2026-06-14' }), true);
});

test('sin fecha resuelta sigue valiendo la del disco', () => {
  const suelto = { createdAt: new Date(2026, 8, 29, 21) };
  assert.strictEqual(evaluateRule(suelto, { field: 'createdAt', op: 'gte', value: '2026-09-01' }), true);
});
