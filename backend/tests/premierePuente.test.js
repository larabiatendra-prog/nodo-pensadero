// El puente entero sin Premiere: las rutas de verdad (routes/premiereRoutes.js)
// con videos de verdad, la extension de verdad (premiere/extension/enlace.js)
// hablando por http, y un Premiere de juguete que ejecuta el host.jsx real.
// Lo que hace la cesta: preparar, enviar y esperar el resumen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const express = require('express');
const { execFileSync } = require('child_process');
const createPremiereRoutes = require('../routes/premiereRoutes');
const { premiereDeMentira } = require('./ayudas/premiereDeMentira');

const ENLACE = fs.readFileSync(path.join(__dirname, '..', '..', 'premiere', 'extension', 'enlace.js'), 'utf8');

function hayFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('preparar, enviar y recibir el resumen: lo que falta y lo que no encaja, dicho', { timeout: 60000 }, async (t) => {
  if (!hayFfmpeg()) { t.skip('sin ffmpeg'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pensadero-puente-'));
  const relojes = [];
  let servidor;
  try {
    // Tres videos: dos apaisados y uno de camara girada (vertical al verse).
    const hacer = (nombre, extra = []) => {
      const ruta = path.join(dir, nombre);
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
        '-t', '1', '-pix_fmt', 'yuv420p', '-shortest', ...extra, ruta]);
      return ruta;
    };
    const a = hacer('Año uno.mp4');
    const b = hacer('dos.mp4');
    const plano = hacer('plano.mp4');
    const girado = path.join(dir, 'girado.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-display_rotation', '90', '-i', plano, '-c', 'copy', girado]);
    const falta = path.join(dir, 'no-esta.mp4');
    // Un .mp4 que no es un video: Premiere sacaria un aviso y se pararia.
    const roto = path.join(dir, 'roto.mp4');
    fs.writeFileSync(roto, Buffer.alloc(50000, 7));

    const archivo = (id, ruta, extra = {}) => ({
      id, name: path.basename(ruta), fullPath: ruta, type: 'video', fechaDia: 20261012, fechaMinuto: 600,
      faces: [], visual_description: '', isFavorite: false, duration: 1, fps: 25, ...extra,
    });
    const archivos = [
      archivo('a', a, { faces: [{ display_name: 'Ana' }], visual_description: 'Plaza llena', isFavorite: true }),
      archivo('g', girado),
      archivo('b', b),
      archivo('f', falta),
      archivo('r', roto),
    ];

    const app = express();
    app.use(express.json());
    app.use('/api', createPremiereRoutes({
      getMediaFiles: () => archivos,
      notesManager: { files: new Map([['a', { note: 'La buena' }]]), ensureLoaded: async () => {} },
      loadScanPaths: async () => [],
    }));
    servidor = await new Promise(ok => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const puerto = servidor.address().port;
    const api = async (metodo, ruta, cuerpo) => {
      const r = await fetch(`http://127.0.0.1:${puerto}/api${ruta}`, {
        method: metodo, headers: { 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
      return r.json();
    };

    // Premiere de juguete y la extension real, con su latido cada 50 ms.
    const medidas = { [a]: { ancho: 640, alto: 360 }, [b]: { ancho: 640, alto: 360 }, [girado]: { ancho: 360, alto: 640 } };
    const premiere = premiereDeMentira({ existen: (r) => fs.existsSync(r), medidas });
    const ventana = {
      pensaderoPuerto: puerto,
      __adobe_cep__: { evalScript: (s, cb) => setImmediate(() => cb(String(vm.runInContext(s, premiere.ctx)))) },
    };
    const ctxExt = vm.createContext({
      window: ventana, document: { getElementById: () => null }, require,
      // El latido (2 s) va deprisa en la prueba; el vigilante de avisos, a su ritmo.
      setInterval: (f, ms) => { const r = setInterval(f, ms === 2000 ? 50 : ms); relojes.push(r); return r; },
      clearInterval,
      console,
    });
    vm.runInContext(ENLACE, ctxExt);

    // Sin envio: Premiere conectado, con proyecto y el puente nuevo.
    let estado;
    for (let i = 0; i < 40; i++) {
      estado = (await api('GET', '/premiere/estado')).data;
      if (estado.conectado) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.strictEqual(estado.conectado, true);
    assert.strictEqual(estado.proyecto, 'Boda.prproj');
    assert.strictEqual(estado.puente, 3);
    assert.strictEqual(estado.puenteActual, 3);

    // La cesta: el vertical va el primero en la secuencia.
    const prep = (await api('POST', '/premiere/xml', { ids: ['g', 'a', 'b', 'f', 'r'], nombre: 'Prueba', ordenar: 'todo', marcadores: true, secuencia: true })).data;
    assert.strictEqual(prep.prevision.forma, 'horizontal');
    assert.strictEqual(prep.prevision.otraForma, 1);
    assert.match(prep.url, /^\/api\/premiere\/xml\//);
    assert.deepStrictEqual(prep.avisos.ilegibles, ['roto.mp4']);

    const id = (await api('POST', '/premiere/enviar', { token: prep.token })).data.id;
    let envio;
    for (let i = 0; i < 200; i++) {
      envio = (await api('GET', `/premiere/envios/${id}`)).data;
      if (envio.estado === 'hecho' || envio.estado === 'error') break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.strictEqual(envio.estado, 'hecho', envio.error || '');
    assert.strictEqual(envio.resumen.importados, 3);
    assert.strictEqual(envio.resumen.total, 4);
    assert.strictEqual(envio.resumen.bandeja, 'Prueba');
    assert.deepStrictEqual(envio.resumen.secuencia, { nombre: 'Prueba', ancho: 640, alto: 360, fps: 25 });
    assert.ok(envio.resumen.avisos.some(x => /No se encontró 1 archivo.*no-esta\.mp4/.test(x)), envio.resumen.avisos.join('\n'));
    assert.ok(envio.resumen.avisos.some(x => /1 clip tiene otra forma: no se deforma,/.test(x)), envio.resumen.avisos.join('\n'));
    assert.ok(envio.resumen.avisos.some(x => /No se envió 1 archivo que no se puede leer.*roto\.mp4/.test(x)), envio.resumen.avisos.join('\n'));

    // Dentro de Premiere: la bandeja, el favorito con su color, nota y personas.
    const bandeja = premiere.raiz.children.find(c => c.name === 'Prueba');
    const fav = bandeja.children.find(c => c.name === 'Año uno.mp4');
    assert.strictEqual(fav._etiqueta, 7);
    assert.match(fav._meta, /Ana · La buena/);
    assert.match(fav._meta, /Plaza llena/);
    assert.strictEqual(premiere.secuencias.length, 1);
    assert.deepStrictEqual(Array.from(premiere.secuencias[0].items, i => i.name), ['girado.mp4', 'Año uno.mp4', 'dos.mp4']);
  } finally {
    relojes.forEach(r => clearInterval(r));
    if (servidor) await new Promise(ok => servidor.close(ok));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
