// Nombres de sesion (src/utils/filenameParser.ts): el evento y de que va, no la
// carpeta que crea la camara. Casos de la prueba con 11 usuarios simulados.
import test from 'node:test';
import assert from 'node:assert';
import {
  etiquetaDeCarpeta, etiquetaDeSesionSuelta, fechaDeCarpeta, esCarpetaTecnica,
  nombreDeBiblioteca, getSessionKey, parseSmartLabel, getFolderLabelSource,
} from '../src/utils/filenameParser.ts';

/** Archivo como lo manda el servidor: ruta completa + mediaKey dentro de su biblioteca. */
function archivo(biblioteca: string, relativa: string) {
  const fullPath = `${biblioteca}\\${relativa}`;
  return { name: relativa.split('\\').pop()!, fullPath, mediaKey: `0123456789abcdef:${relativa.replace(/\\/g, '/').toLowerCase()}` };
}

test('bodas: las tarjetas Sony dicen la boda y la camara, no CLIP ni 100MSDCF', () => {
  const B = 'D:\\BODAS';
  assert.deepStrictEqual(
    etiquetaDeCarpeta(archivo(B, '2026-06-14_Ana_y_Pablo\\CAM_A_FX3\\PRIVATE\\M4ROOT\\CLIP\\C0001.MP4')),
    { line1: '14 jun 2026', line2: 'Ana y Pablo / CAM A FX3' });
  assert.deepStrictEqual(
    etiquetaDeCarpeta(archivo(B, '2026-06-14_Ana_y_Pablo\\CAM_B_A7SIII\\DCIM\\100MSDCF\\C0301.MP4')),
    { line1: '14 jun 2026', line2: 'Ana y Pablo / CAM B A7SIII' });
  assert.deepStrictEqual(
    etiquetaDeCarpeta(archivo(B, '2026-06-14_Ana_y_Pablo\\CAM_A_FX3\\BANQUETE\\C0200.MP4')),
    { line1: '14 jun 2026', line2: 'Ana y Pablo / BANQUETE' });
});

test('documentalista: el fondo y su rango de años', () => {
  assert.deepStrictEqual(
    etiquetaDeCarpeta(archivo('E:\\ARCHIVO', 'FONDO_FAMILIAR_1930-1959\\TIFF_MAESTROS\\FONDO_FAMILIAR_001.tif')),
    { line1: '1930-1959', line2: 'FONDO FAMILIAR / TIFF MAESTROS' });
});

test('agencia: tres dias del mismo fotografo: el congreso, el fotografo y el dia arriba', () => {
  const B = '\\\\NAS\\Eventos';
  const dia = (d: string, dia8: number) => etiquetaDeSesionSuelta(`k#${dia8}`, archivo(B, `2026-03_Congreso_Cliente\\${d}\\Jorge\\foto.jpg`));
  assert.deepStrictEqual(dia('Dia_1', 20260310), { line1: '10 mar 2026', line2: 'Congreso Cliente / Jorge' });
  assert.notStrictEqual(dia('Dia_1', 20260310).line1, dia('Dia_2', 20260311).line1);
});

test('las carpetas AAMMDD_ de Daniel se ven igual que antes', () => {
  const B = 'F:\\(1) WORKS';
  for (const rel of ['260811_Ondara\\P1000001.MP4', '260811_Ondara\\clips\\P1000002.MP4', '190907_Bioritme\\Clips\\Selects\\a.mov']) {
    const f = archivo(B, rel);
    assert.deepStrictEqual(etiquetaDeCarpeta(f), parseSmartLabel(getFolderLabelSource(f)!), rel);
  }
});

test('dia suelto del movil: carpeta numerica dentro de la biblioteca -> la biblioteca', () => {
  const f = archivo('C:\\Fotos\\- Móvil', '3\\IMG_0001.jpg');
  assert.deepStrictEqual(etiquetaDeSesionSuelta('k#20241130', f), { line1: '30 nov 2024', line2: 'Móvil' });
});

test('fechas de carpeta en las formas habituales', () => {
  assert.deepStrictEqual(fechaDeCarpeta('2026-03_Congreso'), { fecha: 'mar 2026', resto: 'Congreso' });
  assert.deepStrictEqual(fechaDeCarpeta('Boda de la nieta 2011'), { fecha: '2011', resto: 'Boda de la nieta' });
  assert.deepStrictEqual(fechaDeCarpeta('2026_Q2_Campana_Artemis'), { fecha: '2026', resto: 'Q2 Campana Artemis' });
  assert.deepStrictEqual(fechaDeCarpeta('20260614 Lucia y Marc'), { fecha: '14 jun 2026', resto: 'Lucia y Marc' });
  for (const sin of ['CAM_A_FX3', '100MSDCF', 'Clip_123456', 'Dia_1', 'Jorge', '01_BRUTOS']) assert.strictEqual(fechaDeCarpeta(sin), null, sin);
});

test('carpetas tecnicas de camara y soporte', () => {
  for (const t of ['PRIVATE', 'M4ROOT', 'CLIP', 'DCIM', '100MSDCF', '100CANON', 'XDROOT', 'VIDEO_TS', '3']) assert.ok(esCarpetaTecnica(t), t);
  for (const no of ['clips', 'BANQUETE', 'CAM_A_FX3', 'Jorge', 'Selects']) assert.ok(!esCarpetaTecnica(no), no);
});

test('WhatsApp ya no se toma por "Prefijo - AAMMDD"', () => {
  assert.strictEqual(getSessionKey('IMG-20260614-WA0010.jpg'), null);
  assert.strictEqual(getSessionKey('KSC-20241119-PH-JBS01_0109.JPG'), null);
  assert.strictEqual(getSessionKey('EDEM_Bootcamp - 240617_Presentaciones.mp4'), 'EDEM_Bootcamp - 240617');
  assert.deepStrictEqual(parseSmartLabel('EDEM_Bootcamp - 240617_Presentaciones'), { line1: 'Bootcamp · 17 jun 2024', line2: 'Presentaciones' });
});

test('nombre de la biblioteca de un archivo (desempate servidor / backup)', () => {
  const rel = '02_PRODUCCION\\2026_Q2_Campana\\01_BRUTOS\\a.mp4';
  assert.strictEqual(nombreDeBiblioteca(archivo('Z:\\SERVIDOR_MARKETING', rel)), 'SERVIDOR_MARKETING');
  assert.strictEqual(nombreDeBiblioteca(archivo('Y:\\BACKUP_LTO_2026', rel)), 'BACKUP_LTO_2026');
});
