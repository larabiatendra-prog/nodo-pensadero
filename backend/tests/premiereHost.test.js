// Lo que la extension hace dentro de Premiere (premiere/extension/host.jsx),
// probado contra un Premiere de mentira: la API minima que usa (bandejas,
// importar, metadatos, marcadores, etiqueta, secuencia). Con el plan real
// (services/premierePlan.js) y llamada a llamada, como hace enlace.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { construirPlan, explicarResultado } = require('../services/premierePlan');

const { premiereDeMentira, HOST } = require('./ayudas/premiereDeMentira');
const ENLACE = fs.readFileSync(path.join(__dirname, '..', '..', 'premiere', 'extension', 'enlace.js'), 'utf8');

// Lo mismo que hace enlace.js para pasar valores a ExtendScript.
const literal = (v) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
const llamar = (ctx, fn, arg) => JSON.parse(vm.runInContext(`${fn}(${arg === undefined ? '' : literal(arg)})`, ctx));

/** El recorrido completo de enlace.js, a mano. */
function enviar(ctx, plan) {
  assert.strictEqual(llamar(ctx, 'pensaderoEmpezar', { nombre: plan.nombre, duplicar: !!plan.duplicar }).ok, true);
  if (!plan.duplicar) assert.strictEqual(llamar(ctx, 'pensaderoMirarProyecto').ok, true);
  for (const b of plan.bandejas) {
    for (let i = 0; i < b.clips.length; i += 2) {
      llamar(ctx, 'pensaderoImportar', {
        bandeja: b.nombre,
        clips: b.clips.slice(i, i + 2).map(k => ({ i: k, ruta: plan.clips[k].ruta, nombre: plan.clips[k].nombre })),
      });
    }
  }
  llamar(ctx, 'pensaderoDetalles', plan.clips.map((c, i) => ({ i, descripcion: c.descripcion, notaRegistro: c.notaRegistro, marcador: c.marcador, etiqueta: c.etiqueta })));
  if (plan.secuencia) llamar(ctx, 'pensaderoSecuencia', { nombre: plan.nombre, orden: plan.orden, formato: plan.formato });
  return llamar(ctx, 'pensaderoTerminar');
}

const clips = [
  // El primero, vertical (camara girada): la secuencia NO debe quedarse vertical.
  { nombre: 'P1004601.MOV', ruta: 'W:\\Acampada\\P1004601.MOV', tipo: 'video', ancho: 2160, alto: 4096, fps: 59.94, dia: 20261007, carpeta: 'Acampada', personas: ['Ana'], descripcion: 'Gente en la plaza', nota: '', favorito: false },
  { nombre: 'P1004602.MOV', ruta: 'W:\\Acampada\\P1004602.MOV', tipo: 'video', ancho: 3840, alto: 2160, fps: 29.97, dia: 20261007, carpeta: 'Acampada', personas: ['Ana', 'Íñigo'], descripcion: 'Asamblea', nota: 'La buena', favorito: true },
  { nombre: 'P1004603.MOV', ruta: 'W:\\Acampada\\P1004603.MOV', tipo: 'video', ancho: 3840, alto: 2160, fps: 29.97, dia: 20261008, carpeta: 'Acampada', personas: [], descripcion: '', nota: '' },
  { nombre: 'Año nuevo ñ.jpg', ruta: 'C:\\Fotos\\Año nuevo ñ.jpg', tipo: 'image', ancho: 4000, alto: 3000, dia: 20261008, carpeta: 'Fotos', personas: [] },
  { nombre: 'falta.MOV', ruta: 'X:\\Desconectado\\falta.MOV', tipo: 'video', ancho: 3840, alto: 2160, fps: 29.97, dia: 20261008, carpeta: 'X', personas: [], conectado: false },
  { nombre: 'raro.braw', ruta: 'W:\\Acampada\\raro.braw', tipo: 'video', ancho: 3840, alto: 2160, fps: 25, dia: 20261008, carpeta: 'Acampada', personas: [] },
];
const existen = new Set(clips.filter(c => c.conectado !== false).map(c => c.ruta));
const medidas = Object.fromEntries(clips.map(c => [c.ruta, { ancho: c.ancho, alto: c.alto }]));

test('host.jsx no usa nada que el ExtendScript de Premiere (ES3) no tenga', () => {
  const sinComentarios = HOST.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [que, re] of [['=>', /=>/], ['let/const', /\b(let|const)\s/], ['forEach', /\.forEach\(/], ['JSON.', /\bJSON\./], ['.trim()', /\.trim\(/], ['plantillas', /`/], ['.includes(', /\.includes\(/]]) {
    assert.ok(!re.test(sinComentarios), `host.jsx usa ${que}`);
  }
});

test('enlace.js no usa nada que el Node y el navegador de Premiere 2019 no tengan', () => {
  const codigo = ENLACE.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\?\.|\?\?/.test(codigo), 'usa ?. o ??');
  assert.ok(!/\{\s*\.\.\./.test(codigo), 'usa spread de objetos');
});

test('un envio entero: bandejas por dia, lo que falta y lo que no lee, dichos por su nombre', () => {
  const { ctx, raiz, secuencias } = premiereDeMentira({ existen, noLee: new Set(['W:\\Acampada\\raro.braw']), medidas });
  const plan = construirPlan({ nombre: 'Acampada · día 7', ordenar: 'dia', marcadores: true, secuencia: true }, clips);
  const r = enviar(ctx, plan);

  assert.strictEqual(r.bandeja, 'Acampada · día 7');
  assert.strictEqual(r.total, 6);
  assert.strictEqual(r.importados, 4);
  assert.deepStrictEqual(r.faltan, ['falta.MOV']);
  assert.deepStrictEqual(r.noImportados, ['raro.braw']);

  const principal = raiz.children[0];
  assert.strictEqual(principal.name, 'Acampada · día 7');
  const nombres = principal.children.map(c => c.name);
  assert.ok(nombres.includes('7 oct 2026') && nombres.includes('8 oct 2026'));

  // Textos, marcador y etiqueta del favorito.
  const dia7 = principal.children.find(c => c.name === '7 oct 2026');
  const fav = dia7.children.find(c => c.name === 'P1004602.MOV');
  assert.strictEqual(fav._etiqueta, 7);
  assert.match(fav._meta, /Asamblea/);
  assert.match(fav._meta, /Ana, Íñigo · La buena/);
  assert.strictEqual(fav._marcadores.length, 1);
  assert.strictEqual(fav._marcadores[0].name, 'Nota');

  // La foto con eñe y tilde llega con su ruta intacta.
  const dia8 = principal.children.find(c => c.name === '8 oct 2026');
  assert.ok(dia8.children.some(c => c.getMediaPath && c.getMediaPath() === 'C:\\Fotos\\Año nuevo ñ.jpg'));

  // Secuencia en el orden de la cesta y con el formato de la mayoria, no el del primero (vertical).
  assert.strictEqual(secuencias.length, 1);
  assert.deepStrictEqual(Array.from(secuencias[0].items, i => i.name), ['P1004601.MOV', 'P1004602.MOV', 'P1004603.MOV', 'Año nuevo ñ.jpg']);
  assert.deepStrictEqual(r.secuencia, { nombre: 'Acampada · día 7', ancho: 3840, alto: 2160, fps: 25 });

  // Y la cesta lo cuenta con palabras.
  const avisos = explicarResultado(r, plan);
  assert.ok(avisos.some(a => /No se encontró 1 archivo.*falta\.MOV/.test(a)), avisos.join('\n'));
  assert.ok(avisos.some(a => /no pudo importar 1 archivo.*raro\.braw/.test(a)));
  assert.ok(avisos.some(a => /La secuencia es horizontal \(3840×2160\)\. 1 clip tiene otra forma: no se deforma,/.test(a)), avisos.join('\n'));
});

test('el nombre de la bandeja no pisa otra que ya este', () => {
  const { ctx, raiz } = premiereDeMentira({ existen, medidas });
  raiz.createBin('Boda');
  const plan = construirPlan({ nombre: 'Boda', ordenar: 'todo' }, clips.slice(0, 2));
  const r = enviar(ctx, plan);
  assert.strictEqual(r.bandeja, 'Boda (2)');
  assert.strictEqual(raiz.children[1].children.length, 2);
});

test('una version sin secuencias ni marcadores: entra todo lo demas y se dice que no pudo', () => {
  const { ctx } = premiereDeMentira({ existen, medidas, sinSecuencia: true, sinMarcadores: true });
  const plan = construirPlan({ nombre: 'Vieja', ordenar: 'persona', marcadores: true, secuencia: true }, clips.slice(0, 3));
  const r = enviar(ctx, plan);
  // Por persona, el clip con Ana e Íñigo entra en las dos bandejas.
  assert.strictEqual(r.importados, 4);
  assert.strictEqual(r.secuencia, null);
  assert.ok(r.sinPoder.some(t => /no deja crear la secuencia/.test(t)));
  assert.ok(r.sinPoder.some(t => /marcadores/.test(t)));
  // Cada aviso una sola vez aunque fallen muchos clips.
  assert.strictEqual(r.sinPoder.filter(t => /marcadores/.test(t)).length, 1);
});

test('sin proyecto abierto lo dice, y sin envio en curso no revienta', () => {
  const { ctx } = premiereDeMentira({ existen });
  vm.runInContext('app.project.path = ""', ctx);
  assert.match(llamar(ctx, 'pensaderoEmpezar', { nombre: 'x' }).error, /No hay ningún proyecto/);
  assert.strictEqual(llamar(ctx, 'pensaderoTerminar').ok, false);
  assert.deepStrictEqual(JSON.parse(vm.runInContext('pensaderoProyecto()', ctx)), { nombre: '', ruta: '', version: '26.2.0', puente: 3 });
});

/** Mete en el proyecto, antes del envio, un clip con esa ruta en su bandeja. */
function yaEnElProyecto(premiere, bandeja, ruta) {
  const b = premiere.raiz.createBin(bandeja);
  premiere.ctx.app.project.importFiles([ruta], true, b, false);
  const item = b.children[b.children.length - 1];
  item._meta = 'mis notas';
  return item;
}

test('lo que ya esta en el proyecto no se duplica: se usa en la secuencia y sus notas no se tocan', () => {
  const premiere = premiereDeMentira({ existen, medidas });
  const viejo = yaEnElProyecto(premiere, '261007_Acampada', 'W:\\Acampada\\P1004602.MOV');
  const plan = construirPlan({ nombre: 'Sin duplicar', ordenar: 'dia', marcadores: true, secuencia: true }, clips.slice(0, 4));
  const r = enviar(premiere.ctx, plan);
  assert.strictEqual(r.importados, 3);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.reutilizados)), [{ nombre: 'P1004602.MOV', bandeja: '261007_Acampada' }]);
  // El de antes, intacto (era favorito y tenia nota en Pensadero: da igual).
  assert.strictEqual(viejo._meta, 'mis notas');
  assert.strictEqual(viejo._etiqueta, null);
  assert.strictEqual(viejo._marcadores.length, 0);
  // Ni rastro de un segundo P1004602 en la bandeja nueva.
  const nueva = premiere.raiz.children.find(c => c.name === 'Sin duplicar');
  const todos = [];
  const recorrer = (b) => b.children.forEach(c => (c.children ? recorrer(c) : todos.push(c.name)));
  recorrer(nueva);
  assert.ok(!todos.includes('P1004602.MOV'), todos.join(', '));
  // Pero en la secuencia esta, en su sitio, y es el de antes.
  assert.strictEqual(premiere.secuencias[0].items[1], viejo);
});

test('con «importar otra vez», se duplica', () => {
  const premiere = premiereDeMentira({ existen, medidas });
  yaEnElProyecto(premiere, '261007_Acampada', 'W:\\Acampada\\P1004602.MOV');
  const plan = construirPlan({ nombre: 'Duplicando', ordenar: 'todo', secuencia: true, duplicar: true }, clips.slice(0, 4));
  const r = enviar(premiere.ctx, plan);
  assert.strictEqual(r.importados, 4);
  assert.strictEqual(r.reutilizados.length, 0);
});

test('un archivo que cambio de disco se reconoce por nombre Y tamaño, no solo por nombre', () => {
  const nuevoDisco = 'W:\\Acampada\\P1004603.MOV';
  const viejoDisco = 'X:\\Copia\\P1004603.MOV';
  const otroMismoNombre = 'Y:\\Otra camara\\P1004601.MOV';
  const tamanos = { [nuevoDisco]: 5000, [viejoDisco]: 5000, 'W:\\Acampada\\P1004601.MOV': 7000, [otroMismoNombre]: 1234 };
  const premiere = premiereDeMentira({ existen: (r) => r in tamanos || existen.has(r), tamanos, medidas });
  const copia = yaEnElProyecto(premiere, 'Copias', viejoDisco);
  yaEnElProyecto(premiere, 'Otra camara', otroMismoNombre);
  const plan = construirPlan({ nombre: 'Discos', ordenar: 'todo', secuencia: true }, clips.slice(0, 3));
  const r = enviar(premiere.ctx, plan);
  // P1004603: mismo nombre y tamaño en otro disco -> el de antes.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.reutilizados)), [{ nombre: 'P1004603.MOV', bandeja: 'Copias' }]);
  assert.strictEqual(premiere.secuencias[0].items[2], copia);
  // P1004601: mismo nombre, otro tamaño (otra camara) -> se importa.
  assert.strictEqual(r.importados, 2);
});
