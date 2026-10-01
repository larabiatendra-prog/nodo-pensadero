// Busqueda en lenguaje natural (aiSearchService): nombres sueltos, fecha real
// y nunca un 0 mudo. El modelo se simula: no hace falta Ollama.
process.env.AI_RERANK_ENABLED = 'false';
const test = require('node:test');
const assert = require('node:assert');
const ai = require('../aiSearchService');

const boda = (rel, extra = {}) => ({
  id: rel, name: rel.split('/').pop(), type: 'video', tags: ['carruaje'],
  mediaKey: `0123456789abcdef:${rel}`, fechaDia: 20260614, ...extra,
});

test('un nombre que no es de nadie conocido pasa a buscarse como texto', () => {
  const sinNadie = ai.normalizeIntent({ person_ids: ['ana', 'pablo'], free_terms: ['carruaje'] }, '', []);
  assert.deepStrictEqual(sinNadie.person_ids, []);
  assert.deepStrictEqual(sinNadie.free_terms, ['carruaje', 'ana', 'pablo']);
  const conGente = ai.normalizeIntent({ person_ids: ['lucia', 'ana'] }, '', [{ person_id: 'lucia' }]);
  assert.deepStrictEqual(conGente.person_ids, ['lucia']);
  assert.deepStrictEqual(conGente.free_terms, ['ana']);
});

test('el texto se busca en las carpetas por palabra entera', () => {
  const intent = ai.normalizeIntent({ free_terms: ['ana'] }, '', []);
  const r = ai.scoreMediaFiles(intent, [
    boda('2026-06-14_ana_y_pablo/cam_a_fx3/clip/c0001.mp4'),
    boda('banana_split/c0002.mp4'),
  ], 200, null, { sinTramos: true });
  const porId = Object.fromEntries(r.map(x => [x.fileId, x.matchedIn]));
  assert.ok(porId['2026-06-14_ana_y_pablo/cam_a_fx3/clip/c0001.mp4'].includes('carpeta'));
  assert.ok(!(porId['banana_split/c0002.mp4'] || []).includes('carpeta'));
});

test('la fecha se compara con la fecha real del archivo', () => {
  const files = [boda('a/c1.mp4')];
  const junio = ai.normalizeIntent({ year: 2026, month: '06' }, '', []);
  const sept = ai.normalizeIntent({ year: 2026, month: '09' }, '', []);
  assert.strictEqual(ai.scoreMediaFiles(junio, files, 200, null, { sinTramos: true }).length, 1);
  assert.strictEqual(ai.scoreMediaFiles(sept, files, 200, null, { sinTramos: true }).length, 0);
});

test('si la fecha deducida deja 0, se busca sin ella y se dice', async () => {
  const original = { extract: ai.extractSearchIntent, sem: ai.computeSemanticScores };
  ai.extractSearchIntent = async () => ai.normalizeIntent({ year: 2026, month: '09', tags: ['carruaje'] }, '', []);
  ai.computeSemanticScores = async () => null;
  try {
    const r = await ai.parseNaturalQuery('carruaje del segundo dia', [boda('a/c1.mp4')]);
    assert.ok(r.results.length > 0);
    assert.deepStrictEqual(r.metadata.relajado, [{ que: 'fecha', valor: 'septiembre de 2026' }]);
    assert.strictEqual(r.intent.month, null);
  } finally {
    ai.extractSearchIntent = original.extract;
    ai.computeSemanticScores = original.sem;
  }
});

test('tipo y fecha solo si la consulta los dice', () => {
  const sinTipo = ai.normalizeIntent({ type: 'image', year: 2026, month: '09' }, 'el carruaje de los novios del segundo dia', []);
  assert.strictEqual(sinTipo.type, null);
  assert.strictEqual(sinTipo.month, null);
  assert.strictEqual(sinTipo.year, null);
  const conTodo = ai.normalizeIntent({ type: 'video', year: 2025, month: '07', month_name: 'julio' }, 'vídeos de la playa en julio de 2025', []);
  assert.deepStrictEqual([conTodo.type, conTodo.year, conTodo.month], ['video', '2025', '07']);
  assert.strictEqual(ai.normalizeIntent({ year: 2025 }, 'fotos del año pasado', []).year, '2025');
});

test('el tipo sale de las palabras de la consulta, lo ponga el modelo o no', () => {
  assert.strictEqual(ai.normalizeIntent({ tags: ['conciertos'] }, 'fotos de conciertos', []).type, 'image');
  const v = ai.normalizeIntent({ tags: ['conciertos', 'videos'] }, 'vídeos de conciertos', []);
  assert.strictEqual(v.type, 'video');
  assert.deepStrictEqual(v.tags, ['conciertos'], '"videos" ya es el tipo, no una etiqueta');
  assert.strictEqual(ai.normalizeIntent({ type: 'image' }, 'fotos y vídeos de la playa', []).type, null);
  assert.strictEqual(ai.normalizeIntent({ type: 'audio' }, 'concierto de música en Valencia', []).type, null);
  assert.strictEqual(ai.normalizeIntent({}, 'notas de voz de mi madre', []).type, 'audio');
});

test('una etiqueta corta no casa con todo lo que la contenga', () => {
  const intent = ai.normalizeIntent({ tags: ['conciertos'] }, 'conciertos', []);
  const r = ai.scoreMediaFiles(intent, [
    { id: 'v', name: 'a.mp3', type: 'audio', tags: ['V', 'con'] },
    { id: 'c', name: 'b.mp4', type: 'video', tags: ['Concierto'] },
  ], 200, null, { sinTramos: true });
  const tags = Object.fromEntries(r.map(x => [x.fileId, x.matchedIn.includes('tags')]));
  assert.strictEqual(tags.v, false);
  assert.strictEqual(tags.c, true);
});

test('claro = casa con lo pedido; lo deducido o los sinonimos solos van aparte', () => {
  const intent = ai.normalizeIntent({ tags: ['festival'], people_framing: 'multitud', expanded_terms: ['concert'] }, 'el segundo dia del festival', []);
  const r = ai.scoreMediaFiles(intent, [
    { id: 'fest', name: 'a.mp4', type: 'video', tags: ['festival'], composition: { people_framing: 'multitud' } },
    { id: 'gente', name: 'b.mp4', type: 'video', tags: ['calle'], composition: { people_framing: 'multitud' } },
    { id: 'sinon', name: 'c.mp4', type: 'video', tags: ['concert'] },
  ]);
  const tramo = Object.fromEntries(r.map(x => [x.fileId, x.tier]));
  assert.strictEqual(tramo.fest, 'primary');
  assert.notStrictEqual(tramo.gente, 'primary', 'solo "multitud", que nadie pidio');
  assert.notStrictEqual(tramo.sinon, 'primary', 'solo un sinonimo del modelo');
  // Si la frase pide el encuadre, si cuenta.
  const grupo = ai.normalizeIntent({ people_framing: 'grupo' }, 'una foto de grupo', []);
  const g = ai.scoreMediaFiles(grupo, [{ id: 'g', name: 'g.jpg', type: 'image', tags: [], composition: { people_framing: 'grupo' } }]);
  assert.strictEqual(g[0]?.tier, 'primary');
});
