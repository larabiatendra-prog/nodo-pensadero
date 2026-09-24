// Fechas de la pantalla (src/utils/dateUtils.ts): dias LOCALES, no UTC.
// Se ejecuta con la zona de España para que el fallo antiguo se vea.
import test from 'node:test';
import assert from 'node:assert';
import { aTextoDiaLocal, deTextoDiaLocal, finDelDia } from '../src/utils/dateUtils.ts';

test('el dia de un campo de fecha es la medianoche LOCAL de ese dia', () => {
  const d = deTextoDiaLocal('2026-09-07');
  assert.ok(d);
  assert.deepStrictEqual([d!.getFullYear(), d!.getMonth(), d!.getDate(), d!.getHours()], [2026, 8, 7, 0]);
  assert.strictEqual(deTextoDiaLocal(''), undefined);
  assert.strictEqual(deTextoDiaLocal('7/9/2026'), undefined);
});

test('ida y vuelta sin perder un dia (toISOString daba el 6)', () => {
  const d = new Date(2026, 8, 7);
  assert.strictEqual(aTextoDiaLocal(d), '2026-09-07');
  assert.strictEqual(aTextoDiaLocal(deTextoDiaLocal('2026-01-01')!), '2026-01-01');
});

test('un archivo del mismo dia entra en un rango de un solo dia', () => {
  const archivo = new Date(2026, 8, 7);           // como la fecha del servidor (medianoche local)
  const desde = deTextoDiaLocal('2026-09-07')!;
  const hasta = finDelDia(deTextoDiaLocal('2026-09-07')!);
  assert.ok(archivo >= desde && archivo <= hasta);
  assert.ok(new Date(2026, 8, 7, 23, 30) <= hasta, 'la noche del ultimo dia tambien');
});
