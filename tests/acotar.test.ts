// Embudo «Acotar» (src/utils/acotar.ts): que sugiere, en que orden y con que
// recuento. Datos inventados; nunca el archivo real.
import test from 'node:test';
import assert from 'node:assert';
import { sugerirAcotar, frecuenciasCatalogo, llevaEtiqueta, cubiertaPorOtroFiltro, claveSugerencias, type ArchivoAcotable } from '../src/utils/acotar.ts';

const archivo = (tags: string[], personas: string[] = []): ArchivoAcotable =>
  ({ tags, faces: personas.map(person_id => ({ person_id })) });

function acotar(sub: ArchivoAcotable[], catalogo: ArchivoAcotable[], extra: Partial<Parameters<typeof sugerirAcotar>[0]> = {}) {
  return sugerirAcotar({ subconjunto: sub, catalogo, frecuencias: frecuenciasCatalogo(catalogo), activas: [], ...extra });
}

// Un catalogo de 200: 40 de una boda (con "ramo" en 10 y "baile" en 12) y 160
// de otras cosas. "adulto" esta en casi todo.
function catalogo() {
  const boda = Array.from({ length: 40 }, (_, i) => archivo([
    'boda', 'adulto',
    ...(i < 10 ? ['ramo'] : []),
    ...(i < 12 ? ['baile'] : []),
    ...(i < 20 ? ['exterior'] : []),
    '2024', 'Octubre', '24-10-12',
  ]));
  const resto = Array.from({ length: 160 }, (_, i) => archivo([
    'adulto', ...(i < 80 ? ['exterior'] : []), ...(i < 30 ? ['baile'] : []),
  ]));
  return { boda, todo: [...boda, ...resto] };
}

test('ordena por lift, no por frecuencia: lo propio de lo que se ve va primero', () => {
  const { boda, todo } = catalogo();
  const r = acotar(boda, todo, { activas: ['boda'] });
  // ramo solo existe en la boda (lift 5); baile existe en todo el archivo
  // (lift ~1,4); exterior esta en la mitad de todo (lift 1).
  assert.deepStrictEqual(r.map(s => s.etiqueta), ['ramo', 'baile', 'exterior']);
  assert.deepStrictEqual(r.map(s => s.n), [10, 12, 20]);
});

test('no sugiere lo activo, lo casi universal ni lo que ya cubre el filtro de fechas', () => {
  const { boda, todo } = catalogo();
  const r = acotar(boda, todo, { activas: ['boda'] }).map(s => s.etiqueta);
  assert.ok(!r.includes('boda'));
  assert.ok(!r.includes('adulto'), 'adulto esta en el 100 % de lo que se ve');
  for (const f of ['2024', 'Octubre', '24-10-12']) assert.ok(!r.includes(f), f);
});

test('solo con 12 resultados o mas, y nunca con el archivo entero', () => {
  const { boda, todo } = catalogo();
  assert.deepStrictEqual(acotar(boda.slice(0, 11), todo), []);
  assert.deepStrictEqual(acotar(todo, todo), []);
});

test('descarta lo que dejaria menos de 3 archivos', () => {
  const cat = [
    ...Array.from({ length: 20 }, (_, i) => archivo(['viaje', ...(i < 2 ? ['faro'] : []), ...(i < 5 ? ['barco'] : [])])),
    ...Array.from({ length: 80 }, () => archivo(['otra'])),
  ];
  const r = acotar(cat.slice(0, 20), cat, { activas: ['viaje'] }).map(s => s.etiqueta);
  assert.ok(!r.includes('faro'));
  assert.ok(r.includes('barco'));
});

test('las etiquetas con cifras valen; las que no tienen ni una letra, no', () => {
  assert.strictEqual(cubiertaPorOtroFiltro('fiesta 40 anos'), false);
  assert.strictEqual(cubiertaPorOtroFiltro('4k'), false);
  assert.strictEqual(cubiertaPorOtroFiltro('2.7'), true);
  assert.strictEqual(cubiertaPorOtroFiltro('2019'), true);
  assert.strictEqual(cubiertaPorOtroFiltro('marzo'), true);
});

test('tildes y mayusculas: una sola sugerencia con la grafia mas repetida y el recuento real', () => {
  const sub = [
    ...Array.from({ length: 6 }, () => archivo(['alegría'])),
    ...Array.from({ length: 2 }, () => archivo(['Alegria'])),
    ...Array.from({ length: 12 }, () => archivo(['nada'])),
  ];
  const cat = [...sub, ...Array.from({ length: 100 }, () => archivo(['otra']))];
  const r = acotar(sub, cat);
  const a = r.find(s => s.etiqueta.toLowerCase().startsWith('alegr'));
  assert.ok(a);
  assert.strictEqual(a!.etiqueta, 'alegría');
  assert.strictEqual(a!.n, 8);
  assert.strictEqual(r.filter(s => s.etiqueta.toLowerCase().startsWith('alegr')).length, 1);
});

test('el numero es lo que deja el filtro de verdad, que es por trozo', () => {
  const sub = [
    ...Array.from({ length: 4 }, () => archivo(['luz'])),
    ...Array.from({ length: 3 }, () => archivo(['luz_dorada'])),
    ...Array.from({ length: 20 }, () => archivo(['sombra'])),
  ];
  const cat = [...sub, ...Array.from({ length: 200 }, () => archivo(['otra']))];
  const luz = acotar(sub, cat).find(s => s.etiqueta === 'luz');
  assert.strictEqual(luz?.n, 7);
  assert.strictEqual(sub.filter(f => llevaEtiqueta(f, 'luz')).length, 7);
});

test('dos etiquetas que dejan los mismos archivos salen una vez', () => {
  const sub = [
    ...Array.from({ length: 5 }, () => archivo(['cumple', 'tarta'])),
    ...Array.from({ length: 20 }, () => archivo(['sala'])),
  ];
  const cat = [...sub, ...Array.from({ length: 100 }, () => archivo(['otra']))];
  const r = acotar(sub, cat).map(s => s.etiqueta);
  assert.strictEqual(r.filter(t => t === 'cumple' || t === 'tarta').length, 1);
});

test('con una persona activa no sugiere la etiqueta que se llama como ella', () => {
  const cara = { person_id: 'lucia_martin', display_name: 'Lucía Martín' };
  const deLucia: ArchivoAcotable[] = [
    ...Array.from({ length: 6 }, () => ({ tags: ['Lucía', 'jardin'], faces: [cara] })),
    ...Array.from({ length: 6 }, () => ({ tags: ['Casa Lucía', 'jardin'], faces: [cara] })),
    // "ramo" solo existe con ella: acompañarla siempre no la hace ella.
    ...Array.from({ length: 8 }, () => ({ tags: ['ramo', 'jardin'], faces: [cara] })),
  ];
  const cat = [
    ...deLucia,
    ...Array.from({ length: 11 }, () => archivo(['Lucía'])),
    ...Array.from({ length: 200 }, () => archivo(['otra'])),
  ];
  const r = acotar(deLucia, cat, { personas: ['lucia_martin'] }).map(s => s.etiqueta);
  assert.ok(!r.includes('Lucía'), r.join(','));
  assert.ok(r.includes('Casa Lucía'), 'un sitio con su nombre si acota');
  assert.ok(r.includes('ramo'), 'lo que siempre va con ella tambien');
  // Sin la persona activa, "Lucía" es una etiqueta mas.
  assert.ok(acotar(deLucia, cat).map(s => s.etiqueta).includes('Lucía'));
});

test('calcula hasta 12', () => {
  const sub = Array.from({ length: 100 }, (_, i) => archivo([`t${i % 20}`, 'base']));
  const cat = [...sub, ...Array.from({ length: 900 }, () => archivo(['otra']))];
  assert.strictEqual(acotar(sub, cat).length, 12);
});

test('la clave cambia con las etiquetas y no con los recuentos', () => {
  assert.strictEqual(claveSugerencias([{ etiqueta: 'Ramo', n: 3 }]), claveSugerencias([{ etiqueta: 'ramo', n: 9 }]));
  assert.notStrictEqual(claveSugerencias([{ etiqueta: 'ramo', n: 3 }]), claveSugerencias([{ etiqueta: 'baile', n: 3 }]));
});
