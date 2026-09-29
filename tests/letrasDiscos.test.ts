// Letras fijas para los discos (src/utils/letrasDiscos.ts). Datos inventados.
import test from 'node:test';
import assert from 'node:assert';
import { planLetras, discosDeLaTarjeta, letraDe, type RutaConDisco } from '../src/utils/letrasDiscos.ts';

const disco = (etiqueta: string) => ({ etiqueta, capacidad: 6e12 });

// Dos discos con la misma carpeta y las letras cruzadas: el de "a" (apuntada
// a D:) esta en G:, y el de "b" (apuntada a E:) esta en D:, la ruta de "a".
const cruzadas: RutaConDisco[] = [
  { id: 'c', path: 'C:\\Fotos' },
  { id: 'a', path: 'D:\\Trabajos', disco: disco('Disco Seis'), sugerencia: { ruta: 'G:\\Trabajos' } },
  {
    id: 'b', path: 'E:\\Trabajos', disco: disco('Disco Diez'),
    sugerencia: { ruta: 'D:\\Trabajos', ocupadaPor: { id: 'a', nombre: 'Trabajos', mismoDisco: false, suDisco: 'G:\\Trabajos' } },
  },
];

test('letraDe', () => {
  assert.strictEqual(letraDe('g:\\Trabajos'), 'G:');
  assert.strictEqual(letraDe('\\\\nas\\fotos'), '');
  assert.strictEqual(letraDe(null), '');
});

test('letras cruzadas: una letra alta distinta para cada disco', () => {
  const plan = planLetras(cruzadas);
  assert.deepStrictEqual([...plan.keys()], ['G:', 'D:']);
  assert.strictEqual(plan.get('G:')!.letraNueva, 'W');
  assert.strictEqual(plan.get('G:')!.etiqueta, 'Disco Seis');
  assert.strictEqual(plan.get('D:')!.letraNueva, 'X');
});

test('las dos tarjetas proponen lo mismo, cada una con su disco primero', () => {
  const a = discosDeLaTarjeta(cruzadas, 'a');
  const b = discosDeLaTarjeta(cruzadas, 'b');
  assert.deepStrictEqual(a.map(d => `${d.letraAhora}>${d.letraNueva}`), ['G:>W', 'D:>X']);
  assert.deepStrictEqual(b.map(d => `${d.letraAhora}>${d.letraNueva}`), ['D:>X', 'G:>W']);
  assert.deepStrictEqual(discosDeLaTarjeta(cruzadas, 'c'), []);
});

test('no propone una letra que ya usa una biblioteca', () => {
  const rutas: RutaConDisco[] = [
    { id: 'w', path: 'W:\\Archivo' },
    { id: 'a', path: 'D:\\Fotos', sugerencia: { ruta: 'E:\\Fotos' } },
  ];
  assert.strictEqual(planLetras(rutas).get('E:')!.letraNueva, 'X');
});

test('un disco ya en una letra alta no necesita tutorial', () => {
  const rutas: RutaConDisco[] = [
    { id: 'a', path: 'D:\\Trabajos', sugerencia: { ruta: 'W:\\Trabajos' } },
    { id: 'b', path: 'E:\\Trabajos', sugerencia: { ruta: 'X:\\Trabajos' } },
  ];
  assert.strictEqual(planLetras(rutas).size, 0);
  assert.deepStrictEqual(discosDeLaTarjeta(rutas, 'a'), []);
});

test('dos bibliotecas del mismo disco comparten letra nueva', () => {
  const rutas: RutaConDisco[] = [
    { id: 'f', path: 'D:\\Fotos', sugerencia: { ruta: 'F:\\Fotos' } },
    { id: 'v', path: 'D:\\Videos', sugerencia: { ruta: 'F:\\Videos' } },
  ];
  const plan = planLetras(rutas);
  assert.strictEqual(plan.size, 1);
  assert.deepStrictEqual(plan.get('F:')!.bibliotecas, ['f', 'v']);
});

test('una biblioteca desvinculada no cuenta', () => {
  const rutas: RutaConDisco[] = [
    { id: 'a', path: 'D:\\Fotos', isActive: false, sugerencia: { ruta: 'E:\\Fotos' } },
  ];
  assert.strictEqual(planLetras(rutas).size, 0);
});
