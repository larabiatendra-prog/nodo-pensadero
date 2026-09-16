/**
 * Ocultos Routes — Pensadero
 *
 * El candado del material (ver ocultosManager.js).
 *
 *  - GET  /api/ocultos/estado          -> { total }            (sin clave: solo cuantos)
 *  - POST /api/ocultos/ocultar         -> body { ids }         (sin clave: ocultar no expone nada)
 *  - POST /api/ocultos/deshacer        -> body { token }       (unos segundos tras ocultar)
 *  - POST /api/ocultos/abrir           -> body { clave }       -> { llave, caduca }
 *  - POST /api/ocultos/cerrar          -> cabecera de llave
 *  - GET  /api/ocultos                 -> cabecera de llave    -> archivos ocultos
 *  - POST /api/ocultos/mostrar         -> cabecera de llave, body { ids }
 *  - POST /api/ocultos/clave           -> body { actual, nueva }
 *
 * La llave viaja en la cabecera `x-llave-ocultos`, nunca en la URL: una URL
 * acaba en el historial y en los logs.
 */

const express = require('express');
const ocultosManager = require('../ocultosManager');
const fallos = require('../utils/failureReason');

const CABECERA = 'x-llave-ocultos';

module.exports = function createOcultosRoutes(deps = {}) {
  const router = express.Router();
  const { getMediaFiles, broadcastProgress } = deps;

  const todos = () => (typeof getMediaFiles === 'function' ? getMediaFiles() : []);
  const avisar = () => {
    // La galeria se recarga en silencio: lo oculto sale, lo liberado vuelve.
    if (typeof broadcastProgress === 'function') broadcastProgress({ type: 'catalog_refresh', motivo: 'ocultos' });
  };
  const conLlave = (req, res, next) => {
    if (!ocultosManager.llaveValida(req.get(CABECERA))) {
      return res.status(401).json({ success: false, error: 'Hace falta la clave', codigo: 'sin_llave' });
    }
    next();
  };
  const fallo = (res, operacion, err) => {
    const causa = fallos.record(operacion, err, {});
    res.status(500).json({ success: false, error: (causa && causa.reason) || err.message });
  };

  router.get('/ocultos/estado', async (req, res) => {
    await ocultosManager.ensureLoaded();
    res.json({ success: true, data: { total: ocultosManager.total() } });
  });

  router.post('/ocultos/ocultar', async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (ids.length === 0) return res.status(400).json({ success: false, error: 'ids requeridos' });
    try {
      const porId = new Set(ids);
      const files = todos().filter(f => porId.has(f.id));
      // Sin aviso de recarga: la galeria ya lo ha quitado al pulsar, y una
      // recarga completa por cada candado haria parpadear la pantalla.
      const r = await ocultosManager.ocultar(files);
      res.json({ success: true, data: { ...r, total: ocultosManager.total() } });
    } catch (err) {
      fallo(res, 'ocultar material', err);
    }
  });

  router.post('/ocultos/deshacer', async (req, res) => {
    try {
      const n = await ocultosManager.deshacerOcultado(req.body && req.body.token);
      if (n === null) {
        return res.status(410).json({ success: false, error: 'Ya no se puede deshacer: sácalo desde Material oculto' });
      }
      if (n > 0) avisar();
      res.json({ success: true, data: { mostrados: n, total: ocultosManager.total() } });
    } catch (err) {
      fallo(res, 'deshacer el ocultado', err);
    }
  });

  router.post('/ocultos/abrir', async (req, res) => {
    await ocultosManager.ensureLoaded();
    const r = ocultosManager.abrir(req.body && req.body.clave);
    if (!r) {
      // Una pausa corta ante una clave mala: probar claves a mano sigue
      // siendo posible, a ciegas y a toda velocidad ya no.
      await new Promise(ok => setTimeout(ok, 600));
      return res.status(401).json({ success: false, error: 'Clave incorrecta' });
    }
    res.json({ success: true, data: r });
  });

  router.post('/ocultos/cerrar', (req, res) => {
    ocultosManager.cerrar(req.get(CABECERA));
    res.json({ success: true });
  });

  router.get('/ocultos', conLlave, async (req, res) => {
    const files = todos().filter(f => ocultosManager.estaOculto(f));
    // Entradas cuyo archivo no esta ahora en el catalogo: disco desconectado.
    // Se listan igual para poder liberarlas sin esperar a que vuelva.
    const presentes = new Set();
    for (const f of files) {
      if (f.mediaKey) presentes.add(f.mediaKey);
      presentes.add(f.id);
    }
    const ausentes = ocultosManager.entradas()
      .filter(e => !presentes.has(e.clave) && !(e.id && presentes.has(e.id)))
      .map(e => ({ clave: e.clave, nombre: e.nombre, desde: e.desde }));
    res.json({ success: true, data: { files, ausentes, total: ocultosManager.total() } });
  });

  router.post('/ocultos/mostrar', conLlave, async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (ids.length === 0) return res.status(400).json({ success: false, error: 'ids requeridos' });
    try {
      const n = await ocultosManager.mostrar(ids);
      if (n > 0) avisar();
      res.json({ success: true, data: { mostrados: n, total: ocultosManager.total() } });
    } catch (err) {
      fallo(res, 'sacar material del candado', err);
    }
  });

  router.post('/ocultos/clave', async (req, res) => {
    const { actual, nueva } = req.body || {};
    try {
      const r = await ocultosManager.cambiarClave(actual, nueva);
      if (!r.ok) return res.status(400).json({ success: false, error: r.error });
      res.json({ success: true });
    } catch (err) {
      fallo(res, 'cambiar la clave del material oculto', err);
    }
  });

  return router;
};
