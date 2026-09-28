// Pista bajo la barra y promocion silenciosa (src/utils/pista.ts). Datos
// inventados; nunca el archivo real.
import test from 'node:test';
import assert from 'node:assert';
import { decidirPista, promocionSilenciosa, prepararVocabulario, levenshtein, prefijoMasCorto, errataMasCercana, type EntradaPista } from '../src/utils/pista.ts';

const vocab = prepararVocabulario(
  ['Playa', 'playa de noche', 'playas', 'Montaña', 'Cumpleaños', 'Lucía', 'jardín', 'tarta'],
  [{ person_id: 'lucia', display_name: 'Lucía' }, { person_id: 'pablo_ruiz', display_name: 'Pablo Ruiz' }],
);

function pista(extra: Partial<EntradaPista>) {
  return decidirPista({
    textos: [], incluidas: [], etiquetasActivas: [], personasActivas: [],
    vocabulario: vocab, resultados: 10, contar: () => 5, ...extra,
  });
}

test('levenshtein con corte', () => {
  assert.strictEqual(levenshtein('playa', 'plaza'), 1);
  assert.strictEqual(levenshtein('montana', 'montaña'), 1);
  assert.strictEqual(levenshtein('cumple', 'cumpleanos', 2), 3, 'la diferencia de largo ya supera el maximo');
  assert.strictEqual(levenshtein('abc', 'abc', 0), 0);
});

test('0. sin texto, una etiqueta activa que se llama como una persona: sustituirla', () => {
  const p = pista({ incluidas: ['Lucía'], etiquetasActivas: ['Lucía'], contar: () => 14 });
  assert.strictEqual(p?.caso, 0);
  assert.strictEqual(p?.frase, '«Lucía» también es una persona.');
  assert.strictEqual(p?.accion, 'Filtrar solo por Lucía (14)');
  assert.deepStrictEqual(p?.quitar, { clase: 'etiqueta', valor: 'Lucía' });
  assert.deepStrictEqual(p?.poner, { clase: 'persona', id: 'lucia', nombre: 'Lucía' });
});

test('1. el texto es una persona (gana a la etiqueta homonima)', () => {
  const p = pista({ textos: ['lucia'] });
  assert.strictEqual(p?.caso, 1);
  assert.strictEqual(p?.frase, '«lucia» también es una persona.');
  assert.deepStrictEqual(p?.quitar, { clase: 'texto', valor: 'lucia' });
});

test('2. el texto es una etiqueta; si la persona ya esta activa, se salta al 2', () => {
  assert.strictEqual(pista({ textos: ['PLAYA'] })?.accion, 'Filtrar solo por la etiqueta (5)');
  assert.strictEqual(pista({ textos: ['lucia'], personasActivas: ['lucia'] })?.caso, 2);
});

test('el recuento siempre a la vista; una accion que deja 0 no se ofrece', () => {
  assert.match(pista({ textos: ['playa'], contar: () => 3 })!.accion, /\(3\)$/);
  assert.strictEqual(pista({ textos: ['tarta'], contar: () => 0 }), null);
});

test('3. prefijo: la etiqueta mas corta que empieza por el texto', () => {
  const p = pista({ textos: ['cumple'] });
  assert.strictEqual(p?.caso, 'prefijo');
  assert.strictEqual(p?.frase, 'Ninguna etiqueta se llama «cumple»: se busca como coincidencia de texto.');
  assert.strictEqual(p?.accion, '¿Quizás Cumpleaños? (5)');
  assert.deepStrictEqual(prefijoMasCorto('pla', vocab), { clase: 'etiqueta', valor: 'Playa' });
  assert.strictEqual(prefijoMasCorto('pl', vocab), null, 'con menos de 3 letras no');
  // Sin etiqueta que empiece asi, la persona mas corta.
  assert.deepStrictEqual(prefijoMasCorto('pablo', vocab), { clase: 'persona', id: 'pablo_ruiz', nombre: 'Pablo Ruiz' });
});

test('4. errata: solo sin resultados y con 4 letras o mas', () => {
  assert.strictEqual(pista({ textos: ['montanya'], resultados: 3 }), null, 'con resultados no se corrige');
  const p = pista({ textos: ['montanya'], resultados: 0 });
  assert.strictEqual(p?.caso, 'errata');
  assert.strictEqual(p?.frase, 'Sin resultados para «montanya».');
  assert.strictEqual(p?.accion, '¿Quizás Montaña? (5)');
  assert.strictEqual(errataMasCercana('tatr', vocab), null, 'tatr -> tarta son 2: con 4 letras el maximo es 1');
  assert.strictEqual(errataMasCercana('pla', vocab), null);
  // A igual distancia, la mas corta.
  assert.deepStrictEqual(errataMasCercana('playaz', vocab), { clase: 'etiqueta', valor: 'Playa' });
});

test('la pista habla del ultimo texto', () => {
  assert.strictEqual(pista({ textos: ['playa', 'lucia'] })?.caso, 1);
});

test('promocion silenciosa: solo si no se pierde ni un resultado', () => {
  const activas = { etiquetas: [], personas: [] };
  assert.deepStrictEqual(promocionSilenciosa('playa', vocab, activas, () => true), { clase: 'etiqueta', valor: 'Playa' });
  assert.strictEqual(promocionSilenciosa('playa', vocab, activas, () => false), null);
  // La etiqueta pierde resultados pero la persona no: se promociona a la persona.
  assert.deepStrictEqual(
    promocionSilenciosa('lucia', vocab, activas, v => v.clase === 'persona'),
    { clase: 'persona', id: 'lucia', nombre: 'Lucía' },
  );
  assert.strictEqual(promocionSilenciosa('playa', vocab, { etiquetas: ['playa'], personas: [] }, () => true), null, 'ya activa');
  assert.strictEqual(promocionSilenciosa('nada', vocab, activas, () => true), null);
});
