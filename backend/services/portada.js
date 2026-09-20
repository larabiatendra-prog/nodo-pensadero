/**
 * Portada — Pensadero
 *
 * Prepara lo que flota en la pantalla de inicio: unos cientos de recuerdos
 * elegidos del archivo y los HILOS que los unen (una persona, el mismo dia de
 * otro año, dos planos que se parecen, la misma luz...). El navegador solo
 * tiene que pasear por ellos.
 *
 * Por que se guarda en disco: la portada es la pantalla de carga. Se ve justo
 * al abrir la aplicacion, que es cuando el servidor todavia no tiene la lista
 * de archivos (la sincronizacion inicial tarda de segundos a minutos). Por eso
 * se prepara al TERMINAR cada sincronizacion y se guarda: la siguiente
 * apertura tiene material desde el primer segundo.
 *
 * Lo oculto bajo candado se guarda igual y se filtra al servir, para que
 * ocultar o liberar algo se note en la portada sin esperar a otra pasada.
 *
 * Un hilo solo vale si sorprende. Nunca une dos archivos del mismo evento
 * (eso es obvio) y las relaciones van por prioridad: persona, lugar, rima
 * visual y fecha antes que tema, luz o color.
 *
 * Y sabe que dia es: lo que paso un dia como hoy de otros años entra primero
 * en el reparto (las efemerides). Un archivo personal tiene esa carta y no
 * jugarla seria tonto: es lo unico que hace que abrir la aplicacion un martes
 * cualquiera tenga premio. La eleccion se sesga al preparar y las efemerides
 * se marcan al SERVIR, con la fecha de hoy, para que una portada preparada
 * ayer no cuente el dia de ayer.
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('../utils/jsonStore');
const fallos = require('../utils/failureReason');
const pathsConfig = require('../config/paths');

const ARCHIVO = path.join(__dirname, '..', 'portada_cache.json');
// Reserva de la que bebe la portada. Holgada a proposito: en pantalla caben
// 9-18, y el resto es lo que permite que se vayan relevando sin repetirse.
const MAX_NODOS = 300;
// Tamaño maximo de un grupo al proponer parejas (misma persona, mismo tema...).
// Se muestrea repartido por todo el grupo, no los primeros: con una reserva
// grande, coger los primeros dejaba sin hilos a todo lo que entraba tarde.
const MAX_GRUPO = 30;
const MAX_ENLACES_POR_NODO = 12;
// Tope de hilos con la MISMA etiqueta: sin el, quien sale en todo (el propio
// autor del archivo) o una palabra comodin se quedaban la mitad de los hilos.
const MAX_POR_ETIQUETA = 6;
// Recuerdos por evento: pocos para que haya variedad, mas si hay pocos eventos.
const MAX_RONDAS = 5;
// Cuantos recuerdos de "un dia como hoy" se reservan antes del reparto normal.
// Bastantes para que haya hilos entre ellos, pocos para que no sea una sola
// historia: la portada sigue siendo el archivo entero.
const MAX_EFEMERIDES = 20;
const MAX_EFEMERIDES_POR_EVENTO = 2;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_CORTOS = ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sept.', 'oct.', 'nov.', 'dic.'];

// Prioridad al elegir UNA relacion por pareja: lo mas humano primero.
const PRIORIDAD = { persona: 7, lugar: 6, rima: 5, fecha: 5, tema: 3, luz: 2, color: 1 };

const LUCES = {
  luz_dorada: 'luz dorada', contraluz: 'a contraluz', nocturna: 'de noche', neon: 'neón',
};
const MOMENTOS = { atardecer: 'al atardecer', amanecer: 'al amanecer' };
const AMBIENTES = { intimo: 'lo íntimo', melancolico: 'melancolía', contemplativo: 'quietud', festivo: 'fiesta', energico: 'energía' };

const FAMILIAS = [
  { id: 'azul', nombres: ['azul', 'celeste', 'indigo', 'turquesa'], hex: '#6f8fe0' },
  { id: 'rojo', nombres: ['rojo', 'granate', 'magenta'], hex: '#d0606a' },
  { id: 'verde', nombres: ['verde'], hex: '#7fb38a' },
  { id: 'naranja', nombres: ['naranja', 'ocre', 'mostaza', 'amarillo'], hex: '#e3a45c' },
  { id: 'violeta', nombres: ['lavanda', 'morado', 'rosa'], hex: '#b89be0' },
];

// Etiquetas que no cuentan nada como hilo: enums del catalogo, colores,
// fechas y demografia. Lo que queda son cosas que se ven: "guitarra",
// "abrazo", "sorpresa".
const ETIQUETAS_VACIAS = new Set([
  'clips', 'raw', 'material', 'export', 'normal', 'fijo', 'grupo', 'individual', 'pareja', 'ninguno', 'multitud',
  'exterior', 'interior', 'urbano', 'naturaleza', 'hogar', 'oficina', 'escenario', 'transito',
  'mañana', 'manana', 'mediodia', 'tarde', 'noche', 'atardecer', 'amanecer', 'indeterminado',
  'ambiente', 'documental', 'retrato', 'paisaje', 'accion', 'producto', 'abstracto',
  'joven', 'adulto', 'mayor', 'niño', 'nino', 'mujer', 'hombre', 'persona', 'personas', 'gente',
  'alegre', 'neutro', 'serio', 'formal', 'festivo', 'intimo', 'melancolico', 'contemplativo', 'energico',
  'luz_natural', 'luz_dorada', 'contraluz', 'nocturna', 'neon', 'mixta',
  'picado', 'contrapicado', 'cenital', 'nadir', 'paneo', 'cabeceo', 'acercamiento', 'alejamiento', 'inestable',
  'video', 'foto', 'imagen', 'camara', 'cámara', 'dani', 'nest', 'final', 'copia', 'version', 'edit',
  // Lo que la IA ve en casi cualquier plano: como hilo no dice nada.
  'mirar', 'observar', 'caminar', 'hablar', 'conversar', 'sonreir', 'sonreír', 'sonrisa', 'sostener', 'mostrar',
  'dirigirse', 'estar', 'sentarse', 'sentado', 'sentada', 'pie', 'posar', 'escuchar', 'esperar', 'reír', 'reir',
  'mesa', 'silla', 'sillas', 'texto', 'pantalla', 'fondo', 'mano', 'manos', 'ropa', 'puerta', 'edificio', 'ventana',
  'pared', 'suelo', 'cielo', 'árboles', 'arboles', 'árbol', 'arbol', 'vegetación', 'vegetacion', 'planta', 'plantas',
  'senior', 'botella', 'vaso', 'coche', 'calle', 'luz', 'sombra', 'objeto', 'objetos', 'cartel', 'letrero',
  ...MESES, ...MESES.map(m => m[0].toUpperCase() + m.slice(1)),
]);

const CARPETA_FECHADA = /(?:^|[\s\-_])(\d{6})[_\s]/;

let _memoria = null; // { version, generada, nodos, enlaces }

/** Evento de un archivo: el ancestro fechado mas cercano, o su carpeta. */
function eventoDe(fullPath) {
  const segs = String(fullPath || '').split(/[\\/]/).filter(Boolean);
  for (let i = segs.length - 2; i >= 0; i--) {
    if (CARPETA_FECHADA.test(segs[i])) return segs.slice(0, i + 1).join('/').toLowerCase();
  }
  return segs.slice(0, -1).join('/').toLowerCase();
}

function fechaDe(f) {
  const cand = f.extractedDate || f.createdAt;
  const d = cand ? new Date(cand) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

/**
 * Dia del calendario, en hora local. Con toISOString un archivo llamado
 * 190907 salia como "2019-09-06": la fecha sacada del nombre es medianoche
 * local, que en UTC es el dia anterior. Eso desplazaba un dia las etiquetas y
 * dejaba las efemerides sin encontrar nada.
 */
const diaLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mmddLocal = (d) => diaLocal(d).slice(5);

/**
 * La situacion de un archivo: donde (exterior, escenario, naturaleza...), con
 * cuanta gente y si es de noche. Es lo que hace que dos recuerdos se sientan
 * distintos a primera vista, y lo que la portada reparte para no enseñar diez
 * fotos de grupo seguidas. Sale de lo que describio el VLM; sin eso, 'otro'.
 */
function situacionDe(f) {
  const atm = f.atmosphere || {};
  const encuadre = (f.composition && f.composition.people_framing) || '';
  const gente = !encuadre || encuadre === 'ninguno' ? 'nadie'
    : encuadre === 'individual' ? 'alguien'
      : encuadre === 'pareja' ? 'dos'
        : encuadre === 'multitud' || encuadre === 'grupo_grande' ? 'mucha gente'
          : 'grupo';
  const noche = atm.time_of_day === 'noche' || atm.lighting === 'nocturna' ? 'noche' : 'dia';
  return `${atm.space_type || 'otro'}·${gente}·${noche}`;
}

/**
 * ¿Es un fotograma en negro? Toda su paleta por debajo de una luminancia muy
 * baja: el primer instante de un clip, la tapa puesta. Una noche con luces no
 * cae aqui (su paleta tiene algun color claro). En la portada un cuadro negro
 * no enseña ninguna situacion: es un hueco. Hay unos 400 en el archivo.
 */
function casiNegro(f) {
  const pal = f.colors && Array.isArray(f.colors.palette) ? f.colors.palette : [];
  let max = -1;
  for (const c of pal) {
    const m = /^#?([0-9a-f]{6})$/i.exec((c && c.hex) || '');
    if (!m) continue;
    const n = parseInt(m[1], 16);
    max = Math.max(max, 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255));
  }
  return max >= 0 && max < 20;
}

/** Entero estable a partir de una cadena. */
function semilla(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

/** Ruta en disco de la miniatura del archivo, o null si no existe. */
function rutaMiniatura(f) {
  if (!f || !f.fullPath || !f.id) return null;
  try {
    const loc = pathsConfig.resolveThumbnailLocation({ fullPath: f.fullPath, fileId: f.id, fileName: f.name });
    if (loc.thumbnailPath && fs.existsSync(loc.thumbnailPath)) return loc.thumbnailPath;
    const legacy = pathsConfig.resolveThumbnailLocation({ fullPath: f.fullPath, fileId: f.id, fileName: f.name, legacy: true });
    return legacy.thumbnailPath && fs.existsSync(legacy.thumbnailPath) ? legacy.thumbnailPath : null;
  } catch {
    return null;
  }
}

/**
 * Elige los nodos: variados (como mucho dos por evento), con miniatura real y
 * con algo por lo que poder unirse a otros. La semilla es el dia, asi que cada
 * dia la portada tiene otro reparto.
 */
function elegirNodos(files, clipIndex, dia, hoy) {
  const porEvento = new Map();
  for (const f of files) {
    if (!f || (f.type !== 'image' && f.type !== 'video')) continue;
    if (!f.fullPath || /\.pensadero|\$recycle\.bin/i.test(f.fullPath)) continue;
    if (casiNegro(f)) continue;
    const personas = Array.isArray(f.faces) ? f.faces.filter(c => c && c.person_id).length : 0;
    const clip = clipIndex && typeof clipIndex.has === 'function' && clipIndex.has(f.id);
    const atm = f.atmosphere && (f.atmosphere.lighting || f.atmosphere.mood);
    let puntos = (personas > 0 ? 4 : 0) + (clip ? 2 : 0) + (atm ? 1 : 0) + (Array.isArray(f.spaces) && f.spaces.length ? 2 : 0);
    if (puntos === 0) continue;
    puntos += (semilla(f.id + dia) % 100) / 100; // desempate que cambia cada dia
    const ev = eventoDe(f.fullPath);
    const arr = porEvento.get(ev);
    const item = { f, puntos, situacion: situacionDe(f) };
    if (arr) arr.push(item); else porEvento.set(ev, [item]);
  }

  const eventos = Array.from(porEvento.entries())
    .map(([ev, arr]) => ({ ev, arr: arr.sort((a, b) => b.puntos - a.puntos), orden: semilla(ev + dia) }))
    .sort((a, b) => a.orden - b.orden);

  const elegidos = [];
  const yaElegido = new Set();
  const mete = (cand, ev) => {
    if (!cand || yaElegido.has(cand.f.id)) return false;
    const ruta = rutaMiniatura(cand.f);
    if (!ruta) return false;
    yaElegido.add(cand.f.id);
    elegidos.push({ f: cand.f, ev, ruta });
    return true;
  };

  // Primero, un dia como hoy de otros años: es lo que hace que la portada
  // tenga algo que contar justo hoy.
  const mmdd = mmddLocal(hoy);
  const esteAnio = hoy.getFullYear();
  const efemerides = [];
  for (const { ev, arr } of eventos) {
    let puestos = 0;
    for (const cand of arr) {
      if (puestos >= MAX_EFEMERIDES_POR_EVENTO) break;
      const d = fechaDe(cand.f);
      if (!d) continue;
      if (mmddLocal(d) !== mmdd) continue;
      // Lo de hoy mismo no es una efemeride, es hoy: cuenta, pero detras.
      efemerides.push({ cand, ev, otroAnio: d.getFullYear() !== esteAnio });
      puestos++;
    }
  }
  efemerides.sort((a, b) => (b.otroAnio ? 1 : 0) - (a.otroAnio ? 1 : 0) || b.cand.puntos - a.cand.puntos);
  for (const e of efemerides) {
    if (elegidos.length >= MAX_EFEMERIDES) break;
    mete(e.cand, e.ev);
  }

  // Cada ronda saca uno de cada evento, pero no "el mejor": el de la situacion
  // que menos hay hasta ahora (a igualdad, el de mas puntos). Antes se cogia
  // siempre el de mas puntos, que casi siempre era una foto con gente, y la
  // portada era un desfile de grupos. Asi entran tambien el paisaje sin nadie,
  // el escenario de noche, la mesa, la carretera.
  const porSituacion = new Map();
  for (const e of elegidos) {
    const s = situacionDe(e.f);
    porSituacion.set(s, (porSituacion.get(s) || 0) + 1);
  }
  // Con pocos eventos se sacan mas de cada uno (situaciones distintas dentro
  // del mismo: la ceremonia, la cena, el baile), para que la reserva de
  // relevos no se quede corta. Con muchos, basta con pocos de cada.
  const rondas = Math.max(MAX_RONDAS, Math.min(10, Math.ceil(MAX_NODOS / Math.max(1, eventos.length))));
  for (let ronda = 0; ronda < rondas && elegidos.length < MAX_NODOS; ronda++) {
    for (const { ev, arr } of eventos) {
      if (elegidos.length >= MAX_NODOS) break;
      const orden = arr
        .filter(c => !yaElegido.has(c.f.id))
        .map(c => ({ c, clave: (porSituacion.get(c.situacion) || 0) - c.puntos * 0.01 }))
        .sort((a, b) => a.clave - b.clave);
      // Si al primero le falta la miniatura, el siguiente: un evento no se
      // queda fuera de la ronda por un archivo sin preparar.
      for (const { c } of orden.slice(0, 5)) {
        if (mete(c, ev)) {
          porSituacion.set(c.situacion, (porSituacion.get(c.situacion) || 0) + 1);
          break;
        }
      }
    }
  }
  return elegidos;
}

function familiaDe(f) {
  const pal = f.colors && Array.isArray(f.colors.palette) ? f.colors.palette : [];
  for (const c of pal.slice(0, 3)) {
    const base = c && typeof c.name === 'string' ? c.name.split(' ')[0] : '';
    const fam = FAMILIAS.find(x => x.nombres.includes(base));
    if (fam) return fam;
  }
  return null;
}

/**
 * Prepara la portada a partir de la lista de archivos (sin filtrar por el
 * candado: eso se hace al servir).
 */
function preparar(files, { clipIndex, hoy = new Date() } = {}) {
  const dia = hoy.toISOString().slice(0, 10);
  const elegidos = elegirNodos(Array.isArray(files) ? files : [], clipIndex, dia, hoy);

  // Conteo de etiquetas por evento, sobre TODO el archivo: una etiqueta que
  // sale en 400 eventos no une nada; una que sale en 2 a 30, si.
  const eventosPorEtiqueta = new Map();
  for (const f of files || []) {
    if (!Array.isArray(f.tags)) continue;
    const ev = eventoDe(f.fullPath);
    for (const t of f.tags) {
      if (typeof t !== 'string') continue;
      const k = t.trim().toLowerCase();
      if (k.length < 4 || ETIQUETAS_VACIAS.has(k) || /\d/.test(k) || k.includes('_') || /^(gris|negro|blanco|marron|piel|crema|beige)\b/.test(k)) continue;
      let s = eventosPorEtiqueta.get(k);
      if (!s) { s = new Set(); eventosPorEtiqueta.set(k, s); }
      if (s.size < 40) s.add(ev);
    }
  }

  // Rara = significativa: una etiqueta sirve de hilo si sale en pocos eventos.
  const totalEventos = new Set((files || []).map(f => eventoDe(f.fullPath))).size;
  const techoTema = Math.max(3, Math.round(totalEventos * 0.06));

  const nodos = elegidos.map(({ f, ev, ruta }, i) => {
    const d = fechaDe(f);
    const personas = [];
    for (const c of Array.isArray(f.faces) ? f.faces : []) {
      if (c && c.person_id && !personas.some(p => p.id === c.person_id)) {
        personas.push({ id: c.person_id, nombre: c.display_name || c.person_id });
      }
    }
    const temas = (Array.isArray(f.tags) ? f.tags : [])
      .map(t => String(t).trim().toLowerCase())
      .filter(t => { const s = eventosPorEtiqueta.get(t); return s && s.size >= 2 && s.size <= techoTema; })
      .slice(0, 12);
    return {
      i,
      id: f.id,
      mediaKey: f.mediaKey || null,
      tipo: f.type,
      evento: ev,
      ruta,
      fecha: d ? diaLocal(d) : null,
      situacion: situacionDe(f),
      personas,
      lugares: (Array.isArray(f.spaces) ? f.spaces : []).filter(s => s && s.space_id).map(s => ({ id: s.space_id, nombre: s.display_name || s.space_id })),
      luz: f.atmosphere && LUCES[f.atmosphere.lighting] ? f.atmosphere.lighting : null,
      momento: f.atmosphere && MOMENTOS[f.atmosphere.time_of_day] ? f.atmosphere.time_of_day : null,
      ambiente: f.atmosphere && AMBIENTES[f.atmosphere.mood] ? f.atmosphere.mood : null,
      familia: familiaDe(f),
      temas,
    };
  });

  // ── Enlaces ─────────────────────────────────────────────────────────────
  const porPareja = new Map();
  const proponer = (a, b, tipo, etiqueta, detalle, extra) => {
    if (a === b) return;
    const na = nodos[a];
    const nb = nodos[b];
    if (na.evento === nb.evento) return; // lo obvio no es un hilo
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    const prev = porPareja.get(k);
    if (prev && PRIORIDAD[prev.tipo] >= PRIORIDAD[tipo]) return;
    porPareja.set(k, { a: Math.min(a, b), b: Math.max(a, b), tipo, etiqueta, detalle: detalle || '', ...(extra || {}) });
  };
  const anioDe = n => (n.fecha ? Number(n.fecha.slice(0, 4)) : null);
  const distancia = (na, nb) => {
    const ya = anioDe(na);
    const yb = anioDe(nb);
    if (!ya || !yb || ya === yb) return '';
    return `${Math.min(ya, yb)} → ${Math.max(ya, yb)}`;
  };
  // Agrupa por clave y propone todas las parejas del grupo (acotado).
  const porClave = (claveDe, alProponer) => {
    const grupos = new Map();
    nodos.forEach((n, idx) => {
      for (const k of [].concat(claveDe(n) || [])) {
        if (!k) continue;
        const arr = grupos.get(k);
        if (arr) arr.push(idx); else grupos.set(k, [idx]);
      }
    });
    for (const [k, idxs] of grupos) {
      const paso = Math.ceil(idxs.length / MAX_GRUPO);
      const lista = paso <= 1 ? idxs : idxs.filter((_, k) => k % paso === 0);
      for (let x = 0; x < lista.length; x++) {
        for (let y = x + 1; y < lista.length; y++) alProponer(k, lista[x], lista[y]);
      }
    }
  };

  porClave(n => n.personas.map(p => p.id), (k, a, b) => {
    const p = nodos[a].personas.find(x => x.id === k);
    proponer(a, b, 'persona', p ? p.nombre : k, distancia(nodos[a], nodos[b]), { personaId: k });
  });
  porClave(n => n.lugares.map(l => l.id), (k, a, b) => {
    const l = nodos[a].lugares.find(x => x.id === k);
    proponer(a, b, 'lugar', l ? l.nombre : k, distancia(nodos[a], nodos[b]));
  });
  porClave(n => (n.fecha ? n.fecha.slice(5) : null), (k, a, b) => {
    const ya = anioDe(nodos[a]);
    const yb = anioDe(nodos[b]);
    const [mm, dd] = k.split('-').map(Number);
    if (ya && yb && ya !== yb) {
      proponer(a, b, 'fecha', `${dd} de ${MESES[mm - 1]}`, `${Math.min(ya, yb)} · ${Math.max(ya, yb)}`);
    } else if (ya && ya === yb) {
      proponer(a, b, 'fecha', 'el mismo día', `${dd} ${MESES_CORTOS[mm - 1]} ${ya}`);
    }
  });
  porClave(n => n.temas, (k, a, b) => proponer(a, b, 'tema', k, distancia(nodos[a], nodos[b])));
  porClave(n => [n.luz && `l:${n.luz}`, n.momento && `m:${n.momento}`, n.ambiente && `a:${n.ambiente}`], (k, a, b) => {
    const [t, v] = k.split(':');
    const etiqueta = t === 'l' ? LUCES[v] : t === 'm' ? MOMENTOS[v] : AMBIENTES[v];
    proponer(a, b, 'luz', etiqueta, distancia(nodos[a], nodos[b]));
  });
  porClave(n => (n.familia ? n.familia.id : null), (k, a, b) => {
    proponer(a, b, 'color', nodos[a].familia.id, '', { color: nodos[a].familia.hex });
  });

  // Rima visual: la huella de SigLIP-2. Umbral relativo al propio conjunto
  // (el 1,5 % mas parecido), con suelo: si nada se parece de verdad, no hay
  // rimas en vez de rimas forzadas.
  if (clipIndex && typeof clipIndex.get === 'function') {
    const embs = nodos.map(n => clipIndex.get(n.id));
    const sims = [];
    for (let a = 0; a < nodos.length; a++) {
      const ea = embs[a];
      if (!ea) continue;
      for (let b = a + 1; b < nodos.length; b++) {
        const eb = embs[b];
        if (!eb || nodos[a].evento === nodos[b].evento) continue;
        let dot = 0;
        for (let k = 0; k < ea.length; k++) dot += ea[k] * eb[k];
        sims.push({ a, b, dot });
      }
    }
    if (sims.length > 0) {
      sims.sort((x, y) => y.dot - x.dot);
      const corte = Math.max(0.78, sims[Math.floor(sims.length * 0.015)]?.dot ?? 1);
      for (const s of sims) {
        if (s.dot < corte) break;
        proponer(s.a, s.b, 'rima', 'se parecen', distancia(nodos[s.a], nodos[s.b]));
      }
    }
  }

  // Tope por nodo: los de mas prioridad. Un nodo con cuarenta hilos de color
  // es ruido, no una red.
  const todos = Array.from(porPareja.values()).sort((x, y) => PRIORIDAD[y.tipo] - PRIORIDAD[x.tipo]);
  // Dentro de la misma prioridad se prefieren los hilos que cruzan años: una
  // persona en 2019 y en 2024 cuenta mas que la misma persona dos veces en 2024.
  todos.sort((x, y) => PRIORIDAD[y.tipo] - PRIORIDAD[x.tipo] || (y.detalle ? 1 : 0) - (x.detalle ? 1 : 0) || semilla(`${x.a}|${x.b}${dia}`) - semilla(`${y.a}|${y.b}${dia}`));
  const cuenta = new Array(nodos.length).fill(0);
  const porEtiqueta = new Map();
  const enlaces = [];
  for (const e of todos) {
    if (cuenta[e.a] >= MAX_ENLACES_POR_NODO || cuenta[e.b] >= MAX_ENLACES_POR_NODO) continue;
    const k = `${e.tipo}:${e.etiqueta}`;
    const n = porEtiqueta.get(k) || 0;
    if (n >= MAX_POR_ETIQUETA) continue;
    porEtiqueta.set(k, n + 1);
    cuenta[e.a]++;
    cuenta[e.b]++;
    enlaces.push(e);
  }

  return {
    version: 1,
    generada: new Date().toISOString(),
    nodos: nodos.map(n => ({
      i: n.i, id: n.id, mediaKey: n.mediaKey, tipo: n.tipo, fecha: n.fecha, ruta: n.ruta,
      personas: n.personas.slice(0, 4),
      situacion: n.situacion,
      // El evento como numero: a la portada solo le hace falta saber si dos
      // recuerdos son del mismo, no la ruta.
      ev: semilla(n.evento),
    })),
    enlaces,
  };
}

/** Prepara, guarda en disco y deja en memoria. Nunca lanza. */
async function regenerar(files, deps = {}) {
  try {
    const t = Date.now();
    const p = preparar(files, deps);
    _memoria = p;
    await atomicWriteFile(ARCHIVO, JSON.stringify(p));
    console.log(`🌫️ Portada preparada: ${p.nodos.length} recuerdos, ${p.enlaces.length} hilos (${Date.now() - t} ms)`);
    return p;
  } catch (err) {
    fallos.record('preparar la portada', err, { path: ARCHIVO });
    return _memoria;
  }
}

/** La ultima portada preparada (memoria o disco), o null si no hay. */
function leer() {
  if (_memoria) return _memoria;
  try {
    _memoria = JSON.parse(fs.readFileSync(ARCHIVO, 'utf-8'));
  } catch {
    _memoria = null;
  }
  return _memoria;
}

/**
 * Lo que se entrega: sin lo que este bajo candado, y reindexado para que el
 * navegador no tenga que saber de huecos.
 */
function servir(portada, estaOculto, hoy = new Date()) {
  if (!portada || !Array.isArray(portada.nodos)) return { nodos: [], enlaces: [] };
  // Fuera lo que este bajo candado y lo que viva en un disco que ahora no esta:
  // una miniatura que no carga seria un hueco flotando.
  const vivos = portada.nodos.filter(n => !estaOculto({ id: n.id, mediaKey: n.mediaKey })
    && (!n.ruta || fs.existsSync(n.ruta)));
  const nuevo = new Map(vivos.map((n, idx) => [n.i, idx]));
  // Un dia como hoy: se calcula ahora, no al preparar, para que una portada
  // de ayer no siga contando el dia de ayer.
  const mmdd = mmddLocal(hoy);
  const efemerides = [];
  const anios = new Set();
  vivos.forEach((n, idx) => {
    if (!n.fecha || n.fecha.slice(5) !== mmdd) return;
    efemerides.push(idx);
    anios.add(Number(n.fecha.slice(0, 4)));
  });

  return {
    generada: portada.generada,
    // Solo se cuenta como efemeride si hay al menos dos años distintos: "hoy"
    // a secas no es un reencuentro, y la gracia esta en el salto entre años.
    efemeride: anios.size >= 2
      ? {
        nodos: efemerides,
        dia: `${hoy.getDate()} de ${MESES[hoy.getMonth()]}`,
        anios: Array.from(anios).sort((a, b) => a - b),
      }
      : null,
    nodos: vivos.map((n, idx) => ({
      i: idx, id: n.id, tipo: n.tipo, fecha: n.fecha, personas: n.personas,
      situacion: n.situacion || '', ev: n.ev || 0,
      miniatura: `/api/thumbnails/${encodeURIComponent(n.id)}`,
    })),
    enlaces: (portada.enlaces || [])
      .filter(e => nuevo.has(e.a) && nuevo.has(e.b))
      .map(e => ({ ...e, a: nuevo.get(e.a), b: nuevo.get(e.b) })),
  };
}

module.exports = { preparar, regenerar, leer, servir, _eventoDe: eventoDe };
