import React, { useRef, useEffect, useState } from 'react';
import * as d3 from 'd3';
import { Search, X, Plus, Tag } from 'lucide-react';
import { MediaFile } from '../types';
import { buildApiUrl } from '../config';

interface GraphViewProps {
  files: MediaFile[];
}

interface Node {
  id: string;
  label: string;
  count: number;
  radius: number;
  isPinned?: boolean;
}

interface Link {
  source: string;
  target: string;
  strength: number;
}

export default function GraphView({ files }: GraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  // New states for pinned tags functionality
  const [pinnedTags, setPinnedTags] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [allTags, setAllTags] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [hoveredPinnedTag, setHoveredPinnedTag] = useState<string | null>(null);

  useEffect(() => {
    const updateDimensions = () => {
      const container = svgRef.current?.parentElement;
      if (container) {
        setDimensions({
          width: container.clientWidth,
          height: Math.min(container.clientHeight || 600, 600)
        });
      }
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  // Fetch all available tags on mount
  useEffect(() => {
    const fetchTags = async () => {
      try {
        const response = await fetch(buildApiUrl('tags'));
        const result = await response.json();
        if (result.success && result.data?.allTags) {
          setAllTags(result.data.allTags);
        }
      } catch (error) {
        console.error('Error fetching tags:', error);
      }
    };
    fetchTags();
  }, []);

  // Calculate tag frequency map (used for filtering suggestions)
  const tagFrequencyMap = React.useMemo(() => {
    const freq = new Map<string, number>();
    files.forEach(file => {
      file.tags.forEach(tag => {
        freq.set(tag, (freq.get(tag) || 0) + 1);
      });
    });
    return freq;
  }, [files]);

  // Get top 100 tag names for filtering
  const top100TagNames = React.useMemo(() => {
    return new Set(
      Array.from(tagFrequencyMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
        .map(([tag]) => tag)
    );
  }, [tagFrequencyMap]);

  // Filter suggestions based on search query
  const suggestions = React.useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    return allTags
      .filter(tag =>
        tag.toLowerCase().includes(query) &&
        !pinnedTags.includes(tag) &&
        !top100TagNames.has(tag) // Only show tags not already in the graph
      )
      .slice(0, 8);
  }, [searchQuery, allTags, pinnedTags, top100TagNames]);

  // Handler functions
  const addPinnedTag = (tag: string) => {
    if (!pinnedTags.includes(tag)) {
      setPinnedTags(prev => [...prev, tag]);
    }
    setSearchQuery('');
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  };

  const removePinnedTag = (tag: string) => {
    setPinnedTags(prev => prev.filter(t => t !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev =>
        prev < suggestions.length - 1 ? prev + 1 : prev
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => prev > 0 ? prev - 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && suggestions[highlightedIndex]) {
        addPinnedTag(suggestions[highlightedIndex]);
      } else if (suggestions.length > 0) {
        addPinnedTag(suggestions[0]);
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    }
  };

  useEffect(() => {
    if (!svgRef.current || files.length === 0) return;

    // Calculate tag frequencies
    const tagFrequency = new Map<string, number>();
    const tagCoOccurrence = new Map<string, Map<string, number>>();

    files.forEach(file => {
      file.tags.forEach(tag => {
        tagFrequency.set(tag, (tagFrequency.get(tag) || 0) + 1);
        
        // Track co-occurrences
        file.tags.forEach(otherTag => {
          if (tag !== otherTag) {
            if (!tagCoOccurrence.has(tag)) {
              tagCoOccurrence.set(tag, new Map());
            }
            const coMap = tagCoOccurrence.get(tag)!;
            coMap.set(otherTag, (coMap.get(otherTag) || 0) + 1);
          }
        });
      });
    });

    // Get top 100 tags by frequency
    const sortedTags = Array.from(tagFrequency.entries())
      .sort((a, b) => b[1] - a[1]);

    const top100Tags = sortedTags.slice(0, 100);
    const top100TagNames = new Set(top100Tags.map(([tag]) => tag));

    // Add pinned tags that are not in top 100
    const combinedTags: [string, number][] = [...top100Tags];
    pinnedTags.forEach(tag => {
      if (!top100TagNames.has(tag) && tagFrequency.has(tag)) {
        combinedTags.push([tag, tagFrequency.get(tag)!]);
      }
    });

    if (combinedTags.length === 0) return;

    const maxCount = combinedTags[0][1];
    const minCount = combinedTags[combinedTags.length - 1][1];

    // Create nodes
    const nodes: Node[] = combinedTags.map(([tag, count]) => ({
      id: tag,
      label: tag,
      count: count,
      radius: 5 + (count - minCount) / (maxCount - minCount || 1) * 25, // Node size from 5 to 30
      isPinned: pinnedTags.includes(tag) && !top100TagNames.has(tag)
    }));

    // Create links based on co-occurrence
    const links: Link[] = [];
    const processedPairs = new Set<string>();

    nodes.forEach(node => {
      const coMap = tagCoOccurrence.get(node.id);
      if (coMap) {
        nodes.forEach(otherNode => {
          if (node.id !== otherNode.id) {
            const pairKey = [node.id, otherNode.id].sort().join('|');
            if (!processedPairs.has(pairKey)) {
              const coCount = coMap.get(otherNode.id) || 0;
              if (coCount > 0) {
                links.push({
                  source: node.id,
                  target: otherNode.id,
                  strength: coCount
                });
                processedPairs.add(pairKey);
              }
            }
          }
        });
      }
    });

    // Clear previous graph
    d3.select(svgRef.current).selectAll('*').remove();

    const svg = d3.select(svgRef.current);
    const width = dimensions.width;
    const height = dimensions.height;

    // Create zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        container.attr('transform', event.transform.toString());
      });

    svg.call(zoom);

    const container = svg.append('g');

    // Create force simulation with much more spacing
    const simulation = d3.forceSimulation(nodes as any)
      .force('link', d3.forceLink(links)
        .id((d: any) => d.id)
        .distance(400)  // Increased from 250 to 400
        .strength((d: any) => Math.min(d.strength / 30, 0.2)))  // Further reduced strength
      .force('charge', d3.forceManyBody().strength(-2000))  // Increased repulsion from -1000 to -2000
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius((d: any) => d.radius + 70))  // Increased collision radius from 40 to 70
      .force('x', d3.forceX(width / 2).strength(0.02))  // Further reduced centering force
      .force('y', d3.forceY(height / 2).strength(0.02));  // Further reduced centering force

    // Add links
    const link = container.append('g')
      .selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('stroke', '#ffd3b9')
      .attr('stroke-opacity', 0.5)
      .attr('stroke-width', (d) => Math.min(d.strength / 2, 3));

    // Add nodes
    const node = container.append('g')
      .selectAll('g')
      .data(nodes)
      .enter().append('g')
      .attr('cursor', 'pointer')
      .call(d3.drag<any, any>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any);

    // Helper function to get node color based on state
    const getNodeColor = (n: any, isHighlighted: boolean = false) => {
      if (isHighlighted) return '#f56845'; // Jaffa for highlighted/selected
      return n.isPinned ? '#28568c' : '#fac6a8'; // St Tropaz for pinned, Apricot for normal
    };

    // Add circles for nodes
    node.append('circle')
      .attr('r', (d) => d.radius)
      .attr('fill', (d: any) => getNodeColor(d))
      .on('mouseover', function(event, d: any) {
        // Don't change color on hover if already selected
        if (selectedNode !== d.id) {
          d3.select(this)
            .transition()
            .duration(200)
            .attr('fill', '#f56845');
        }

        // Highlight connected links
        link
          .style('stroke-opacity', (l: any) =>
            l.source.id === d.id || l.target.id === d.id ? 0.8 : 0.1
          )
          .style('stroke', (l: any) =>
            l.source.id === d.id || l.target.id === d.id ? '#f56845' : '#ffd3b9'
          );

        // Highlight connected nodes
        node.select('circle').attr('fill', function(n: any) {
          if (selectedNode === n.id) return '#f56845'; // Keep selected node color
          const isConnected = links.some((l: any) =>
            (l.source.id === d.id && l.target.id === n.id) ||
            (l.target.id === d.id && l.source.id === n.id)
          );
          return n.id === d.id || isConnected ? '#f56845' : getNodeColor(n);
        });
        
        node.style('opacity', (n: any) => {
          const isConnected = links.some((l: any) => 
            (l.source.id === d.id && l.target.id === n.id) ||
            (l.target.id === d.id && l.source.id === n.id)
          );
          return n.id === d.id || isConnected ? 1 : 0.3;
        });
      })
      .on('mouseout', function(event, d: any) {
        // Reset colors except for selected node
        node.select('circle').attr('fill', (n: any) =>
          selectedNode === n.id ? '#f56845' : getNodeColor(n)
        );
        
        // Reset link colors and opacity
        link
          .style('stroke-opacity', (l: any) => {
            if (selectedNode) {
              return l.source.id === selectedNode || l.target.id === selectedNode ? 0.8 : 0.4;
            }
            return 0.4;
          })
          .style('stroke', (l: any) => {
            if (selectedNode && (l.source.id === selectedNode || l.target.id === selectedNode)) {
              return '#f56845';
            }
            return '#ffd3b9';
          });
        
        // Reset node opacity
        if (selectedNode) {
          node.style('opacity', (n: any) => {
            const isConnected = links.some((l: any) => 
              (l.source.id === selectedNode && l.target.id === n.id) ||
              (l.target.id === selectedNode && l.source.id === n.id)
            );
            return n.id === selectedNode || isConnected ? 1 : 0.3;
          });
        } else {
          node.style('opacity', 1);
        }
      })
      .on('click', (event, d: any) => {
        const newSelectedNode = d.id === selectedNode ? null : d.id;
        setSelectedNode(newSelectedNode);

        // Update persistent selection colors
        node.select('circle').attr('fill', (n: any) => {
          if (!newSelectedNode) return getNodeColor(n);
          const isConnected = links.some((l: any) =>
            (l.source.id === newSelectedNode && l.target.id === n.id) ||
            (l.target.id === newSelectedNode && l.source.id === n.id)
          );
          return n.id === newSelectedNode || isConnected ? '#f56845' : getNodeColor(n);
        });
        
        // Update link colors
        link
          .style('stroke', (l: any) => {
            if (!newSelectedNode) return '#ffd3b9';
            return l.source.id === newSelectedNode || l.target.id === newSelectedNode ? '#f56845' : '#ffd3b9';
          })
          .style('stroke-opacity', (l: any) => {
            if (!newSelectedNode) return 0.4;
            return l.source.id === newSelectedNode || l.target.id === newSelectedNode ? 0.8 : 0.4;
          });
        
        // Update node opacity
        node.style('opacity', (n: any) => {
          if (!newSelectedNode) return 1;
          const isConnected = links.some((l: any) => 
            (l.source.id === newSelectedNode && l.target.id === n.id) ||
            (l.target.id === newSelectedNode && l.source.id === n.id)
          );
          return n.id === newSelectedNode || isConnected ? 1 : 0.3;
        });
      });

    // Add labels
    node.append('text')
      .text((d) => d.label)
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => d.radius + 15)
      .attr('font-size', (d) => Math.min(d.radius / 2 + 8, 14))
      .attr('fill', '#4a4544')
      .attr('font-weight', (d) => d.count > maxCount * 0.5 ? 'bold' : 'normal')
      .style('pointer-events', 'none')
      .style('user-select', 'none');

    // Add count labels on hover
    node.append('title')
      .text((d) => `${d.label}: ${d.count} archivos`);

    // Update positions on simulation tick
    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);

      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    // Drag functions
    function dragstarted(event: any, d: any) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event: any, d: any) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(event: any, d: any) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }

    // Cleanup
    return () => {
      simulation.stop();
    };
  }, [files, dimensions, pinnedTags]);

  // Effect to highlight node when hovering pinned tag in sidebar
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const container = svg.select('g');
    if (container.empty()) return;

    const nodeGroups = container.selectAll('g').filter(function() {
      return d3.select(this).select('circle').size() > 0;
    });
    const links = container.selectAll('line');

    if (hoveredPinnedTag) {
      // Highlight the hovered node
      nodeGroups.each(function(d: any) {
        if (!d || !d.id) return;
        const nodeGroup = d3.select(this);
        const circle = nodeGroup.select('circle');

        if (d.id === hoveredPinnedTag) {
          circle.transition().duration(200).attr('fill', '#f56845');
          nodeGroup.style('opacity', 1);
        } else {
          // Check if connected to hovered node
          const isConnected = links.data().some((l: any) =>
            (l.source?.id === hoveredPinnedTag && l.target?.id === d.id) ||
            (l.target?.id === hoveredPinnedTag && l.source?.id === d.id)
          );
          if (isConnected) {
            circle.transition().duration(200).attr('fill', '#f56845');
            nodeGroup.style('opacity', 1);
          } else {
            circle.transition().duration(200).attr('fill', d.isPinned ? '#28568c' : '#fac6a8');
            nodeGroup.style('opacity', 0.3);
          }
        }
      });

      // Highlight connected links
      links
        .style('stroke-opacity', (l: any) =>
          l.source?.id === hoveredPinnedTag || l.target?.id === hoveredPinnedTag ? 0.8 : 0.1
        )
        .style('stroke', (l: any) =>
          l.source?.id === hoveredPinnedTag || l.target?.id === hoveredPinnedTag ? '#f56845' : '#ffd3b9'
        );
    } else {
      // Reset all nodes and links
      nodeGroups.each(function(d: any) {
        if (!d || !d.id) return;
        const nodeGroup = d3.select(this);
        const circle = nodeGroup.select('circle');
        circle.transition().duration(200).attr('fill', d.isPinned ? '#28568c' : '#fac6a8');
        nodeGroup.style('opacity', 1);
      });

      links
        .style('stroke-opacity', 0.5)
        .style('stroke', '#ffd3b9');
    }
  }, [hoveredPinnedTag]);

  // Calculate stats
  const tagStats = () => {
    const tagFrequency = new Map<string, number>();
    files.forEach(file => {
      file.tags.forEach(tag => {
        tagFrequency.set(tag, (tagFrequency.get(tag) || 0) + 1);
      });
    });
    
    const totalTags = tagFrequency.size;
    const totalConnections = files.filter(f => f.tags.length > 1).length;
    
    return { totalTags, totalConnections };
  };

  const stats = tagStats();

  return (
    <div className="bg-tinta rounded-xl p-6 shadow-sm border border-slate-200">
      <div className="mb-4">
        <h2 className="text-xl font-bold text-slate-900 mb-2">Vista de Grafo de Etiquetas</h2>
        <div className="flex items-center flex-wrap gap-4 text-sm text-slate-600">
          <div className="flex items-center space-x-2">
            <div className="w-3 h-3 rounded-full bg-lavanda-claro"></div>
            <span>Top 100 etiquetas</span>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-3 h-3 rounded-full bg-bruma"></div>
            <span>Etiquetas añadidas</span>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-8 h-0.5 bg-melocoton"></div>
            <span>Co-ocurrencia</span>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-3 h-3 rounded-full bg-lavanda"></div>
            <span>Seleccionadas</span>
          </div>
        </div>
        {selectedNode && (
          <div className="mt-2 p-2 bg-lavanda-claro bg-opacity-20 rounded-lg">
            <span className="text-sm font-medium text-marfil">
              Etiqueta seleccionada: {selectedNode}
            </span>
          </div>
        )}
      </div>

      <div className="flex gap-4" style={{ height: '600px' }}>
        {/* Graph container */}
        <div className="flex-1 relative bg-noche rounded-lg overflow-hidden">
          <svg
            ref={svgRef}
            width={dimensions.width}
            height={dimensions.height}
            className="w-full h-full"
            style={{ cursor: 'grab' }}
          />

          <div className="absolute bottom-4 right-4 text-xs text-slate-500 bg-tinta bg-opacity-90 px-2 py-1 rounded">
            Arrastra para mover • Scroll para zoom • Click para seleccionar
          </div>
        </div>

        {/* Sidebar for pinned tags */}
        <div className="w-64 flex flex-col bg-grafito rounded-lg p-4">
          <h3 className="text-sm font-semibold text-marfil mb-3 flex items-center gap-2">
            <Plus className="w-4 h-4" />
            Añadir etiquetas al grafo
          </h3>

          {/* Search input with autocomplete */}
          <div className="relative mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowSuggestions(true);
                  setHighlightedIndex(-1);
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                onKeyDown={handleKeyDown}
                placeholder="Buscar etiqueta..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-pizarra rounded-lg focus:outline-none focus:ring-2 focus:ring-lavanda focus:border-transparent bg-tinta"
              />
            </div>

            {/* Suggestions dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-tinta border border-pizarra rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                {suggestions.map((tag, index) => (
                  <button
                    key={tag}
                    onClick={() => addPinnedTag(tag)}
                    className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between hover:bg-lavanda-claro hover:bg-opacity-20 ${
                      index === highlightedIndex ? 'bg-lavanda-claro bg-opacity-30' : ''
                    }`}
                  >
                    <span className="text-marfil truncate">{tag}</span>
                    <span className="text-xs text-slate-400 ml-2">
                      {tagFrequencyMap.get(tag) || 0}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* No results message */}
            {showSuggestions && searchQuery.trim() && suggestions.length === 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-tinta border border-pizarra rounded-lg shadow-lg z-50 p-3">
                <p className="text-sm text-slate-500 text-center">
                  No se encontraron etiquetas
                </p>
              </div>
            )}
          </div>

          {/* Pinned tags list */}
          <div className="flex-1 overflow-y-auto">
            {pinnedTags.length > 0 ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-500">
                    {pinnedTags.length} etiqueta{pinnedTags.length !== 1 ? 's' : ''} añadida{pinnedTags.length !== 1 ? 's' : ''}
                  </span>
                  <button
                    onClick={() => setPinnedTags([])}
                    className="text-xs text-lavanda hover:text-lavanda-archivo transition-colors"
                  >
                    Limpiar todas
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {pinnedTags.map(tag => (
                    <div
                      key={tag}
                      className={`flex items-center justify-between px-3 py-2 rounded-lg group cursor-pointer transition-colors ${
                        hoveredPinnedTag === tag
                          ? 'bg-lavanda bg-opacity-30'
                          : 'bg-bruma bg-opacity-20 hover:bg-bruma hover:bg-opacity-30'
                      }`}
                      onMouseEnter={() => setHoveredPinnedTag(tag)}
                      onMouseLeave={() => setHoveredPinnedTag(null)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Tag className={`w-3 h-3 flex-shrink-0 ${
                          hoveredPinnedTag === tag ? 'text-lavanda' : 'text-bruma'
                        }`} />
                        <span className="text-sm text-marfil truncate">{tag}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removePinnedTag(tag);
                        }}
                        className="p-1 text-slate-400 hover:text-lavanda hover:bg-tinta rounded transition-colors flex-shrink-0"
                        title="Eliminar etiqueta"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-32 text-center">
                <Tag className="w-8 h-8 text-slate-300 mb-2" />
                <p className="text-sm text-slate-500">
                  Busca y añade etiquetas para ver sus conexiones en el grafo
                </p>
              </div>
            )}
          </div>

          {/* Info text */}
          <div className="mt-4 pt-3 border-t border-pizarra">
            <p className="text-xs text-slate-500">
              Las etiquetas añadidas se conectarán con los nodos del grafo con los que compartan archivos.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}