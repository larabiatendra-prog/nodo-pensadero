// Fechas de la pantalla (src/utils/dateUtils.ts): dias LOCALES, no UTC.
// Se ejecuta con la zona de España para que el fallo antiguo se vea.
import test from 'node:test';
import assert from 'node:assert';
import { aTextoDiaLocal, deTextoDiaLocal, finDelDia, fechaDeArchivo } from '../src/utils/dateUtils.ts';

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

test('la tarjeta enseña la fecha resuelta, no la de copia', () => {
  // Boda del 14/06 volcada el 29/09: antes la tarjeta decia 29/9/2026.
  const boda = { fechaDia: 20260614, fechaFuente: 'carpeta', createdAt: new Date(2026, 8, 29, 21) };
  assert.deepStrictEqual(fechaDeArchivo(boda), { texto: '14/6/2026', aviso: undefined });
  // Solo la sabe el disco: se avisa en el title.
  const deDisco = fechaDeArchivo({ fechaDia: 20191105, fechaFuente: 'disco' });
  assert.strictEqual(deDisco.texto, '5/11/2019');
  assert.ok(deDisco.aviso);
  // Sin fecha del servidor: la mas antigua de las dos del disco.
  const suelto = fechaDeArchivo({ createdAt: new Date(2026, 8, 29), modifiedAt: new Date(2019, 10, 5) });
  assert.strictEqual(suelto.texto, '5/11/2019');
  assert.strictEqual(fechaDeArchivo({}).texto, '');
});
