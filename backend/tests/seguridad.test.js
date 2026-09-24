// Seguridad: quien puede hablar con Pensadero, que carpetas aceptan las
// acciones de caras y que "Abrir en el explorador" no pasa por la consola.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const childProcess = require('child_process');
const { hostPermitido, origenPermitido } = require('../utils/origenLocal');
const { dentroDeBiblioteca, nombreSuelto } = require('../utils/rutaDeBiblioteca');

test('host: se entra por localhost o por IP, no por un dominio ajeno', () => {
  const extra = new Set(['nodo']);
  for (const h of ['localhost:5000', '127.0.0.1:5000', '[::1]:5000', 'app.localhost:5173', '192.168.1.40:5000', 'NODO:5000', undefined]) {
    assert.ok(hostPermitido(h, extra), `deberia pasar: ${h}`);
  }
  // DNS rebinding: el dominio de la web apunta a 127.0.0.1
  for (const h of ['ataque.example.com:5000', 'localhost.ataque.com', '127.0.0.1.nip.io:5000', 'nodo.ataque.com']) {
    assert.ok(!hostPermitido(h, extra), `deberia rechazarse: ${h}`);
  }
});

test('origen: el propio Pensadero o el Vite de desarrollo, nada mas', () => {
  assert.ok(origenPermitido(undefined, 'localhost:5000'));
  assert.ok(origenPermitido('http://localhost:5173', 'localhost:5000'));
  assert.ok(origenPermitido('http://192.168.1.40:5000', '192.168.1.40:5000'));
  assert.ok(!origenPermitido('https://ataque.example.com', 'localhost:5000'));
  assert.ok(!origenPermitido('null', 'localhost:5000'));
});

test('caras: solo carpetas de las bibliotecas, sin escaparse con ..', () => {
  const raiz = path.resolve('/biblio/Fotos');
  assert.ok(dentroDeBiblioteca(raiz, [raiz]));
  assert.ok(dentroDeBiblioteca(path.join(raiz, '191225_Navidad'), [raiz]));
  assert.ok(dentroDeBiblioteca(path.join(raiz, '..fotos raras'), [raiz]), 'un nombre que empieza por .. es una carpeta normal');
  assert.ok(!dentroDeBiblioteca([raiz, '..', '..', 'Windows'].join(path.sep), [raiz]));
  assert.ok(!dentroDeBiblioteca(path.resolve('/biblio/Fotos-bis'), [raiz]), 'un prefijo no es estar dentro');
  assert.ok(!dentroDeBiblioteca(path.resolve('/Windows/System32'), [raiz]));
  assert.ok(!dentroDeBiblioteca('Fotos', [raiz]), 'una ruta relativa no vale');
  assert.ok(!dentroDeBiblioteca(raiz, []));
  if (process.platform === 'win32') {
    assert.ok(dentroDeBiblioteca('k:\\fotos\\2019', ['K:\\Fotos']), 'en Windows sin distinguir mayusculas');
  }
});

test('caras: el nombre es un archivo suelto', () => {
  assert.ok(nombreSuelto('IMG_3421.JPG'));
  assert.ok(nombreSuelto('a..b.jpg'));
  for (const n of ['', '.', '..', '../secreto.txt', '..\\secreto.txt', 'sub/foto.jpg', 'C:\\Windows\\win.ini', null, 7]) {
    assert.ok(!nombreSuelto(n), `deberia rechazarse: ${n}`);
  }
});

test('abrir en el explorador: la ruta va como argumento, sin consola de por medio', async () => {
  const llamadas = [];
  const original = childProcess.spawn;
  childProcess.spawn = (programa, args, opciones) => {
    llamadas.push({ programa, args, opciones });
    const { EventEmitter } = require('events');
    const hijo = new EventEmitter();
    hijo.unref = () => {};
    setImmediate(() => hijo.emit('spawn'));
    return hijo;
  };
  const rutaMala = path.resolve('/biblio/Fotos/100% & calc.jpg');
  let server;
  try {
    delete require.cache[require.resolve('../routes/mediaRoutes')];
    const crear = require('../routes/mediaRoutes');
    const express = require('express');
    const app = express();
    app.use('/api', crear({
      getMediaFiles: () => [{ id: 'abc', name: '100% & calc.jpg', fullPath: rutaMala }],
      setMediaFiles: () => {}, getFileCache: () => ({}), setFileCache: () => {}, saveCache: () => {},
    }));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/files/abc/open-path`, { method: 'POST' });
    const cuerpo = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(cuerpo));
    assert.strictEqual(llamadas.length, 1);
    const { programa, args, opciones } = llamadas[0];
    assert.ok(!opciones.shell, 'sin shell');
    if (process.platform === 'win32') {
      assert.strictEqual(programa, 'explorer.exe');
      assert.deepStrictEqual(args, [`/select,"${rutaMala}"`]);
    } else {
      assert.ok(args.includes(rutaMala) || args.includes(path.dirname(rutaMala)));
    }
  } finally {
    childProcess.spawn = original;
    delete require.cache[require.resolve('../routes/mediaRoutes')];
    if (server) await new Promise(r => server.close(r));
  }
});
