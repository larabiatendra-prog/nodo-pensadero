import { useEffect, useMemo, useState } from 'react';
import {
  Network, BarChart3, AlertTriangle, ArrowRight, X, Film, Image as ImageIcon, Music,
} from 'lucide-react';
import { api } from '../services/api';
import GraphView from './GraphView';
import ProxiesPanel from './ProxiesPanel';
import Avatar from './Avatar';
import { MediaFile } from '../types';
import { getFileSortDate } from '../utils/filenameParser';

/**
 * Estadisticas del archivo.
 *
 * No es una rejilla de tarjetas: es UNA pantalla con jerarquia. A la izquierda,
 * fija, la cifra que manda y el estado del sistema; a la derecha, el mapa de
 * doce años mes a mes, que es lo unico que merece ocupar el centro. Lo demas
 * —de que esta hecho, quien sale, de que color es— baja de tamaño en ese orden.
 *
 * Y sobre todo: TODO filtra TODO. Pulsar un mes, un año, un tipo, una persona o
 * una biblioteca no te saca de aqui, reescribe la pagina entera con ese recorte.
 * Pasar el raton por un mes adelanta sus cifras en la columna izquierda sin
 * comprometerse. Para irse a la galeria hay un boton explicito.
 *
 * Todo se calcula sobre `files`, que ya esta en memoria: filtrar 28.000 fichas
 * son dos milisegundos, asi que no hace falta pedirle nada al servidor para
 * cambiar de recorte.
 */

interface PersonaAgregada {
  person_id: string;
  display_name: string;
  count: number;
  avatar_url: string | null;
}

interface RutaBiblioteca {
  id: string;
  path: string;
  displayName: string;
  fileCount: number;
  visualTotal?: number;
  visualScanned?: number;
}

interface StatisticsProps {
  files: MediaFile[];
  onTagClick?: (tag: string) => void;
  onTypeClick?: (type: 'image' | 'video' | 'audio') => void;
  onYearClick?: (year: string) => void;
  onPersonClick?: (personId: string) => void;
  onColorClick?: (hex: string) => void;
  onMonthClick?: (year: number, month: number) => void;
}

type Tipo = 'video' | 'image' | 'audio';

interface Seleccion {
  anyo: number | null;
  mes: number | null;
  tipo: Tipo | null;
  persona: string | null;
  biblioteca: string | null;
}

const VACIA: Seleccion = { anyo: null, mes: null, tipo: null, persona: null, biblioteca: null };

const COLOR: Record<Tipo, string> = {
  video: '#C8B6FF',   // lavanda
  image: '#F2B8A0',   // melocoton
  audio: '#9CB7A5',   // salvia
};
const NOMBRE_TIPO: Record<Tipo, string> = { video: 'vídeo', image: 'imagen', audio: 'audio' };

const MESES = ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const TAB_KEY = 'pensadero.stats.tab';

const numero = (n: number) => n.toLocaleString('es-ES');

function tamaño(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(i >= 3 ? 2 : 0))} ${u[i]}`;
}

function duracion(seg: number): string {
  if (!seg || seg <= 0) return '—';
  let h = Math.floor(seg / 3600);
  let m = Math.round((seg % 3600) / 60);
  if (m === 60) { h++; m = 0; } // redondear 59,7 min no puede dar "22 h 60 min"
  if (h > 0) return m > 0 ? `${numero(h)} h ${m} min` : `${numero(h)} h`;
  return `${m} min`;
}

export default function Statistics({
  files, onTagClick, onTypeClick, onYearClick, onPersonClick, onColorClick, onMonthClick,
}: StatisticsProps) {
  const [personas, setPersonas] = useState<PersonaAgregada[]>([]);
  const [rutas, setRutas] = useState<RutaBiblioteca[]>([]);
  const [salud, setSalud] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'stats' | 'graph'>(() => {
    try { return localStorage.getItem(TAB_KEY) === 'graph' ? 'graph' : 'stats'; } catch { return 'stats'; }
  });
  const [sel, setSel] = useState<Seleccion>(VACIA);
  /** Mes bajo el raton: adelanta sus cifras sin comprometer la seleccion. */
  const [asomado, setAsomado] = useState<{ anyo: number; mes: number } | null>(null);

  useEffect(() => { try { localStorage.setItem(TAB_KEY, activeTab); } catch { /* modo privado */ } }, [activeTab]);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      const [r1, r2, r3] = await Promise.allSettled([
        api.getPersons(), api.getScanPaths(), api.getHealth(),
      ]);
      if (cancelado) return;
      if (r1.status === 'fulfilled' && r1.value.success && Array.isArray(r1.value.data)) {
        setPersonas(r1.value.data as PersonaAgregada[]);
      }
      if (r2.status === 'fulfilled' && r2.value.success && Array.isArray(r2.value.data)) {
        setRutas(r2.value.data as RutaBiblioteca[]);
      }
      if (r3.status === 'fulfilled' && r3.value.success) setSalud(r3.value.data);
    })();
    return () => { cancelado = true; };
  }, []);

  /**
   * Un solo recorrido por el catalogo. A partir de aqui todo son cuentas sobre
   * arrays planos, que es lo que permite refiltrar en cada clic sin parpadeos.
   * La fecha sale del nombre o de la carpeta (getFileSortDate, que devuelve
   * YYYYMMDD), no del mtime del disco: eso es cuando se copio, no cuando se
   * grabo.
   */
  const indice = useMemo(() => {
    const n = files.length;
    const anyos = new Int16Array(n);
    const meses = new Int8Array(n);
    const tipos = new Uint8Array(n);       // 0 video · 1 imagen · 2 audio
    const bytes = new Float64Array(n);
    const duraciones = new Float32Array(n);
    const bibliotecas: string[] = new Array(n);
    const gente: string[][] = new Array(n);
    const tonos: string[][] = new Array(n);
    const etiquetas: string[][] = new Array(n);
    const anyosVistos = new Set<number>();

    for (let i = 0; i < n; i++) {
      const f = files[i];
      const aaaammdd = getFileSortDate(f as any);
      const a = aaaammdd ? Math.floor(aaaammdd / 10000) : 0;
      const m = aaaammdd ? Math.floor((aaaammdd % 10000) / 100) - 1 : -1;
      const valida = a >= 1900 && a <= 2100 && m >= 0 && m <= 11;
      anyos[i] = valida ? a : 0;
      meses[i] = valida ? m : -1;
      if (valida) anyosVistos.add(a);
      tipos[i] = f.type === 'video' ? 0 : f.type === 'audio' ? 2 : 1;
      bytes[i] = f.size || 0;
      duraciones[i] = f.duration || 0;
      bibliotecas[i] = (f as unknown as { libraryId?: string }).libraryId || '';
      const ids: string[] = [];
      for (const c of (f.faces || [])) if (c.person_id && !ids.includes(c.person_id)) ids.push(c.person_id);
      gente[i] = ids;
      const pal = (f as unknown as { colors?: { palette?: Array<{ hex?: string }> } }).colors?.palette;
      tonos[i] = Array.isArray(pal) ? pal.map(p => (p.hex || '').toLowerCase()).filter(Boolean) : [];
      etiquetas[i] = Array.isArray(f.tags) ? f.tags : [];
    }
    const listaAnyos = [...anyosVistos].sort((a, b) => a - b);
    return { n, anyos, meses, tipos, bytes, duraciones, bibliotecas, gente, tonos, etiquetas, listaAnyos };
  }, [files]);

  /** Indices que sobreviven al recorte activo. */
  const filtrados = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < indice.n; i++) {
      if (sel.anyo !== null && indice.anyos[i] !== sel.anyo) continue;
      if (sel.mes !== null && indice.meses[i] !== sel.mes) continue;
      if (sel.tipo !== null && indice.tipos[i] !== (sel.tipo === 'video' ? 0 : sel.tipo === 'audio' ? 2 : 1)) continue;
      if (sel.biblioteca !== null && indice.bibliotecas[i] !== sel.biblioteca) continue;
      if (sel.persona !== null && !indice.gente[i].includes(sel.persona)) continue;
      out.push(i);
    }
    return out;
  }, [indice, sel]);

  /** Cuentas del recorte: lo que pinta la columna izquierda y el mapa. */
  const resumen = useMemo(() => {
    let bytesTotal = 0, segundos = 0;
    const porTipo = [0, 0, 0];
    const bytesTipo = [0, 0, 0];
    const matriz = new Map<number, number[]>();     // año -> 12 meses
    const totalAnyo = new Map<number, number>();
    const gente = new Map<string, number>();
    const tonos = new Map<string, number>();
    const etiquetas = new Map<string, number>();
    let maxMes = 0, maxAnyo = 0, primero = 0, ultimo = 0;

    for (const i of filtrados) {
      bytesTotal += indice.bytes[i];
      segundos += indice.duraciones[i];
      porTipo[indice.tipos[i]]++;
      bytesTipo[indice.tipos[i]] += indice.bytes[i];
      const a = indice.anyos[i];
      const m = indice.meses[i];
      if (a) {
        if (!primero || a < primero) primero = a;
        if (a > ultimo) ultimo = a;
        const t = (totalAnyo.get(a) || 0) + 1;
        totalAnyo.set(a, t);
        if (t > maxAnyo) maxAnyo = t;
        if (m >= 0) {
          let fila = matriz.get(a);
          if (!fila) { fila = new Array(12).fill(0); matriz.set(a, fila); }
          fila[m]++;
          if (fila[m] > maxMes) maxMes = fila[m];
        }
      }
      for (const p of indice.gente[i]) gente.set(p, (gente.get(p) || 0) + 1);
      for (const h of indice.tonos[i]) tonos.set(h, (tonos.get(h) || 0) + 1);
      for (const t of indice.etiquetas[i]) etiquetas.set(t, (etiquetas.get(t) || 0) + 1);
    }

    return {
      archivos: filtrados.length,
      bytes: bytesTotal,
      segundos,
      porTipo,
      bytesTipo,
      matriz,
      totalAnyo,
      maxMes,
      maxAnyo,
      primero,
      ultimo,
      gente: [...gente.entries()].sort((a, b) => b[1] - a[1]),
      tonos: [...tonos.entries()].sort((a, b) => b[1] - a[1]),
      etiquetas: [...etiquetas.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [filtrados, indice]);

  /** Cifras del mes bajo el raton (o las del recorte, si no hay ninguno). */
  const adelanto = useMemo(() => {
    if (!asomado) return null;
    let archivos = 0, bytes = 0, segundos = 0;
    for (const i of filtrados) {
      if (indice.anyos[i] !== asomado.anyo || indice.meses[i] !== asomado.mes) continue;
      archivos++;
      bytes += indice.bytes[i];
      segundos += indice.duraciones[i];
    }
    return { archivos, bytes, segundos };
  }, [asomado, filtrados, indice]);

  const nombrePersona = useMemo(() => {
    const m = new Map<string, PersonaAgregada>();
    for (const p of personas) m.set(p.person_id, p);
    return m;
  }, [personas]);

  const accesible = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const r of (salud?.checks?.bibliotecas?.rutas || [])) m.set(r.path, !!r.accesible);
    return m;
  }, [salud]);

  const escaneo = salud?.checks?.escaneo as { total: number; descritos: number; pendientes: number } | undefined;
  const caidas = rutas.filter(r => accesible.get(r.path) === false);
  const hayRecorte = sel.anyo !== null || sel.mes !== null || sel.tipo !== null || sel.persona !== null || sel.biblioteca !== null;

  // Alternar: pulsar lo ya elegido lo suelta.
  const alternar = <K extends keyof Seleccion>(clave: K, valor: Seleccion[K]) =>
    setSel(prev => ({ ...prev, [clave]: prev[clave] === valor ? null : valor }));

  const irALaGaleria = () => {
    if (sel.anyo !== null && sel.mes !== null) onMonthClick?.(sel.anyo, sel.mes);
    else if (sel.anyo !== null) onYearClick?.(String(sel.anyo));
    else if (sel.persona !== null) onPersonClick?.(sel.persona);
    else if (sel.tipo !== null) onTypeClick?.(sel.tipo);
  };

  const cifras = adelanto || resumen;

  return (
    <div>
      {/* ── Cabecera ───────────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between flex-wrap gap-4 mb-10">
        <div>
          <h1 className="text-[1.7rem] font-bold text-marfil leading-none">Estadísticas del archivo</h1>
          <p className="mt-2 text-sm text-niebla">
            Pulsa cualquier cosa para recortar el archivo. Todo lo demás se recalcula.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-full bg-grafito/70 p-1">
          {([['stats', 'Estadísticas', <BarChart3 key="a" className="w-4 h-4" />],
            ['graph', 'Vista de grafo', <Network key="b" className="w-4 h-4" />]] as const).map(([id, txt, ic]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id as 'stats' | 'graph')}
              className={`inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium transition-colors ${
                activeTab === id ? 'bg-lavanda text-noche' : 'text-niebla hover:text-marfil'
              }`}
            >
              {ic} {txt}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'graph' && (
        <GraphView files={files} onTagClick={onTagClick} onPersonClick={onPersonClick} />
      )}

      {activeTab === 'stats' && (
        <div className="lg:grid lg:grid-cols-[250px_1fr] lg:gap-14">
          {/* ═══ Columna fija: la cifra que manda y el estado ═══════════════ */}
          <aside className="lg:sticky lg:top-2 lg:self-start mb-10 lg:mb-0">
            <p className="font-mono text-[10px] tracking-wider uppercase text-humo">
              {asomado
                ? `${MESES_LARGOS[asomado.mes]} de ${asomado.anyo}`
                : hayRecorte ? 'en este recorte' : 'todo el archivo'}
            </p>
            <p className={`mt-1.5 text-[54px] leading-[0.95] font-bold tabular-nums transition-colors ${asomado ? 'text-lavanda' : 'text-marfil'}`}>
              {numero(cifras.archivos)}
            </p>
            <p className="mt-1 text-sm text-niebla">
              {cifras.archivos === 1 ? 'archivo' : 'archivos'}
            </p>

            <dl className="mt-6 flex flex-col gap-2.5">
              <Dato termino="metraje" valor={duracion(cifras.segundos)} />
              <Dato termino="en disco" valor={tamaño(cifras.bytes)} />
              <Dato
                termino="años"
                valor={resumen.primero ? (resumen.primero === resumen.ultimo ? String(resumen.primero) : `${resumen.primero} – ${resumen.ultimo}`) : '—'}
              />
              <Dato termino="personas" valor={numero(resumen.gente.length)} />
            </dl>

            {/* Recorte activo */}
            {hayRecorte && (
              <div className="mt-7 pt-5 border-t border-borde-sutil">
                <p className="font-mono text-[10px] tracking-wider uppercase text-humo mb-2.5">Recorte</p>
                <div className="flex flex-wrap gap-1.5">
                  {sel.anyo !== null && (
                    <Chip texto={String(sel.anyo)} onQuitar={() => setSel(p => ({ ...p, anyo: null, mes: null }))} />
                  )}
                  {sel.mes !== null && (
                    <Chip texto={MESES_LARGOS[sel.mes]} onQuitar={() => setSel(p => ({ ...p, mes: null }))} />
                  )}
                  {sel.tipo !== null && (
                    <Chip texto={NOMBRE_TIPO[sel.tipo]} color={COLOR[sel.tipo]} onQuitar={() => setSel(p => ({ ...p, tipo: null }))} />
                  )}
                  {sel.persona !== null && (
                    <Chip
                      texto={nombrePersona.get(sel.persona)?.display_name || sel.persona}
                      onQuitar={() => setSel(p => ({ ...p, persona: null }))}
                    />
                  )}
                  {sel.biblioteca !== null && (
                    <Chip
                      texto={rutas.find(r => r.id === sel.biblioteca)?.displayName || 'biblioteca'}
                      onQuitar={() => setSel(p => ({ ...p, biblioteca: null }))}
                    />
                  )}
                </div>
                <div className="mt-3 flex flex-col gap-1.5 items-start">
                  <button onClick={() => setSel(VACIA)} className="text-[12px] text-humo hover:text-niebla transition-colors">
                    Quitar el recorte
                  </button>
                  {(onMonthClick || onYearClick || onPersonClick || onTypeClick) && (
                    <button
                      onClick={irALaGaleria}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-lavanda hover:text-lavanda-claro transition-colors"
                    >
                      Verlo en la galería <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Estado del sistema: discreto, pero con voz propia si algo falla */}
            <div className="mt-7 pt-5 border-t border-borde-sutil">
              <p className="font-mono text-[10px] tracking-wider uppercase text-humo mb-3">El sistema</p>

              {escaneo && (
                <div className="mb-4">
                  <div className="flex items-baseline justify-between mb-1.5">
                    <span className="text-[12px] text-niebla">descrito por la IA</span>
                    <span className="font-mono text-[12px] text-marfil tabular-nums">
                      {Math.round((escaneo.descritos / Math.max(1, escaneo.total)) * 100)}%
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-pizarra overflow-hidden">
                    <div className="h-full rounded-full bg-lavanda" style={{ width: `${(escaneo.descritos / Math.max(1, escaneo.total)) * 100}%` }} />
                  </div>
                  {escaneo.pendientes > 0 && (
                    <p className="mt-1.5 text-[11px] text-humo">{numero(escaneo.pendientes)} sin describir</p>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-2">
                {rutas.map(r => {
                  const viva = accesible.get(r.path) !== false;
                  const activa = sel.biblioteca === r.id;
                  return (
                    <button
                      key={r.id}
                      onClick={() => alternar('biblioteca', r.id)}
                      title={`${r.path} — ${viva ? 'responde' : 'no responde'}`}
                      className={`flex items-center gap-2 text-left transition-colors ${activa ? 'text-lavanda' : 'text-niebla hover:text-marfil'}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${viva ? 'bg-estado-exito' : 'bg-melocoton'}`} />
                      <span className="text-[12px] truncate flex-1">{r.displayName || r.path}</span>
                      <span className="font-mono text-[10px] text-humo tabular-nums">{numero(r.fileCount || 0)}</span>
                    </button>
                  );
                })}
              </div>

              {caidas.length > 0 && (
                <p className="mt-3 flex items-start gap-1.5 text-[11px] text-melocoton leading-snug">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span>
                    {caidas.map(r => r.displayName || r.path).join(', ')} no responde: sus archivos cuentan
                    aquí pero no se pueden abrir.
                  </span>
                </p>
              )}
            </div>
          </aside>

          {/* ═══ El mapa y lo demás ════════════════════════════════════════ */}
          <main className="min-w-0">
            {/* ── Mapa: años x meses ──────────────────────────────────────── */}
            <section onMouseLeave={() => setAsomado(null)}>
              <div className="flex items-baseline justify-between gap-4 mb-4 flex-wrap">
                <h2 className="text-[15px] font-semibold text-marfil">Doce años, mes a mes</h2>
                <span className="text-[11px] text-humo">
                  pasa el ratón para ver un mes · pulsa para recortar
                </span>
              </div>

              <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full border-separate" style={{ borderSpacing: '3px 4px' }}>
                  <thead>
                    <tr>
                      <th className="w-[38px]" />
                      {MESES.map((m, i) => (
                        <th key={i} className="font-mono text-[9px] font-normal text-humo">{m}</th>
                      ))}
                      <th className="w-[34%]" />
                    </tr>
                  </thead>
                  <tbody>
                    {[...indice.listaAnyos].reverse().map(anyo => {
                      const fila = resumen.matriz.get(anyo);
                      const total = resumen.totalAnyo.get(anyo) || 0;
                      const anyoActivo = sel.anyo === anyo;
                      return (
                        <tr key={anyo}>
                          <td>
                            <button
                              onClick={() => alternar('anyo', anyo)}
                              className={`font-mono text-[11px] tabular-nums transition-colors ${
                                anyoActivo ? 'text-lavanda font-semibold' : total > 0 ? 'text-niebla hover:text-marfil' : 'text-humo/50'
                              }`}
                            >
                              {anyo}
                            </button>
                          </td>
                          {Array.from({ length: 12 }).map((_, m) => {
                            const n = fila ? fila[m] : 0;
                            const t = n > 0 ? Math.pow(n / Math.max(1, resumen.maxMes), 0.45) : 0;
                            const elegido = sel.anyo === anyo && sel.mes === m;
                            return (
                              <td key={m}>
                                <button
                                  onMouseEnter={() => n > 0 && setAsomado({ anyo, mes: m })}
                                  onClick={() => n > 0 && setSel(p => ({
                                    ...p,
                                    anyo: p.anyo === anyo && p.mes === m ? null : anyo,
                                    mes: p.anyo === anyo && p.mes === m ? null : m,
                                  }))}
                                  disabled={n === 0}
                                  title={n > 0 ? `${MESES_LARGOS[m]} de ${anyo}: ${numero(n)}` : ''}
                                  className={`block w-full h-[19px] rounded-[4px] transition-all ${
                                    n > 0 ? 'hover:scale-y-125 cursor-pointer' : 'cursor-default'
                                  }`}
                                  style={{
                                    background: n > 0 ? `rgba(200,182,255,${(0.12 + t * 0.85).toFixed(3)})` : 'rgba(37,42,66,0.42)',
                                    outline: elegido ? '1.5px solid #C8B6FF' : undefined,
                                    outlineOffset: elegido ? '1.5px' : undefined,
                                  }}
                                />
                              </td>
                            );
                          })}
                          <td>
                            <span className="flex items-center gap-2 pl-2">
                              <span className="flex-1 h-[5px] rounded-full bg-pizarra/70 overflow-hidden min-w-[30px]">
                                <span
                                  className={`block h-full rounded-full transition-all ${anyoActivo ? 'bg-lavanda' : 'bg-lavanda/45'}`}
                                  style={{ width: `${(total / Math.max(1, resumen.maxAnyo)) * 100}%` }}
                                />
                              </span>
                              <span className={`font-mono text-[10px] tabular-nums w-[46px] text-right ${total > 0 ? 'text-humo' : 'text-humo/40'}`}>
                                {total > 0 ? numero(total) : '·'}
                              </span>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ── De qué está hecho ───────────────────────────────────────── */}
            <section className="mt-12 pt-8 border-t border-borde-sutil">
              <div className="flex items-baseline justify-between gap-4 mb-5 flex-wrap">
                <h2 className="text-[15px] font-semibold text-marfil">De qué está hecho</h2>
                <span className="text-[11px] text-humo">el vídeo es el 71% de los archivos y el 99% del disco</span>
              </div>

              <div className="flex h-1.5 rounded-full overflow-hidden bg-pizarra mb-5">
                {(['video', 'image', 'audio'] as Tipo[]).map((t, i) => (
                  <span
                    key={t}
                    style={{
                      width: `${(resumen.porTipo[i] / Math.max(1, resumen.archivos)) * 100}%`,
                      background: COLOR[t],
                      opacity: sel.tipo && sel.tipo !== t ? 0.25 : 1,
                      transition: 'opacity .2s',
                    }}
                  />
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                {(['video', 'image', 'audio'] as Tipo[]).map((t, i) => {
                  const n = resumen.porTipo[i];
                  const activo = sel.tipo === t;
                  const Icono = t === 'video' ? Film : t === 'image' ? ImageIcon : Music;
                  return (
                    <button
                      key={t}
                      onClick={() => alternar('tipo', t)}
                      disabled={n === 0}
                      className={`text-left transition-opacity ${sel.tipo && !activo ? 'opacity-45' : ''} ${n === 0 ? 'opacity-30' : ''}`}
                    >
                      <span className="flex items-center gap-2 mb-1.5" style={{ color: COLOR[t] }}>
                        <Icono className="w-3.5 h-3.5" />
                        <span className="font-mono text-[10px] tracking-wider uppercase text-humo">{NOMBRE_TIPO[t]}</span>
                      </span>
                      <span className={`block text-[26px] leading-none font-bold tabular-nums ${activo ? 'text-lavanda' : 'text-marfil'}`}>
                        {numero(n)}
                      </span>
                      <span className="mt-1.5 block text-[11px] text-humo">
                        {tamaño(resumen.bytesTipo[i])}
                        {n > 0 && ` · ${tamaño(resumen.bytesTipo[i] / n)} de media`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* ── Vídeos preparados (proxies) ─────────────────────────────── */}
            <ProxiesPanel />

            {/* ── Quién sale ──────────────────────────────────────────────── */}
            {resumen.gente.length > 0 && (
              <section className="mt-12 pt-8 border-t border-borde-sutil">
                <div className="flex items-baseline justify-between gap-4 mb-5 flex-wrap">
                  <h2 className="text-[15px] font-semibold text-marfil">Quién sale</h2>
                  <span className="text-[11px] text-humo">
                    {numero(resumen.gente.length)} {resumen.gente.length === 1 ? 'persona' : 'personas'}
                    {hayRecorte ? ' en este recorte' : ''}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-4">
                  {resumen.gente.slice(0, 14).map(([id, n]) => {
                    const p = nombrePersona.get(id);
                    const activo = sel.persona === id;
                    const tope = resumen.gente[0][1] || 1;
                    return (
                      <button
                        key={id}
                        onClick={() => alternar('persona', id)}
                        className={`flex items-center gap-2.5 transition-opacity ${sel.persona && !activo ? 'opacity-40' : ''}`}
                        title={`${p?.display_name || id}: ${numero(n)} archivos`}
                      >
                        <span className={`w-10 h-10 rounded-full overflow-hidden bg-pizarra flex items-center justify-center transition-shadow ${
                          activo ? 'ring-2 ring-lavanda' : ''
                        }`}>
                          <Avatar url={p?.avatar_url || null} name={p?.display_name || id} iconClassName="w-4 h-4" />
                        </span>
                        <span className="text-left">
                          <span className={`block text-[13px] font-medium ${activo ? 'text-lavanda' : 'text-marfil'}`}>
                            {p?.display_name || id}
                          </span>
                          <span className="block font-mono text-[10px] text-humo tabular-nums">{numero(n)}</span>
                          <span className="mt-1 block w-14 h-[2px] rounded-full bg-pizarra overflow-hidden">
                            <span className="block h-full rounded-full bg-lavanda/60" style={{ width: `${(n / tope) * 100}%` }} />
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── El color ────────────────────────────────────────────────── */}
            {resumen.tonos.length > 0 && (
              <section className="mt-12 pt-8 border-t border-borde-sutil">
                <div className="flex items-baseline justify-between gap-4 mb-5 flex-wrap">
                  <h2 className="text-[15px] font-semibold text-marfil">De qué color es</h2>
                  <span className="text-[11px] text-humo">
                    {onColorClick ? 'pulsa un tono para buscar ese color en la galería' : 'tonos dominantes'}
                  </span>
                </div>
                <div className="flex h-16 rounded-lg overflow-hidden">
                  {(() => {
                    const top = resumen.tonos.slice(0, 26);
                    const suma = top.reduce((s, x) => s + x[1], 0) || 1;
                    return top.map(([hex, n]) => (
                      <button
                        key={hex}
                        onClick={() => onColorClick?.(hex)}
                        disabled={!onColorClick}
                        title={`${hex} · ${numero(n)} archivos`}
                        className="h-full transition-transform hover:scale-y-110 hover:z-10"
                        style={{
                          backgroundColor: hex,
                          width: `${Math.max(1.2, (n / suma) * 100)}%`,
                          cursor: onColorClick ? 'pointer' : 'default',
                        }}
                      />
                    ));
                  })()}
                </div>
              </section>
            )}

            {/* ── Lo que ve la IA ─────────────────────────────────────────── */}
            {resumen.etiquetas.length > 0 && (
              <section className="mt-12 pt-8 border-t border-borde-sutil pb-4">
                <div className="flex items-baseline justify-between gap-4 mb-5 flex-wrap">
                  <h2 className="text-[15px] font-semibold text-marfil">Lo que ve la IA</h2>
                  <span className="text-[11px] text-humo">descriptores del modelo, no etiquetas tuyas</span>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-2.5">
                  {resumen.etiquetas.slice(0, 22).map(([tag, n]) => (
                    <button
                      key={tag}
                      onClick={() => onTagClick?.(tag)}
                      disabled={!onTagClick}
                      className="group flex items-baseline gap-1.5"
                      title={`${numero(n)} archivos`}
                    >
                      <span className="text-[13px] text-niebla group-hover:text-lavanda transition-colors">{tag}</span>
                      <span className="font-mono text-[10px] text-humo tabular-nums">{numero(n)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

/** Una linea de la ficha izquierda: termino a la izquierda, valor a la derecha. */
function Dato({ termino, valor }: { termino: string; valor: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-humo">{termino}</dt>
      <dd className="font-mono text-[12px] text-marfil tabular-nums text-right">{valor}</dd>
    </div>
  );
}

/** Etiqueta de un recorte activo, con su aspa. */
function Chip({ texto, color, onQuitar }: { texto: string; color?: string; onQuitar: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 h-6 pl-2.5 pr-1.5 rounded-full text-[11px] font-medium bg-lavanda/15 text-lavanda"
      style={color ? { background: `${color}22`, color } : undefined}
    >
      {texto}
      <button onClick={onQuitar} className="opacity-70 hover:opacity-100" title="Quitar">
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}
