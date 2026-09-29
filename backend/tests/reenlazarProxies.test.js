// Proxies sin enlazar tras cambiar de letra un disco (utils/reenlazarProxies.js).
// Rutas inventadas; "existe" es un conjunto, no el disco.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { planReenlace } = require('../utils/reenlazarProxies');

// Como el md5, sin barras ni dos puntos: el id acaba en un nombre de archivo.
const idDe = (ruta) => `id_${ruta.replace(/[^a-z0-9]/gi, '_')}`;
const junto = (fullPath, id) => path.join(path.dirname(fullPath), '.pensadero', 'proxies', `${id}.mp4`);
const deps = (existentes, extra = {}) => ({ idDe, junto, existe: async (r) => existentes.has(r), ...extra });

const video = (fullPath, mtimeMs = 1000) => ({ id: idDe(fullPath), fullPath, mtimeMs });

test('un proxy hecho con el disco en D: se reenlaza al pasar a X:', async () => {
  const v = video('X:\\Trabajos\\a\\clip.mov');
  const viejo = idDe('D:\\Trabajos\\a\\clip.mov');
  const index = { [viejo]: { status: 'ready', srcMtime: 1000, ruta: 'D:\\Trabajos\\a\\.pensadero\\proxies\\x.mp4' } };
  const plan = await planReenlace([v], index, deps(new Set([junto(v.fullPath, viejo)])));
  assert.deepStrictEqual(plan, [{ viejo, nuevo: v.id, de: junto(v.fullPath, viejo), a: junto(v.fullPath, v.id) }]);
});

test('el proxy de otro disco con la misma carpeta no se toma', async () => {
  // El otro disco (ahora en X:) tuvo esta ruta con D:; su proxy esta alli, no aqui.
  const v = video('W:\\Trabajos\\a\\clip.mov');
  const index = { [idDe('D:\\Trabajos\\a\\clip.mov')]: { status: 'ready', srcMtime: 1000 } };
  const plan = await planReenlace([v], index, deps(new Set()));
  assert.deepStrictEqual(plan, []);
});

test('con otra fecha no es el mismo archivo', async () => {
  const v = video('X:\\Trabajos\\clip.mov', 50000);
  const viejo = idDe('D:\\Trabajos\\clip.mov');
  const index = { [viejo]: { status: 'ready', srcMtime: 1000 } };
  const plan = await planReenlace([v], index, deps(new Set([junto(v.fullPath, viejo)])));
  assert.deepStrictEqual(plan, []);
});

test('si la ruta vieja la tiene ahora otro video, es de ese', async () => {
  const aqui = video('X:\\Trabajos\\clip.mov');
  const otro = video('D:\\Trabajos\\clip.mov');
  const index = { [otro.id]: { status: 'ready', srcMtime: 1000 } };
  const plan = await planReenlace([aqui, otro], index, deps(new Set([junto(aqui.fullPath, otro.id)])));
  assert.deepStrictEqual(plan, []);
});

test('una letra que no encaja no impide probar las demas', async () => {
  const v = video('X:\\Trabajos\\clip.mov');
  const deOtroDisco = idDe('D:\\Trabajos\\clip.mov'); // sin proxy aqui
  const bueno = idDe('E:\\Trabajos\\clip.mov');
  const index = {
    [deOtroDisco]: { status: 'ready', srcMtime: 1000 },
    [bueno]: { status: 'ready', srcMtime: 1000 },
  };
  const plan = await planReenlace([v], index, deps(new Set([junto(v.fullPath, bueno)])));
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].viejo, bueno);
});

test('los nativos (sin proxy) se reenlazan sin archivo', async () => {
  const v = video('X:\\Trabajos\\clip.mp4');
  const viejo = idDe('D:\\Trabajos\\clip.mp4');
  const plan = await planReenlace([v], { [viejo]: { status: 'native', srcMtime: 1000 } }, deps(new Set()));
  assert.deepStrictEqual(plan, [{ viejo, nuevo: v.id, de: null, a: null }]);
});

test('un proxy guardado en la carpeta del sistema tambien', async () => {
  const sistema = 'C:\\Pensadero\\backend\\proxies';
  const v = video('X:\\Trabajos\\clip.mov');
  const viejo = idDe('D:\\Trabajos\\clip.mov');
  const ruta = path.join(sistema, `${viejo}.mp4`);
  const index = { [viejo]: { status: 'ready', srcMtime: 1000, ruta } };
  const plan = await planReenlace([v], index, deps(new Set([ruta]), { dirSistema: sistema }));
  assert.deepStrictEqual(plan, [{ viejo, nuevo: v.id, de: ruta, a: path.join(sistema, `${v.id}.mp4`) }]);
});

test('lo que ya tiene entrada o no tiene letra no se toca', async () => {
  const v = video('X:\\Trabajos\\clip.mov');
  const red = video('\\\\nas\\Trabajos\\clip.mov');
  const index = { [v.id]: { status: 'ready', srcMtime: 1000 }, [idDe('D:\\Trabajos\\clip.mov')]: { status: 'ready', srcMtime: 1000 } };
  assert.deepStrictEqual(await planReenlace([v, red], index, deps(new Set([junto(v.fullPath, idDe('D:\\Trabajos\\clip.mov'))]))), []);
});

test('los errores no se reenlazan', async () => {
  const v = video('X:\\Trabajos\\clip.mov');
  const viejo = idDe('D:\\Trabajos\\clip.mov');
  const plan = await planReenlace([v], { [viejo]: { status: 'error', srcMtime: 1000 } }, deps(new Set([junto(v.fullPath, viejo)])));
  assert.deepStrictEqual(plan, []);
});
