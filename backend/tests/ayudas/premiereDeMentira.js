// Un Premiere de juguete con la API minima que usa la extension de Pensadero
// (premiere/extension/host.jsx): bandejas, importar, metadatos, marcadores,
// etiqueta y secuencia. Ejecuta el host.jsx real dentro de un contexto de vm.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HOST = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'premiere', 'extension', 'host.jsx'), 'utf8');

const BIN = 2;
const CLIP = 1;

/** Un Premiere de juguete. `opciones`: archivos que existen, que no sabe leer, que no tiene... */
function premiereDeMentira({ tamanos = null, existen, noLee = new Set(), medidas = {}, sinSecuencia = false, sinMarcadores = false } = {}) {
  let siguiente = 0;
  const lista = () => {
    const a = [];
    Object.defineProperty(a, 'numItems', { get() { return a.length; } });
    return a;
  };
  function Item(nombre, tipo, ruta) {
    this.name = nombre;
    this.type = tipo;
    this.nodeId = String(++siguiente);
    this._ruta = ruta;
    this._meta = '<x:xmpmeta/>';
    this._campos = null;
    this._marcadores = [];
    this._etiqueta = null;
    if (tipo === BIN) this.children = lista();
  }
  Item.prototype.createBin = function (n) { const b = new Item(n, BIN); this.children.push(b); return b; };
  Item.prototype.getMediaPath = function () { return this._ruta; };
  Item.prototype.getProjectMetadata = function () { return this._meta; };
  Item.prototype.setProjectMetadata = function (xmp, campos) { this._meta = xmp; this._campos = campos; };
  Item.prototype.getMarkers = function () {
    if (sinMarcadores) throw new Error('no implementado');
    const yo = this;
    return { createMarker(t) { const m = { start: t }; yo._marcadores.push(m); return m; } };
  };
  Item.prototype.setColorLabel = function (n) { this._etiqueta = n; };

  const raiz = new Item('raiz', BIN);
  const secuencias = [];
  const project = {
    name: 'Boda.prproj',
    path: 'C:\\Proyectos\\Boda.prproj',
    rootItem: raiz,
    importFiles(rutas, sinAvisos, bandeja) {
      for (const r of rutas) {
        if (noLee.has(r)) continue;
        bandeja.children.push(new Item(path.win32.basename(r), CLIP, r));
      }
      return true;
    },
  };
  if (!sinSecuencia) {
    project.createNewSequenceFromClips = function (nombre, items, bandeja) {
      const m = medidas[items[0]._ruta] || { ancho: 1920, alto: 1080 };
      const ajustes = { videoFrameWidth: m.ancho, videoFrameHeight: m.alto, videoFrameRate: { seconds: 1 / 25 } };
      const seq = {
        name: nombre, items,
        getSettings() { return { ...ajustes, videoFrameRate: { ...ajustes.videoFrameRate } }; },
        setSettings(s) { Object.assign(ajustes, s); },
      };
      bandeja.children.push(new Item(nombre, 3));
      secuencias.push(seq);
      return seq;
    };
  }
  function XMPMeta(s) { this.props = {}; this.base = s; }
  XMPMeta.prototype.setProperty = function (uri, k, v) { this.props[k] = v; };
  XMPMeta.prototype.serialize = function () { return JSON.stringify(this.props); };

  const ctx = vm.createContext({
    app: { version: '26.2.0', project },
    File: function (r) {
      this.exists = typeof existen === 'function' ? existen(r) : existen.has(r);
      // Tamaño en disco: el de la prueba, o 1000 para todo lo que existe.
      this.length = !this.exists ? -1 : (tamanos ? (typeof tamanos === 'function' ? tamanos(r) : (tamanos[r] ?? 1000)) : 1000);
    },
    XMPMeta,
    ExternalObject: {},
    ProjectItemType: { BIN, CLIP },
  });
  vm.runInContext(HOST, ctx);
  return { ctx, raiz, secuencias };
}

module.exports = { premiereDeMentira, HOST };
