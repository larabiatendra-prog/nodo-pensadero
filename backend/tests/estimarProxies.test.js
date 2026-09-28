// Cuanto tardaria preparar todos los videos (utils/estimarProxies.js).
const test = require('node:test');
const assert = require('node:assert');
const { estimarLote } = require('../utils/estimarProxies');

const GB = 1073741824;
const MB_S = 0.65e6;
const sinLimite = { topeBytes: 0, ocupadoBytes: 0, libreGB: null, minLibreGB: 30 };

test('tiempo = duracion por lo que tarda el equipo, mas el coste fijo de cada archivo', () => {
  const videos = [{ raiz: 'F:\\', duration: 60 }, { raiz: 'F:\\', duration: 40 }];
  const r = estimarLote(videos, { segPorSegundo: 0.2, arranqueSeg: 1 }, { 'F:\\': sinLimite }, { bytesPorSegundo: MB_S });
  assert.strictEqual(r.n, 2);
  assert.strictEqual(r.segundos, 100 * 0.2 + 2 * 1);
  assert.strictEqual(r.bytes, Math.round(100 * MB_S));
  assert.strictEqual(r.fuera, 0);
});

test('sin medir la velocidad no se inventa el tiempo', () => {
  const r = estimarLote([{ raiz: 'F:\\', duration: 10 }], null, { 'F:\\': sinLimite }, { bytesPorSegundo: MB_S });
  assert.strictEqual(r.segundos, null);
  assert.strictEqual(r.n, 1);
});

test('lo que no tiene duracion cuenta como la media', () => {
  const videos = [{ raiz: 'F:\\', duration: 30 }, { raiz: 'F:\\', duration: 10 }, { raiz: 'F:\\' }];
  const r = estimarLote(videos, { segPorSegundo: 1, arranqueSeg: 0 }, { 'F:\\': sinLimite }, { bytesPorSegundo: MB_S });
  assert.strictEqual(r.segundos, 30 + 10 + 20);
  assert.strictEqual(r.sinMedir, 1);
});

test('al llegar al tope ese disco se para y lo suyo no cuenta; los demas siguen', () => {
  // Tope de 1 GB con 0,5 GB ya ocupados: caben ~0,5 GB = ~826 s de video.
  const presupuestos = {
    'F:\\': { topeBytes: GB, ocupadoBytes: GB / 2, libreGB: 500, minLibreGB: 30 },
    'D:\\': sinLimite,
  };
  const videos = [
    { raiz: 'F:\\', duration: 600 },
    { raiz: 'D:\\', duration: 100 },
    { raiz: 'F:\\', duration: 600 }, // ya no cabe
    { raiz: 'F:\\', duration: 10 },  // cabria, pero el disco ya se paro (como el lote)
  ];
  const r = estimarLote(videos, { segPorSegundo: 1, arranqueSeg: 0 }, presupuestos, { bytesPorSegundo: MB_S });
  assert.strictEqual(r.n, 2);
  assert.strictEqual(r.fuera, 2);
  assert.strictEqual(r.segundos, 700);
  const f = r.discos.find(d => d.raiz === 'F:\\');
  assert.deepStrictEqual([f.n, f.fuera, f.limite, f.topeGB], [1, 2, 'tope', 1]);
  assert.strictEqual(r.discos.find(d => d.raiz === 'D:\\').limite, null);
});

test('un disco con poco sitio se para antes que su tope', () => {
  // 30,2 GB libres y minimo de 30: caben ~0,2 GB.
  const presupuestos = { 'C:\\': { topeBytes: 40 * GB, ocupadoBytes: 0, libreGB: 30.2, minLibreGB: 30 } };
  const videos = Array.from({ length: 5 }, () => ({ raiz: 'C:\\', duration: 100 }));
  const r = estimarLote(videos, null, presupuestos, { bytesPorSegundo: MB_S });
  assert.strictEqual(r.discos[0].limite, 'sitio');
  assert.strictEqual(r.n, 3);
  assert.strictEqual(r.fuera, 2);
});
