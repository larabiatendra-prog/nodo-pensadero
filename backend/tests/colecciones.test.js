// Colecciones: se guardan por mediaKey y la limpieza no borra lo que no puede
// demostrar que falta. Sin tocar disco: se anulan el guardado y la caja negra.
const test = require('node:test');
const assert = require('node:assert');
const retiradas = require('../services/retiradas');
const cm = require('../collectionsManager');

retiradas.anotar = () => {};
cm.saveCollections = async () => {};

const LIB = '0123456789abcdef';
const OTRA = 'fedcba9876543210';
const archivos = [
  { id: 'aaa', mediaKey: `${LIB}:x/a.jpg`, fullPath: 'E:\\Fotos\\x\\A.jpg' },
  { id: 'bbb', mediaKey: `${LIB}:x/b.jpg`, fullPath: 'E:\\Fotos\\x\\b.jpg' },
];
const nueva = (refs) => {
  cm.collections = new Map([['c1', { id: 'c1', name: 'Prueba', type: 'static', mediaFiles: [...refs] }]]);
  return cm.collections.get('c1');
};

test('añadir guarda por mediaKey y no repite aunque llegue de otra forma', async () => {
  const c = nueva([]);
  const r1 = await cm.anadirArchivos('c1', ['aaa'], archivos);
  const r2 = await cm.anadirArchivos('c1', ['e:\\fotos\\x\\a.jpg', 'E:\\Fotos\\x\\b.jpg'], archivos);
  assert.strictEqual(r1.added, 1);
  assert.deepStrictEqual([r2.added, r2.skipped], [1, 1]);
  assert.deepStrictEqual(c.mediaFiles, [`${LIB}:x/a.jpg`, `${LIB}:x/b.jpg`]);
});

test('quitar funciona con cualquiera de sus formas', async () => {
  const c = nueva([`${LIB}:x/a.jpg`, 'bbb']);
  await cm.quitarArchivos('c1', ['e:\\fotos\\x\\a.jpg'], archivos);
  await cm.quitarArchivos('c1', [`${LIB}:x/b.jpg`], archivos);
  assert.deepStrictEqual(c.mediaFiles, []);
});

test('lo antiguo (id o ruta) pasa a mediaKey y la UI recibe ids', async () => {
  const c = nueva(['aaa', 'e:\\fotos\\x\\b.jpg', 'no-esta']);
  await cm.aPortable(archivos);
  assert.deepStrictEqual(c.mediaFiles, [`${LIB}:x/a.jpg`, `${LIB}:x/b.jpg`, 'no-esta']);
  assert.deepStrictEqual(cm.refsParaCliente(c, cm.indiceDeArchivos(archivos)), ['aaa', 'bbb', 'no-esta']);
});

test('la limpieza no borra lo de una biblioteca que no se ha leido', async () => {
  // Una por mediaKey de OTRA biblioteca, una ruta y un id que "ubicar" sitúa en OTRA.
  const c = nueva([`${OTRA}:y/c.jpg`, 'f:\\otra\\d.jpg', 'idDeOtra', `${LIB}:x/a.jpg`]);
  await cm.cleanupOrphanedFiles(archivos, {
    scannedLibraryIds: new Set([LIB]),
    todasLasBibliotecasLeidas: true, // "todas las activas": la OTRA esta desactivada
    ubicar: (ref) => (ref === 'idDeOtra' || ref.startsWith('f:') ? OTRA : null),
  });
  assert.strictEqual(c.mediaFiles.length, 4, 'no se ha borrado nada');
});

test('la limpieza SI borra lo que se demuestra que falta', async () => {
  const c = nueva([`${LIB}:x/desaparecido.jpg`, `${LIB}:x/a.jpg`]);
  await cm.cleanupOrphanedFiles(archivos, { scannedLibraryIds: new Set([LIB]) });
  assert.deepStrictEqual(c.mediaFiles, [`${LIB}:x/a.jpg`]);
});

test('lo añadido en grupo (por ruta) cuenta como presente', async () => {
  const c = nueva(['e:\\fotos\\x\\a.jpg']);
  await cm.cleanupOrphanedFiles(archivos, { scannedLibraryIds: new Set([LIB]), todasLasBibliotecasLeidas: true });
  assert.strictEqual(c.mediaFiles.length, 1);
});
