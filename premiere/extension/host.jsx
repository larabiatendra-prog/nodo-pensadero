// Lo que la extension de Pensadero le pide a Premiere (ExtendScript).
//
// ExtendScript es JavaScript antiguo (ES3): sin JSON, sin forEach, sin
// indexOf de listas, sin trim. Todo lo de aqui se escribe asi a proposito.
//
// Un envio va por pasos, cada uno una llamada corta (Premiere no se queda
// congelado y la extension puede contar el progreso):
//   pensaderoEmpezar  -> crea la bandeja principal
//   pensaderoMirarProyecto -> apunta lo que ya hay (para no duplicarlo)
//   pensaderoImportar -> importa un trozo de archivos en su bandeja
//   pensaderoDetalles -> textos, marcadores y etiqueta de color
//   pensaderoSecuencia-> la secuencia, con el formato de la mayoria
//   pensaderoTerminar -> el resumen: que entro, que no y por que
// Cada cosa que una version de Premiere no sepa hacer se apunta en
// `sinPoder` (dicho para personas) y el resto sigue.

// --- Texto y JSON a mano ---------------------------------------------------

function pensaderoTexto(s) {
  s = String(s);
  var r = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i), n = s.charCodeAt(i);
    if (c === '"') r += '\\"';
    else if (c === '\\') r += '\\\\';
    else if (n < 32 || n > 126) {
      var h = n.toString(16);
      while (h.length < 4) h = '0' + h;
      r += '\\u' + h;
    } else r += c;
  }
  return r + '"';
}

function pensaderoJSON(v) {
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return pensaderoTexto(v);
  var partes = [];
  if (v instanceof Array) {
    for (var i = 0; i < v.length; i++) partes.push(pensaderoJSON(v[i]));
    return '[' + partes.join(',') + ']';
  }
  for (var k in v) {
    if (v.hasOwnProperty(k)) partes.push(pensaderoTexto(k) + ':' + pensaderoJSON(v[k]));
  }
  return '{' + partes.join(',') + '}';
}

function pensaderoRuta(r) {
  return String(r || '').replace(/\//g, '\\').toLowerCase();
}

// El nombre del archivo de una ruta, en minusculas.
function pensaderoNombreArchivo(r) {
  var partes = String(r || '').replace(/\//g, '\\').split('\\');
  return partes[partes.length - 1].toLowerCase();
}

// Tamaño en disco, o -1 si no se puede saber (desconectado, sin permiso).
function pensaderoTamano(r) {
  try { var f = new File(r); return f.exists ? f.length : -1; } catch (e) { return -1; }
}

// --- Estado del envio en curso (sobrevive entre llamadas) ------------------

if (typeof pensaderoEnvio === 'undefined') { var pensaderoEnvio = null; }

function pensaderoSinPoder(texto) {
  var e = pensaderoEnvio;
  if (!e) return;
  for (var i = 0; i < e.sinPoder.length; i++) if (e.sinPoder[i] === texto) return;
  e.sinPoder.push(texto);
}

function pensaderoHayProyecto() {
  try { return !!(app.project && app.project.path); } catch (e) { return false; }
}

// Busca un hijo de una bandeja por nombre (y que sea bandeja si se pide).
function pensaderoHijo(padre, nombre, soloBandejas) {
  var hijos = padre.children;
  for (var i = 0; i < hijos.numItems; i++) {
    var c = hijos[i];
    if (c && c.name === nombre && (!soloBandejas || c.type === ProjectItemType.BIN)) return c;
  }
  return null;
}

function pensaderoCrearBandeja(padre, nombre) {
  var b = null;
  try { b = padre.createBin(nombre); } catch (e) { b = null; }
  // Versiones que no devuelven la bandeja creada: se busca.
  if (!b || typeof b !== 'object' || !b.children) b = pensaderoHijo(padre, nombre, true);
  return b;
}

// --- Llamadas que hace la extension ------------------------------------

// El proyecto abierto. Sin proyecto (pantalla de inicio), nombre vacio.
function pensaderoProyecto() {
  var nombre = '', ruta = '', version = '';
  try { version = String(app.version); } catch (e) {}
  try {
    if (app.project && app.project.path) {
      nombre = String(app.project.name);
      ruta = String(app.project.path);
    }
  } catch (e2) {}
  return pensaderoJSON({ nombre: nombre, ruta: ruta, version: version, puente: 3 });
}

function pensaderoEmpezar(cab) {
  if (!pensaderoHayProyecto()) return pensaderoJSON({ ok: false, error: 'No hay ningún proyecto abierto en Premiere.' });
  var raiz = app.project.rootItem;
  // Nombre libre en la raiz: «Boda», «Boda (2)»...
  var base = String(cab.nombre || 'Pensadero'), nombre = base, n = 2;
  while (pensaderoHijo(raiz, nombre, false)) { nombre = base + ' (' + n + ')'; n++; }
  var principal = pensaderoCrearBandeja(raiz, nombre);
  if (!principal) return pensaderoJSON({ ok: false, error: 'Premiere no ha dejado crear la bandeja «' + nombre + '».' });
  pensaderoEnvio = {
    principal: principal, bandeja: nombre, bandejas: {}, items: {},
    importados: 0, total: 0, faltan: [], noImportados: [], sinPoder: [], secuencia: null,
    // No duplicar: lo que el proyecto ya tiene se usa tal cual (y no se toca).
    duplicar: !!cab.duplicar, yaHay: null, reutilizados: [], reusados: {}, contados: {},
  };
  return pensaderoJSON({ ok: true, bandeja: nombre });
}

// Apunta lo que ya hay en el proyecto (en cualquier bandeja), por ruta y por
// nombre de archivo, ANTES de importar nada de este envio.
function pensaderoMirarProyecto() {
  var e = pensaderoEnvio;
  if (!e) return pensaderoJSON({ ok: false, error: 'El envío se ha perdido.' });
  var porRuta = {}, porNombre = {}, n = 0;
  function recorrer(bandeja, nombreBandeja) {
    var hijos = bandeja.children;
    for (var i = 0; i < hijos.numItems; i++) {
      var c = hijos[i];
      if (!c) continue;
      if (c.type === ProjectItemType.BIN) {
        if (c.nodeId !== e.principal.nodeId) recorrer(c, c.name);
        continue;
      }
      var ruta = '';
      try { ruta = c.getMediaPath(); } catch (err) { ruta = ''; }
      if (!ruta) continue; // secuencias y elementos sin archivo
      var registro = { item: c, bandeja: nombreBandeja, ruta: ruta };
      var clave = pensaderoRuta(ruta);
      if (!porRuta[clave]) porRuta[clave] = registro;
      var nombre = pensaderoNombreArchivo(ruta);
      if (!porNombre[nombre]) porNombre[nombre] = [];
      porNombre[nombre].push(registro);
      n++;
    }
  }
  recorrer(app.project.rootItem, '');
  e.yaHay = { porRuta: porRuta, porNombre: porNombre };
  return pensaderoJSON({ ok: true, clips: n });
}

// ¿Esta ya este archivo? Por su ruta; o, si se movio de disco o de letra, por
// nombre Y tamaño a la vez (las camaras repiten nombres: P1000001...).
function pensaderoYaEsta(ruta) {
  var e = pensaderoEnvio;
  if (!e || e.duplicar || !e.yaHay) return null;
  var porRuta = e.yaHay.porRuta[pensaderoRuta(ruta)];
  if (porRuta) return porRuta;
  var candidatos = e.yaHay.porNombre[pensaderoNombreArchivo(ruta)];
  if (!candidatos) return null;
  var tamano = pensaderoTamano(ruta);
  if (tamano <= 0) return null;
  for (var i = 0; i < candidatos.length; i++) {
    if (pensaderoTamano(candidatos[i].ruta) === tamano) return candidatos[i];
  }
  return null;
}

// paso = { bandeja: 'nombre' | '', clips: [{ i, ruta, nombre }] }
function pensaderoImportar(paso) {
  var e = pensaderoEnvio;
  if (!e) return pensaderoJSON({ ok: false, error: 'El envío se ha perdido (¿se cerró el proyecto?).' });
  var destino = e.principal;
  if (paso.bandeja) {
    destino = e.bandejas[paso.bandeja];
    if (!destino) {
      destino = pensaderoCrearBandeja(e.principal, paso.bandeja) || e.principal;
      e.bandejas[paso.bandeja] = destino;
    }
  }
  // Lo que no esta en disco no se le pide a Premiere (se queda en «faltan»).
  var rutas = [], pedidos = [];
  for (var k = 0; k < paso.clips.length; k++) {
    var c = paso.clips[k];
    e.total++;
    var ya = pensaderoYaEsta(c.ruta);
    if (ya) {
      if (!e.items[c.i]) e.items[c.i] = [];
      e.items[c.i].push(ya.item);
      e.reusados[ya.item.nodeId] = true;
      if (!e.contados[c.i]) {
        e.contados[c.i] = true;
        e.reutilizados.push({ nombre: c.nombre, bandeja: ya.bandeja });
      }
      continue;
    }
    var existe = false;
    try { existe = new File(c.ruta).exists; } catch (err) { existe = false; }
    if (existe) { rutas.push(c.ruta); pedidos.push(c); }
    else e.faltan.push(c.nombre);
  }
  if (rutas.length === 0) return pensaderoJSON({ ok: true, importados: 0 });

  var antes = {};
  var hijos = destino.children;
  for (var a = 0; a < hijos.numItems; a++) antes[hijos[a].nodeId] = true;

  try {
    app.project.importFiles(rutas, true, destino, false);
  } catch (err2) {
    for (var x = 0; x < pedidos.length; x++) e.noImportados.push(pedidos[x].nombre);
    return pensaderoJSON({ ok: false, error: 'Premiere dio un error al importar: ' + err2 });
  }

  // Lo nuevo de la bandeja, por su ruta (y por nombre si no se puede saber).
  var porRuta = {}, porNombre = {};
  hijos = destino.children;
  for (var b = 0; b < hijos.numItems; b++) {
    var it = hijos[b];
    if (!it || antes[it.nodeId]) continue;
    var ruta = '';
    try { ruta = it.getMediaPath(); } catch (err3) { ruta = ''; }
    if (ruta) porRuta[pensaderoRuta(ruta)] = it;
    porNombre[it.name] = it;
  }
  var entraron = 0;
  for (var p = 0; p < pedidos.length; p++) {
    var pc = pedidos[p];
    var item = porRuta[pensaderoRuta(pc.ruta)] || porNombre[pc.nombre] || null;
    if (item) {
      if (!e.items[pc.i]) e.items[pc.i] = [];
      e.items[pc.i].push(item);
      e.importados++;
      entraron++;
    } else {
      e.noImportados.push(pc.nombre);
    }
  }
  return pensaderoJSON({ ok: true, importados: entraron });
}

var PENSADERO_URI = 'http://ns.adobe.com/premierePrivateProjectMetaData/1.0/';

function pensaderoTextos(item, descripcion, notaRegistro) {
  if (typeof XMPMeta === 'undefined') {
    if (ExternalObject.AdobeXMPScript === undefined) {
      try { ExternalObject.AdobeXMPScript = new ExternalObject('lib:AdobeXMPScript'); } catch (e) {}
    }
  }
  var xmp = new XMPMeta(item.getProjectMetadata());
  var campos = [];
  if (descripcion) { xmp.setProperty(PENSADERO_URI, 'Column.PropertyText.Description', descripcion); campos.push('Column.PropertyText.Description'); }
  if (notaRegistro) { xmp.setProperty(PENSADERO_URI, 'Column.Intrinsic.LogNote', notaRegistro); campos.push('Column.Intrinsic.LogNote'); }
  if (campos.length) item.setProjectMetadata(xmp.serialize(), campos);
}

// lote = [{ i, descripcion, notaRegistro, marcador: { nombre, texto } | null, etiqueta: n | null }]
function pensaderoDetalles(lote) {
  var e = pensaderoEnvio;
  if (!e) return pensaderoJSON({ ok: false, error: 'El envío se ha perdido.' });
  for (var k = 0; k < lote.length; k++) {
    var d = lote[k];
    var items = e.items[d.i];
    if (!items) continue;
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      // Lo que ya estaba en el proyecto no se toca: sus notas son de quien edita.
      if (e.reusados[it.nodeId]) continue;
      if (d.descripcion || d.notaRegistro) {
        try { pensaderoTextos(it, d.descripcion, d.notaRegistro); }
        catch (e1) { pensaderoSinPoder('Esta versión de Premiere no ha dejado escribir la descripción ni las notas en los clips.'); }
      }
      if (d.marcador) {
        try {
          var m = it.getMarkers().createMarker(0);
          m.name = d.marcador.nombre;
          m.comments = d.marcador.texto;
        } catch (e2) { pensaderoSinPoder('Esta versión de Premiere no ha dejado poner marcadores en los clips.'); }
      }
      if (d.etiqueta !== null && d.etiqueta !== undefined) {
        try { it.setColorLabel(d.etiqueta); }
        catch (e3) { pensaderoSinPoder('Esta versión de Premiere no ha dejado poner el color de los favoritos.'); }
      }
    }
  }
  return pensaderoJSON({ ok: true });
}

// s = { nombre, orden: [i], formato: { ancho, alto, fps } | null }
function pensaderoSecuencia(s) {
  var e = pensaderoEnvio;
  if (!e) return pensaderoJSON({ ok: false, error: 'El envío se ha perdido.' });
  var items = [];
  for (var k = 0; k < s.orden.length; k++) {
    var it = e.items[s.orden[k]];
    if (it && it.length) items.push(it[0]);
  }
  if (items.length === 0) return pensaderoJSON({ ok: true });
  if (typeof app.project.createNewSequenceFromClips !== 'function') {
    pensaderoSinPoder('Esta versión de Premiere no deja crear la secuencia desde fuera: los clips están en la bandeja, en orden de fecha.');
    return pensaderoJSON({ ok: true });
  }
  var seq = null;
  try { seq = app.project.createNewSequenceFromClips(s.nombre, items, e.principal); }
  catch (err) { seq = null; }
  if (!seq) {
    pensaderoSinPoder('Premiere no ha podido crear la secuencia; los clips sí están en la bandeja.');
    return pensaderoJSON({ ok: true });
  }
  // Premiere toma el formato del primer clip. Si ese no es el de la mayoria
  // (un vertical delante de veinte horizontales), se pone el de la mayoria:
  // cambiar el tamaño del cuadro no estira ningun clip.
  var ancho = 0, alto = 0, fps = 0;
  try {
    var ajustes = seq.getSettings();
    if (s.formato && s.formato.ancho && s.formato.alto
      && (ajustes.videoFrameWidth !== s.formato.ancho || ajustes.videoFrameHeight !== s.formato.alto)) {
      ajustes.videoFrameWidth = s.formato.ancho;
      ajustes.videoFrameHeight = s.formato.alto;
      seq.setSettings(ajustes);
      ajustes = seq.getSettings();
    }
    ancho = ajustes.videoFrameWidth;
    alto = ajustes.videoFrameHeight;
    var seg = ajustes.videoFrameRate && ajustes.videoFrameRate.seconds;
    if (seg > 0) fps = 1 / seg;
  } catch (err2) {
    try { ancho = seq.frameSizeHorizontal; alto = seq.frameSizeVertical; } catch (err3) {}
  }
  e.secuencia = { nombre: String(seq.name || s.nombre), ancho: ancho || 0, alto: alto || 0, fps: fps || 0 };
  return pensaderoJSON({ ok: true });
}

function pensaderoTerminar() {
  var e = pensaderoEnvio;
  pensaderoEnvio = null;
  if (!e) return pensaderoJSON({ ok: false, error: 'El envío se ha perdido.' });
  return pensaderoJSON({
    ok: true,
    importados: e.importados, total: e.total, bandeja: e.bandeja, reutilizados: e.reutilizados,
    faltan: e.faltan, noImportados: e.noImportados, sinPoder: e.sinPoder, secuencia: e.secuencia,
  });
}
