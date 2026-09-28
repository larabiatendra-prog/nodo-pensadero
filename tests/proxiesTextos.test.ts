// Textos de los videos preparados (src/utils/proxies.ts).
import test from 'node:test';
import assert from 'node:assert';
import { aproximado, tiempo, textoSinPrevisualizar } from '../src/utils/proxies.ts';

test('una estimacion se dice redondeada', () => {
  assert.strictEqual(aproximado(20), 'menos de un minuto');
  assert.strictEqual(aproximado(7 * 60 + 10), 'unos 7 minutos');
  assert.strictEqual(aproximado(27 * 60), 'unos 25 minutos');
  assert.strictEqual(aproximado(3 * 3600 + 17 * 60), 'unas 3 h 20 min');
  assert.strictEqual(aproximado(2 * 3600 + 58 * 60), 'unas 3 h');
  assert.strictEqual(aproximado(14 * 3600 + 20 * 60), 'unas 14 h 30 min');
  assert.strictEqual(aproximado(52 * 3600), 'unos 2 días y 4 h');
});

test('la duracion exacta sigue como estaba', () => {
  assert.strictEqual(tiempo(45), '45 s');
  assert.strictEqual(tiempo(12 * 60), '12 min');
  assert.strictEqual(tiempo(200 * 60), '3 h 20 min');
});

test('singular y plural', () => {
  assert.strictEqual(textoSinPrevisualizar(1), 'Tienes 1 archivo sin previsualizar');
  assert.strictEqual(textoSinPrevisualizar(12345), 'Tienes 12.345 archivos sin previsualizar');
});
