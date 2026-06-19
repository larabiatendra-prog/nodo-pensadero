/**
 * Atlas de recuerdos — motor de grafo (Fase A).
 *
 * Unidad de "recuerdo" = SESION (carpeta colapsada via getSessionKey), la
 * unidad atomica de significado del proyecto. Las aristas entre recuerdos se
 * tejen por entidades compartidas (personas, lugares, etiquetas) y cercania
 * temporal, usando INDICES INVERTIDOS (no O(n^2) ciego): solo se tocan los
 * pares que realmente comparten algo, con un tope de fan-out para que una
 * entidad demasiado generica no genere un hairball.
 *
 * Todo es puro y client-side: opera sobre el array de archivos ya en memoria.
 * Escala bien porque #sesiones << #archivos. El calculo se ejecuta en un Web
 * Worker (ver atlasWorker.ts) para no congelar la UI. Lo que NO entra en Fase A
 * (similitud CLIP, espacios first-class, agregacion galactica WebGL) se
 * añadira mas adelante sin cambiar este contrato.
 */
import { MediaFile } from '../types';
import { getFileSessionKey, getSessionLabelSource, parseSmartLabel } from './filenameParser';

export interface Recuerdo {
  key: string;
  label1: string;
  label2: string;
  fileIds: string[];
  // Miniaturas de muestra (hasta 12) — el Recuerdo es ligero y serializable
  // (no arrastra MediaFile completos), apto para postMessage a un worker.
  sampleThumbnails: string[];
  size: number;
  date: Date | null;
  dateLabel: string;
  people: string[];
  tags: string[];
  places: string[];
  thumbnail: string;
}

export interface EdgeReasons {
  people: string[];
  places: string[];
  tags: string[];
  days: number | null;
}

export interface AtlasEdge {
  a: string;
  b: string;
  weight: number;
  reasons: EdgeReasons;
}

export interface AtlasWeights {
  person: number;
  place: number;
  tag: number;
  time: number;
  timeWindowDays: number;
  minEdgeWeight: number;
  maxFanout: number;     // entidades en mas de N sesiones no tejen aristas (demasiado genericas)
  topKPerNode: number;   // conservar solo las K aristas mas fuertes por nodo (0 = sin poda)
}

export const DEFAULT_WEIGHTS: AtlasWeights = {
  person: 3,
  place: 3,
  tag: 1,
  time: 2,
  timeWindowDays: 10,
  minEdgeWeight: 2,
  maxFanout: 30,
  topKPerNode: 12,
};

export interface AtlasGraph {
  recuerdos: Recuerdo[];
  edges: AtlasEdge[];
  byKey: Map<string, Recuerdo>;
  adjacency: Map<string, { other: string; edge: AtlasEdge }[]>;
  looseCount: number;
  fileCount: number;
}

// ── helpers de tags/fechas ─────────────────────────────────────────────────
const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Tags de fecha/genericos que no aportan significado (mismo criterio que el
// backend de estadisticas).
function isMeaningfulTag(tag: string): boolean {
  if (!tag) return false;
  if (/^\d{2}-\d{2}-\d{2}$/.test(tag)) return false;
  if (/^\d{4}$/.test(tag)) return false;
  if (MONTHS_ES.includes(tag)) return false;
  return true;
}

function parseSessionDate(key: string): Date | null {
  // Acepta fecha tras guion ("Prefijo - 240617") o al inicio ("240412_Viaje").
  const m = key.match(/(?:^|-\s*)(\d{6})/);
  if (!m) return null;
  const s = m[1];
  const yy = parseInt(s.substring(0, 2), 10);
  const mm = parseInt(s.substring(2, 4), 10);
  const dd = parseInt(s.substring(4, 6), 10);
  const year = yy > 50 ? 1900 + yy : 2000 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return new Date(year, mm - 1, dd);
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// ── construccion del grafo ─────────────────────────────────────────────────
export function buildAtlas(
  files: MediaFile[],
  weights: AtlasWeights = DEFAULT_WEIGHTS,
): AtlasGraph {
  // 1) Agrupar por sesion (key null = archivo suelto)
  const groups = new Map<string, MediaFile[]>();
  let looseCount = 0;
  for (const f of files) {
    const key = getFileSessionKey(f);
    if (key === null) { looseCount++; continue; }
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(f);
  }

  // 2) Agregar cada sesion en un Recuerdo (ligero) e indexar por entero
  const recuerdos: Recuerdo[] = [];
  const byKey = new Map<string, Recuerdo>();
  for (const [key, gfiles] of groups) {
    const people = uniq(
      gfiles.flatMap(f => (f.faces || []).map(fc => fc.person_id).filter(Boolean) as string[])
    );
    const tags = uniq(
      gfiles.flatMap(f => (f.tags || []).filter(isMeaningfulTag))
    );
    const places = uniq(
      gfiles.flatMap(f => {
        const sp = (f as unknown as { spaces?: Array<{ space_id?: string }> }).spaces;
        return Array.isArray(sp) ? sp.map(s => s.space_id).filter(Boolean) as string[] : [];
      })
    );
    const label = parseSmartLabel(getSessionLabelSource(gfiles[0]));
    const date = parseSessionDate(key);
    const r: Recuerdo = {
      key,
      label1: label.line1 || key,
      label2: label.line2 || '',
      fileIds: gfiles.map(f => f.id),
      sampleThumbnails: gfiles.slice(0, 12).map(f => f.thumbnail).filter(Boolean) as string[],
      size: gfiles.length,
      date,
      dateLabel: date ? `${date.getDate()} ${MONTHS_ES[date.getMonth()].slice(0, 3).toLowerCase()} ${date.getFullYear()}` : '',
      people,
      tags,
      places,
      thumbnail: gfiles[0]?.thumbnail || '',
    };
    byKey.set(key, r);
    recuerdos.push(r);
  }

  const N = recuerdos.length;
  if (N === 0) {
    return { recuerdos, edges: [], byKey, adjacency: new Map(), looseCount, fileCount: files.length };
  }

  // 3) Aristas via indices invertidos con CLAVE NUMERICA del par (sin allocs de
  // string): pairId = i*N + j con i<j. Cabe en double mientras N^2 < 2^53.
  const acc = new Map<number, EdgeReasons>();
  const ensure = (ia: number, ib: number): EdgeReasons => {
    const i = ia < ib ? ia : ib;
    const j = ia < ib ? ib : ia;
    const id = i * N + j;
    let e = acc.get(id);
    if (!e) { e = { people: [], places: [], tags: [], days: null }; acc.set(id, e); }
    return e;
  };

  const accumulateEntity = (index: Map<string, number[]>, bucket: 'people' | 'places' | 'tags') => {
    for (const [entity, idxs] of index) {
      if (idxs.length < 2 || idxs.length > weights.maxFanout) continue; // unico o demasiado generico
      for (let i = 0; i < idxs.length; i++) {
        for (let j = i + 1; j < idxs.length; j++) {
          ensure(idxs[i], idxs[j])[bucket].push(entity);
        }
      }
    }
  };

  const pushIdx = (m: Map<string, number[]>, k: string, v: number) => {
    const a = m.get(k); if (a) a.push(v); else m.set(k, [v]);
  };
  const peopleIdx = new Map<string, number[]>();
  const placesIdx = new Map<string, number[]>();
  const tagsIdx = new Map<string, number[]>();
  recuerdos.forEach((r, idx) => {
    for (const p of r.people) pushIdx(peopleIdx, p, idx);
    for (const pl of r.places) pushIdx(placesIdx, pl, idx);
    for (const t of r.tags) pushIdx(tagsIdx, t, idx);
  });
  accumulateEntity(peopleIdx, 'people');
  accumulateEntity(placesIdx, 'places');
  accumulateEntity(tagsIdx, 'tags');

  // 4) Aristas temporales: orden por fecha + ventana, con tope por sesion para
  // evitar explosion O(D^2) cuando muchas sesiones caen el mismo dia.
  const dated = recuerdos
    .map((r, idx) => ({ idx, t: r.date ? r.date.getTime() : 0, has: !!r.date }))
    .filter(d => d.has)
    .sort((a, b) => a.t - b.t);
  const windowMs = weights.timeWindowDays * 86400000;
  const MAX_TIME_LINKS = 50;
  for (let i = 0; i < dated.length; i++) {
    let made = 0;
    for (let j = i + 1; j < dated.length && made < MAX_TIME_LINKS; j++) {
      const dt = dated[j].t - dated[i].t;
      if (dt > windowMs) break;
      const days = Math.round(dt / 86400000);
      const e = ensure(dated[i].idx, dated[j].idx);
      if (e.days === null || days < e.days) e.days = days;
      made++;
    }
  }

  // 5) Materializar aristas con peso y filtrar por minimo
  const allEdges: AtlasEdge[] = [];
  for (const [id, reasons] of acc) {
    const i = Math.floor(id / N);
    const j = id % N;
    let weight = weights.person * reasons.people.length
      + weights.place * reasons.places.length
      + weights.tag * reasons.tags.length;
    if (reasons.days !== null) weight += weights.time * Math.max(0, 1 - reasons.days / weights.timeWindowDays);
    if (weight < weights.minEdgeWeight) continue;
    allEdges.push({
      a: recuerdos[i].key,
      b: recuerdos[j].key,
      weight,
      reasons: {
        people: uniq(reasons.people),
        places: uniq(reasons.places),
        tags: uniq(reasons.tags),
        days: reasons.days,
      },
    });
  }

  // 5b) Sparsificar: conservar solo las top-K aristas mas fuertes por nodo
  // (union de ambos extremos) — mata el hairball y acelera fuerza+render.
  const edges = topKSparsify(allEdges, weights.topKPerNode);

  // 6) Adyacencia
  const adjacency = new Map<string, { other: string; edge: AtlasEdge }[]>();
  for (const r of recuerdos) adjacency.set(r.key, []);
  for (const e of edges) {
    adjacency.get(e.a)?.push({ other: e.b, edge: e });
    adjacency.get(e.b)?.push({ other: e.a, edge: e });
  }

  return { recuerdos, edges, byKey, adjacency, looseCount, fileCount: files.length };
}

function topKSparsify(edges: AtlasEdge[], k: number): AtlasEdge[] {
  if (k <= 0 || edges.length === 0) return edges;
  const byNode = new Map<string, AtlasEdge[]>();
  const add = (node: string, e: AtlasEdge) => { const a = byNode.get(node); if (a) a.push(e); else byNode.set(node, [e]); };
  for (const e of edges) { add(e.a, e); add(e.b, e); }
  const keep = new Set<AtlasEdge>();
  for (const [, list] of byNode) {
    if (list.length > k) list.sort((x, y) => y.weight - x.weight);
    for (let i = 0; i < Math.min(k, list.length); i++) keep.add(list[i]);
  }
  return edges.filter(e => keep.has(e));
}

// ── union-find ──────────────────────────────────────────────────────────────
class UnionFind {
  parent = new Map<string, string>();
  add(x: string) { if (!this.parent.has(x)) this.parent.set(x, x); }
  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) { this.parent.set(x, x); return x; }
    while (p !== x) { const gp = this.parent.get(p)!; this.parent.set(x, gp); x = p; p = gp; }
    return x;
  }
  union(a: string, b: string) { this.add(a); this.add(b); this.parent.set(this.find(a), this.find(b)); }
}

export interface Component { id: string; keys: string[]; size: number; }

function componentsFrom(graph: AtlasGraph, edgeFilter: (e: AtlasEdge) => boolean): Map<string, string> {
  const uf = new UnionFind();
  for (const r of graph.recuerdos) uf.add(r.key);
  for (const e of graph.edges) if (edgeFilter(e)) uf.union(e.a, e.b);
  const comp = new Map<string, string>();
  for (const r of graph.recuerdos) comp.set(r.key, uf.find(r.key));
  return comp;
}

export function connectedComponents(graph: AtlasGraph): Component[] {
  const comp = componentsFrom(graph, () => true);
  const groups = new Map<string, string[]>();
  for (const [key, root] of comp) (groups.get(root) || groups.set(root, []).get(root)!).push(key);
  return Array.from(groups.entries())
    .map(([id, keys]) => ({ id, keys, size: keys.length }))
    .sort((a, b) => b.size - a.size);
}

// ── metricas emergentes ──────────────────────────────────────────────────────
export interface CenterNode { key: string; score: number; degree: number; }

export function centersOfGravity(graph: AtlasGraph, topN = 12): CenterNode[] {
  const wdeg = new Map<string, number>();
  const deg = new Map<string, number>();
  for (const r of graph.recuerdos) { wdeg.set(r.key, 0); deg.set(r.key, 0); }
  for (const e of graph.edges) {
    wdeg.set(e.a, (wdeg.get(e.a) || 0) + e.weight);
    wdeg.set(e.b, (wdeg.get(e.b) || 0) + e.weight);
    deg.set(e.a, (deg.get(e.a) || 0) + 1);
    deg.set(e.b, (deg.get(e.b) || 0) + 1);
  }
  return graph.recuerdos
    .map(r => ({ key: r.key, degree: deg.get(r.key) || 0, score: (wdeg.get(r.key) || 0) + Math.log2(r.size + 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

export interface BridgePerson {
  personId: string;
  clusterCount: number;
  sessionCount: number;
  clusters: Array<{ id: string; label: string }>;
}

/**
 * Personas puente: clusters "base" = componentes IGNORANDO las aristas de
 * personas (solo lugar/tag/tiempo). Una persona es puente si aparece en
 * sesiones que caen en >=2 clusters base distintos -> une mundos que de otro
 * modo quedarian separados (el ejemplo "Laura conecta Pirineos/Paris/...").
 */
export function bridgePeople(graph: AtlasGraph, topN = 10): BridgePerson[] {
  const baseComp = componentsFrom(graph, e => e.reasons.places.length > 0 || e.reasons.tags.length > 0 || e.reasons.days !== null);

  // etiqueta representativa por cluster base = label1 de la sesion mas grande
  const clusterLabel = new Map<string, { label: string; size: number }>();
  for (const r of graph.recuerdos) {
    const c = baseComp.get(r.key)!;
    const cur = clusterLabel.get(c);
    if (!cur || r.size > cur.size) clusterLabel.set(c, { label: r.label1, size: r.size });
  }

  const personClusters = new Map<string, Set<string>>();
  const personSessions = new Map<string, number>();
  for (const r of graph.recuerdos) {
    const c = baseComp.get(r.key)!;
    for (const p of r.people) {
      (personClusters.get(p) || personClusters.set(p, new Set()).get(p)!).add(c);
      personSessions.set(p, (personSessions.get(p) || 0) + 1);
    }
  }

  const out: BridgePerson[] = [];
  for (const [personId, clusters] of personClusters) {
    if (clusters.size < 2) continue;
    out.push({
      personId,
      clusterCount: clusters.size,
      sessionCount: personSessions.get(personId) || 0,
      clusters: Array.from(clusters).map(id => ({ id, label: clusterLabel.get(id)?.label || id })).slice(0, 8),
    });
  }
  return out.sort((a, b) => b.clusterCount - a.clusterCount || b.sessionCount - a.sessionCount).slice(0, topN);
}

export interface AnchorPlace { placeId: string; sessionCount: number; }

export function anchorPlaces(graph: AtlasGraph, topN = 10): AnchorPlace[] {
  const idx = new Map<string, number>();
  for (const r of graph.recuerdos) for (const pl of r.places) idx.set(pl, (idx.get(pl) || 0) + 1);
  return Array.from(idx.entries())
    .map(([placeId, sessionCount]) => ({ placeId, sessionCount }))
    .sort((a, b) => b.sessionCount - a.sessionCount)
    .slice(0, topN);
}

export interface Island { key: string; componentSize: number; }

export function islands(graph: AtlasGraph, maxComponentSize = 2): Island[] {
  const comps = connectedComponents(graph);
  const small = comps.filter(c => c.size <= maxComponentSize);
  const out: Island[] = [];
  for (const c of small) for (const key of c.keys) out.push({ key, componentSize: c.size });
  // mas aislados primero (componente de tamaño 1)
  return out.sort((a, b) => a.componentSize - b.componentSize);
}

// ── caminos ──────────────────────────────────────────────────────────────────
export interface PathHop { key: string; reason: string | null; }

function reasonString(e: AtlasEdge): string {
  if (e.reasons.people.length) return `${e.reasons.people.length} persona${e.reasons.people.length > 1 ? 's' : ''} en común`;
  if (e.reasons.places.length) return 'mismo lugar';
  if (e.reasons.tags.length) return `tema: ${e.reasons.tags.slice(0, 2).join(', ')}`;
  if (e.reasons.days !== null) return e.reasons.days === 0 ? 'el mismo día' : `a ${e.reasons.days} día${e.reasons.days > 1 ? 's' : ''}`;
  return 'conexión';
}

/** Camino mas "fuerte" entre dos recuerdos (Dijkstra con coste = 1/peso). */
export function shortestPath(graph: AtlasGraph, from: string, to: string): PathHop[] | null {
  if (from === to) return [{ key: from, reason: null }];
  const dist = new Map<string, number>();
  const prev = new Map<string, { key: string; edge: AtlasEdge }>();
  const visited = new Set<string>();
  dist.set(from, 0);
  // cola simple (grafos pequeños): extraer min linealmente
  const pending = new Set<string>([from]);
  while (pending.size) {
    let u: string | null = null;
    let best = Infinity;
    for (const k of pending) { const d = dist.get(k) ?? Infinity; if (d < best) { best = d; u = k; } }
    if (u === null) break;
    pending.delete(u);
    if (u === to) break;
    visited.add(u);
    for (const { other, edge } of graph.adjacency.get(u) || []) {
      if (visited.has(other)) continue;
      const nd = (dist.get(u) ?? Infinity) + 1 / Math.max(edge.weight, 0.001);
      if (nd < (dist.get(other) ?? Infinity)) {
        dist.set(other, nd);
        prev.set(other, { key: u, edge });
        pending.add(other);
      }
    }
  }
  if (!prev.has(to) && from !== to) return null;
  const chain: PathHop[] = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (!p) return null;
    chain.unshift({ key: cur, reason: reasonString(p.edge) });
    cur = p.key;
  }
  chain.unshift({ key: from, reason: null });
  return chain;
}

// ── deriva (paseo aleatorio sesgado por peso) ────────────────────────────────
export function deriva(graph: AtlasGraph, seed: string | null, steps = 7): PathHop[] {
  const start = seed && graph.byKey.has(seed)
    ? seed
    : graph.recuerdos.length
      ? graph.recuerdos[Math.floor(Math.random() * graph.recuerdos.length)].key
      : null;
  if (!start) return [];
  const walk: PathHop[] = [{ key: start, reason: null }];
  let cur = start;
  let prev: string | null = null;
  for (let s = 0; s < steps; s++) {
    const neigh = (graph.adjacency.get(cur) || []).filter(n => n.other !== prev);
    if (!neigh.length) break;
    const total = neigh.reduce((acc, n) => acc + n.edge.weight, 0);
    let pick = Math.random() * total;
    let chosen = neigh[neigh.length - 1];
    for (const n of neigh) { pick -= n.edge.weight; if (pick <= 0) { chosen = n; break; } }
    walk.push({ key: chosen.other, reason: reasonString(chosen.edge) });
    prev = cur;
    cur = chosen.other;
  }
  return walk;
}
