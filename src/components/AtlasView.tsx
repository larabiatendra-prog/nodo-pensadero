import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import {
  Sparkles, Shuffle, Route, X, ArrowRight, Users, MapPin, Compass, Star, Anchor, Waypoints,
} from 'lucide-react';
import { MediaFile, Person } from '../types';
import { api } from '../services/api';
import config from '../config';
import {
  shortestPath, deriva,
  AtlasGraph, AtlasEdge, Recuerdo, PathHop,
  CenterNode, BridgePerson, AnchorPlace, Island,
} from '../utils/atlasGraph';
import AtlasWorker from '../workers/atlasWorker?worker';
import Loader from './Loader';

interface AtlasViewProps {
  files: MediaFile[];
  onOpenDay?: (date: Date) => void;
  onPersonClick?: (personId: string) => void;
  onTagClick?: (tag: string) => void;
}

type Lens = 'explorar' | 'centros' | 'puentes' | 'islas';

// Paleta literal (D3 pinta SVG). Mapea a tokens noche/lavanda.
const PAL = {
  noche: '#0F111A',
  link: 'rgba(184,179,201,0.22)',
  linkHi: '#C8B6FF',
  ringDim: 'rgba(184,179,201,0.25)',
  marfil: '#F5F1FF',
  lavanda: '#C8B6FF',
  amber: '#E6C177',
  label: '#F5F1FF',
};
// Colores rotatorios para "mundos" (componentes) en modo Explorar
const COMPONENT_COLORS = ['#C8B6FF', '#F2B8A0', '#9CB7A5', '#8EA4FF', '#DACDFF', '#E6C177', '#E58B9B'];

const RENDER_CAP = 180; // nº maximo de recuerdos dibujados (las metricas usan el grafo completo)
const TAU = Math.PI * 2;

interface AtlasMetrics {
  componentCount: number;
  compById: Map<string, number>;
  centers: CenterNode[];
  bridges: BridgePerson[];
  anchors: AnchorPlace[];
  islandList: Island[];
}

const EMPTY_GRAPH: AtlasGraph = { recuerdos: [], edges: [], byKey: new Map(), adjacency: new Map(), looseCount: 0, fileCount: 0 };
const EMPTY_METRICS: AtlasMetrics = { componentCount: 0, compById: new Map(), centers: [], bridges: [], anchors: [], islandList: [] };

// Reensambla el AtlasGraph (Maps) desde el payload serializable del worker.
function assembleGraph(p: any): AtlasGraph {
  const recuerdos: Recuerdo[] = p.recuerdos || [];
  const edges: AtlasEdge[] = p.edges || [];
  const byKey = new Map<string, Recuerdo>(recuerdos.map(r => [r.key, r]));
  const adjacency = new Map<string, { other: string; edge: AtlasEdge }[]>();
  for (const r of recuerdos) adjacency.set(r.key, []);
  for (const e of edges) {
    adjacency.get(e.a)?.push({ other: e.b, edge: e });
    adjacency.get(e.b)?.push({ other: e.a, edge: e });
  }
  return { recuerdos, edges, byKey, adjacency, looseCount: p.looseCount || 0, fileCount: p.fileCount || 0 };
}

export default function AtlasView({ files, onOpenDay, onPersonClick, onTagClick }: AtlasViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 640 });

  const [noteKeys, setNoteKeys] = useState<Set<string>>(new Set());
  const [persons, setPersons] = useState<Person[]>([]);

  const [lens, setLens] = useState<Lens>('explorar');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusPerson, setFocusPerson] = useState<string | null>(null);
  const [caminoMode, setCaminoMode] = useState(false);
  const [pathA, setPathA] = useState<string | null>(null);
  const [pathB, setPathB] = useState<string | null>(null);
  const [derivaWalk, setDerivaWalk] = useState<PathHop[] | null>(null);

  // ── refs para el render imperativo en canvas ───────────────────────────────
  // El canvas se redibuja leyendo estos refs (sin re-render de React). draw vive
  // dentro del efecto [renderSet, dimensions]; los refs le dan estado fresco.
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const scheduleRef = useRef<() => void>(() => {});
  const styleRef = useRef<{ selectedKey: string | null; highlightKeys: Set<string> | null; lens: Lens; compById: Map<string, number> }>(
    { selectedKey: null, highlightKeys: null, lens: 'explorar', compById: new Map() }
  );
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  // ref al ultimo handleNodeClick: el handler D3 se enlaza una vez (efecto con
  // deps [renderSet, dimensions]) pero debe ver el estado actual (camino/etc).
  const clickRef = useRef<(key: string) => void>(() => {});

  useEffect(() => {
    const update = () => {
      const c = canvasRef.current?.parentElement;
      if (c) setDimensions({ width: c.clientWidth, height: Math.min(c.clientHeight || 640, 640) });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getNotes()
      .then(r => { if (!cancelled && r.success && r.data?.sessions) setNoteKeys(new Set(Object.keys(r.data.sessions))); })
      .catch(() => {});
    api.getPersons()
      .then(r => { if (!cancelled && r.success && Array.isArray(r.data)) setPersons(r.data as Person[]); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const personsMap = useMemo(() => new Map(persons.map(p => [p.person_id, p])), [persons]);
  const personName = (id: string) => personsMap.get(id)?.display_name || id;

  // ── grafo + metricas: calculados en un Web Worker (no congelan la UI) ───────
  const workerRef = useRef<Worker | null>(null);
  const [result, setResult] = useState<{ graph: AtlasGraph; metrics: AtlasMetrics } | null>(null);
  const [computing, setComputing] = useState(true);

  useEffect(() => {
    const w = new AtlasWorker();
    workerRef.current = w;
    w.onmessage = (e: MessageEvent) => {
      const p = e.data;
      setResult({ graph: assembleGraph(p), metrics: { ...p.metrics, compById: new Map(p.metrics.compById) } });
      setComputing(false);
    };
    return () => { w.terminate(); };
  }, []);

  useEffect(() => {
    const w = workerRef.current;
    if (!w) return;
    setComputing(true);
    // Proyeccion ligera: solo los campos que el motor necesita (payload pequeño).
    const lite = files.map(f => ({
      id: f.id,
      name: f.name,
      thumbnail: f.thumbnail,
      tags: f.tags,
      faces: (f.faces || []).map(fc => ({ person_id: fc.person_id })),
      spaces: (f as unknown as { spaces?: unknown }).spaces,
    }));
    w.postMessage({ files: lite });
  }, [files]);

  const graph = result?.graph ?? EMPTY_GRAPH;
  const metrics = result?.metrics ?? EMPTY_METRICS;

  // Grado ponderado para decidir qué se dibuja (cap de render)
  const renderSet = useMemo(() => {
    const wdeg = new Map<string, number>();
    for (const r of graph.recuerdos) wdeg.set(r.key, 0);
    for (const e of graph.edges) {
      wdeg.set(e.a, (wdeg.get(e.a) || 0) + e.weight);
      wdeg.set(e.b, (wdeg.get(e.b) || 0) + e.weight);
    }
    const kept = [...graph.recuerdos]
      .sort((a, b) => (wdeg.get(b.key)! - wdeg.get(a.key)!) || (b.size - a.size))
      .slice(0, RENDER_CAP);
    const keptKeys = new Set(kept.map(r => r.key));
    const keptEdges = graph.edges.filter(e => keptKeys.has(e.a) && keptKeys.has(e.b));
    return { nodes: kept, edges: keptEdges, keptKeys, hidden: graph.recuerdos.length - kept.length };
  }, [graph]);

  const selected = selectedKey ? graph.byKey.get(selectedKey) || null : null;

  // Conjunto de claves a resaltar segun estado (camino/deriva/persona puente)
  const pathResult = useMemo(() => {
    if (caminoMode && pathA && pathB) return shortestPath(graph, pathA, pathB);
    return null;
  }, [caminoMode, pathA, pathB, graph]);

  const highlightKeys = useMemo(() => {
    if (derivaWalk) return new Set(derivaWalk.map(h => h.key));
    if (pathResult) return new Set(pathResult.map(h => h.key));
    if (lens === 'puentes' && focusPerson) {
      return new Set(graph.recuerdos.filter(r => r.people.includes(focusPerson)).map(r => r.key));
    }
    if (lens === 'islas') return new Set(metrics.islandList.map(i => i.key));
    if (lens === 'centros') return new Set(metrics.centers.map(c => c.key));
    return null as Set<string> | null;
  }, [derivaWalk, pathResult, lens, focusPerson, graph, metrics]);

  // ── Canvas: simulacion + render (una vez por dataset/dimensiones) ───────────
  // SVG con ~180 <image>+<clipPath> re-rasterizaba todo en cada zoom/pan (jank).
  // Canvas: un solo transform, sin DOM por nodo, clip por arc. La simulacion
  // corre viva (no freeze sincrono) porque canvas anima 180 nodos sin coste DOM.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const { width, height } = dimensions;
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap dpr: nitidez sin inflar el coste de fill
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    if (!renderSet.nodes.length) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      scheduleRef.current = () => {};
      return;
    }

    const nodes = renderSet.nodes.map(r => ({ ...r })) as any[];
    const links = renderSet.edges.map(e => ({ source: e.a, target: e.b, weight: e.weight, reasons: e.reasons })) as any[];

    const rOf = (d: any) => 8 + Math.sqrt(d.size) * 3.2;

    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id((d: any) => d.key).distance((l: any) => 120 - Math.min(l.weight * 6, 70)).strength((l: any) => Math.min(l.weight / 20, 0.6)))
      .force('charge', d3.forceManyBody().strength(-320))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius((d: any) => rOf(d) + 8))
      .alphaDecay(0.045); // se asienta en ~2s con animacion fluida (canvas), sin freeze

    // Caché de miniaturas: cada carga dispara un redraw coalescido (no tormenta
    // de repaint como en SVG). Devuelve la imagen solo si ya esta decodificada.
    const ensureImage = (url: string): HTMLImageElement | null => {
      if (!url) return null;
      const cache = imgCacheRef.current;
      let img = cache.get(url);
      if (!img) {
        img = new Image();
        img.decoding = 'async';
        img.onload = () => scheduleRef.current();
        img.src = url;
        cache.set(url, img);
      }
      return (img.complete && img.naturalWidth > 0) ? img : null;
    };

    const draw = () => {
      const t = transformRef.current;
      const st = styleRef.current;
      const hl = st.highlightKeys;
      context.save();
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.scale(dpr, dpr);
      context.translate(t.x, t.y);
      context.scale(t.k, t.k);

      // enlaces
      for (const l of links) {
        const a = l.source, b = l.target;
        const ak = a.key, bk = b.key;
        let stroke = PAL.link, alpha = 0.5;
        if (hl) { const on = hl.has(ak) && hl.has(bk); stroke = on ? PAL.linkHi : PAL.link; alpha = on ? 0.9 : 0.06; }
        else if (st.selectedKey && (ak === st.selectedKey || bk === st.selectedKey)) { stroke = PAL.linkHi; alpha = 0.85; }
        else if (st.selectedKey) { alpha = 0.12; }
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.strokeStyle = stroke;
        context.globalAlpha = alpha;
        context.lineWidth = Math.min(1 + l.weight / 4, 4);
        context.stroke();
      }
      context.globalAlpha = 1;

      // nodos: base + miniatura recortada a circulo + anillo
      for (const d of nodes) {
        const r = rOf(d);
        const dim = !!hl && !hl.has(d.key) && d.key !== st.selectedKey;
        context.globalAlpha = dim ? 0.28 : 1;

        context.beginPath();
        context.arc(d.x, d.y, r, 0, TAU);
        context.fillStyle = '#252A42';
        context.fill();

        if (r >= 14 && d.thumbnail) {
          const img = ensureImage(d.thumbnail);
          if (img) {
            context.save();
            context.beginPath();
            context.arc(d.x, d.y, r, 0, TAU);
            context.clip();
            // cover: recorte central cuadrado (equivale a preserveAspectRatio slice)
            const iw = img.naturalWidth, ih = img.naturalHeight, s = Math.min(iw, ih);
            context.globalAlpha = dim ? 0.28 : 0.92;
            context.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, d.x - r, d.y - r, r * 2, r * 2);
            context.restore();
            context.globalAlpha = dim ? 0.28 : 1;
          }
        }

        let ring = PAL.ringDim, rw = 2.2;
        if (d.key === st.selectedKey) { ring = PAL.marfil; rw = 3.5; }
        else if (hl) { const on = hl.has(d.key); ring = on ? PAL.lavanda : PAL.ringDim; rw = on ? 3 : 2.2; }
        else if (st.lens === 'explorar') { ring = COMPONENT_COLORS[(st.compById.get(d.key) || 0) % COMPONENT_COLORS.length]; }
        context.beginPath();
        context.arc(d.x, d.y, r, 0, TAU);
        context.strokeStyle = ring;
        context.lineWidth = rw;
        context.stroke();
      }
      context.globalAlpha = 1;
      context.restore();
    };

    // coalescer de frames: varios eventos (tick/zoom/imagen) => un solo repaint
    let rafId = 0;
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
    };
    scheduleRef.current = schedule;
    sim.on('tick', schedule);

    // hit-test en coordenadas de la simulacion (invierte el zoom)
    const nodeAt = (cssX: number, cssY: number): any | null => {
      const t = transformRef.current;
      const x = t.invertX(cssX), y = t.invertY(cssY);
      const n: any = sim.find(x, y); // sin radio: el chequeo per-nodo (r) acota cualquier tamaño
      if (!n) return null;
      const dx = n.x - x, dy = n.y - y, r = rOf(n);
      return (dx * dx + dy * dy) <= r * r ? n : null;
    };

    const sel = d3.select(canvas);

    // drag de nodos. Click = drag sin desplazamiento (se detecta en 'end').
    const drag = d3.drag<HTMLCanvasElement, unknown>()
      .container(() => canvas)
      .subject((event: any) => nodeAt(event.x, event.y))
      .on('start', (event: any) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        const s = event.subject;
        s.__x0 = event.x; s.__y0 = event.y; s.__moved = false;
        s.fx = s.x; s.fy = s.y;
      })
      .on('drag', (event: any) => {
        const s = event.subject;
        if (Math.hypot(event.x - s.__x0, event.y - s.__y0) > 3) s.__moved = true;
        // event.x/y mezcla espacios: el subject esta en coords de sim, asi que
        // d3-drag le suma un offset y el resultado deja de ser px CSS puro. Tomar
        // el puntero CSS real del evento fuente y luego invertir el zoom.
        const [cssX, cssY] = d3.pointer(event.sourceEvent, canvas);
        const t = transformRef.current;
        s.fx = t.invertX(cssX); s.fy = t.invertY(cssY);
      })
      .on('end', (event: any) => {
        if (!event.active) sim.alphaTarget(0);
        const s = event.subject;
        s.fx = null; s.fy = null;
        if (!s.__moved) clickRef.current(s.key);
      });

    // zoom/paneo. filter ignora el mousedown sobre un nodo => sin conflicto con
    // el drag (el nodo lo gestiona drag; el vacio lo panea zoom).
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.08, 4])
      .filter((event: any) => {
        if (event.type === 'wheel') return true;
        if (event.button) return false;
        const [px, py] = d3.pointer(event, canvas);
        return !nodeAt(px, py);
      })
      .on('zoom', (event: any) => { transformRef.current = event.transform; schedule(); });

    sel.call(drag as any).call(zoom as any);

    // cursor + tooltip imperativos (sin re-render de React en cada mousemove)
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const n = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
      canvas.style.cursor = n ? 'pointer' : 'grab';
      const tip = tipRef.current;
      if (!tip) return;
      if (n) {
        tip.textContent = `${n.label1}${n.label2 ? ' · ' + n.label2 : ''} · ${n.size} archivos`;
        tip.style.left = `${e.clientX - rect.left + 12}px`;
        tip.style.top = `${e.clientY - rect.top + 12}px`;
        tip.style.opacity = '1';
      } else {
        tip.style.opacity = '0';
      }
    };
    const onLeave = () => { if (tipRef.current) tipRef.current.style.opacity = '0'; };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);

    schedule();

    return () => {
      sim.stop();
      if (rafId) cancelAnimationFrame(rafId);
      scheduleRef.current = () => {}; // un img.onload tardio no reprograma sobre canvas muerto
      sel.on('.zoom', null).on('.drag', null);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    };
    // clickRef/styleRef se leen via ref (siempre frescos); no entran en deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderSet, dimensions]);

  // ── restyle = redraw: sincroniza el estado visual en styleRef y repinta ─────
  useEffect(() => {
    styleRef.current = { selectedKey, highlightKeys, lens, compById: metrics.compById };
    scheduleRef.current();
  }, [selectedKey, highlightKeys, lens, metrics]);

  // ── interaccion ─────────────────────────────────────────────────────────────
  const handleNodeClick = (key: string) => {
    if (caminoMode) {
      setDerivaWalk(null);
      if (!pathA) { setPathA(key); return; }
      if (!pathB && key !== pathA) { setPathB(key); return; }
      // reiniciar seleccion de camino
      setPathA(key); setPathB(null);
      return;
    }
    setDerivaWalk(null);
    setSelectedKey(prev => (prev === key ? null : key));
  };
  clickRef.current = handleNodeClick;

  const runDeriva = () => {
    setCaminoMode(false); setPathA(null); setPathB(null); setSelectedKey(null);
    setDerivaWalk(deriva(graph, selectedKey, 7));
  };

  const toggleCamino = () => {
    setDerivaWalk(null);
    setCaminoMode(m => !m);
    setPathA(null); setPathB(null);
  };

  const lensList: { id: Lens; label: string; icon: React.ReactNode }[] = [
    { id: 'explorar', label: 'Explorar', icon: <Compass className="w-4 h-4" /> },
    { id: 'centros', label: 'Centros', icon: <Star className="w-4 h-4" /> },
    { id: 'puentes', label: 'Puentes', icon: <Waypoints className="w-4 h-4" /> },
    { id: 'islas', label: 'Islas', icon: <Anchor className="w-4 h-4" /> },
  ];

  const empty = graph.recuerdos.length === 0;

  // ── helpers de render de listas ──────────────────────────────────────────────
  const RecuerdoRow = ({ r, sub }: { r: Recuerdo; sub?: string }) => (
    <button
      onClick={() => { setLens('explorar'); setCaminoMode(false); setDerivaWalk(null); setSelectedKey(r.key); }}
      className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-pizarra text-left transition-colors"
    >
      <div className="w-9 h-9 rounded-md overflow-hidden bg-noche flex-shrink-0">
        {r.thumbnail && <img src={r.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />}
      </div>
      <div className="min-w-0">
        <p className="text-sm text-marfil truncate">{r.label1}</p>
        <p className="text-xs text-humo truncate">{sub ?? `${r.size} archivos${r.label2 ? ' · ' + r.label2 : ''}`}</p>
      </div>
    </button>
  );

  return (
    <div className="bg-tinta rounded-xl p-6 shadow-sm border border-borde-sutil">
      <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-marfil flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-lavanda" /> Atlas de recuerdos
          </h2>
          <p className="text-sm text-niebla mt-1">
            Cada nodo es una <span className="text-lavanda">sesión</span> de tu archivo. Las conexiones nacen de personas, lugares, temas y cercanía en el tiempo.
          </p>
        </div>
        <div className="flex items-center gap-1 bg-grafito rounded-lg p-1">
          {lensList.map(l => (
            <button
              key={l.id}
              onClick={() => { setLens(l.id); setDerivaWalk(null); if (l.id === 'puentes') setFocusPerson(metrics.bridges[0]?.personId ?? null); }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors ${
                lens === l.id ? 'bg-lavanda text-noche' : 'text-niebla hover:text-marfil'
              }`}
            >
              {l.icon} {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-4" style={{ height: '640px' }}>
        {/* Lienzo */}
        <div className="flex-1 relative bg-noche rounded-lg overflow-hidden border border-borde-sutil">
          <canvas ref={canvasRef} className="w-full h-full" style={{ cursor: 'grab', display: 'block' }} />
          <div
            ref={tipRef}
            className="pointer-events-none absolute z-20 px-2 py-1 rounded bg-noche/90 text-marfil text-xs whitespace-nowrap shadow-lg transition-opacity duration-100"
            style={{ opacity: 0, left: 0, top: 0 }}
          />

          {computing && (
            <div className="absolute inset-0 flex items-center justify-center bg-noche/60 z-10">
              <Loader variant="atlas" cap="Tejiendo tu atlas" sub="Enlazando sesiones y recuerdos" />
            </div>
          )}

          {!computing && empty && (
            <div className="absolute inset-0 flex items-center justify-center text-center px-8">
              <div>
                <Sparkles className="w-10 h-10 text-lavanda-archivo mx-auto mb-3" />
                <p className="text-niebla text-sm">
                  Aún no hay recuerdos que mapear. El Atlas agrupa archivos en sesiones por su nombre (patrón <span className="text-lavanda">- AAMMDD</span>).
                </p>
              </div>
            </div>
          )}

          {!empty && (
            <div className="absolute top-3 left-3 flex gap-2">
              <button
                onClick={runDeriva}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-lavanda/15 text-lavanda hover:bg-lavanda/25 transition-colors border border-lavanda/30"
                title="Recorre conexiones inesperadas de tu archivo"
              >
                <Shuffle className="w-4 h-4" /> Llévame a algún sitio
              </button>
              <button
                onClick={toggleCamino}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  caminoMode ? 'bg-lavanda text-noche border-lavanda' : 'bg-grafito/70 text-niebla border-borde-sutil hover:text-marfil'
                }`}
                title="¿Cómo conecta un recuerdo con otro?"
              >
                <Route className="w-4 h-4" /> Camino
              </button>
            </div>
          )}

          {renderSet.hidden > 0 && (
            <div className="absolute bottom-4 left-4 text-xs text-humo bg-tinta/90 px-2 py-1 rounded">
              Mostrando {renderSet.nodes.length} recuerdos más conectados · {renderSet.hidden} no dibujados
            </div>
          )}
          <div className="absolute bottom-4 right-4 text-xs text-humo bg-tinta/90 px-2 py-1 rounded">
            Arrastra · Zoom con scroll · Click para abrir
          </div>
        </div>

        {/* Panel lateral */}
        <div className="w-80 flex flex-col bg-grafito rounded-lg p-4 overflow-hidden">
          <div className="flex-1 overflow-y-auto min-h-0 pr-1">
            {/* Deriva activa */}
            {derivaWalk ? (
              <SequencePanel
                title="Deriva" icon={<Shuffle className="w-4 h-4 text-lavanda" />}
                walk={derivaWalk} graph={graph}
                onClose={() => setDerivaWalk(null)} onPick={(k) => { setDerivaWalk(null); setSelectedKey(k); }}
                footer={<button onClick={runDeriva} className="w-full mt-2 px-3 py-2 rounded-lg text-sm font-medium bg-lavanda/15 text-lavanda hover:bg-lavanda/25 border border-lavanda/30">Otra deriva</button>}
              />
            ) : caminoMode ? (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-marfil flex items-center gap-2"><Route className="w-4 h-4 text-lavanda" /> Camino entre recuerdos</h3>
                  <button onClick={toggleCamino} className="p-1 text-humo hover:text-marfil"><X className="w-3.5 h-3.5" /></button>
                </div>
                <p className="text-xs text-humo mb-3">
                  {!pathA ? 'Pulsa el primer recuerdo en el mapa.' : !pathB ? 'Ahora pulsa el segundo.' : 'Cadena más fuerte encontrada:'}
                </p>
                <div className="flex items-center gap-2 mb-3 text-xs">
                  <span className={`px-2 py-1 rounded ${pathA ? 'bg-lavanda/20 text-marfil' : 'bg-noche text-humo'}`}>{pathA ? graph.byKey.get(pathA)?.label1 : 'origen'}</span>
                  <ArrowRight className="w-3 h-3 text-humo" />
                  <span className={`px-2 py-1 rounded ${pathB ? 'bg-lavanda/20 text-marfil' : 'bg-noche text-humo'}`}>{pathB ? graph.byKey.get(pathB)?.label1 : 'destino'}</span>
                </div>
                {pathA && pathB && (
                  pathResult ? (
                    <SequencePanel walk={pathResult} graph={graph} onPick={(k) => setSelectedKey(k)} />
                  ) : (
                    <p className="text-sm text-estado-aviso">No hay camino: estos recuerdos viven en mundos separados de tu archivo.</p>
                  )
                )}
              </div>
            ) : selected ? (
              <RecuerdoDetail
                r={selected} hasNote={noteKeys.has(selected.key)} personName={personName} personsMap={personsMap}
                onClose={() => setSelectedKey(null)}
                onOpenDay={onOpenDay} onPersonClick={onPersonClick} onTagClick={onTagClick}
              />
            ) : (
              <LensPanel
                lens={lens} metrics={metrics} graph={graph} personName={personName}
                focusPerson={focusPerson}
                onBridge={(pid) => { setLens('puentes'); setFocusPerson(pid); }}
                RecuerdoRow={RecuerdoRow}
              />
            )}
          </div>

          {/* Stats emergentes (pie) */}
          <div className="mt-3 pt-3 border-t border-borde-sutil grid grid-cols-2 gap-y-1 text-xs text-humo">
            <span>{graph.recuerdos.length} recuerdos</span>
            <span>{graph.edges.length} conexiones</span>
            <span>{metrics.componentCount} mundos</span>
            <span>{graph.looseCount} sueltos</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── subcomponentes ────────────────────────────────────────────────────────────
function SequencePanel({ title, icon, walk, graph, onClose, onPick, footer }: {
  title?: string; icon?: React.ReactNode; walk: PathHop[]; graph: AtlasGraph;
  onClose?: () => void; onPick: (key: string) => void; footer?: React.ReactNode;
}) {
  return (
    <div>
      {title && (
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-marfil flex items-center gap-2">{icon} {title}</h3>
          {onClose && <button onClick={onClose} className="p-1 text-humo hover:text-marfil"><X className="w-3.5 h-3.5" /></button>}
        </div>
      )}
      <ol className="relative border-l border-borde-sutil ml-3">
        {walk.map((hop, i) => {
          const r = graph.byKey.get(hop.key);
          return (
            <li key={hop.key + i} className="ml-4 mb-3">
              <span className="absolute -left-1.5 w-3 h-3 rounded-full bg-lavanda" />
              {hop.reason && <p className="text-[11px] text-humo italic mb-1">↳ {hop.reason}</p>}
              <button onClick={() => onPick(hop.key)} className="w-full flex items-center gap-2 p-1.5 rounded-lg hover:bg-pizarra text-left">
                <div className="w-9 h-9 rounded-md overflow-hidden bg-noche flex-shrink-0">
                  {r?.thumbnail && <img src={r.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />}
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-marfil truncate">{r?.label1 || hop.key}</p>
                  <p className="text-xs text-humo truncate">{r?.dateLabel}</p>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
      {footer}
    </div>
  );
}

function RecuerdoDetail({ r, hasNote, personName, personsMap, onClose, onOpenDay, onPersonClick, onTagClick }: {
  r: Recuerdo; hasNote: boolean; personName: (id: string) => string; personsMap: Map<string, Person>;
  onClose: () => void; onOpenDay?: (d: Date) => void; onPersonClick?: (id: string) => void; onTagClick?: (t: string) => void;
}) {
  return (
    <div>
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-marfil truncate">{r.label1}</h3>
          {r.label2 && <p className="text-xs text-niebla truncate">{r.label2}</p>}
        </div>
        <button onClick={onClose} className="p-1 text-humo hover:text-marfil flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
      </div>
      <p className="text-xs text-humo mb-3">{r.size} archivos{r.dateLabel ? ` · ${r.dateLabel}` : ''}{hasNote ? ' · 📝 con nota' : ''}</p>

      <div className="grid grid-cols-3 gap-1.5 mb-3">
        {r.sampleThumbnails.slice(0, 9).map((thumb, idx) => (
          <div key={idx} className="aspect-square rounded overflow-hidden bg-noche">
            <img src={thumb} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
        ))}
      </div>

      {r.people.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-humo mb-1 flex items-center gap-1"><Users className="w-3 h-3" /> Personas</p>
          <div className="flex flex-wrap gap-1.5">
            {r.people.slice(0, 12).map(pid => {
              const av = personsMap.get(pid)?.avatar_url;
              return (
                <button key={pid} onClick={() => onPersonClick?.(pid)} disabled={!onPersonClick}
                  className="inline-flex items-center gap-1 pl-1 pr-2 py-0.5 rounded-full bg-pizarra text-xs text-marfil hover:bg-lavanda/20 transition-colors">
                  <span className="w-4 h-4 rounded-full overflow-hidden bg-noche inline-block">
                    {av && <img src={`${config.apiUrl}${av}`} alt="" className="w-full h-full object-cover" />}
                  </span>
                  {personName(pid)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {r.tags.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-humo mb-1">Temas</p>
          <div className="flex flex-wrap gap-1.5">
            {r.tags.slice(0, 10).map(t => (
              <button key={t} onClick={() => onTagClick?.(t)} disabled={!onTagClick}
                className="px-2 py-0.5 rounded-md bg-pizarra text-xs text-marfil hover:bg-lavanda/20 transition-colors">{t}</button>
            ))}
          </div>
        </div>
      )}

      {r.date && onOpenDay && (
        <button onClick={() => onOpenDay(r.date!)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-lavanda text-noche hover:bg-lavanda-claro transition-colors">
          <ArrowRight className="w-4 h-4" /> Ver ese día en la biblioteca
        </button>
      )}
    </div>
  );
}

function LensPanel({ lens, metrics, graph, personName, focusPerson, onBridge, RecuerdoRow }: {
  lens: Lens;
  metrics: any;
  graph: AtlasGraph;
  personName: (id: string) => string;
  focusPerson: string | null;
  onBridge: (pid: string) => void;
  RecuerdoRow: (p: { r: Recuerdo; sub?: string }) => JSX.Element;
}) {
  if (lens === 'centros') {
    return (
      <Section title="Centros de gravedad" icon={<Star className="w-4 h-4 text-lavanda" />} hint="Los grandes núcleos de tu archivo: muchas conexiones, mucho material.">
        {metrics.centers.map((c: any) => {
          const r = graph.byKey.get(c.key)!;
          return <RecuerdoRow key={c.key} r={r} sub={`${r.size} archivos · ${c.degree} conexiones`} />;
        })}
      </Section>
    );
  }
  if (lens === 'puentes') {
    return (
      <Section title="Personas puente" icon={<Waypoints className="w-4 h-4 text-lavanda" />} hint="Quienes unen mundos que de otro modo quedarían separados.">
        {metrics.bridges.length === 0 && <p className="text-sm text-humo">Aún no hay personas que crucen varios mundos. Identifica más caras en Personas.</p>}
        {metrics.bridges.map((b: any) => (
          <button key={b.personId} onClick={() => onBridge(b.personId)}
            className={`w-full text-left p-2 rounded-lg mb-1 transition-colors ${focusPerson === b.personId ? 'bg-lavanda/20' : 'hover:bg-pizarra'}`}>
            <p className="text-sm text-marfil">{personName(b.personId)}</p>
            <p className="text-xs text-humo">conecta {b.clusterCount} mundos · {b.sessionCount} sesiones</p>
            <p className="text-[11px] text-niebla truncate mt-0.5">{b.clusters.map((c: any) => c.label).join(' · ')}</p>
          </button>
        ))}
      </Section>
    );
  }
  if (lens === 'islas') {
    return (
      <Section title="Islas" icon={<Anchor className="w-4 h-4 text-lavanda" />} hint="Material que apenas conecta con el resto. Quizá pide tags o caras.">
        {metrics.islandList.length === 0 && <p className="text-sm text-humo">No hay islas: todo tu archivo está conectado.</p>}
        {metrics.islandList.slice(0, 40).map((i: any) => {
          const r = graph.byKey.get(i.key)!;
          return <RecuerdoRow key={i.key} r={r} sub={i.componentSize === 1 ? 'aislado' : `grupo de ${i.componentSize}`} />;
        })}
      </Section>
    );
  }
  // explorar
  const topAnchor = metrics.anchors[0];
  const topBridge = metrics.bridges[0];
  return (
    <Section title="Tu archivo de un vistazo" icon={<Compass className="w-4 h-4 text-lavanda" />} hint="Elige una lente arriba para profundizar, o suéltate con la deriva.">
      <ul className="text-sm text-niebla space-y-2">
        <li><Star className="w-3.5 h-3.5 inline text-lavanda mr-1" /> {graph.recuerdos.length} recuerdos en {metrics.componentCount} mundos.</li>
        {topBridge && <li><Waypoints className="w-3.5 h-3.5 inline text-lavanda mr-1" /> Mayor puente: <span className="text-marfil">{personName(topBridge.personId)}</span> ({topBridge.clusterCount} mundos).</li>}
        {topAnchor && <li><MapPin className="w-3.5 h-3.5 inline text-lavanda mr-1" /> Lugar ancla: <span className="text-marfil">{topAnchor.placeId}</span> ({topAnchor.sessionCount} sesiones).</li>}
        {!topAnchor && <li className="text-humo"><MapPin className="w-3.5 h-3.5 inline mr-1" /> Lugares ancla: requiere espacios identificados (pendiente).</li>}
        <li><Anchor className="w-3.5 h-3.5 inline text-lavanda mr-1" /> {metrics.islandList.length} recuerdos isla.</li>
      </ul>
    </Section>
  );
}

function Section({ title, icon, hint, children }: { title: string; icon: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-marfil flex items-center gap-2 mb-1">{icon} {title}</h3>
      {hint && <p className="text-xs text-humo mb-3">{hint}</p>}
      <div>{children}</div>
    </div>
  );
}
