/*
 * Pensadero en Premiere: da un latido a Pensadero (localhost:5000) cada dos
 * segundos con el proyecto abierto y, si Pensadero tiene algo que enviar, lo
 * hace dentro de Premiere por pasos (ver host.jsx), contando por donde va.
 *
 * Habla con Pensadero por el modulo http de Node y no con fetch: una peticion
 * del navegador de la extension llevaria un Origin que Pensadero rechaza.
 *
 * Se pone al dia sola: al arrancar vuelve a cargar host.jsx (Premiere solo lo
 * carga al abrirse) y, si Pensadero dice que la extension ha cambiado, se
 * recarga entre envios. Asi una version nueva no pide reiniciar Premiere.
 *
 * Escrito para el Node y el navegador mas antiguos que trae Premiere 2019
 * (CEP 9, Node 8): nada de ?. ni ?? ni spread de objetos.
 */
(function () {
  var nodeRequire = typeof require === 'function' ? require : (window.cep_node && window.cep_node.require);
  var estadoEl = document.getElementById('estado');
  var ultimoEl = document.getElementById('ultimo');
  function pintar(el, texto) { if (el) el.textContent = texto; }

  if (!nodeRequire || !window.__adobe_cep__) {
    pintar(estadoEl, 'A esta extensión le falta Node: reinstálala desde Pensadero.');
    return;
  }
  var http = nodeRequire('http');
  var Buffer = nodeRequire('buffer').Buffer;

  var HOST = '127.0.0.1';
  // El puerto de Pensadero; las pruebas lo cambian (window.pensaderoPuerto).
  var PUERTO = window.pensaderoPuerto || 5000;
  var CADA_MS = 2000;
  var TROZO_IMPORTAR = 20;
  var TROZO_DETALLES = 40;

  function pedir(metodo, ruta, cuerpo) {
    return new Promise(function (ok, mal) {
      var datos = cuerpo ? Buffer.from(JSON.stringify(cuerpo), 'utf8') : null;
      var req = http.request({
        host: HOST, port: PUERTO, path: ruta, method: metodo, timeout: 20000,
        headers: datos ? { 'Content-Type': 'application/json', 'Content-Length': datos.length } : {},
      }, function (res) {
        var trozos = [];
        res.on('data', function (c) { trozos.push(c); });
        res.on('end', function () {
          var texto = Buffer.concat(trozos).toString('utf8');
          if (res.statusCode >= 400) return mal(new Error('Pensadero respondió ' + res.statusCode));
          ok(texto);
        });
      });
      req.on('error', mal);
      req.on('timeout', function () { req.destroy(new Error('Pensadero no responde')); });
      if (datos) req.write(datos);
      req.end();
    });
  }

  // Un valor de JavaScript escrito para ExtendScript: JSON es un literal valido,
  // pero lo no ASCII va escapado (tildes y eñes en rutas llegan intactas).
  function literal(v) {
    return JSON.stringify(v).replace(/[\u007f-￿]/g, function (c) {
      return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  function premiere(script) {
    return new Promise(function (ok) {
      window.__adobe_cep__.evalScript(script, function (r) { ok(r); });
    });
  }

  // Durante un envio: a quien contarle que Premiere tarda. Premiere saca un
  // aviso que lo deja parado (p. ej. «compresión no admitida») aunque se le
  // pida silencio; la extension no puede cerrarlo, pero si decirlo.
  var siTarda = null;
  var TARDA_MS = 10000;

  // Una llamada a host.jsx que contesta JSON; si ExtendScript falla, lo dice.
  async function paso(nombre, arg) {
    var reloj = null;
    if (siTarda) {
      var avisar = siTarda;
      reloj = setInterval(function () {
        avisar('Premiere tarda: si te enseña un aviso, pulsa Aceptar para seguir.');
      }, TARDA_MS);
    }
    var r;
    try {
      r = await premiere(nombre + '(' + (arg === undefined ? '' : literal(arg)) + ')');
    } finally {
      if (reloj) clearInterval(reloj);
    }
    var d;
    try { d = JSON.parse(r); } catch (e) { throw new Error('Premiere dio un error en «' + nombre + '»: ' + r); }
    if (d && d.ok === false) throw new Error(d.error || ('Premiere no pudo hacer «' + nombre + '».'));
    return d;
  }

  function trozos(lista, n) {
    var r = [];
    for (var i = 0; i < lista.length; i += n) r.push(lista.slice(i, i + n));
    return r;
  }

  async function enviar(envio) {
    var contar = function (texto) {
      pintar(ultimoEl, texto);
      return pedir('POST', '/api/premiere/envios/' + envio.id + '/progreso', { texto: texto }).catch(function () {});
    };
    var resumen = null;
    var error = null;
    siTarda = contar;
    try {
      var plan = JSON.parse(await pedir('GET', envio.plan)).plan;
      await contar('Preparando la bandeja…');
      await paso('pensaderoEmpezar', { nombre: plan.nombre, duplicar: !!plan.duplicar });
      if (!plan.duplicar) {
        await contar('Mirando lo que ya hay en el proyecto…');
        await paso('pensaderoMirarProyecto');
      }

      var total = 0;
      plan.bandejas.forEach(function (b) { total += b.clips.length; });
      var hechos = 0;
      for (var b = 0; b < plan.bandejas.length; b++) {
        var bandeja = plan.bandejas[b];
        var partes = trozos(bandeja.clips, TROZO_IMPORTAR);
        for (var t = 0; t < partes.length; t++) {
          await contar('Importando ' + hechos + ' de ' + total + '…');
          await paso('pensaderoImportar', {
            bandeja: bandeja.nombre,
            clips: partes[t].map(function (i) { return { i: i, ruta: plan.clips[i].ruta, nombre: plan.clips[i].nombre }; }),
          });
          hechos += partes[t].length;
        }
      }

      var detalles = [];
      plan.clips.forEach(function (c, i) {
        if (c.descripcion || c.notaRegistro || c.marcador || c.etiqueta !== null) {
          detalles.push({ i: i, descripcion: c.descripcion, notaRegistro: c.notaRegistro, marcador: c.marcador, etiqueta: c.etiqueta });
        }
      });
      var lotes = trozos(detalles, TROZO_DETALLES);
      for (var d = 0; d < lotes.length; d++) {
        await contar('Poniendo notas y marcadores…');
        await paso('pensaderoDetalles', lotes[d]);
      }

      if (plan.secuencia) {
        await contar('Haciendo la secuencia…');
        await paso('pensaderoSecuencia', { nombre: plan.nombre, orden: plan.orden, formato: plan.formato });
      }
    } catch (e) {
      error = String((e && e.message) || e);
    }
    // El resumen siempre: aunque algo fallara, lo que entro, entro.
    try { resumen = await paso('pensaderoTerminar'); } catch (e2) { resumen = null; }
    siTarda = null;
    var dentro = resumen ? resumen.importados + (resumen.reutilizados ? resumen.reutilizados.length : 0) : 0;
    var ok = !error && !!resumen && dentro > 0;
    if (!error && resumen && dentro === 0) error = 'No ha entrado ningún archivo en Premiere.';
    pintar(ultimoEl, ok ? 'Enviado: ' + dentro + ' de ' + resumen.total + ' en «' + resumen.bandeja + '»' : 'No se pudo: ' + error);
    try { await pedir('POST', '/api/premiere/envios/' + envio.id, { ok: ok, error: error, resumen: resumen }); } catch (e3) { /* Pensadero lo dara por perdido */ }
  }

  // host.jsx de nuevo: Premiere solo lo lee al abrirse, y la extension puede
  // haberse actualizado despues (la carpeta es un enlace a la de Pensadero).
  async function cargarHost() {
    try {
      var ruta = decodeURI(String(window.__adobe_cep__.getSystemPath('extension') || '')).replace(/^file:\/{2,3}/, '');
      if (ruta) await premiere('$.evalFile(' + literal(ruta + '/host.jsx') + ')');
    } catch (e) { /* se queda el que cargo Premiere */ }
  }

  var versionCargada = null;
  var ocupado = false;
  async function latir() {
    if (ocupado) return;
    ocupado = true;
    try {
      var info = {};
      var crudo = await premiere('pensaderoProyecto()');
      // Si host.jsx no se cargo, Premiere contesta «EvalScript error.»: se dice.
      try { info = JSON.parse(crudo); } catch (e) { info = { fallo: String(crudo || 'sin respuesta') }; }
      var r = JSON.parse(await pedir('POST', '/api/premiere/latido', {
        proyecto: info.nombre || '', rutaProyecto: info.ruta || '', version: info.version || '', puente: 3, fallo: info.fallo || '',
      }));
      pintar(estadoEl, info.nombre ? 'Conectado con Pensadero · ' + info.nombre : 'Conectado con Pensadero · abre un proyecto');
      var envios = r.envios || [];
      for (var i = 0; i < envios.length; i++) await enviar(envios[i]);
      // Pensadero trae otra version de la extension: recargarse (entre envios).
      if (r.extension) {
        if (!versionCargada) versionCargada = r.extension;
        else if (r.extension !== versionCargada) { window.location.reload(); return; }
      }
    } catch (e) {
      pintar(estadoEl, 'Esperando a Pensadero…');
    } finally {
      ocupado = false;
    }
  }

  cargarHost().then(function () {
    latir();
    setInterval(latir, CADA_MS);
  });
})();
