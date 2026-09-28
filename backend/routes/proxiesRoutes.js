/**
 * Proxies Routes — Pensadero
 *
 * El estado, los ajustes y la preparación en lote de los vídeos preparados
 * (ver videoProxyService).
 *
 *  - GET   /api/proxies/estado             -> cuánto ocupan por disco, contra qué
 *                                             tope, qué queda libre, qué ganaría
 *                                             fluidez y el lote en marcha
 *  - PATCH /api/proxies/ajustes            -> body { topeGB?, alLlegar?, porDisco? }
 *  - POST  /api/proxies/liberar            -> body { raiz } libera los menos vistos
 *  - POST  /api/proxies/estimar            -> cuánto tardaría y ocuparía preparar
 *                                             todos (mide este equipo con unas
 *                                             muestras; no prepara nada)
 *  - POST  /api/proxies/preparar           -> body { raiz } prepara los que ganarían
 *                                             (sin raiz: todos los discos conectados)
 *  - POST  /api/proxies/preparar/cancelar  -> para el lote en marcha
 *
 * El resumen de fluidez se calcula aquí y no en el servicio porque hace falta
 * el catálogo entero, y el servicio solo conoce los vídeos que ya han pasado
 * por él. Se calcula con lo que ya sabemos de cada archivo (duración,
 * resolución, tamaño): ni un ffprobe, que con un archivo grande serían horas.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const videoProxyService = require('../services/videoProxyService');
const fallos = require('../utils/failureReason');
const { estimarLote } = require('../utils/estimarProxies');
const descartesManager = require('../descartesManager');

// Códecs que el navegador no abre, por mucho que el archivo sea pequeño.
const CODECS_DUROS = /hevc|h265|prores|mjpeg|qtrle|dnxhd|cineform|wmv|vp6/i;
// Un proxy a 5 Mbps de vídeo + 160k de audio ocupa ~0,65 MB por segundo.
const BYTES_POR_SEGUNDO = 0.65e6;

const altoDe = (f) => {
  const m = String(f.resolution || '').match(/x\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  return (f.dimensions && f.dimensions.height) || 0;
};
const mbpsDe = (f) => (f.duration > 0 && f.size > 0 ? (f.size * 8) / f.duration / 1e6 : 0);

module.exports = function createProxiesRoutes(deps = {}) {
  const router = express.Router();
  const { getMediaFiles } = deps;
  // Lo que se ve en la galeria: server.js pasa lo visible (sin candado ni
  // copias exactas sobrantes) y aqui se quitan las tomas gemelas apartadas.
  // Antes era el catalogo entero y un video con su copia de seguridad
  // conectada se preparaba dos veces.
  const todos = () => (typeof getMediaFiles === 'function' ? getMediaFiles() : [])
    .filter(f => f && !descartesManager.isDescartado(f.id));
  const cargar = () => descartesManager.ensureLoaded().catch(() => {});

  /** ¿Este vídeo se vería mejor con una versión ligera y aún no la tiene? */
  const ganaria = (f) => {
    if (!f || f.type !== 'video' || !f.fullPath) return false;
    if (videoProxyService.yaListo(f.id)) return false;
    return altoDe(f) > videoProxyService.ALTO_COMODO
      || mbpsDe(f) > videoProxyService.MBPS_COMODO
      || CODECS_DUROS.test(String(f.codec || ''));
  };

  const raizDe = (f) => path.parse(f.fullPath).root.toUpperCase();

  /**
   * Los que ganarian fluidez, de un disco o de todos los CONECTADOS (lo de un
   * disco desenchufado no se puede preparar: el lote solo sumaria fallos). En
   * el orden del catalogo, que es el del lote: la estimacion cuenta con el.
   */
  const pendientes = (raiz) => {
    const conectado = new Map();
    return todos().filter(f => {
      if (!ganaria(f)) return false;
      const r = raizDe(f);
      if (raiz) return r === raiz;
      if (!conectado.has(r)) conectado.set(r, fs.existsSync(r));
      return conectado.get(r);
    });
  };

  /** Candidatos ya en la forma que espera el servicio. */
  const candidatos = (raiz) => pendientes(raiz).map(f => ({ id: f.id, fullPath: f.fullPath, name: f.name }));

  /**
   * Cuántos vídeos ganarían fluidez, por disco. Solo discos conectados: lo que
   * vive en uno desenchufado no se puede preparar ni sirve de nada contarlo.
   */
  const fluidez = () => {
    const porRaiz = new Map();
    const conectado = new Map();
    for (const f of todos()) {
      if (!f || f.type !== 'video' || !f.fullPath) continue;
      const raiz = path.parse(f.fullPath).root.toUpperCase();
      if (!conectado.has(raiz)) conectado.set(raiz, fs.existsSync(raiz));
      if (!conectado.get(raiz)) continue;
      const d = porRaiz.get(raiz) || { raiz, n: 0, bytes: 0, total: 0, sinMedir: 0 };
      d.total++;
      if (ganaria(f)) {
        d.n++;
        if (f.duration > 0) d.bytes += f.duration * BYTES_POR_SEGUNDO;
        else d.sinMedir++;
      }
      porRaiz.set(raiz, d);
    }
    return [...porRaiz.values()].filter(d => d.n > 0).sort((a, b) => b.n - a.n);
  };

  const fallo = (res, operacion, err) => {
    const causa = fallos.record(operacion, err, {});
    res.status(500).json({ success: false, error: causa.reason });
  };

  const conFluidez = async () => ({ ...(await videoProxyService.estado()), fluidez: fluidez() });

  router.get('/proxies/estado', async (req, res) => {
    try {
      await cargar();
      res.json({ success: true, data: await conFluidez() });
    } catch (err) {
      fallo(res, 'leer el estado de los vídeos preparados', err);
    }
  });

  router.patch('/proxies/ajustes', async (req, res) => {
    try {
      const { topeGB, alLlegar, porDisco } = req.body || {};
      const ajustes = await videoProxyService.setAjustes({ topeGB, alLlegar, porDisco });
      res.json({ success: true, data: { ajustes, estado: await conFluidez() } });
    } catch (err) {
      fallo(res, 'guardar los ajustes de los vídeos preparados', err);
    }
  });

  router.post('/proxies/liberar', async (req, res) => {
    try {
      const raiz = (req.body && req.body.raiz) || '';
      if (!raiz) return res.status(400).json({ success: false, error: 'falta el disco' });
      const liberados = await videoProxyService.liberar(raiz);
      res.json({ success: true, data: { liberados, estado: await conFluidez() } });
    } catch (err) {
      fallo(res, 'liberar vídeos preparados', err);
    }
  });

  /**
   * Antes de preparar todo: cuanto tardaria en ESTE equipo y cuanto ocuparia.
   * Se mide de verdad con tres muestras (poco, medio y mucho bitrate): segun
   * haya grafica o no, lo mismo son veinte minutos que una noche entera.
   */
  router.post('/proxies/estimar', async (req, res) => {
    try {
      const enMarcha = videoProxyService.estadoLote();
      if (enMarcha && !enMarcha.terminado) {
        return res.status(409).json({ success: false, error: 'ya hay una preparación en marcha' });
      }
      await cargar();
      const lista = pendientes(null);
      if (lista.length === 0) {
        return res.json({ success: true, data: estimarLote([], null, {}, { bytesPorSegundo: BYTES_POR_SEGUNDO }) });
      }
      const porBitrate = [...lista].sort((a, b) => mbpsDe(a) - mbpsDe(b));
      const muestras = [...new Set([0.2, 0.5, 0.8]
        .map(q => porBitrate[Math.min(porBitrate.length - 1, Math.floor(q * porBitrate.length))]))];
      const velocidad = await videoProxyService.medirVelocidad(muestras);
      const presupuestos = {};
      for (const raiz of new Set(lista.map(raizDe))) presupuestos[raiz] = await videoProxyService.presupuestoDe(raiz);
      const estimacion = estimarLote(
        lista.map(f => ({ raiz: raizDe(f), duration: f.duration })),
        velocidad, presupuestos, { bytesPorSegundo: BYTES_POR_SEGUNDO },
      );
      res.json({
        success: true,
        data: { ...estimacion, encoder: velocidad ? velocidad.encoder : null, muestras: velocidad ? velocidad.muestras : 0 },
      });
    } catch (err) {
      fallo(res, 'calcular cuánto tardaría preparar los vídeos', err);
    }
  });

  router.post('/proxies/preparar', async (req, res) => {
    try {
      const raiz = ((req.body && req.body.raiz) || '').toUpperCase() || null;
      await cargar();
      const lista = candidatos(raiz);
      if (lista.length === 0) {
        return res.json({ success: true, data: { total: 0, estado: await conFluidez() } });
      }
      await videoProxyService.prepararLote(lista, { raiz });
      res.json({ success: true, data: { total: lista.length, estado: await conFluidez() } });
    } catch (err) {
      // "ya hay una preparación en marcha" es una respuesta, no un fallo del sistema.
      if (/en marcha/.test(err.message)) {
        return res.status(409).json({ success: false, error: err.message });
      }
      fallo(res, 'preparar vídeos en lote', err);
    }
  });

  router.post('/proxies/preparar/cancelar', async (req, res) => {
    try {
      videoProxyService.cancelarLote();
      res.json({ success: true, data: { estado: await conFluidez() } });
    } catch (err) {
      fallo(res, 'parar la preparación de vídeos', err);
    }
  });

  return router;
};
