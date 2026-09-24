import type { MediaFile } from '../types';
import { getFileSessionKey, getSessionLabelSource, getFileSortDate } from './filenameParser';

/**
 * Reposo activo — el archivo habla primero.
 *
 * `patrones-experiencia.md` lo pide con esas palabras: "las herramientas de
 * memoria ofrecen contenido sin que se les pregunte (ecos y aniversarios en
 * pensadero)". Con 4.489 archivos y el 84% concentrado en un solo año, el
 * archivo no se cura navegando: se cura cuando te pone algo delante.
 *
 * Por que aqui y no en el backend: la sesion (la carpeta como unidad atomica
 * de significado) y su fecha ya estan resueltas en `filenameParser.ts`, y los
 * MediaFile ya estan en memoria. Reimplementarlo en el servidor seria una
 * segunda definicion de "que es una sesion" — el error que ya se pago caro con
 * `face_count`.
 *
 * Todo se calcula sobre lo que ya hay cargado: ni endpoint nuevo, ni I/O, ni
 * dato que persistir.
 */

export type TipoEco = 'aniversario' | 'sin_ver' | 'nota' | 'pareja' | 'mes' | 'tema' | 'color' | 'rincon';

export interface Eco {
  /** Estable durante el dia: la tarjeta no baila entre renders. */
  id: string;
  tipo: TipoEco;
  /** Linea principal: "Hace 2 años". */
  titulo: string;
  /** Linea secundaria: de que material se trata. */
  detalle: string;
  /** Cuantos archivos hay detras. */
  total: number;
  /** Los archivos del eco, para filtrar la galeria al pulsarlo. */
  fileIds: string[];
  /** Muestras del propio material, para pintar la tarjeta con imagen. */
  thumbnails: string[];
  /** Lo que cada tipo necesita para pintarse a su manera. */
  extra?: {
    /** Aniversario: el año, que la tarjeta enseña en grande. */
    anio?: number;
    /** Sin ver / pareja: a quien se refiere, para poner su cara. */
    personas?: Array<{ id: string; nombre: string }>;
    /** Color: las muestras de la paleta. */
    colores?: string[];
  };
}

/**
 * Miniaturas de muestra para pintar el eco: repartidas a lo largo de la sesion
 * (no las cuatro primeras, que suelen ser el mismo plano) y evitando los
 * placeholders SVG de los archivos sin thumbnail, que dejarian la tarjeta con
 * cuadros negros. Si no hay ninguna real, se devuelve lo que haya.
 */
function muestras(files: MediaFile[], cuantas = 4): string[] {
  const reales = files.filter(f => f.thumbnail && !f.thumbnail.startsWith('data:image/svg'));
  const fuente = reales.length > 0 ? reales : files;
  const paso = Math.max(1, Math.floor(fuente.length / cuantas));
  const out: string[] = [];
  for (let i = 0; i < fuente.length && out.length < cuantas; i += paso) {
    if (fuente[i]?.thumbnail) out.push(fuente[i].thumbnail);
  }
  return out;
}

/**
 * Hasta `cuantas` miniaturas elegidas con semilla y de sesiones distintas:
 * una tarjeta tematica ("luz dorada") que enseña ocho planos del mismo dia no
 * cuenta el tema, cuenta ese dia. Solo si no hay sesiones suficientes repite.
 */
function muestrasVariadas(files: MediaFile[], sesionDe: Map<string, string>, sal: number, cuantas = 8): string[] {
  const reales = files.filter(f => f.thumbnail && !f.thumbnail.startsWith('data:image/svg'));
  if (reales.length === 0) return muestras(files, Math.min(cuantas, 4));
  const porSesion = new Map<string, MediaFile[]>();
  for (const f of reales) {
    const k = sesionDe.get(f.id) || f.id;
    const arr = porSesion.get(k);
    if (arr) arr.push(f); else porSesion.set(k, [f]);
  }
  // Orden estable pero barajado por la semilla.
  const grupos = Array.from(porSesion.entries())
    .map(([k, arr]) => ({ orden: semilla(k + ':' + sal), arr }))
    .sort((a, b) => a.orden - b.orden)
    .map(g => g.arr);
  const out: string[] = [];
  for (let ronda = 0; out.length < cuantas && ronda < 4; ronda++) {
    for (const arr of grupos) {
      if (out.length >= cuantas) break;
      const f = arr[(semilla(arr[0].id + ':' + sal) + ronda * 7) % arr.length];
      if (f && f.thumbnail && !out.includes(f.thumbnail)) out.push(f.thumbnail);
    }
  }
  return out;
}

/** YYYYMMDD -> {anio, mes, dia}. Devuelve null si no es una fecha usable. */
function partes(num: number): { anio: number; mes: number; dia: number } | null {
  if (!num || num < 19000101) return null;
  const anio = Math.floor(num / 10000);
  const mes = Math.floor((num % 10000) / 100);
  const dia = num % 100;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return { anio, mes, dia };
}

/** Distancia en dias entre dos (mes, dia), ignorando el año. Maneja el salto de diciembre a enero. */
function distanciaDelAnio(mesA: number, diaA: number, mesB: number, diaB: number): number {
  const base = 2001; // año no bisiesto, sirve de referencia estable
  const a = Date.UTC(base, mesA - 1, diaA);
  const b = Date.UTC(base, mesB - 1, diaB);
  const dif = Math.abs(a - b) / 86400000;
  return Math.min(dif, 365 - dif);
}

interface Sesion {
  key: string;
  etiqueta: string;
  /** Carpeta-evento que engloba la sesion. Dos sesiones del mismo evento la comparten. */
  evento: string;
  /** Cache/proyecto de Premiere: sirve para buscar, no para recordar. */
  tecnica: boolean;
  fecha: number;      // YYYYMMDD representativa (la mas antigua del grupo)
  files: MediaFile[];
}

// Carpeta fechada, tolerando los prefijos que usa el archivo real:
// "240317_Villalba", "- 190907_Bioritme", "- 000000_The Big School".
// No se toca FOLDER_DATE_PREFIX de filenameParser a proposito: esa constante
// decide como AGRUPA y ORDENA toda la galeria, y cambiarla por mejorar una
// etiqueta movería material de sitio.
const CARPETA_FECHADA = /(?:^|[\s\-_])(\d{6})[_\s]/;

/**
 * Nombre del EVENTO al que pertenece un archivo: el ancestro fechado mas
 * cercano. Sirve para dos cosas: etiquetar con algo que situe ("Bioritme" y no
 * "Clips") y no repetir dos veces el mismo aniversario porque el material este
 * repartido en subcarpetas.
 */
// Carpetas que genera Premiere/AME: cache, previews y proyectos. Tienen
// material dentro y fecha en el nombre, pero como recuerdo no valen: nadie
// quiere que el archivo le proponga "Adobe Premiere Pro Video Previews".
const CARPETA_TECNICA = /\.PRV$|Adobe Premiere|Video Previews|_AME$|\[project\]/i;

function esTecnica(file: MediaFile): boolean {
  const fp = file.fullPath;
  if (!fp) return false;
  // Por las dos barras: con solo "/" una ruta de Windows no se partia y
  // `\.PRV$` / `_AME$` (que miran el final de cada carpeta) no casaban nunca.
  return fp.split(/[\\/]/).some(seg => CARPETA_TECNICA.test(seg));
}

/** Quita de una etiqueta los trozos que sean un nombre de archivo. */
function limpiarEtiqueta(s: string): string {
  return s.split(' / ')
    .filter(parte => !/\.[a-z0-9]{2,4}$/i.test(parte.trim()))
    .join(' / ')
    .trim();
}

function eventoDe(file: MediaFile): string {
  const fp = file.fullPath;
  if (!fp) return '';
  const segs = fp.split(/[\\/]/).filter(Boolean);
  for (let i = segs.length - 2; i >= 0; i--) {
    if (CARPETA_FECHADA.test(segs[i])) return segs[i];
  }
  return '';
}

/** Agrupa los archivos en sesiones, con la misma clave que usa la galeria. */
function agruparSesiones(files: MediaFile[]): Sesion[] {
  const porClave = new Map<string, MediaFile[]>();
  for (const f of files) {
    const k = getFileSessionKey(f);
    if (!k) continue;
    const arr = porClave.get(k);
    if (arr) arr.push(f); else porClave.set(k, [f]);
  }
  const out: Sesion[] = [];
  for (const [key, arr] of porClave) {
    let fecha = 0;
    for (const f of arr) {
      const d = getFileSortDate(f);
      // La mas ANTIGUA representa al evento: si una carpeta se retoca años
      // despues, su fecha sigue siendo la del dia que se grabo.
      if (d && (fecha === 0 || d < fecha)) fecha = d;
    }
    const etiquetaSesion = getSessionLabelSource(arr[0]) || key;
    const evento = eventoDe(arr[0]);
    // Si el evento existe y la etiqueta de la sesion no lo menciona, se
    // antepone: "Clips" no situa nada, "- 190907_Bioritme / Clips" si.
    const compuesta = evento && !etiquetaSesion.includes(evento)
      ? `${evento} / ${etiquetaSesion}`
      : etiquetaSesion;
    const etiqueta = limpiarEtiqueta(compuesta) || evento || etiquetaSesion;
    out.push({ key, etiqueta, evento: evento || key, files: arr, fecha, tecnica: esTecnica(arr[0]) });
  }
  return out;
}

/** Entero estable a partir de una cadena (para elegir sin azar real). */
function semilla(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export interface OpcionesEcos {
  /** Fecha de referencia (inyectable para poder probarlo). */
  hoy?: Date;
  /** Ventana del aniversario, en dias a cada lado. */
  ventanaDias?: number;
  /** Meses sin aparecer para que una persona cuente como "sin ver". */
  mesesSinVer?: number;
  /** Maximo de ecos devueltos. */
  maximo?: number;
  /** Cada "barajar" suma uno: otra seleccion del mismo dia, repetible. */
  giro?: number;
  /** Nota humana de un archivo, si la tiene. Sin esto no hay eco de notas. */
  notaDe?: (file: MediaFile) => string | undefined;
}

/**
 * Calcula los ecos del dia. Deterministico: el mismo archivo y el mismo dia
 * dan siempre el mismo resultado, para que esto se sienta como una seccion
 * del archivo y no como una tombola.
 */
export function calcularEcos(files: MediaFile[], opts: OpcionesEcos = {}): Eco[] {
  const hoy = opts.hoy || new Date();
  const ventana = opts.ventanaDias ?? 5;
  const mesesSinVer = opts.mesesSinVer ?? 6;
  const maximo = opts.maximo ?? 8;
  const giro = Math.max(0, Math.floor(opts.giro ?? 0));
  if (!Array.isArray(files) || files.length === 0) return [];

  const claveDia = `${hoy.getFullYear()}-${hoy.getMonth() + 1}-${hoy.getDate()}`;
  // La semilla cambia con el dia y con cada "barajar": mismo dia y mismo giro,
  // mismos ecos. Asi se puede volver atras y encontrar lo que habia.
  const claveTirada = `${claveDia}#${giro}`;
  const elegir = <T>(lista: T[], sal: string): T => lista[semilla(sal + claveTirada) % lista.length];
  const anioHoy = hoy.getFullYear();
  const mesHoy = hoy.getMonth() + 1;
  const diaHoy = hoy.getDate();

  const sesiones = agruparSesiones(files);
  const sesionDe = new Map<string, string>();
  for (const s of sesiones) for (const f of s.files) sesionDe.set(f.id, s.key);
  const muestrasDe = (lista: MediaFile[], sal: string, cuantas = 8) =>
    muestrasVariadas(lista, sesionDe, semilla(sal + claveTirada), cuantas);

  const ecos: Eco[] = [];
  const usados = new Set<string>(); // primer archivo de cada eco: no repetir historia

  const empujar = (eco: Eco) => {
    if (eco.fileIds.length === 0 || usados.has(eco.fileIds[0])) return;
    usados.add(eco.fileIds[0]);
    ecos.push(eco);
  };

  // ── 1. Aniversario de sesion ────────────────────────────────────────────
  // La unidad es el evento, no el archivo: un aniversario por dia exacto casi
  // nunca dispararia, y cuando lo hace son cuatro fotos sueltas. La carpeta si
  // es una historia.
  const candidatos: Array<{ s: Sesion; anios: number; dist: number }> = [];
  for (const s of sesiones) {
    const p = partes(s.fecha);
    if (!p || p.anio >= anioHoy || s.tecnica) continue;
    const dist = distanciaDelAnio(p.mes, p.dia, mesHoy, diaHoy);
    if (dist > ventana) continue;
    candidatos.push({ s, anios: anioHoy - p.anio, dist });
  }
  candidatos.sort((a, b) => a.dist - b.dist || b.s.files.length - a.s.files.length);
  // Un evento, un aniversario: un rodaje repartido en "Clips", "119_PANA" y
  // "120_PANA" no puede ocupar tres huecos con la misma historia.
  const eventosVistos = new Set<string>();
  const unicos = candidatos.filter(c => {
    if (eventosVistos.has(c.s.evento)) return false;
    eventosVistos.add(c.s.evento);
    return true;
  });
  // Barajar rota entre los aniversarios de la ventana, sin inventar otros.
  const rotados = unicos.length > 2 ? [...unicos.slice(giro % unicos.length), ...unicos.slice(0, giro % unicos.length)] : unicos;
  for (const c of rotados.slice(0, 2)) {
    const p = partes(c.s.fecha)!;
    empujar({
      id: `aniv:${c.s.key}:${claveDia}`,
      tipo: 'aniversario',
      titulo: c.dist === 0
        ? (c.anios === 1 ? 'Hoy hace un año' : `Hoy hace ${c.anios} años`)
        : (c.anios === 1 ? 'Hace un año' : `Hace ${c.anios} años`),
      detalle: `${c.s.etiqueta} · ${p.dia} de ${MESES[p.mes - 1]} de ${p.anio}`,
      total: c.s.files.length,
      fileIds: c.s.files.map(f => f.id),
      thumbnails: muestrasDe(c.s.files, 'aniv' + c.s.key),
      extra: { anio: p.anio },
    });
  }

  // ── Personas: quien aparece, cuando, y con quien ────────────────────────
  const porPersona = new Map<string, { nombre: string; ultima: number; primera: number; files: MediaFile[] }>();
  const porPareja = new Map<string, { a: string; b: string; files: MediaFile[]; primera: number }>();
  for (const f of files) {
    if (!Array.isArray(f.faces) || f.faces.length === 0) continue;
    const d = getFileSortDate(f);
    const ids: string[] = [];
    for (const cara of f.faces) {
      const pid = cara && cara.person_id;
      if (!pid || ids.includes(pid)) continue;
      ids.push(pid);
      const prev = porPersona.get(pid);
      if (prev) {
        prev.files.push(f);
        if (d > prev.ultima) prev.ultima = d;
        if (d && (!prev.primera || d < prev.primera)) prev.primera = d;
      } else {
        porPersona.set(pid, { nombre: cara.display_name || pid, ultima: d, primera: d, files: [f] });
      }
    }
    // Parejas: mas de seis caras en un plano es una multitud, no un "juntos".
    if (ids.length >= 2 && ids.length <= 6) {
      ids.sort();
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const k = `${ids[i]}|${ids[j]}`;
          const prev = porPareja.get(k);
          if (prev) {
            prev.files.push(f);
            if (d && (!prev.primera || d < prev.primera)) prev.primera = d;
          } else {
            porPareja.set(k, { a: ids[i], b: ids[j], files: [f], primera: d });
          }
        }
      }
    }
  }

  // ── 2. Alguien que no aparece hace tiempo ───────────────────────────────
  // El eco que mas acompaña: no habla de material, habla de gente.
  const hoyNum = anioHoy * 10000 + mesHoy * 100 + diaHoy;
  const ausentes: Array<{ pid: string; nombre: string; meses: number; files: MediaFile[] }> = [];
  for (const [pid, v] of porPersona) {
    const p = partes(v.ultima);
    if (!p) continue;
    const meses = (anioHoy - p.anio) * 12 + (mesHoy - p.mes);
    if (meses >= mesesSinVer && v.files.length >= 3 && v.ultima < hoyNum) {
      ausentes.push({ pid, nombre: v.nombre, meses, files: v.files });
    }
  }
  if (ausentes.length > 0) {
    ausentes.sort((a, b) => b.files.length - a.files.length);
    const elegido = elegir(ausentes.slice(0, 8), 'sinver');
    const anios = Math.floor(elegido.meses / 12);
    empujar({
      id: `sinver:${elegido.pid}:${claveTirada}`,
      tipo: 'sin_ver',
      titulo: anios >= 1
        ? `Hace ${anios === 1 ? 'más de un año' : `más de ${anios} años`} que no veías a ${elegido.nombre}`
        : `Hace ${elegido.meses} meses que no veías a ${elegido.nombre}`,
      detalle: `${elegido.files.length} archivos en el archivo`,
      total: elegido.files.length,
      fileIds: elegido.files.map(f => f.id),
      thumbnails: muestrasDe(elegido.files, 'sinver' + elegido.pid),
      extra: { personas: [{ id: elegido.pid, nombre: elegido.nombre }] },
    });
  }

  // ── 3. Lo que escribiste ────────────────────────────────────────────────
  // Una nota humana es lo menos regenerable del archivo: devolverla de vez en
  // cuando es recordar por que se guardo aquello.
  if (typeof opts.notaDe === 'function') {
    const conNota: Array<{ f: MediaFile; nota: string }> = [];
    const textos = new Set<string>();
    for (const f of files) {
      const nota = opts.notaDe(f);
      if (!nota || nota.trim().length < 12 || textos.has(nota)) continue;
      textos.add(nota);
      conNota.push({ f, nota: nota.trim() });
    }
    if (conNota.length > 0) {
      const { f, nota } = elegir(conNota, 'nota');
      const clave = sesionDe.get(f.id);
      const sesion = clave ? sesiones.find(s => s.key === clave) : undefined;
      const grupo = sesion ? sesion.files : [f];
      const p = partes(sesion ? sesion.fecha : getFileSortDate(f));
      const resto = grupo.filter(x => x.id !== f.id);
      empujar({
        id: `nota:${f.id}:${claveTirada}`,
        tipo: 'nota',
        titulo: nota,
        detalle: [sesion ? sesion.etiqueta : (f.displayName || f.name), p ? `${MESES[p.mes - 1]} de ${p.anio}` : '']
          .filter(Boolean).join(' · '),
        total: grupo.length,
        fileIds: [f.id, ...resto.map(x => x.id)],
        thumbnails: [f.thumbnail, ...muestrasDe(resto, 'nota' + f.id, 7)].filter(Boolean),
      });
    }
  }

  // ── 4. Dos personas que van juntas ──────────────────────────────────────
  const parejas = Array.from(porPareja.values())
    .filter(p => p.files.length >= 5)
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, 12);
  if (parejas.length > 0) {
    const par = elegir(parejas, 'pareja');
    const na = porPersona.get(par.a)?.nombre || par.a;
    const nb = porPersona.get(par.b)?.nombre || par.b;
    const desde = partes(par.primera);
    empujar({
      id: `pareja:${par.a}|${par.b}:${claveTirada}`,
      tipo: 'pareja',
      titulo: `${na} y ${nb}`,
      detalle: `juntos en ${par.files.length} archivos${desde ? ` · desde ${desde.anio}` : ''}`,
      total: par.files.length,
      fileIds: par.files.map(f => f.id),
      thumbnails: muestrasDe(par.files, 'pareja' + par.a + par.b),
      extra: { personas: [{ id: par.a, nombre: na }, { id: par.b, nombre: nb }] },
    });
  }

  // ── 5. Este mes, otros años ─────────────────────────────────────────────
  const delMes = new Map<number, MediaFile[]>();
  for (const s of sesiones) {
    if (s.tecnica) continue;
    const p = partes(s.fecha);
    if (!p || p.mes !== mesHoy || p.anio >= anioHoy) continue;
    const arr = delMes.get(p.anio);
    if (arr) arr.push(...s.files); else delMes.set(p.anio, [...s.files]);
  }
  if (delMes.size >= 2) {
    const anios = Array.from(delMes.keys()).sort((a, b) => a - b);
    const todos = anios.flatMap(a => delMes.get(a)!);
    // Una miniatura por año como minimo: la tarjeta tiene que enseñar que son
    // septiembres distintos, no el mismo evento ocho veces.
    const porAnio = anios.map(a => muestrasDe(delMes.get(a)!, 'mes' + a, 2)).flat();
    empujar({
      id: `mes:${mesHoy}:${claveDia}`,
      tipo: 'mes',
      titulo: `Tus ${MESES[mesHoy - 1]}s`,
      detalle: `${anios.join(' · ')} — ${todos.length} archivos`,
      total: todos.length,
      fileIds: todos.map(f => f.id),
      thumbnails: porAnio.slice(0, 8),
    });
  }

  // ── 6. Una luz, un ambiente ─────────────────────────────────────────────
  // Lo que ha visto la IA, devuelto como tema: todas las luces doradas del
  // archivo juntas dicen algo que ninguna sesion dice sola.
  const TEMAS: Array<{ id: string; titulo: string; detalle: (n: number) => string; casa: (f: MediaFile) => boolean }> = [
    { id: 'luz_dorada', titulo: 'Luz dorada', detalle: n => `${n} momentos con esa luz`, casa: f => f.atmosphere?.lighting === 'luz_dorada' },
    { id: 'nocturna', titulo: 'De noche', detalle: n => `${n} archivos cuando ya no había sol`, casa: f => f.atmosphere?.lighting === 'nocturna' },
    { id: 'contraluz', titulo: 'A contraluz', detalle: n => `${n} siluetas`, casa: f => f.atmosphere?.lighting === 'contraluz' },
    { id: 'neon', titulo: 'Neón', detalle: n => `${n} archivos bajo luces de color`, casa: f => f.atmosphere?.lighting === 'neon' },
    { id: 'intimo', titulo: 'Lo íntimo', detalle: n => `${n} momentos de cerca`, casa: f => f.atmosphere?.mood === 'intimo' },
    { id: 'contemplativo', titulo: 'Momentos quietos', detalle: n => `${n} archivos sin prisa`, casa: f => f.atmosphere?.mood === 'contemplativo' },
    { id: 'melancolico', titulo: 'Melancolía', detalle: n => `${n} archivos con ese aire`, casa: f => f.atmosphere?.mood === 'melancolico' },
    { id: 'festivo', titulo: 'Días de fiesta', detalle: n => `${n} archivos de celebración`, casa: f => f.atmosphere?.mood === 'festivo' },
    { id: 'atardecer', titulo: 'Atardeceres', detalle: n => `${n} archivos al caer el sol`, casa: f => f.atmosphere?.time_of_day === 'atardecer' },
  ];
  const temas = TEMAS
    .map(t => ({ t, lista: files.filter(t.casa) }))
    .filter(x => x.lista.length >= 12);
  if (temas.length > 0) {
    const { t, lista } = elegir(temas, 'tema');
    empujar({
      id: `tema:${t.id}:${claveTirada}`,
      tipo: 'tema',
      titulo: t.titulo,
      detalle: t.detalle(lista.length),
      total: lista.length,
      fileIds: lista.map(f => f.id),
      thumbnails: muestrasDe(lista, 'tema' + t.id),
    });
  }

  // ── 7. Un color ─────────────────────────────────────────────────────────
  const FAMILIAS: Array<{ id: string; titulo: string; nombres: string[]; muestra: string }> = [
    { id: 'azul', titulo: 'El archivo en azul', nombres: ['azul', 'celeste', 'indigo', 'turquesa'], muestra: '#5b7fd6' },
    { id: 'rojo', titulo: 'El archivo en rojo', nombres: ['rojo', 'granate', 'magenta'], muestra: '#c8505a' },
    { id: 'verde', titulo: 'El archivo en verde', nombres: ['verde'], muestra: '#6fa37a' },
    { id: 'calido', titulo: 'Tonos cálidos', nombres: ['naranja', 'ocre', 'mostaza', 'amarillo', 'crema', 'beige'], muestra: '#e0a560' },
    { id: 'violeta', titulo: 'Violetas y rosas', nombres: ['lavanda', 'morado', 'rosa'], muestra: '#b89be0' },
  ];
  const colores = FAMILIAS.map(fam => {
    const lista: MediaFile[] = [];
    const hexes: string[] = [];
    for (const f of files) {
      const pal = (f as { colors?: { palette?: Array<{ hex?: string; name?: string }> } }).colors?.palette;
      if (!Array.isArray(pal)) continue;
      const hit = pal.slice(0, 3).find(c => c && typeof c.name === 'string' && fam.nombres.includes(c.name.split(' ')[0]));
      if (hit) {
        lista.push(f);
        if (hit.hex && hexes.length < 3 && !hexes.includes(hit.hex)) hexes.push(hit.hex);
      }
    }
    return { fam, lista, hexes };
  }).filter(x => x.lista.length >= 12);
  if (colores.length > 0) {
    const { fam, lista, hexes } = elegir(colores, 'color');
    empujar({
      id: `color:${fam.id}:${claveTirada}`,
      tipo: 'color',
      titulo: fam.titulo,
      detalle: `${lista.length} archivos`,
      total: lista.length,
      fileIds: lista.map(f => f.id),
      thumbnails: muestrasDe(lista, 'color' + fam.id),
      extra: { colores: hexes.length > 0 ? hexes : [fam.muestra] },
    });
  }

  // ── 8. Un rincon del archivo ────────────────────────────────────────────
  // Garantiza que SIEMPRE haya algo que enseñar. Se elige entre las sesiones
  // con peso, descartando lo mas reciente (eso ya lo tienes visto).
  const conPeso = sesiones
    .filter(s => s.files.length >= 8 && s.fecha > 0
      // Solo eventos con nombre propio: un volcado de movil ("- Movil / 4")
      // como recuerdo no dice nada.
      && !!s.evento && CARPETA_FECHADA.test(s.evento) && !s.tecnica)
    .sort((a, b) => a.fecha - b.fecha);
  if (conPeso.length > 0) {
    const antiguas = conPeso.slice(0, Math.max(1, Math.floor(conPeso.length * 0.75)));
    const elegida = elegir(antiguas, 'rincon');
    const p = partes(elegida.fecha);
    empujar({
      id: `rincon:${elegida.key}:${claveTirada}`,
      tipo: 'rincon',
      titulo: 'Un rincón del archivo',
      detalle: p ? `${elegida.etiqueta} · ${MESES[p.mes - 1]} de ${p.anio}` : elegida.etiqueta,
      total: elegida.files.length,
      fileIds: elegida.files.map(f => f.id),
      thumbnails: muestrasDe(elegida.files, 'rincon' + elegida.key),
    });
  }

  return ecos.slice(0, maximo);
}
