/**
 * Los archivos de una persona — Pensadero
 *
 * Que hacer con todo el material en el que aparece alguien:
 *
 *  - GET  /api/personas/:id/archivos?alcance=todos|sin_otros
 *         -> vista previa: cuantos, cuanto pesan, con quien mas salen, en que
 *            discos. Nada se toca.
 *  - POST /api/personas/:id/ocultar   { alcance }
 *         -> bajo el candado: dejan de verse en la aplicacion, siguen en disco,
 *            se recuperan con la clave (ver ocultosManager).
 *  - POST /api/personas/:id/papelera  { alcance, confirmacion }
 *         -> se MUEVEN a la papelera de Pensadero (ver services/papelera.js).
 *            Hay que escribir el nombre de la persona: es la unica accion de
 *            esta pantalla que saca archivos de su sitio.
 *
 *  - GET  /api/papelera                          -> lotes en la papelera
 *  - POST /api/papelera/:lote/restaurar          -> todo a su sitio
 *  - POST /api/papelera/:lote/vaciar { confirmacion: 'vaciar' } -> borrar de verdad
 *
 * "Aparece" es: alguna cara de ese archivo esta identificada como esa persona.
 * "sin_otros": ademas, no hay ninguna otra persona identificada en el mismo
 * archivo. Importa sobre todo al borrar: una foto de grupo es tambien de los
 * demas, y la vista previa lo dice antes de que se toque nada.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const peopleRegistry = require('../peopleRegistry');
const ocultosManager = require('../ocultosManager');
const papelera = require('../services/papelera');
const fallos = require('../utils/failureReason');

const normal = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

module.exports = function createPersonaArchivosRoutes(deps = {}) {
  const router = express.Router();
  const { getMediaFiles, getScanPaths, syncFiles, broadcastProgress } = deps;
  const todos = () => (typeof getMediaFiles === 'function' ? getMediaFiles() : []);

  // El nombre sale del registro; si no esta (persona recien olvidada, registro
  // sin cargar), del que quedo apuntado en las propias caras del catalogo.
  const nombreDe = (id) => {
    const delRegistro = peopleRegistry.getDisplayName(id);
    if (delRegistro && delRegistro !== id) return delRegistro;
    for (const f of todos()) {
      for (const c of (f && f.faces) || []) {
        if (c && c.person_id === id && c.display_name) return c.display_name;
      }
    }
    return delRegistro || id;
  };

  /** Los archivos donde aparece. Del catalogo entero: tambien lo ya oculto. */
  function archivosDe(personId, alcance) {
    const out = [];
    for (const f of todos()) {
      const caras = Array.isArray(f && f.faces) ? f.faces : [];
      if (!caras.some(c => c && c.person_id === personId)) continue;
      if (alcance === 'sin_otros' && caras.some(c => c && c.person_id && c.person_id !== personId)) continue;
      out.push(f);
    }
    return out;
  }

  const fallo = (res, operacion, err) => {
    const causa = fallos.record(operacion, err, {});
    res.status(500).json({ success: false, error: causa.reason });
  };

  const alcanceDe = (v) => (v === 'sin_otros' ? 'sin_otros' : 'todos');

  // ── Vista previa ──────────────────────────────────────────────────────────
  router.get('/personas/:id/archivos', (req, res) => {
    try {
      const personId = req.params.id;
      const alcance = alcanceDe(req.query.alcance);
      const lista = archivosDe(personId, alcance);
      const soloElla = archivosDe(personId, 'sin_otros').length;

      let bytes = 0;
      const porTipo = { video: 0, image: 0, audio: 0 };
      const otros = new Map();
      const carpetas = new Map();
      const discos = new Map();
      let ocultos = 0;
      for (const f of lista) {
        bytes += f.size || 0;
        if (porTipo[f.type] !== undefined) porTipo[f.type]++;
        if (ocultosManager.estaOculto(f)) ocultos++;
        const vistos = new Set();
        for (const c of f.faces || []) {
          if (!c || !c.person_id || c.person_id === personId || vistos.has(c.person_id)) continue;
          vistos.add(c.person_id);
          otros.set(c.person_id, (otros.get(c.person_id) || 0) + 1);
        }
        const carpeta = f.fullPath ? path.basename(path.dirname(f.fullPath)) : '—';
        carpetas.set(carpeta, (carpetas.get(carpeta) || 0) + 1);
        const raiz = f.fullPath ? path.parse(f.fullPath).root.toUpperCase() : '?';
        const d = discos.get(raiz) || { raiz, n: 0, bytes: 0 };
        d.n++; d.bytes += f.size || 0;
        discos.set(raiz, d);
      }
      const conOtros = lista.filter(f => (f.faces || []).some(c => c && c.person_id && c.person_id !== personId)).length;

      res.json({
        success: true,
        data: {
          persona: { id: personId, nombre: nombreDe(personId) },
          alcance,
          total: lista.length,
          bytes,
          porTipo,
          soloElla,
          conOtros,
          otros: Array.from(otros.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6)
            .map(([id, n]) => ({ id, nombre: nombreDe(id), n })),
          carpetas: Array.from(carpetas.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([nombre, n]) => ({ nombre, n })),
          // Lo que esta en un disco desenchufado no se puede mover ahora.
          discos: Array.from(discos.values()).map(d => ({ ...d, conectado: fs.existsSync(d.raiz) })),
          ocultos,
          muestra: lista.slice(0, 12).map(f => f.id),
        },
      });
    } catch (err) {
      fallo(res, 'preparar la vista previa de los archivos de una persona', err);
    }
  });

  // ── Ocultar (candado) ────────────────────────────────────────────────────
  router.post('/personas/:id/ocultar', async (req, res) => {
    try {
      const personId = req.params.id;
      const lista = archivosDe(personId, alcanceDe(req.body && req.body.alcance));
      const r = await ocultosManager.ocultar(lista);
      // La galeria se recarga en silencio: lo oculto sale.
      if (typeof broadcastProgress === 'function') broadcastProgress({ type: 'catalog_refresh', motivo: 'ocultos' });
      res.json({ success: true, data: { ocultados: r.ocultados, yaEstaban: lista.length - r.ocultados, deshacer: r.deshacer } });
    } catch (err) {
      fallo(res, 'ocultar los archivos de una persona', err);
    }
  });

  // ── Mover a la papelera ──────────────────────────────────────────────────
  router.post('/personas/:id/papelera', async (req, res) => {
    try {
      const personId = req.params.id;
      const nombre = nombreDe(personId);
      const { alcance, confirmacion } = req.body || {};
      // Tambien aqui y no solo en la interfaz: esta es la unica llamada que saca
      // archivos de su sitio, y no puede salir de un clic suelto.
      if (normal(confirmacion) !== normal(nombre)) {
        return res.status(400).json({ success: false, error: `Para moverlos hay que escribir «${nombre}»` });
      }
      const lista = archivosDe(personId, alcanceDe(alcance))
        .filter(f => f.fullPath && fs.existsSync(f.fullPath));
      if (lista.length === 0) return res.json({ success: true, data: { movidos: 0, bytes: 0, fallidos: [], lote: null } });

      const bibliotecas = typeof getScanPaths === 'function' ? await getScanPaths() : [];
      const r = await papelera.mover(lista, { motivo: `Persona: ${nombre}`, bibliotecas });
      // Que la aplicacion deje de enseñarlos ya, sin esperar a otra pasada.
      if (r.movidos > 0 && typeof syncFiles === 'function') syncFiles().catch(() => {});
      res.json({ success: true, data: r });
    } catch (err) {
      fallo(res, 'mover a la papelera los archivos de una persona', err);
    }
  });

  // ── Papelera ─────────────────────────────────────────────────────────────
  router.get('/papelera', async (req, res) => {
    try {
      res.json({ success: true, data: await papelera.listar() });
    } catch (err) {
      fallo(res, 'leer la papelera', err);
    }
  });

  router.post('/papelera/:lote/restaurar', async (req, res) => {
    try {
      const r = await papelera.restaurar(req.params.lote);
      if (!r) return res.status(404).json({ success: false, error: 'Ese lote ya no está en la papelera' });
      if (r.restaurados > 0 && typeof syncFiles === 'function') syncFiles().catch(() => {});
      res.json({ success: true, data: r });
    } catch (err) {
      fallo(res, 'restaurar desde la papelera', err);
    }
  });

  router.post('/papelera/:lote/vaciar', async (req, res) => {
    try {
      if (normal(req.body && req.body.confirmacion) !== 'vaciar') {
        return res.status(400).json({ success: false, error: 'Para vaciar hay que escribir «vaciar»' });
      }
      const r = await papelera.vaciar(req.params.lote);
      if (!r) return res.status(404).json({ success: false, error: 'Ese lote ya no está en la papelera' });
      res.json({ success: true, data: r });
    } catch (err) {
      fallo(res, 'vaciar la papelera', err);
    }
  });

  return router;
};
