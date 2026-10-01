// Etiquetas legibles (utils/etiquetas.js) y lo que hereda un archivo de sus
// carpetas (folderNames.applyFolderInheritance). Datos inventados.
const test = require('node:test');
const assert = require('node:assert');
const { etiquetaDeEscaneo, esCodigoDeArchivo, esCarpetaTecnica } = require('../utils/etiquetas');
const folderNames = require('../folderNames');

test('los atributos del escaneo se escriben como se dicen', () => {
  assert.strictEqual(etiquetaDeEscaneo('shot_type', 'plano_general'), 'plano general');
  assert.strictEqual(etiquetaDeEscaneo('people_framing', 'ninguno'), 'sin personas');
  assert.strictEqual(etiquetaDeEscaneo('people_framing', 'grupo_pequeno'), 'grupo pequeño');
  assert.strictEqual(etiquetaDeEscaneo('camera_angle', 'normal'), 'ángulo normal');
  assert.strictEqual(etiquetaDeEscaneo('time_of_day', 'indeterminado'), null);
  assert.strictEqual(etiquetaDeEscaneo('mood', 'alegre'), 'alegre', 'lo que no es codigo, tal cual');
  assert.strictEqual(etiquetaDeEscaneo('shot_type', 'plano_raro'), 'plano raro', 'fuera de la tabla, sin guiones bajos');
});

test('contadores y prefijos de camara no son etiquetas; las palabras si', () => {
  for (const c of ['C0001', 'WA0010', 'ZOOM0001', 'P1000001', 'JBS01', 'IMG', 'DSC', 'V', 'y']) assert.ok(esCodigoDeArchivo(c), c);
  for (const p of ['Boda', 'BANQUETE', 'Concierto', 'FX3', 'Q2', 'HD', '4K', 'KSC']) assert.ok(!esCodigoDeArchivo(p), p);
  assert.ok(esCarpetaTecnica('100MSDCF') && esCarpetaTecnica('CLIP') && !esCarpetaTecnica('clips'));
});

test('el material de camara hereda el evento con su fecha en cualquier forma', () => {
  const nombre = (s) => ({ tags: s.split(/[-_]+/).filter(p => p && !/^\d+$/.test(p) && !esCodigoDeArchivo(p)) });
  const f = {
    fullPath: String.raw`D:\BODAS\2026-06-14_Ana_y_Pablo\CAM_A_FX3\PRIVATE\M4ROOT\CLIP\C0001.MP4`,
    relativePath: '2026-06-14_Ana_y_Pablo/CAM_A_FX3/PRIVATE/M4ROOT/CLIP/C0001.MP4',
    tags: [],
  };
  folderNames.applyFolderInheritance([f], { smartTags: nombre });
  assert.strictEqual(f.folderName, '2026-06-14_Ana_y_Pablo / CAM_A_FX3');
  assert.ok(f.tags.includes('Ana') && f.tags.includes('Pablo'));
  assert.ok(!f.tags.includes('CLIP') && !f.tags.includes('M4ROOT') && !f.tags.includes('y'));
  // Las carpetas AAMMDD_ siguen igual.
  const g = { fullPath: String.raw`F:\Archivo\240811_Playa\clips\P1.MP4`, relativePath: '240811_Playa/clips/P1.MP4', tags: [] };
  folderNames.applyFolderInheritance([g], { smartTags: nombre });
  assert.strictEqual(g.folderName, '240811_Playa / clips');
});

test('lo de la cache tambien se limpia; lo que tiene espacios o es fecha se queda', () => {
  const { limpiarEtiquetas } = require('../utils/etiquetas');
  const [f] = limpiarEtiquetas([{ tags: ['CLIP', 'C0002', 'Ana', 'IMG', 'primer plano', '26-06-14', '2026', 'Concert Adri', 'V'] }]);
  assert.deepStrictEqual(f.tags, ['Ana', 'primer plano', '26-06-14', '2026', 'Concert Adri']);
});
