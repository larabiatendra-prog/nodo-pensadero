/**
 * Hallazgos del archivo — Pensadero NODO
 *
 * Lo que la carta semanal puede contar. Cada tipo mira el archivo desde un
 * angulo distinto y devuelve candidatos; cartaService elige uno por semana y el
 * modelo local solo lo redacta.
 *
 * ── Regla de diseño: el coste NO crece con el archivo ──────────────────────
 *
 * Esto tiene que seguir funcionando cuando las rutas apunten a decenas de
 * miles de archivos, asi que:
 *
 *   1. UN solo recorrido de los archivos construye el contexto compartido
 *      (fechas, eventos, dias, personas). Los tipos leen de ahi, no del array.
 *   2. Nada de O(N^2). El unico tipo que compara embeddings lo hace sobre una
 *      MUESTRA de tamaño fijo (MUESTRA_CLIP), asi que su coste es constante
 *      tenga el archivo 4.000 o 400.000 entradas.
 *   3. Topes en todo: candidatos por tipo, eventos por cubo, años cruzados.
 *      Un archivo raro puede hacer que un tipo no encuentre nada; no puede
 *      hacer que el servidor se quede pensando.
 *   4. Cada tipo va aislado en try/catch: si uno falla por datos inesperados,
 *      la carta sale igual con los demas.
 *   5. El bucle de eventos se cede entre tipos (yield). El backend sirve video
 *      mientras tanto y no puede congelarse por una carta.
 *
 * El calculo ocurre UNA vez por semana (cartaService cachea la carta), asi que
 * este presupuesto es de sobra.
 */

const clipIndex = require('../clipIndex');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const SEPARADOR = /[\\/]/;
const FECHADA_CORTA = /^\d{6}[_\s-]/;
const FECHADA_LARGA = /^(19|20)\d{6}[_\s-]/;

// ── Presupuesto ─────────────────────────────────────────────────────────────
/** Candidatos que aporta como mucho cada tipo. Mas no añade variedad real. */
const MAX_POR_TIPO = 6;
/** Archivos que se comparan entre si en el hallazgo visual. Fijo a proposito. */
const MUESTRA_CLIP = 200;
/** Material minimo para que un evento sostenga una carta. */
const MIN_ARCHIVOS_EVENTO = 3;

/** Cede el bucle de eventos: el backend sigue sirviendo mientras esto piensa. */
const respirar = () => new Promise(r => setImmediate(r));

/**
 * YYYYMMDD -> {anio, mes, dia}, o null si no es una fecha usable.
 *
 * El rango de mes y dia NO es cosmetico: el archivo real tiene carpetas como
 * "000000_Post Politica", que el parser de fechas lee como 20000000 y colaba
 * como año 2000 mes 0 dia 0. La carta llego a decir "el 0 de undefined de
 * 2000 grabaste 4070 archivos".
 */
function partes(num) {
  if (!num || num < 19000101) return null;
  const anio = Math.floor(num / 10000);
  const mes = Math.floor((num % 10000) / 100);
  const dia = num % 100;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return { anio, mes, dia };
}

function fechaLegible(num) {
  const p = partes(num);
  if (!p) return '';
  return `${p.dia} de ${MESES[p.mes - 1]} de ${p.anio}`;
}

function mesYAnio(num) {
  const p = partes(num);
  if (!p) return '';
  return `${MESES[p.mes - 1]} de ${p.anio}`;
}

/** Semilla estable: el hallazgo de esta semana no baila entre recargas. */
function semilla(txt) {
  let h = 0;
  for (let i = 0; i < txt.length; i++) { h = (h * 31 + txt.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

/** Fecha de un archivo: la del nombre o la de la carpeta antes que la del disco. */
function fechaDe(file) {
  // La fecha resuelta en el servidor (utils/fechaArchivo.js) manda; lo de
  // abajo queda para archivos que aun no la tienen.
  if (file.fechaDia && partes(file.fechaDia)) return file.fechaDia;
  const texto = `${file.displayName || ''} ${file.name || ''} ${file.folderName || ''} ${file.fullPath || ''}`;
  const m = texto.match(/(?:^|[\\/\s_-])((?:19|20)\d{6}|\d{6})(?=[_\s-])/);
  if (m) {
    const crudo = m[1];
    const num = crudo.length === 6
      ? (parseInt(crudo.slice(0, 2), 10) + 2000) * 10000 + parseInt(crudo.slice(2, 4), 10) * 100 + parseInt(crudo.slice(4, 6), 10)
      : parseInt(crudo, 10);
    if (partes(num)) return num;
  }
  const bruto = file.createdAt || file.modifiedAt;
  if (bruto) {
    const d = bruto instanceof Date ? bruto : new Date(bruto);
    if (!isNaN(d.getTime())) return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  return 0;
}

/**
 * Carpeta-evento: el ancestro con fecha en el nombre. Solo vale como recuerdo
 * si tiene nombre propio — la papelera de Windows deja carpetas tipo
 * "$RFGJHHE" que pasan el filtro de fecha y dejarian una carta diciendo
 * "en agosto grabaste $RFGJHHE".
 */
function esBasura(nombre) {
  return !nombre || nombre.startsWith('$') || /recycle|^temp$/i.test(nombre);
}

function eventoDe(file) {
  const segs = String(file.fullPath || '').split(SEPARADOR).filter(Boolean);
  for (let i = segs.length - 2; i >= 0; i--) {
    const seg = segs[i];
    if (esBasura(seg)) return '';
    if (FECHADA_CORTA.test(seg) || FECHADA_LARGA.test(seg)) return seg;
  }
  // Sin ancestro fechado no hay evento: el fallback a la carpeta suelta daba
  // "eventos" como "- Dani" o "3", que en una carta no dicen nada.
  return '';
}

/**
 * Contexto compartido. Un solo recorrido de los archivos; a partir de aqui
 * todos los tipos trabajan sobre indices ya construidos.
 */
function construirContexto(files) {
  const ctx = {
    conFecha: [],                 // [{ f, fecha, evento }]
    porDia: new Map(),            // YYYYMMDD -> [archivos]
    porAnio: new Map(),           // anio -> [archivos]
    porMesAnio: new Map(),        // mes -> Map(anio -> [archivos])
    porEvento: new Map(),         // evento -> { archivos, fechaMin }
    porPersona: new Map(),        // person_id -> { nombre, min, max, archivos }
    porMesDia: new Map(),         // "MMDD" -> [{ f, fecha }]
  };

  for (const f of files) {
    if (!f) continue;
    const fecha = fechaDe(f);
    if (!fecha) continue;
    const p = partes(fecha);
    if (!p) continue;
    const evento = eventoDe(f);
    ctx.conFecha.push({ f, fecha, evento });

    const dia = ctx.porDia.get(fecha);
    if (dia) dia.push(f); else ctx.porDia.set(fecha, [f]);

    const anioArr = ctx.porAnio.get(p.anio);
    if (anioArr) anioArr.push(f); else ctx.porAnio.set(p.anio, [f]);

    if (!ctx.porMesAnio.has(p.mes)) ctx.porMesAnio.set(p.mes, new Map());
    const porAnio = ctx.porMesAnio.get(p.mes);
    const arrMes = porAnio.get(p.anio);
    if (arrMes) arrMes.push(f); else porAnio.set(p.anio, [f]);

    const md = String(p.mes).padStart(2, '0') + String(p.dia).padStart(2, '0');
    const arrMd = ctx.porMesDia.get(md);
    if (arrMd) arrMd.push({ f, fecha }); else ctx.porMesDia.set(md, [{ f, fecha }]);

    if (evento) {
      const ev = ctx.porEvento.get(evento);
      if (ev) { ev.archivos.push(f); ev.fechaMin = Math.min(ev.fechaMin, fecha); }
      else ctx.porEvento.set(evento, { archivos: [f], fechaMin: fecha });
    }

    for (const cara of (f.faces || [])) {
      if (!cara || !cara.person_id) continue;
      const acc = ctx.porPersona.get(cara.person_id)
        || { nombre: cara.display_name || cara.person_id, min: fecha, max: fecha, archivos: [] };
      acc.min = Math.min(acc.min, fecha);
      acc.max = Math.max(acc.max, fecha);
      acc.archivos.push(f);
      ctx.porPersona.set(cara.person_id, acc);
    }
  }
  return ctx;
}

/** De un monton de archivos, el evento con mas material (o null). */
function mejorEvento(archivos) {
  const porEvento = new Map();
  for (const f of archivos) {
    const ev = eventoDe(f);
    if (!ev) continue;
    const arr = porEvento.get(ev);
    if (arr) arr.push(f); else porEvento.set(ev, [f]);
  }
  let mejor = null;
  for (const [ev, arr] of porEvento.entries()) {
    if (!mejor || arr.length > mejor.archivos.length) mejor = { evento: ev, archivos: arr };
  }
  return mejor && mejor.archivos.length >= MIN_ARCHIVOS_EVENTO ? mejor : null;
}

const ids = (archivos, n = 4) => archivos.slice(0, n).map(a => a.id);

// ── Los tipos ───────────────────────────────────────────────────────────────

/** 1. Esta misma semana, hace años. Es el hallazgo con mas "ahora" de todos. */
function tipoAniversarioSemana(ctx, hoy) {
  const out = [];
  const anioHoy = hoy.getFullYear();
  // Los 7 dias que vienen, como "MMDD".
  for (let d = 0; d < 7; d++) {
    const f = new Date(hoy.getTime() + d * 86400000);
    const md = String(f.getMonth() + 1).padStart(2, '0') + String(f.getDate()).padStart(2, '0');
    const items = ctx.porMesDia.get(md);
    if (!items) continue;
    const porAnio = new Map();
    for (const it of items) {
      const a = Math.floor(it.fecha / 10000);
      if (a >= anioHoy) continue;
      const arr = porAnio.get(a);
      if (arr) arr.push(it.f); else porAnio.set(a, [it.f]);
    }
    for (const [anio, archivos] of porAnio.entries()) {
      const ev = mejorEvento(archivos);
      if (!ev) continue;
      out.push({
        tipo: 'aniversario_semana',
        datos: {
          anios: anioHoy - anio,
          fecha: fechaLegible(anio * 10000 + parseInt(md.slice(0, 2), 10) * 100 + parseInt(md.slice(2), 10)),
          evento: ev.evento,
          cuantos: ev.archivos.length,
        },
        fileIds: ids(ev.archivos),
      });
    }
  }
  return out.slice(0, MAX_POR_TIPO);
}

/** 2. El mismo mes en dos años distintos. */
function tipoMismoMes(ctx) {
  const out = [];
  for (const [mes, porAnio] of ctx.porMesAnio.entries()) {
    const anios = [...porAnio.keys()].sort((a, b) => a - b);
    for (let i = 0; i < anios.length; i++) {
      for (let j = i + 1; j < anios.length; j++) {
        if (anios[j] - anios[i] < 1) continue;
        const evViejo = mejorEvento(porAnio.get(anios[i]));
        const evNuevo = mejorEvento(porAnio.get(anios[j]));
        if (!evViejo || !evNuevo || evViejo.evento === evNuevo.evento) continue;
        out.push({
          tipo: 'mismo_mes',
          datos: {
            mes: MESES[mes - 1],
            anioViejo: anios[i],
            anioNuevo: anios[j],
            distancia: anios[j] - anios[i],
            eventoViejo: evViejo.evento,
            eventoNuevo: evNuevo.evento,
            cuantosViejo: evViejo.archivos.length,
            cuantosNuevo: evNuevo.archivos.length,
          },
          fileIds: [...ids(evViejo.archivos, 2), ...ids(evNuevo.archivos, 2)],
        });
      }
    }
  }
  // Primero las parejas mas separadas en el tiempo: dicen mas.
  out.sort((a, b) => b.datos.distancia - a.datos.distancia);
  return out.slice(0, MAX_POR_TIPO);
}

/** 3. La persona que mas atraviesa el archivo. */
function tipoPersonaLarga(ctx) {
  const out = [];
  const conRecorrido = [...ctx.porPersona.values()]
    .map(v => ({ ...v, anios: Math.floor((v.max - v.min) / 10000) }))
    .filter(v => v.anios >= 1)
    .sort((a, b) => b.anios - a.anios || b.archivos.length - a.archivos.length);
  for (const v of conRecorrido.slice(0, MAX_POR_TIPO)) {
    out.push({
      tipo: 'persona_larga',
      datos: {
        nombre: v.nombre,
        anios: v.anios,
        desde: mesYAnio(v.min),
        hasta: mesYAnio(v.max),
        cuantos: v.archivos.length,
      },
      fileIds: ids(v.archivos),
    });
  }
  return out;
}

/** 4. El dia que mas grabaste. Un record, con su fecha y su evento. */
function tipoDiaMasActivo(ctx) {
  const dias = [...ctx.porDia.entries()]
    .filter(([, arr]) => arr.length >= 20)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_POR_TIPO);
  const out = [];
  for (const [fecha, archivos] of dias) {
    const ev = mejorEvento(archivos);
    if (!ev) continue;
    out.push({
      tipo: 'dia_mas_activo',
      datos: {
        fecha: fechaLegible(fecha),
        cuantos: archivos.length,
        evento: ev.evento,
      },
      fileIds: ids(archivos),
    });
  }
  return out;
}

/**
 * 5. Un año callado: mucho material antes y despues, casi nada en medio. Es el
 * unico hallazgo que habla de una AUSENCIA, y por eso dice bastante.
 */
function tipoAnioCallado(ctx) {
  const anios = [...ctx.porAnio.entries()].sort((a, b) => a[0] - b[0]);
  if (anios.length < 3) return [];
  const out = [];
  for (let i = 1; i < anios.length - 1; i++) {
    const [anio, archivos] = anios[i];
    const [anioAntes, archAntes] = anios[i - 1];
    const [anioDespues, archDespues] = anios[i + 1];
    // Años consecutivos de verdad y un bajon de al menos 10x por los dos lados.
    if (anioAntes !== anio - 1 || anioDespues !== anio + 1) continue;
    if (archivos.length * 10 > archAntes.length || archivos.length * 10 > archDespues.length) continue;
    out.push({
      tipo: 'anio_callado',
      datos: {
        anio,
        cuantos: archivos.length,
        anioAntes,
        cuantosAntes: archAntes.length,
        anioDespues,
        cuantosDespues: archDespues.length,
      },
      // Lo poco que hay de ese año es justo lo que la carta debe enseñar.
      fileIds: ids(archivos),
    });
  }
  return out.slice(0, MAX_POR_TIPO);
}

/**
 * 6. El evento mas antiguo que guardas. Red de seguridad: un archivo recien
 * estrenado, con un solo año dentro, sigue teniendo algo que contar.
 */
function tipoLoMasViejo(ctx) {
  const conEvento = ctx.conFecha.filter(x => x.evento);
  if (conEvento.length === 0) return [];
  const masViejo = conEvento.reduce((a, b) => (a.fecha <= b.fecha ? a : b));
  const ev = ctx.porEvento.get(masViejo.evento);
  return [{
    tipo: 'lo_mas_viejo',
    datos: {
      evento: masViejo.evento,
      fecha: fechaLegible(masViejo.fecha),
      cuantos: ev ? ev.archivos.length : 1,
    },
    fileIds: ids(ev ? ev.archivos : [masViejo.f]),
  }];
}

/**
 * 7. Dos momentos que se parecen y estan separados por años.
 *
 * Usa los embeddings que el escaneo ya dejo en el indice CLIP. El coste esta
 * ACOTADO: se comparan entre si MUESTRA_CLIP archivos como mucho, repartidos
 * entre años distintos. Con 200 son 20.000 productos escalares — decimas de
 * segundo — y esa cifra es la misma con 4.000 archivos que con 400.000.
 */
function tipoEcoVisual(ctx, clave) {
  if (!clipIndex.isLoaded() || clipIndex.size() === 0) return [];

  // Muestra repartida por años: sin esto, en un archivo con un año dominante
  // las 200 saldrian casi todas del mismo sitio y nunca habria salto temporal.
  const porAnio = new Map();
  for (const item of ctx.conFecha) {
    if (!item.evento) continue;
    const anio = Math.floor(item.fecha / 10000);
    const arr = porAnio.get(anio);
    if (arr) arr.push(item); else porAnio.set(anio, [item]);
  }
  const anios = [...porAnio.keys()];
  if (anios.length < 2) return [];

  const porCadaAnio = Math.max(2, Math.floor(MUESTRA_CLIP / anios.length));
  const muestra = [];
  const base = semilla('eco' + clave);
  for (const anio of anios) {
    const arr = porAnio.get(anio);
    // Paso pseudoaleatorio estable por semana: distinta muestra cada lunes.
    const paso = Math.max(1, Math.floor(arr.length / porCadaAnio));
    const offset = base % Math.max(1, paso);
    for (let i = offset; i < arr.length && muestra.length < MUESTRA_CLIP; i += paso) {
      const emb = clipIndex.get(arr[i].f.id);
      if (emb) muestra.push({ ...arr[i], emb, anio });
    }
  }
  if (muestra.length < 4) return [];

  let mejor = null;
  for (let i = 0; i < muestra.length; i++) {
    for (let j = i + 1; j < muestra.length; j++) {
      // Solo interesa el parecido LEJANO: mismo aire, años distintos.
      if (Math.abs(muestra[i].anio - muestra[j].anio) < 2) continue;
      if (muestra[i].evento === muestra[j].evento) continue;
      const a = muestra[i].emb, b = muestra[j].emb;
      let dot = 0;
      for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
      // Por debajo de 0.80 el parecido ya es "dos fotos de gente" y no dice nada.
      if (dot >= 0.80 && (!mejor || dot > mejor.sim)) {
        mejor = { sim: dot, a: muestra[i], b: muestra[j] };
      }
    }
  }
  if (!mejor) return [];

  const viejo = mejor.a.fecha <= mejor.b.fecha ? mejor.a : mejor.b;
  const nuevo = mejor.a.fecha <= mejor.b.fecha ? mejor.b : mejor.a;
  return [{
    tipo: 'eco_visual',
    datos: {
      eventoViejo: viejo.evento,
      fechaViejo: mesYAnio(viejo.fecha),
      eventoNuevo: nuevo.evento,
      fechaNuevo: mesYAnio(nuevo.fecha),
      distancia: Math.floor((nuevo.fecha - viejo.fecha) / 10000),
    },
    fileIds: [viejo.f.id, nuevo.f.id],
  }];
}

const TIPOS = [
  { nombre: 'aniversario_semana', fn: (ctx, clave, hoy) => tipoAniversarioSemana(ctx, hoy) },
  { nombre: 'mismo_mes', fn: (ctx) => tipoMismoMes(ctx) },
  { nombre: 'persona_larga', fn: (ctx) => tipoPersonaLarga(ctx) },
  { nombre: 'dia_mas_activo', fn: (ctx) => tipoDiaMasActivo(ctx) },
  { nombre: 'anio_callado', fn: (ctx) => tipoAnioCallado(ctx) },
  { nombre: 'eco_visual', fn: (ctx, clave) => tipoEcoVisual(ctx, clave) },
  { nombre: 'lo_mas_viejo', fn: (ctx) => tipoLoMasViejo(ctx) },
];

/**
 * Todos los candidatos de la semana. Cada tipo va aislado: si uno revienta por
 * datos inesperados, la carta sale con los demas en vez de no salir.
 */
async function buscarCandidatos(files, clave, hoy = new Date()) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const ctx = construirContexto(files);
  if (ctx.conFecha.length === 0) return [];

  // El indice CLIP se carga perezosamente (escaneo, busqueda semantica). Si
  // nadie lo ha tocado aun, el hallazgo visual se quedaria mudo sin decir por
  // que. Cargarlo aqui cuesta una vez por semana y ademas lo deja caliente
  // para la busqueda.
  try {
    if (!clipIndex.isLoaded()) await clipIndex.load();
  } catch (err) {
    console.warn(`[carta] no se pudo cargar el indice CLIP: ${err && err.message}`);
  }

  const candidatos = [];
  for (const tipo of TIPOS) {
    await respirar();
    try {
      const nuevos = tipo.fn(ctx, clave, hoy) || [];
      for (const c of nuevos.slice(0, MAX_POR_TIPO)) candidatos.push(c);
    } catch (err) {
      console.warn(`[carta] el hallazgo "${tipo.nombre}" fallo: ${err && err.message}`);
    }
  }
  return candidatos;
}

/** El hallazgo de esta semana: uno entre todos, estable durante siete dias. */
async function buscarHallazgo(files, clave, hoy = new Date()) {
  const candidatos = await buscarCandidatos(files, clave, hoy);
  if (candidatos.length === 0) return null;
  return candidatos[semilla('carta' + clave) % candidatos.length];
}

module.exports = {
  buscarHallazgo,
  buscarCandidatos,
  construirContexto,
  MESES,
  MAX_POR_TIPO,
  MUESTRA_CLIP,
};
