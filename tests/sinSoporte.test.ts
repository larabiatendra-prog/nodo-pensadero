// Aviso de Rutas de lo que aun no se sabe leer (src/utils/sinSoporte.ts).
import test from 'node:test';
import assert from 'node:assert';
import { textoSinSoporte, totalSinSoporte } from '../src/utils/sinSoporte.ts';

test('cuenta y nombra lo que no se sabe leer', () => {
  const raw = [{ familia: 'RAW de cámara', n: 32, exts: ['.arw', '.cr2', '.cr3', '.nef', '.raf'] }];
  assert.strictEqual(totalSinSoporte(raw), 32);
  assert.strictEqual(textoSinSoporte(raw), '32 archivos que Pensadero aún no sabe leer: RAW de cámara (ARW, CR2, CR3, NEF…). No salen en la galería.');
  assert.strictEqual(textoSinSoporte([{ familia: 'RAW de cine', n: 1, exts: ['.braw'] }]), '1 archivo que Pensadero aún no sabe leer: RAW de cine (BRAW). No sale en la galería.');
  assert.strictEqual(textoSinSoporte(null), '');
});
