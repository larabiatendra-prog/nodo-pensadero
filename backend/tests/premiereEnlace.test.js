// El enlace con la extension de Premiere (services/premiereEnlace.js), con un
// reloj de mentira.
const test = require('node:test');
const assert = require('node:assert');
const { crearEnlace, VIVO_MS, SIN_RECOGER_MS, SIN_CONTESTAR_MS } = require('../services/premiereEnlace');

function reloj() {
  let t = 1_000_000;
  return { ahora: () => t, pasar: (ms) => { t += ms; } };
}

test('sin latido no hay Premiere y enviar lo dice', () => {
  const r = reloj();
  const e = crearEnlace(r);
  assert.deepStrictEqual(e.estado(), { conectado: false, proyecto: null, version: null, puente: null, puenteActual: 3, fallo: null });
  assert.throws(() => e.enviar({ token: 't', archivo: 'a.xml' }), /no está abierto/);
});

test('con Premiere pero sin proyecto, pide abrir uno', () => {
  const r = reloj();
  const e = crearEnlace(r);
  e.latido({ proyecto: '', version: '26.0' });
  assert.strictEqual(e.estado().conectado, true);
  assert.throws(() => e.enviar({ token: 't', archivo: 'a.xml' }), /Abre un proyecto/);
});

test('un envío se entrega una sola vez y termina hecho', () => {
  const r = reloj();
  const e = crearEnlace(r);
  e.latido({ proyecto: 'Boda.prproj' });
  const id = e.enviar({ token: 'tok', archivo: 'Boda.xml' });
  assert.strictEqual(e.consultar(id).estado, 'pendiente');
  const llevar = e.latido({ proyecto: 'Boda.prproj' });
  assert.deepStrictEqual(llevar, [{ id, token: 'tok', archivo: 'Boda.xml' }]);
  assert.deepStrictEqual(e.latido({ proyecto: 'Boda.prproj' }), []);
  assert.strictEqual(e.consultar(id).estado, 'entregado');
  e.resolver(id, { ok: true, resumen: { importados: 3, total: 3 } });
  const c = e.consultar(id);
  assert.strictEqual(c.estado, 'hecho');
  assert.strictEqual(c.error, null);
  assert.strictEqual(c.proyecto, 'Boda.prproj');
  assert.strictEqual(c.token, 'tok');
  assert.deepStrictEqual(c.resumen, { importados: 3, total: 3 });
});

test('el error de Premiere llega tal cual', () => {
  const r = reloj();
  const e = crearEnlace(r);
  e.latido({ proyecto: 'P' });
  const id = e.enviar({ token: 'tok', archivo: 'x.xml' });
  e.latido({ proyecto: 'P' });
  e.resolver(id, { ok: false, error: 'importFiles devolvió false' });
  assert.strictEqual(e.consultar(id).estado, 'error');
  assert.match(e.consultar(id).error, /importFiles/);
});

test('se apaga sin latido, y nada se queda esperando para siempre', () => {
  const r = reloj();
  const e = crearEnlace(r);
  e.latido({ proyecto: 'P' });
  const sinRecoger = e.enviar({ token: 'a', archivo: 'a.xml' });
  r.pasar(VIVO_MS + 1);
  assert.strictEqual(e.estado().conectado, false);
  r.pasar(SIN_RECOGER_MS);
  assert.strictEqual(e.consultar(sinRecoger).estado, 'error');

  e.latido({ proyecto: 'P' });
  const sinContestar = e.enviar({ token: 'b', archivo: 'b.xml' });
  e.latido({ proyecto: 'P' });
  r.pasar(SIN_CONTESTAR_MS + 1);
  assert.strictEqual(e.consultar(sinContestar).estado, 'error');
  assert.match(e.consultar(sinContestar).error, /dejado de contestar/);
});

test('mientras importa, el progreso lo mantiene vivo aunque no haya latido', () => {
  const r = reloj();
  const e = crearEnlace(r);
  e.latido({ proyecto: 'P' });
  const id = e.enviar({ token: 't', archivo: 'a.xml' });
  e.latido({ proyecto: 'P' });
  for (let i = 0; i < 6; i++) {
    r.pasar(SIN_CONTESTAR_MS / 2);
    assert.strictEqual(e.progreso(id, `Importando ${i + 1}/6`), true);
    assert.strictEqual(e.estado().conectado, true);
  }
  assert.strictEqual(e.consultar(id).estado, 'entregado');
  assert.strictEqual(e.consultar(id).progreso, 'Importando 6/6');
});

test('de uno en uno: el segundo envio espera a que acabe el primero', () => {
  const r = reloj();
  const e = crearEnlace(r);
  e.latido({ proyecto: 'P', puente: 2 });
  const a = e.enviar({ token: 'a', archivo: 'a.xml' });
  const b = e.enviar({ token: 'b', archivo: 'b.xml' });
  assert.deepStrictEqual(e.latido({ proyecto: 'P', puente: 2 }).map(x => x.id), [a]);
  assert.deepStrictEqual(e.latido({ proyecto: 'P', puente: 2 }), []);
  e.resolver(a, { ok: true });
  assert.deepStrictEqual(e.latido({ proyecto: 'P', puente: 2 }).map(x => x.id), [b]);
  assert.strictEqual(e.estado().puente, 2);
});
