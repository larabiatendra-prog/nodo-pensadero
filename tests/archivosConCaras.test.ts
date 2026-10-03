// "Archivos con caras" en Personas e Inicio (src/utils/persons.ts).
import test from 'node:test';
import assert from 'node:assert';
import { archivosConCaras } from '../src/utils/persons.ts';

test('cuenta archivos con alguna cara, tenga nombre o no, sin inflar por fotogramas', () => {
  const sinNombre = { face_boxes: [{}, {}, {}], faces: [] };
  const conNombre = { face_boxes: [{}], faces: [{}] };
  const videoConMuchos = { face_boxes: Array.from({ length: 40 }, () => ({})) };
  const paisaje = { face_boxes: [], faces: [] };
  assert.strictEqual(archivosConCaras([sinNombre, conNombre, videoConMuchos, paisaje, {}]), 3);
  assert.strictEqual(archivosConCaras([]), 0);
});
