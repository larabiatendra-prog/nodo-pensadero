import React, { useRef, useEffect, useState, useMemo } from 'react';
import * as d3 from 'd3';
import { Search, X, Plus, Tag, Users, Hash, ArrowRight, Eye } from 'lucide-react';
import { MediaFile, Person } from '../types';
import { buildApiUrl } from '../config';
import config from '../config';
import { api } from '../services/api';

type GraphMode = 'tags' | 'personas';

interface GraphViewProps {
  files: MediaFile[];
  // Deep-link: al pulsar "Ver los N", saltar a la biblioteca filtrada.
  onTagClick?: (tag: string) => void;
  onPersonClick?: (personId: string) => void;
}

interface Node {
  id: string;
  label: string;
  count: number;
  radius: number;
  isPinned?: boolean;
  avatar?: string | null;
}

interface Link {
  source: string;
  target: string;
  strength: number;
}

// Paleta del grafo en valores literales (D3 pinta atributos SVG, no clases
// Tailwind). Mapea 1:1 con los tokens semanticos de tailwind.config.js.
const PAL = {
  node: '#F2B8A0',        // melocoton — nodo normal (tags)
  nodePerson: '#9CB7A5',  // salvia — nodo normal (personas)
  nodePinned: '#8EA4FF',  // bruma — nodo fijado (tags)
  highlight: '#C8B6FF',   // lavanda — nodo seleccionado/resaltado
  link: 'rgba(184,179,201,0.28)',   // niebla con alpha — arista normal
  linkHi: '#C8B6FF',      // lavanda — arista resaltada
  label: '#F5F1FF',       // marfil — etiquetas
  noche: '#0F111A',       // texto sobre nodo claro (iniciales)
};

// Persistencia ligera de preferencias del grafo.
const LS = {
  mode: 'pensadero.graph.mode',
  pins: 'pensadero.graph.pins',
  topN: 'pensadero.graph.topN',
  labels: 'pensadero.graph.labels',
};
function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota/SSR */ }
}

function avatarFullUrl(relativePath: string): string {
  return `${config.apiUrl}${relativePath}`;
}
function initialsFrom(name: string): string {
  const t = (name || '').trim();
  return t ? t.slice(0, 2).toUpperCase() : '??';
}
// id seguro para usar en url(#...) de clipPath
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export default function GraphView({ files, onTagClick, onPersonClick }: GraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const [mode, setMode] = useState<GraphMode>(() => lsGet<GraphMode>(LS.mode, 'tags'));
  const [topN, setTopN] = useState<number>(() => lsGet<number>(LS.topN, 100));
  const [showLabels, setShowLabels] = useState<boolean>(() => lsGet<boolean>(LS.labels, true));

  // Pins (solo modo tags)
  const [pinnedTags, setPinnedTags] = useState<string[]>(() => lsGet<string[]>(LS.pins, []));
  const [searchQuery, setSearchQuery] = useState('');
  const [allTags, setAllTags] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Personas (modo personas): registry agregado para nombre/avatar/conteo
  const [persons, setPersons] = useState<Person[]>([]);

  // Persistir preferencias
  useEffect(() => { lsSet(LS.mode, mode); }, [mode]);
  useEffect(() => { lsSet(LS.topN, topN); }, [topN]);
  useEffect(() => { lsSet(LS.labels, showLabels); }, [showLabels]);
  useEffect(() => { lsSet(LS.pins, pinnedTags); }, [pinnedTags]);

  // Limpiar seleccion al cambiar de modo (el id deja de existir)
  useEffect(() => { setSelectedNode(null); }, [mode]);

  useEffect(() => {
    const updateDimensions = () => {
      const container = svgRef.current?.parentElement;
      if (container) {
        setDimensions({
          width: container.clientWidth,
          height: Math.min(container.clientHeight || 600, 600),
        });
      }
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  // Cargar todas las etiquetas (para el buscador de pins)
  useEffect(() => {
    fetch(buildApiUrl('tags'))
      .then(r => r.json())
      .then(result => {
        if (result.success && result.data?.allTags) setAllTags(result.data.allTags);
      })
      .catch(err => console.error('Error fetching tags:', err));
  }, []);

  // Cargar personas agregadas (nombre/avatar/conteo) para el modo personas
  useEffect(() => {
    let cancelled = false;
    api.getPersons()
      .then(r => { if (!cancelled && r.success && Array.isArray(r.data)) setPersons(r.data as Person[]); })
      .catch(() => { /* sin daemon de caras: el grafo de personas saldra vacio */ });
    return () => { cancelled = true; };
  }, []);

  const personsMap = useMemo(() => new Map(persons.map(p => [p.person_id, p])), [persons]);

  // ── Co-ocurrencia (CARO): solo depende de files + modo. NO se recalcula al
  // fijar/quitar pins ni al mover sliders. Frecuencia = nº de archivos
  // distintos que contienen el token (no detecciones repetidas).
  const coData = useMemo(() => {
    const frequency = new Map<string, number>();
    const co = new Map<string, Map<string, number>>();
    const bump = (a: string, b: string) => {
      let m = co.get(a);
      if (!m) { m = new Map(); co.set(a, m); }
      m.set(b, (m.get(b) || 0) + 1);
    };
    files.forEach(file => {
      let tokens: string[];
      if (mode === 'tags') {
        tokens = file.tags || [];
      } else {
        tokens = (file.faces || [])
          .map(f => f.person_id)
          .filter((id): id is string => Boolean(id));
      }
      const uniq = Array.from(new Set(tokens));
      uniq.forEach(t => frequency.set(t, (frequency.get(t) || 0) + 1));
      for (let i = 0; i < uniq.length; i++) {
        for (let j = 0; j < uniq.length; j++) {
          if (i !== j) bump(uniq[i], uniq[j]);
        }
      }
    });
    return { frequency, co };
  }, [files, mode]);

  // Frecuencias para el buscador de sugerencias (filtrar top-N ya en el grafo)
  const topNamesAll = useMemo(() => new Set(
    Array.from(coData.frequency.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([t]) => t)
  ), [coData, topN]);

  const suggestions = useMemo(() => {
    if (mode !== 'tags' || !searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return allTags
      .filter(tag => tag.toLowerCase().includes(q) && !pinnedTags.includes(tag) && !topNamesAll.has(tag))
      .slice(0, 8);
  }, [mode, searchQuery, allTags, pinnedTags, topNamesAll]);

  // ── Nodos/aristas (BARATO): top-N + pins, sobre los mapas ya memoizados.
  const graphData = useMemo(() => {
    const sorted = Array.from(coData.frequency.entries()).sort((a, b) => b[1] - a[1]);
    const topNames = new Set(sorted.slice(0, topN).map(([t]) => t));
    const combined: [string, number][] = sorted.slice(0, topN);
    if (mode === 'tags') {
      pinnedTags.forEach(tag => {
        if (!topNames.has(tag) && coData.frequency.has(tag)) combined.push([tag, coData.frequency.get(tag)!]);
      });
    }
    if (combined.length === 0) return { nodes: [] as Node[], links: [] as Link[], maxCount: 0 };

    const counts = combined.map(([, c]) => c);
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);

    const nodes: Node[] = combined.map(([id, count]) => ({
      id,
      label: mode === 'personas' ? (personsMap.get(id)?.display_name || id) : id,
      count,
      radius: 5 + ((count - minCount) / ((maxCount - minCount) || 1)) * 25,
      isPinned: mode === 'tags' && pinnedTags.includes(id) && !topNames.has(id),
      avatar: mode === 'personas' ? (personsMap.get(id)?.avatar_url || null) : null,
    }));

    const ids = new Set(nodes.map(n => n.id));
    const links: Link[] = [];
    const seen = new Set<string>();
    nodes.forEach(n => {
      const m = coData.co.get(n.id);
      if (!m) return;
      m.forEach((c, other) => {
        if (!ids.has(other)) return;
        const key = [n.id, other].sort().join('|');
        if (seen.has(key)) return;
        seen.add(key);
        links.push({ source: n.id, target: other, strength: c });
      });
    });
    return { nodes, links, maxCount };
  }, [coData, pinnedTags, topN, mode, personsMap]);

  // Archivos del nodo seleccionado (para el panel de preview)
  const selectedFiles = useMemo(() => {
    if (!selectedNode) return [] as MediaFile[];
    if (mode === 'tags') {
      return files.filter(f => (f.tags || []).includes(selectedNode));
    }
    return files.filter(f => (f.faces || []).some(face => face.person_id === selectedNode));
  }, [selectedNode, files, mode]);

  const selectedLabel = mode === 'personas'
    ? (personsMap.get(selectedNode || '')?.display_name || selectedNode)
    : selectedNode;

  // Handlers de pins
  const addPinnedTag = (tag: string) => {
    setPinnedTags(prev => (prev.includes(tag) ? prev : [...prev, tag]));
    setSearchQuery('');
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  };
  const removePinnedTag = (tag: string) => setPinnedTags(prev => prev.filter(t => t !== tag));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => (prev > 0 ? prev - 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && suggestions[highlightedIndex]) addPinnedTag(suggestions[highlightedIndex]);
      else if (suggestions.length > 0) addPinnedTag(suggestions[0]);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    }
  };

  // Salto a biblioteca filtrada por el nodo seleccionado
  const navigateToSelected = () => {
    if (!selectedNode) return;
    if (mode === 'tags') onTagClick?.(selectedNode);
    else onPersonClick?.(selectedNode);
  };

  // ── Render D3. Depende del dataset memoizado + dimensiones + etiquetas.
  useEffect(() => {
    if (!svgRef.current) return;
    const { nodes, links, maxCount } = graphData;

    d3.select(svgRef.current).selectAll('*').remove();
    if (nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    const width = dimensions.width;
    const height = dimensions.height;

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => { container.attr('transform', event.transform.toString()); });
    svg.call(zoom);

    const container = svg.append('g');

    const simulation = d3.forceSimulation(nodes as any)
      .force('link', d3.forceLink(links)
        .id((d: any) => d.id)
        .distance(400)
        .strength((d: any) => Math.min(d.strength / 30, 0.2)))
      .force('charge', d3.forceManyBody().strength(-2000))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius((d: any) => d.radius + 70))
      .force('x', d3.forceX(width / 2).strength(0.02))
      .force('y', d3.forceY(height / 2).strength(0.02));

    const link = container.append('g')
      .selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('stroke', PAL.link)
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', (d) => Math.min(d.strength / 2, 3));

    const node = container.append('g')
      .selectAll('g')
      .data(nodes)
      .enter().append('g')
      .attr('cursor', 'pointer')
      .call(d3.drag<any, any>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any);

    const getNodeColor = (n: any, isHighlighted = false) => {
      if (isHighlighted) return PAL.highlight;
      if (n.isPinned) return PAL.nodePinned;
      return mode === 'personas' ? PAL.nodePerson : PAL.node;
    };

    const isConnected = (a: any, bId: string) => links.some((l: any) =>
      (l.source.id === a && l.target.id === bId) || (l.target.id === a && l.source.id === bId));

    node.append('circle')
      .attr('r', (d) => d.radius)
      .attr('fill', (d: any) => getNodeColor(d, selectedNode === d.id))
      .attr('stroke', (d: any) => (selectedNode === d.id ? PAL.highlight : 'none'))
      .attr('stroke-width', 2)
      .on('mouseover', function (_event, d: any) {
        if (selectedNode !== d.id) d3.select(this).transition().duration(150).attr('fill', PAL.highlight);
        link
          .style('stroke-opacity', (l: any) => (l.source.id === d.id || l.target.id === d.id ? 0.85 : 0.08))
          .style('stroke', (l: any) => (l.source.id === d.id || l.target.id === d.id ? PAL.linkHi : PAL.link));
        node.select('circle').attr('fill', (n: any) => {
          if (selectedNode === n.id) return PAL.highlight;
          return n.id === d.id || isConnected(d.id, n.id) ? PAL.highlight : getNodeColor(n);
        });
        node.style('opacity', (n: any) => (n.id === d.id || isConnected(d.id, n.id) ? 1 : 0.3));
      })
      .on('mouseout', function () {
        node.select('circle').attr('fill', (n: any) => getNodeColor(n, selectedNode === n.id));
        link
          .style('stroke-opacity', (l: any) => (selectedNode && (l.source.id === selectedNode || l.target.id === selectedNode) ? 0.85 : 0.6))
          .style('stroke', (l: any) => (selectedNode && (l.source.id === selectedNode || l.target.id === selectedNode) ? PAL.linkHi : PAL.link));
        node.style('opacity', (n: any) => {
          if (!selectedNode) return 1;
          return n.id === selectedNode || isConnected(selectedNode, n.id) ? 1 : 0.3;
        });
      })
      .on('click', (_event, d: any) => {
        const next = d.id === selectedNode ? null : d.id;
        setSelectedNode(next);
        node.select('circle')
          .attr('fill', (n: any) => {
            if (!next) return getNodeColor(n);
            return n.id === next || isConnected(next, n.id) ? PAL.highlight : getNodeColor(n);
          })
          .attr('stroke', (n: any) => (n.id === next ? PAL.highlight : 'none'));
        link
          .style('stroke', (l: any) => (next && (l.source.id === next || l.target.id === next) ? PAL.linkHi : PAL.link))
          .style('stroke-opacity', (l: any) => (next && (l.source.id === next || l.target.id === next) ? 0.85 : 0.6));
        node.style('opacity', (n: any) => {
          if (!next) return 1;
          return n.id === next || isConnected(next, n.id) ? 1 : 0.3;
        });
      });

    // Avatares circulares en modo personas (imagen recortada sobre el circulo)
    if (mode === 'personas') {
      node.each(function (d: any) {
        const g = d3.select(this);
        if (d.avatar) {
          const clipId = `gv-clip-${safeId(d.id)}`;
          g.append('clipPath').attr('id', clipId).append('circle').attr('r', d.radius);
          g.append('image')
            .attr('href', avatarFullUrl(d.avatar))
            .attr('x', -d.radius).attr('y', -d.radius)
            .attr('width', d.radius * 2).attr('height', d.radius * 2)
            .attr('clip-path', `url(#${clipId})`)
            .attr('preserveAspectRatio', 'xMidYMid slice')
            .style('pointer-events', 'none');
        } else if (d.radius >= 10) {
          g.append('text')
            .text(initialsFrom(d.label))
            .attr('text-anchor', 'middle').attr('dy', '0.35em')
            .attr('font-size', Math.min(d.radius, 13))
            .attr('fill', PAL.noche).attr('font-weight', '700')
            .style('pointer-events', 'none').style('user-select', 'none');
        }
      });
    }

    if (showLabels) {
      node.append('text')
        .text((d) => d.label)
        .attr('text-anchor', 'middle')
        .attr('dy', (d) => d.radius + 15)
        .attr('font-size', (d) => Math.min(d.radius / 2 + 8, 14))
        .attr('fill', PAL.label)
        .attr('font-weight', (d) => (maxCount && d.count > maxCount * 0.5 ? 'bold' : 'normal'))
        .style('pointer-events', 'none').style('user-select', 'none');
    }

    node.append('title').text((d) => `${d.label}: ${d.count} archivos`);

    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    function dragstarted(event: any, d: any) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    }
    function dragged(event: any, d: any) { d.fx = event.x; d.fy = event.y; }
    function dragended(event: any, d: any) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
    }

    return () => { simulation.stop(); };
    // selectedNode no va en deps: su resaltado se aplica imperativamente en los
    // handlers para no reconstruir la simulacion en cada click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, dimensions, showLabels, mode]);

  const totalNodes = graphData.nodes.length;
  const totalLinks = graphData.links.length;
  const emptyPersonas = mode === 'personas' && totalNodes === 0;

  return (
    <div className="bg-tinta rounded-xl p-6 shadow-sm border border-borde-sutil">
      <div className="mb-4">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <h2 className="text-xl font-bold text-marfil">
            {mode === 'tags' ? 'Grafo de etiquetas' : 'Grafo de personas'}
          </h2>
          {/* Selector de modo */}
          <div className="flex items-center gap-1 bg-grafito rounded-lg p-1">
            <button
              onClick={() => setMode('tags')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors ${
                mode === 'tags' ? 'bg-lavanda text-noche' : 'text-niebla hover:text-marfil'
              }`}
            >
              <Hash className="w-4 h-4" /> Etiquetas
            </button>
            <button
              onClick={() => setMode('personas')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors ${
                mode === 'personas' ? 'bg-lavanda text-noche' : 'text-niebla hover:text-marfil'
              }`}
            >
              <Users className="w-4 h-4" /> Personas
            </button>
          </div>
        </div>

        <div className="flex items-center flex-wrap gap-4 text-sm text-niebla">
          <div className="flex items-center space-x-2">
            <div className="w-3 h-3 rounded-full" style={{ background: mode === 'personas' ? PAL.nodePerson : PAL.node }} />
            <span>{mode === 'personas' ? 'Personas' : `Top ${topN} etiquetas`}</span>
          </div>
          {mode === 'tags' && (
            <div className="flex items-center space-x-2">
              <div className="w-3 h-3 rounded-full" style={{ background: PAL.nodePinned }} />
              <span>Etiquetas añadidas</span>
            </div>
          )}
          <div className="flex items-center space-x-2">
            <div className="w-8 h-0.5" style={{ background: PAL.link }} />
            <span>Co-ocurrencia</span>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-3 h-3 rounded-full" style={{ background: PAL.highlight }} />
            <span>Seleccionada</span>
          </div>
          <span className="text-humo">· {totalNodes} nodos, {totalLinks} conexiones</span>
        </div>
      </div>

      <div className="flex gap-4" style={{ height: '600px' }}>
        {/* Lienzo del grafo */}
        <div className="flex-1 relative bg-noche rounded-lg overflow-hidden border border-borde-sutil">
          <svg
            ref={svgRef}
            width={dimensions.width}
            height={dimensions.height}
            className="w-full h-full"
            style={{ cursor: 'grab' }}
          />

          {emptyPersonas && (
            <div className="absolute inset-0 flex items-center justify-center text-center px-8">
              <div>
                <Users className="w-10 h-10 text-lavanda-archivo mx-auto mb-3" />
                <p className="text-niebla text-sm">
                  Aún no hay personas que coaparezcan en tus archivos.
                  <br />Identifica caras desde <span className="text-lavanda">Personas</span> y re-identifica la biblioteca.
                </p>
              </div>
            </div>
          )}

          <div className="absolute bottom-4 right-4 text-xs text-humo bg-tinta/90 px-2 py-1 rounded">
            Arrastra para mover · Scroll para zoom · Click para seleccionar
          </div>
        </div>

        {/* Panel lateral */}
        <div className="w-72 flex flex-col bg-grafito rounded-lg p-4 overflow-hidden">
          {/* Controles de visualizacion */}
          <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-borde-sutil">
            <label className="flex items-center gap-2 text-xs text-niebla">
              Top
              <select
                value={topN}
                onChange={(e) => setTopN(Number(e.target.value))}
                className="bg-tinta border border-pizarra rounded-md px-2 py-1 text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
              >
                {[50, 100, 150, 200].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button
              onClick={() => setShowLabels(v => !v)}
              className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                showLabels ? 'border-lavanda text-lavanda' : 'border-pizarra text-humo hover:text-niebla'
              }`}
            >
              Etiquetas {showLabels ? 'on' : 'off'}
            </button>
          </div>

          {/* Buscador de pins (solo modo tags) */}
          {mode === 'tags' && (
            <>
              <h3 className="text-sm font-semibold text-marfil mb-3 flex items-center gap-2">
                <Plus className="w-4 h-4" /> Añadir etiquetas al grafo
              </h3>
              <div className="relative mb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-humo" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); setShowSuggestions(true); setHighlightedIndex(-1); }}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                    onKeyDown={handleKeyDown}
                    placeholder="Buscar etiqueta..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-pizarra rounded-lg focus:outline-none focus:ring-2 focus:ring-lavanda bg-tinta text-marfil placeholder-humo"
                  />
                </div>
                {showSuggestions && suggestions.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-tinta border border-pizarra rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                    {suggestions.map((tag, index) => (
                      <button
                        key={tag}
                        onClick={() => addPinnedTag(tag)}
                        className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between hover:bg-lavanda/15 ${
                          index === highlightedIndex ? 'bg-lavanda/20' : ''
                        }`}
                      >
                        <span className="text-marfil truncate">{tag}</span>
                        <span className="text-xs text-humo ml-2">{coData.frequency.get(tag) || 0}</span>
                      </button>
                    ))}
                  </div>
                )}
                {showSuggestions && searchQuery.trim() && suggestions.length === 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-tinta border border-pizarra rounded-lg shadow-lg z-50 p-3">
                    <p className="text-sm text-humo text-center">No se encontraron etiquetas</p>
                  </div>
                )}
              </div>

              {pinnedTags.length > 0 && (
                <div className="mb-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-humo">
                      {pinnedTags.length} añadida{pinnedTags.length !== 1 ? 's' : ''}
                    </span>
                    <button onClick={() => setPinnedTags([])} className="text-xs text-lavanda hover:text-lavanda-claro transition-colors">
                      Limpiar todas
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {pinnedTags.map(tag => (
                      <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-bruma/20 text-marfil">
                        <Tag className="w-3 h-3 text-bruma" />
                        <span className="truncate max-w-[120px]">{tag}</span>
                        <button onClick={() => removePinnedTag(tag)} className="text-humo hover:text-estado-error">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Panel de preview del nodo seleccionado */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {selectedNode ? (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {mode === 'personas' ? <Users className="w-4 h-4 text-lavanda flex-shrink-0" /> : <Tag className="w-4 h-4 text-lavanda flex-shrink-0" />}
                    <span className="text-sm font-semibold text-marfil truncate">{selectedLabel}</span>
                  </div>
                  <button onClick={() => setSelectedNode(null)} className="p-1 text-humo hover:text-marfil rounded">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <p className="text-xs text-humo mb-3">{selectedFiles.length} archivo{selectedFiles.length !== 1 ? 's' : ''}</p>
                <div className="grid grid-cols-3 gap-1.5 mb-3">
                  {selectedFiles.slice(0, 12).map(f => (
                    <div key={f.id} className="aspect-square rounded overflow-hidden bg-noche">
                      {f.thumbnail && (
                        <img
                          src={f.thumbnail}
                          alt={f.name}
                          loading="lazy"
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                        />
                      )}
                    </div>
                  ))}
                </div>
                {selectedFiles.length > 0 && (
                  <button
                    onClick={navigateToSelected}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-lavanda text-noche hover:bg-lavanda-claro transition-colors"
                  >
                    <ArrowRight className="w-4 h-4" />
                    Ver los {selectedFiles.length} en la biblioteca
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-32 text-center">
                <Eye className="w-8 h-8 text-lavanda-archivo mb-2" />
                <p className="text-sm text-humo">
                  Selecciona un nodo para previsualizar sus archivos y saltar a la biblioteca.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
