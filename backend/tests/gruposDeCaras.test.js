// "Caras sin nombre" (services/faceClusterer.js): un grupo se propone si sale
// en al menos 3 archivos distintos, no por tener 3 caras. Datos inventados.
const test = require('node:test');
const assert = require('node:assert');
const { archivosDistintos, seProponeGrupo } = require('../services/faceClusterer');

const cara = (folder, basename, face_index = 0) => ({ folder, basename, face_index });

test('tres caras pequeñas de la misma foto no son una persona', () => {
  const grupo = { cluster_id: 'c0_3', faces: [cara('D:/Fotos/Comida', 'DSC_0008.jpg', 2), cara('D:/Fotos/Comida', 'DSC_0008.jpg', 3), cara('D:/Fotos/Comida', 'DSC_0008.jpg', 5)] };
  assert.strictEqual(archivosDistintos(grupo.faces), 1);
  assert.strictEqual(seProponeGrupo(grupo), false);
});

test('varios fotogramas de un mismo video tampoco bastan; tres archivos si', () => {
  const video = { cluster_id: 'c1_4', faces: [cara('D:/V', 'clip.mp4', 0), cara('D:/V', 'clip.mp4', 1), cara('D:/V', 'clip.mp4', 2), cara('D:/V', 'otro.mp4', 0)] };
  assert.strictEqual(seProponeGrupo(video), false);
  const persona = { cluster_id: 'c2_3', faces: [cara('D:/A', '1.jpg'), cara('D:/A', '2.jpg'), cara('D:/B', '1.jpg')] };
  assert.strictEqual(archivosDistintos(persona.faces), 3, 'el mismo nombre en otra carpeta es otro archivo');
  assert.strictEqual(seProponeGrupo(persona), true);
});

test('lo fusionado o sembrado a mano se respeta aunque sea pequeño', () => {
  assert.strictEqual(seProponeGrupo({ cluster_id: 'merged_abc_2', faces: [cara('D:/A', '1.jpg')] }), true);
  assert.strictEqual(seProponeGrupo({ cluster_id: 'seed_abc_1', faces: [cara('D:/A', '1.jpg')] }), true);
});
