import React, { useState, useRef, useEffect } from 'react';
import { Search, X, Tag, Calendar, MinusCircle, Sparkles, Hash, Loader2 } from 'lucide-react';
import { SearchFilters } from '../types';
import { buildApiUrl, API_CONFIG } from '../config';

// Schema canónico del intent que devuelve el LLM (ver aiSearchService.js).
export interface NaturalIntent {
  type?: string | null;
  year?: string | null;
  month?: string | null;
  month_name?: string | null;
  person_ids?: string[];
  space_ids?: string[];
  tags?: string[];
  free_terms?: string[];
  shot_type?: string | null;
  people_framing?: string | null;
  movement_type?: string | null;
  exposure?: string | null;
  color_terms?: string[];
}

interface TagsData {
  allTags: string[];
  topTags?: { tag: string; count: number }[];
  years: string[];
  months: string[];
  dateRange: {
    earliest: string;
    latest: string;
  } | null;
  totalFiles: number;
  filesWithDates: number;
}

interface SearchBarProps {
  onSearch: (query: string, filters: SearchFilters) => void;
  placeholder?: string;
  includedTags?: string[]; // Etiquetas incluidas desde el componente padre
  excludedTags?: string[]; // Etiquetas excluidas desde el componente padre
  onTagsChange?: (tags: { included: string[]; excluded: string[] }) => void; // Callback cuando cambian las etiquetas
  // Modo Natural: el padre recibe los fileIds ordenados por score y el intent extraído.
  // Si fileIds === null, se borra el filtro natural y se vuelve al flujo normal.
  onNaturalSearch?: (fileIds: string[] | null, intent: NaturalIntent | null) => void;
}

type SearchMode = 'tags' | 'natural';

export default function SearchBar({ onSearch, placeholder = "Buscar archivos...", includedTags = [], excludedTags = [], onTagsChange, onNaturalSearch }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>({ type: 'all' });
  const [localIncludedTags, setLocalIncludedTags] = useState<string[]>(includedTags);
  const [localExcludedTags, setLocalExcludedTags] = useState<string[]>(excludedTags);
  const [tagsData, setTagsData] = useState<TagsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);

  // Modo dual de búsqueda. Persiste en localStorage entre sesiones.
  const [searchMode, setSearchMode] = useState<SearchMode>(() => {
    if (typeof window === 'undefined') return 'tags';
    const saved = window.localStorage.getItem('pensadero.searchMode');
    return saved === 'natural' ? 'natural' : 'tags';
  });
  const [naturalLoading, setNaturalLoading] = useState(false);
  const [naturalIntent, setNaturalIntent] = useState<NaturalIntent | null>(null);
  const [naturalNotice, setNaturalNotice] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('pensadero.searchMode', searchMode);
    }
  }, [searchMode]);

  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Helper function to normalize strings (remove accents/tildes)
  const normalizeString = (str: string): string => {
    return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  };

  // All active tags (included + excluded)
  const allActiveTags = [...localIncludedTags, ...localExcludedTags];

  // Filter suggestions based on query from real backend data (accent-insensitive)
  const suggestions = (tagsData?.allTags || []).filter(tag =>
    normalizeString(tag).includes(normalizeString(query)) && !allActiveTags.includes(tag)
  ).slice(0, 8);

  // Fetch available tags from backend
  const fetchTags = async () => {
    try {
      setLoading(true);
      const response = await fetch(buildApiUrl('tags'));
      const result = await response.json();
      
      if (result.success) {
        setTagsData(result.data);
      }
    } catch (error) {
      console.error('Error fetching tags:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
        setShowFilters(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Close suggestions and filters when pressing ESC
        setShowSuggestions(false);
        setShowFilters(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Fetch tags when component mounts
  useEffect(() => {
    fetchTags();
  }, []);

  // Sync with parent's tags
  useEffect(() => {
    setLocalIncludedTags(includedTags);
    setLocalExcludedTags(excludedTags);
  }, [includedTags, excludedTags]);

  const handleSearch = () => {
    // Regular search mode
    onSearch(query, {
      ...filters,
      tags: localIncludedTags.length > 0 ? localIncludedTags : undefined
    });
  };

  // Lanza búsqueda en lenguaje natural contra Ollama (vía /api/ai/search).
  // Si Ollama no está disponible, cae con elegancia a búsqueda textual normal.
  const runNaturalSearch = async () => {
    const q = query.trim();
    if (!q) return;

    setNaturalLoading(true);
    setNaturalNotice(null);
    setNaturalIntent(null);

    try {
      const res = await fetch(`${API_CONFIG.apiUrl}/ai/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q })
      });

      if (res.status === 503) {
        // Ollama caído: aviso amable y fallback a búsqueda textual normal.
        // CONSERVAR los filtros activos (tags, etc.), no destruirlos.
        setNaturalNotice('Búsqueda inteligente no disponible. He buscado como texto.');
        onNaturalSearch?.(null, null);
        onSearch(q, {
          ...filters,
          tags: localIncludedTags.length > 0 ? localIncludedTags : undefined
        });
        return;
      }

      const json = await res.json();
      if (!json || !json.success) {
        throw new Error(json?.error || 'Respuesta inválida del servidor');
      }

      const fileIds = Array.isArray(json.results) ? json.results.map((r: any) => r.fileId) : [];
      setNaturalIntent(json.intent || null);
      onNaturalSearch?.(fileIds, json.intent || null);
    } catch (err: any) {
      console.warn('[SearchBar] Búsqueda natural falló:', err);
      setNaturalNotice('No he podido procesar la consulta. Buscando como texto.');
      onNaturalSearch?.(null, null);
      onSearch(q, {
        ...filters,
        tags: localIncludedTags.length > 0 ? localIncludedTags : undefined
      });
    } finally {
      setNaturalLoading(false);
    }
  };

  // Cambiar de modo NO destruye filtros activos. Búsqueda natural y tags
  // son capas que se combinan AND con el resto de filtros (tipos, fechas,
  // personas, favoritos). Solo "Limpiar" destruye filtros explícitamente.
  const switchMode = (next: SearchMode) => {
    if (next === searchMode) return;
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
    setNaturalNotice(null);
    if (next === 'tags') {
      // Al pasar a tags: limpiar resultados de búsqueda natural (la query
      // que generó esos resultados ya no aplica como modo activo).
      setNaturalIntent(null);
      onNaturalSearch?.(null, null);
    }
    setSearchMode(next);
    setQuery('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setSelectedSuggestionIndex(-1);
    // Show suggestions when there's a query
    setShowSuggestions(e.target.value.length > 0);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchMode === 'natural') {
        // En modo natural Enter siempre lanza búsqueda LLM (sin Shift+Enter ni autocompletado).
        if (query.trim()) runNaturalSearch();
        return;
      }
      if (e.shiftKey && query.trim()) {
        // Shift+Enter: Convert the query into a tag
        addTag(query.trim());
      } else if (selectedSuggestionIndex >= 0 && suggestions[selectedSuggestionIndex]) {
        // Enter with selected suggestion: Add as tag
        addTag(suggestions[selectedSuggestionIndex]);
      } else if (query.trim() || allActiveTags.length > 0) {
        // Enter solo: Perform regular text search (no convertir a etiqueta)
        handleSearch();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.length > 0) {
        setSelectedSuggestionIndex(prev => 
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestions.length > 0) {
        setSelectedSuggestionIndex(prev => 
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setShowSuggestions(false);
      setSelectedSuggestionIndex(-1);
    }
  };

  // Añadir tag como incluida (desde sugerencias o input)
  const addTag = (tag: string) => {
    if (!allActiveTags.includes(tag)) {
      const newIncluded = [...localIncludedTags, tag];
      setLocalIncludedTags(newIncluded);
      setQuery('');
      setShowSuggestions(false);
      setSelectedSuggestionIndex(-1);

      // Delay focus to give React time to update the query state
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);

      // Notify parent about tags change
      onTagsChange?.({ included: newIncluded, excluded: localExcludedTags });

      // Automatically perform search with the new tags
      onSearch('', { ...filters, tags: newIncluded });
    }
  };

  // Ciclo de estados al hacer click en una tag activa
  // Inactiva → Incluida → Excluida → Inactiva
  const cycleTagState = (tag: string) => {
    const isIncluded = localIncludedTags.includes(tag);
    const isExcluded = localExcludedTags.includes(tag);

    let newIncluded = [...localIncludedTags];
    let newExcluded = [...localExcludedTags];

    if (isIncluded) {
      // Incluida → Excluida
      newIncluded = newIncluded.filter(t => t !== tag);
      newExcluded = [...newExcluded, tag];
      console.log(`🏷️ Etiqueta "${tag}": Incluida → Excluida`);
    } else if (isExcluded) {
      // Excluida → Inactiva (desactivar)
      newExcluded = newExcluded.filter(t => t !== tag);
      console.log(`🏷️ Etiqueta "${tag}": Excluida → Desactivada`);
    }

    setLocalIncludedTags(newIncluded);
    setLocalExcludedTags(newExcluded);

    // Notify parent about tags change
    onTagsChange?.({ included: newIncluded, excluded: newExcluded });

    // Automatically update search
    if (newIncluded.length > 0 || newExcluded.length > 0) {
      onSearch('', { ...filters, tags: newIncluded.length > 0 ? newIncluded : undefined });
    } else {
      // If no tags left, show all files
      onSearch('', { ...filters, tags: undefined });
    }
  };

  // Eliminar tag completamente (botón X)
  const removeTag = (tag: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Evitar que el click se propague al contenedor de la tag

    const newIncluded = localIncludedTags.filter(t => t !== tag);
    const newExcluded = localExcludedTags.filter(t => t !== tag);

    setLocalIncludedTags(newIncluded);
    setLocalExcludedTags(newExcluded);

    // Notify parent about tags change
    onTagsChange?.({ included: newIncluded, excluded: newExcluded });

    // Automatically update search when removing tags
    if (newIncluded.length > 0 || newExcluded.length > 0) {
      onSearch('', { ...filters, tags: newIncluded.length > 0 ? newIncluded : undefined });
    } else {
      // If no tags left, show all files
      onSearch('', { ...filters, tags: undefined });
    }
  };

  const clearFilters = () => {
    setFilters({ type: 'all' });
    setLocalIncludedTags([]);
    setLocalExcludedTags([]);
    setQuery('');
    // Limpieza también del estado de búsqueda natural — evita resultados zombie
    setNaturalIntent(null);
    setNaturalNotice(null);
    onNaturalSearch?.(null, null);
    // Reset search to show all files
    onSearch('', { type: 'all' });
    // Notify parent about clearing tags
    onTagsChange?.({ included: [], excluded: [] });
  };

  const hasActiveFilters = () => {
    return localIncludedTags.length > 0 ||
           localExcludedTags.length > 0 ||
           query ||
           filters.type !== 'all' ||
           filters.favorites ||
           filters.dateFrom ||
           filters.dateTo ||
           filters.year ||
           filters.month;
  };


  const isNatural = searchMode === 'natural';

  return (
    <div ref={searchRef} className="relative w-full">
      <div className={`rounded-full shadow-sm border p-1 transition-all duration-300 ${
        isNatural ? 'bg-grafito border-lavanda/40' : 'bg-pizarra border-borde-sutil'
      }`}>
        <div className="flex items-center space-x-2 md:space-x-3 px-3 py-2 md:px-4 md:py-3">
          {isNatural
            ? <Sparkles className="w-5 h-5 text-lavanda" />
            : <Search className="w-5 h-5 text-humo" />}

          {/* Selected tags - Incluidas (lavanda) y excluidas (rosa apagado).
              Siempre visibles, también en modo Natural: las tags activas siguen
              filtrando AND sobre los resultados aunque la búsqueda sea LLM. */}
          <div className="flex flex-wrap items-center gap-2 flex-1">
            {localIncludedTags.map((tag) => (
              <span
                key={`inc-${tag}`}
                onClick={() => cycleTagState(tag)}
                className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-lavanda text-noche font-medium cursor-pointer hover:bg-lavanda-claro transition-all duration-200 select-none"
                title="Click para excluir esta etiqueta"
              >
                <Tag className="w-3 h-3 mr-1" />
                {tag}
                <button
                  onClick={(e) => removeTag(tag, e)}
                  className="ml-2 hover:text-estado-error transition-colors"
                  title="Eliminar etiqueta"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}

            {/* Etiquetas excluidas */}
            {localExcludedTags.map((tag) => (
              <span
                key={`exc-${tag}`}
                onClick={() => cycleTagState(tag)}
                className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-estado-error text-noche font-medium cursor-pointer hover:opacity-80 transition-all duration-200 select-none"
                title="Click para desactivar esta etiqueta"
              >
                <MinusCircle className="w-3 h-3 mr-1" />
                {tag}
                <button
                  onClick={(e) => removeTag(tag, e)}
                  className="ml-2 hover:text-noche/70 transition-colors"
                  title="Eliminar etiqueta"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}

            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={handleInputChange}
              onKeyDown={handleKeyPress}
              onFocus={() => !isNatural && query.length > 0 && setShowSuggestions(true)}
              placeholder={
                isNatural
                  ? "Pregunta lo que quieras: 'Videos de Alumni con seriedad de 2023'"
                  : (allActiveTags.length === 0
                    ? "Escribe para autocompletar etiquetas · Enter busca texto · Shift+Enter crea etiqueta nueva"
                    : "Añade más etiquetas o texto libre…")
              }
              className="flex-1 min-w-0 bg-transparent outline-none text-marfil placeholder-humo transition-all"
              disabled={naturalLoading}
            />
          </div>

          <div className="flex items-center space-x-2">
            {/* Toggle Tags ↔ Natural */}
            <div className="flex items-center bg-noche/40 rounded-full p-0.5" role="tablist" aria-label="Modo de búsqueda">
              <button
                role="tab"
                aria-selected={!isNatural}
                onClick={() => switchMode('tags')}
                className={`px-2.5 py-1 rounded-full transition-colors flex items-center gap-1 text-xs font-medium ${
                  !isNatural ? 'bg-lavanda text-noche' : 'text-niebla hover:text-marfil'
                }`}
                title="Búsqueda por etiquetas (texto literal y filtros)"
              >
                <Hash className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Tags</span>
              </button>
              <button
                role="tab"
                aria-selected={isNatural}
                onClick={() => switchMode('natural')}
                className={`px-2.5 py-1 rounded-full transition-colors flex items-center gap-1 text-xs font-medium ${
                  isNatural ? 'bg-lavanda text-noche' : 'text-niebla hover:text-marfil'
                }`}
                title="Búsqueda en lenguaje natural (LLM local)"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Natural</span>
              </button>
            </div>

            {hasActiveFilters() && (
              <button
                onClick={clearFilters}
                className="p-2 rounded-lg text-humo hover:bg-grafito hover:text-marfil transition-colors"
                title="Limpiar búsqueda"
              >
                <X className="w-5 h-5" />
              </button>
            )}

            <button
              onClick={isNatural ? runNaturalSearch : handleSearch}
              disabled={naturalLoading || (isNatural && !query.trim())}
              className="px-4 py-2 md:px-6 rounded-full transition-all duration-300 font-medium bg-lavanda text-noche hover:bg-lavanda-claro hover:shadow-lg text-sm md:text-base disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {naturalLoading
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Pensando…</>
                : (isNatural
                  ? 'Preguntar'
                  : (allActiveTags.length > 0 ? `Buscar (${allActiveTags.length})` : 'Buscar'))
              }
            </button>
          </div>
        </div>

      </div>

      {/* Banner del intent extraído por el LLM (modo Natural) */}
      {isNatural && (naturalIntent || naturalNotice) && (
        <div className="mt-3 px-3 py-2 rounded-lg bg-tinta border border-borde-sutil text-xs text-niebla flex flex-wrap items-center gap-x-3 gap-y-1">
          {naturalNotice && (
            <span className="text-estado-aviso font-medium">{naturalNotice}</span>
          )}
          {naturalIntent && (
            <>
              <span className="text-humo">Entendí:</span>
              {naturalIntent.type && <Chip>tipo: {naturalIntent.type}</Chip>}
              {naturalIntent.year && <Chip>año: {naturalIntent.year}</Chip>}
              {naturalIntent.month_name && <Chip>mes: {naturalIntent.month_name}</Chip>}
              {naturalIntent.person_ids && naturalIntent.person_ids.length > 0 && (
                <Chip>personas: {naturalIntent.person_ids.join(', ')}</Chip>
              )}
              {naturalIntent.space_ids && naturalIntent.space_ids.length > 0 && (
                <Chip>espacios: {naturalIntent.space_ids.join(', ')}</Chip>
              )}
              {naturalIntent.tags && naturalIntent.tags.length > 0 && (
                <Chip>tags: {naturalIntent.tags.join(', ')}</Chip>
              )}
              {naturalIntent.shot_type && <Chip>plano: {naturalIntent.shot_type}</Chip>}
              {naturalIntent.people_framing && <Chip>encuadre: {naturalIntent.people_framing}</Chip>}
              {naturalIntent.movement_type && <Chip>movimiento: {naturalIntent.movement_type}</Chip>}
              {naturalIntent.exposure && <Chip>exposición: {naturalIntent.exposure}</Chip>}
              {naturalIntent.color_terms && naturalIntent.color_terms.length > 0 && (
                <Chip>colores: {naturalIntent.color_terms.join(', ')}</Chip>
              )}
              {naturalIntent.free_terms && naturalIntent.free_terms.length > 0 && (
                <Chip>términos: {naturalIntent.free_terms.join(', ')}</Chip>
              )}
            </>
          )}
        </div>
      )}

      {/* Top tags rápidas — chips clicables cuando no hay tags activas y la barra
          está cerrada. Permite descubrir etiquetas sin tener que escribir.
          En modo Natural se ocultan: el LLM las hereda implícitamente del catálogo. */}
      {!isNatural && !showSuggestions && allActiveTags.length === 0 && tagsData?.topTags && tagsData.topTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mt-3 px-2">
          <span className="text-xs font-mono text-humo">Etiquetas frecuentes:</span>
          {tagsData.topTags.slice(0, 12).map(({ tag, count }) => (
            <button
              key={tag}
              onClick={() => addTag(tag)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs bg-grafito text-niebla hover:bg-lavanda hover:text-noche transition-colors"
              title={`${count} archivo${count === 1 ? '' : 's'} con esta etiqueta`}
            >
              <Tag className="w-3 h-3" />
              {tag}
              <span className="font-mono text-[10px] opacity-70">{count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Suggestions dropdown — solo en modo Tags */}
      {!isNatural && showSuggestions && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-tinta rounded-xl shadow-lg border border-borde-sutil z-10">
          <div className="p-2">
            <div className="text-sm text-humo px-3 py-2">Etiquetas sugeridas</div>
            {suggestions.map((tag, index) => (
              <button
                key={tag}
                onClick={() => addTag(tag)}
                className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition-colors text-left ${
                  index === selectedSuggestionIndex
                    ? 'bg-lavanda text-white'
                    : 'hover:bg-lavanda-claro hover:bg-opacity-20'
                }`}
              >
                <Tag className={`w-4 h-4 ${
                  index === selectedSuggestionIndex ? "text-noche" : "text-humo"
                }`} />
                <span className={`${
                  index === selectedSuggestionIndex ? "text-noche" : "text-marfil"
                }`}>{tag}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Advanced filters panel — solo en modo Tags */}
      {!isNatural && showFilters && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-tinta rounded-xl shadow-lg border border-borde-sutil z-10">
          <div className="p-4 md:p-6">
            <h3 className="font-medium text-marfil mb-4">Filtros Avanzados</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-niebla mb-2">
                  Solo favoritos
                </label>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={filters.favorites || false}
                    onChange={(e) => setFilters({ ...filters, favorites: e.target.checked })}
                    className="rounded border-borde-sutil text-lavanda focus:ring-lavanda"
                  />
                  <span className="ml-2 text-sm text-niebla">Mostrar solo archivos favoritos</span>
                </label>
              </div>

              <div>
                <label className="block text-sm font-medium text-niebla mb-2">
                  <Calendar className="w-4 h-4 inline mr-1" />
                  Fecha extraída del nombre de archivo
                </label>
                <div className="space-y-3">
                  {/* Filtros rápidos por año */}
                  {tagsData?.years && tagsData.years.length > 0 && (
                    <div>
                      <div className="text-sm text-niebla mb-2">Años disponibles:</div>
                      <div className="flex flex-wrap gap-1">
                        {tagsData.years.map((year) => (
                          <button
                            key={year}
                            onClick={() => setFilters({ ...filters, year })}
                            className={`px-3 py-1 rounded-full text-xs transition-colors ${
                              filters.year === year
                                ? 'bg-lavanda text-noche'
                                : 'bg-pizarra text-niebla hover:bg-grafito'
                            }`}
                          >
                            {year}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {/* Filtros por mes */}
                  {tagsData?.months && tagsData.months.length > 0 && (
                    <div>
                      <div className="text-sm text-niebla mb-2">Meses disponibles:</div>
                      <div className="flex flex-wrap gap-1">
                        {tagsData.months.map((month) => (
                          <button
                            key={month}
                            onClick={() => setFilters({ ...filters, month })}
                            className={`px-3 py-1 rounded-full text-xs transition-colors ${
                              filters.month === month
                                ? 'bg-lavanda text-noche'
                                : 'bg-pizarra text-niebla hover:bg-grafito'
                            }`}
                          >
                            {month}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {/* Rango de fechas personalizado */}
                  <div>
                    <div className="text-sm text-niebla mb-2">Rango personalizado:</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input
                        type="date"
                        value={filters.dateFrom?.toISOString().split('T')[0] || ''}
                        onChange={(e) => setFilters({ 
                          ...filters, 
                          dateFrom: e.target.value ? new Date(e.target.value) : undefined,
                          year: undefined, // Clear year filter when using date range
                          month: undefined // Clear month filter when using date range
                        })}
                        className="border border-borde-sutil rounded-lg px-3 py-2 text-sm"
                        placeholder="Desde"
                        min={tagsData?.dateRange?.earliest}
                        max={tagsData?.dateRange?.latest}
                      />
                      <input
                        type="date"
                        value={filters.dateTo?.toISOString().split('T')[0] || ''}
                        onChange={(e) => setFilters({ 
                          ...filters, 
                          dateTo: e.target.value ? new Date(e.target.value) : undefined,
                          year: undefined, // Clear year filter when using date range
                          month: undefined // Clear month filter when using date range
                        })}
                        className="border border-borde-sutil rounded-lg px-3 py-2 text-sm"
                        placeholder="Hasta"
                        min={tagsData?.dateRange?.earliest}
                        max={tagsData?.dateRange?.latest}
                      />
                    </div>
                    {tagsData?.dateRange && (
                      <div className="text-xs text-humo mt-1">
                        Rango disponible: {new Date(tagsData.dateRange.earliest).toLocaleDateString('es-ES')} - {new Date(tagsData.dateRange.latest).toLocaleDateString('es-ES')}
                        <br />
                        Archivos con fecha: {tagsData.filesWithDates}/{tagsData.totalFiles}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Píldora compacta para mostrar campos del intent extraído por el LLM.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-pizarra text-marfil text-[11px] font-mono">
      {children}
    </span>
  );
}