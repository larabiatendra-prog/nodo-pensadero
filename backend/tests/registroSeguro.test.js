// Lectura segura de los registros de personas y lugares (en una carpeta temporal).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { leerRegistro } = require('../utils/registroSeguro');

const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'pensadero-test-registro-'));
test.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
const ruta = path.join(carpeta, 'people_registry.json');
const limpiar = () => { for (const n of fs.readdirSync(carpeta)) fs.rmSync(path.join(carpeta, n), { recursive: true, force: true }); };

test('lee un registro bueno (tambien con BOM)', () => {
  limpiar();
  fs.writeFileSync(ruta, '﻿' + JSON.stringify({ people: [{ person_id: 'ana' }] }));
  const r = leerRegistro(ruta, 'people', { primeraVez: true });
  assert.strictEqual(r.estado, 'ok');
  assert.strictEqual(r.datos.people.length, 1);
});

test('no existe: lo dice sin tocar nada', () => {
  limpiar();
  assert.strictEqual(leerRegistro(ruta, 'people').estado, 'no_existe');
});

test('roto en una recarga: no aparta nada', () => {
  limpiar();
  fs.writeFileSync(ruta, '{"people": [');
  const r = leerRegistro(ruta, 'people', { primeraVez: false });
  assert.strictEqual(r.estado, 'roto');
  assert.ok(fs.existsSync(ruta));
});

test('roto al arrancar: se aparta y se usa la copia .bak', () => {
  limpiar();
  fs.writeFileSync(ruta, 'basura');
  fs.writeFileSync(ruta + '.bak', JSON.stringify({ people: [{ person_id: 'luis' }] }));
  const r = leerRegistro(ruta, 'people', { primeraVez: true });
  assert.strictEqual(r.estado, 'ok');
  assert.strictEqual(r.desdeCopia, true);
  assert.ok(!fs.existsSync(ruta), 'el roto se ha apartado');
  assert.ok(fs.readdirSync(carpeta).some(n => n.includes('.corrupt-')));
});

test('solo lectura (diagnostico): ni aparta ni usa la copia', () => {
  limpiar();
  fs.writeFileSync(ruta, 'basura');
  fs.writeFileSync(ruta + '.bak', JSON.stringify({ people: [] }));
  const r = leerRegistro(ruta, 'people', { primeraVez: true, soloLectura: true });
  assert.strictEqual(r.estado, 'roto');
  assert.ok(fs.existsSync(ruta));
});

test('no se puede leer (es una carpeta): ilegible, para no escribir encima', () => {
  limpiar();
  fs.mkdirSync(ruta);
  assert.strictEqual(leerRegistro(ruta, 'people', { primeraVez: true }).estado, 'ilegible');
});
