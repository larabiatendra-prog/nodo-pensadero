// Candado de Material oculto (ocultosManager.js): sin contraseña al principio,
// siempre despues de ponerla, y restablecerla desde fuera si se olvida.
// Trabaja en una carpeta temporal: no toca los datos de nadie.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OcultosManager, ARCHIVO_RESTABLECER } = require('../ocultosManager');

function candadoDePrueba() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candado-'));
  const m = new OcultosManager();
  m.file = path.join(dir, 'ocultos_persistent.json');
  m.restablecer = path.join(dir, ARCHIVO_RESTABLECER);
  return { m, dir };
}

test('sin contraseña puesta se entra sin pedir nada; 1234 ya no es una clave', async () => {
  const { m } = candadoDePrueba();
  await m.ensureLoaded();
  assert.strictEqual(m.tieneClave(), false);
  assert.ok(m.abrir(''), 'se abre sin clave');
  assert.ok(m.abrir(undefined), 'ni hace falta mandarla');
});

test('al ponerla se pide siempre, y quien la pone sigue dentro', async () => {
  const { m } = candadoDePrueba();
  await m.ensureLoaded();
  const r = await m.cambiarClave('', 'girasol');
  assert.ok(r.ok && r.llave, 'devuelve una llave nueva');
  assert.ok(m.llaveValida(r.llave));
  assert.strictEqual(m.tieneClave(), true);
  assert.strictEqual(m.abrir(''), null);
  assert.strictEqual(m.abrir('1234'), null);
  assert.ok(m.abrir('girasol'));
  // Cambiarla pide la actual.
  assert.strictEqual((await m.cambiarClave('otra', 'nueva1')).ok, false);
  assert.strictEqual((await m.cambiarClave('girasol', 'abc')).ok, false, 'al menos 4 caracteres');
  assert.ok((await m.cambiarClave('girasol', 'nueva1')).ok);
});

test('olvidada: el aviso de la herramienta quita la contraseña y lo oculto sigue oculto', async () => {
  const { m } = candadoDePrueba();
  await m.ensureLoaded();
  await m.ocultar([{ id: 'a1', mediaKey: 'k:fiesta.jpg', name: 'fiesta.jpg' }]);
  const { llave } = await m.cambiarClave('', 'girasol');
  fs.writeFileSync(m.restablecer, 'pedido');

  await m.ensureLoaded();
  assert.strictEqual(m.tieneClave(), false);
  assert.ok(!fs.existsSync(m.restablecer), 'el aviso se consume');
  assert.ok(!m.llaveValida(llave), 'las llaves de antes no valen');
  assert.ok(m.estaOculto({ id: 'a1', mediaKey: 'k:fiesta.jpg' }));

  // Y queda asi al volver a arrancar.
  const otra = new OcultosManager();
  otra.file = m.file;
  otra.restablecer = m.restablecer;
  await otra.ensureLoaded();
  assert.strictEqual(otra.tieneClave(), false);
  assert.strictEqual(otra.total(), 1);
});
