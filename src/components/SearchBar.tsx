import React, { useState, useRef, useEffect } from 'react';
import { Search, X, Tag, Calendar, MinusCircle, Sparkles, Hash, Loader2, AtSign, User } from 'lucide-react';
import { MentionsInput, Mention } from 'react-mentions';
import { SearchFilters, Person } from '../types';
import { buildApiUrl, API_CONFIG } from '../config';
import { api } from '../services/api';
import config from '../config';

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
  // Modo Natural: el padre recibe los fileIds ordenados por score, el intent
  // extraído y cuántos de esos IDs pertenecen al tramo "resultados claros"
  // (los primeros N del array). El resto del array son resultados "menos
  // probables" que se mostrarán bajo un separador en la UI.
  // Si fileIds === null, se borra el filtro natural y se vuelve al flujo normal.
  onNaturalSearch?: (fileIds: string[] | null, intent: NaturalIntent | null, primaryCount?: number) => void;
  // @persona: lista de personas en el archivo + callbacks para añadir/quitar.
  // Permite filtrar la galeria por persona desde la propia barra de busqueda.
  selectedPersonIds?: string[];
  onAddPerson?: (personId: string) => void;
  onRemovePerson?: (personId: string) => void;
}

type SearchMode = 'tags' | 'natural';

export default function SearchBar({ onSearch, placeholder = "Buscar archivos...", includedTags = [], excludedTags = [], onTagsChange, onNaturalSearch, selectedPersonIds = [], onAddPerson, onRemovePerson }: SearchBarProps) {
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
  // Modelo activo para "Natural". Se carga al montar via /api/ai/models.
  // Si el usuario lo cambia, se persiste solo en runtime del backend.
  const [aiAvailableModels, setAiAvailableModels] = useState<string[]>([]);
  const [aiSelectedModel, setAiSelectedModel] = useState<string>('');
  // Metadata de la última búsqueda natural (para indicar si Stage 2 entró,
  // cuántos resultados, etc.). null cuando no hay búsqueda activa.
  const [naturalMetadata, setNaturalMetadata] = useState<{
    stage2Applied?: boolean;
    stage2Time?: number;
    primaryCount?: number;
    secondaryCount?: number;
    processingTime?: number;
  } | null>(null);

  // ─────────────────────────────────────────────────────────────────────
  // Estado del input rich del modo natural — react-mentions.
  //
  // El input mantiene una versión "markup" (`@[Display Name](person_id)`)
  // que es lo que controlamos vía la prop `value` del MentionsInput. La lib
  // expone también el `plainText` (lo que ve el usuario, con las @mentions
  // ya sustituidas por `@<display_name>`) y el array `mentions` (objetos
  // estructurados con id y display de cada @persona en la frase).
  //
  // En `runNaturalSearch` derivamos:
  //   - person_ids: mentions.map(m => m.id) ∪ selectedPersonIds
  //   - queryForLLM: markup con los tokens `@[...](...)` strippeados
  // ─────────────────────────────────────────────────────────────────────
  const [naturalMarkup, setNaturalMarkup] = useState('');
  const [naturalPlainText, setNaturalPlainText] = useState('');
  const [naturalMentions, setNaturalMentions] = useState<Array<{ id: string; display: string }>>([]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('pensadero.searchMode', searchMode);
    }
  }, [searchMode]);

  // Cargar modelos disponibles para "Natural" al montar (solo una vez)
  useEffect(() => {
    api.aiModels().then(r => {
      if (r.success && r.data) {
        setAiAvailableModels(r.data.models);
        setAiSelectedModel(r.data.current);
      }
    }).catch(() => {});
  }, []);

  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Helper function to normalize strings (remove accents/tildes)
  const normalizeString = (str: string): string => {
    return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  };

  // All active tags (included + excluded)
  const allActiveTags = [...localIncludedTags, ...localExcludedTags];

  // Personas para autocompletado @nombre. Fetch unico al montar.
  const [persons, setPersons] = useState<Person[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`${config.apiBaseUrl}/persons`)
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (cancelled) return;
        if (json && json.success && Array.isArray(json.data)) setPersons(json.data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const isNatural = searchMode === 'natural';

  // Detección de mention @ — sólo modo tags (la query es íntegramente la
  // mention y al seleccionar se borra todo). En modo natural el rich-input
  // de react-mentions lleva su propio autocompletado interno.
  const isPersonMention = !isNatural && query.startsWith('@');
  const personMentionQuery = isPersonMention ? query.slice(1).trim() : '';

  const personSuggestions: Person[] = isPersonMention
    ? persons
        .filter(p => !selectedPersonIds.includes(p.person_id))
        .filter(p => {
          if (!personMentionQuery) return true;
          const q = normalizeString(personMentionQuery);
          return normalizeString(p.display_name).includes(q) || normalizeString(p.person_id).includes(q);
        })
        .slice(0, 8)
    : [];

  // Datos para el MentionsInput (modo natural). El campo `display` es lo
  // que la lib filtra y muestra; `avatar_url` y `count` los usamos en
  // renderSuggestion. Excluimos las ya seleccionadas para no duplicar.
  const personsMentionsData = persons
    .filter(p => !selectedPersonIds.includes(p.person_id))
    .map(p => ({
      id: p.person_id,
      display: p.display_name,
      avatar_url: p.avatar_url,
      count: p.count,
    }));

  // Filter suggestions based on query from real backend data (accent-insensitive)
  const suggestions = isPersonMention ? [] : (tagsData?.allTags || []).filter(tag =>
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
    // Las @mentions vienen ya estructuradas desde MentionsInput. El markup
    // interno tiene formato `@[Display Name](person_id)`; basta con striparlo
    // para obtener la query "limpia" que enviamos al LLM.
    const markup = naturalMarkup;
    const fallbackPlain = naturalPlainText.trim();
    if (!markup.trim() && !fallbackPlain) return;

    const queryStripped = markup
      .replace(/@\[[^\]]+\]\([^)]+\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const queryForLLM = queryStripped || fallbackPlain;

    // Promover cada mention a chip (selectedPersonIds) si no existe. Eso
    // hace que el filtro AND del padre (App.tsx applyAllFilters) aplique
    // y mantiene coherencia con el modo tags.
    const newIds: string[] = [];
    for (const m of naturalMentions) {
      if (!selectedPersonIds.includes(m.id) && !newIds.includes(m.id)) {
        newIds.push(m.id);
        onAddPerson?.(m.id);
      }
    }
    const personIdsForRequest = Array.from(new Set([
      ...(selectedPersonIds || []),
      ...newIds,
    ]));

    console.log(
      `[SearchBar] natural mentions: markup="${markup}" cleaned="${queryStripped}" ids=[${newIds.join(',')}] selected=[${(selectedPersonIds || []).join(',')}]`
    );

    setNaturalLoading(true);
    setNaturalNotice(null);
    setNaturalIntent(null);

    try {
      const res = await fetch(`${API_CONFIG.apiUrl}/ai/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: queryForLLM,
          person_ids: personIdsForRequest,
        })
      });

      if (res.status === 503) {
        // Ollama caído: aviso amable y fallback a búsqueda textual normal.
        // CONSERVAR los filtros activos (tags, etc.), no destruirlos.
        setNaturalNotice('Búsqueda inteligente no disponible. He buscado como texto.');
        onNaturalSearch?.(null, null);
        onSearch(queryForLLM, {
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
      // Cuántos de los fileIds son del tramo "primary". El backend nos lo dice
      // explícitamente en metadata.primaryCount; si por lo que sea falta, lo
      // recontamos a partir del campo `tier` de cada resultado.
      const primaryCount: number = typeof json?.metadata?.primaryCount === 'number'
        ? json.metadata.primaryCount
        : (Array.isArray(json.results) ? json.results.filter((r: any) => r.tier !== 'secondary').length : 0);
      setNaturalIntent(json.intent || null);
      setNaturalMetadata(json.metadata || null);
      onNaturalSearch?.(fileIds, json.intent || null, primaryCount);
    } catch (err: any) {
      console.warn('[SearchBar] Búsqueda natural falló:', err);
      setNaturalNotice('No he podido procesar la consulta. Buscando como texto.');
      onNaturalSearch?.(null, null);
      onSearch(queryForLLM, {
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
      setNaturalMetadata(null);
      onNaturalSearch?.(null, null);
    }
    setSearchMode(next);
    setQuery('');
    // Resetear también el estado del MentionsInput al cambiar de modo
    setNaturalMarkup('');
    setNaturalPlainText('');
    setNaturalMentions([]);
  };

  // Handler de teclas para el MentionsInput. Cuando el dropdown de
  // sugerencias está abierto, la lib intercepta Up/Down/Enter/Tab y llama
  // a preventDefault, por lo que sólo lanzamos la búsqueda si el evento
  // no fue ya consumido por la lib.
  const handleNaturalKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (naturalPlainText.trim() || naturalMarkup.trim()) runNaturalSearch();
  };

  // onChange del MentionsInput — actualiza los tres estados sincronizados.
  // `newValue`: markup `@[Display](id)`; `newPlainText`: lo que ve el usuario;
  // `mentions`: array estructurado de personas referenciadas.
  const handleNaturalChange = (
    _event: { target: { value: string } },
    newValue: string,
    newPlainText: string,
    mentions: Array<{ id: string; display: string }>
  ) => {
    setNaturalMarkup(newValue);
    setNaturalPlainText(newPlainText);
    setNaturalMentions(mentions);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setSelectedSuggestionIndex(-1);
    // Show suggestions when there's a query
    setShowSuggestions(e.target.value.length > 0);
  };

  // handleKeyPress queda solo para el <input> plain del modo tags. En modo
  // natural el MentionsInput tiene su propio onKeyDown que delega en
  // handleNaturalKeyDown.
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Modo @persona (tags): Enter selecciona la sugerencia resaltada o
      // la primera y promueve a chip.
      if (isPersonMention && showSuggestions && personSuggestions.length > 0) {
        const idx = selectedSuggestionIndex >= 0 && selectedSuggestionIndex < personSuggestions.length
          ? selectedSuggestionIndex
          : 0;
        addPerson(personSuggestions[idx].person_id);
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
      const list = isPersonMention ? personSuggestions : suggestions;
      if (list.length > 0) {
        setSelectedSuggestionIndex(prev =>
          prev < list.length - 1 ? prev + 1 : 0
        );
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const list = isPersonMention ? personSuggestions : suggestions;
      if (list.length > 0) {
        setSelectedSuggestionIndex(prev =>
          prev > 0 ? prev - 1 : list.length - 1
        );
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setShowSuggestions(false);
      setSelectedSuggestionIndex(-1);
    }
  };

  // Añadir persona desde el dropdown @ (modo tags). En natural lo gestiona
  // el `MentionsInput` de react-mentions, que pinta la chip inline en sitio.
  const addPerson = (personId: string) => {
    if (!onAddPerson) return;
    onAddPerson(personId);
    setQuery('');
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
    setTimeout(() => { inputRef.current?.focus(); }, 50);
  };

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
    setNaturalMarkup('');
    setNaturalPlainText('');
    setNaturalMentions([]);
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
           naturalMarkup ||
           filters.type !== 'all' ||
           filters.favorites ||
           filters.dateFrom ||
           filters.dateTo ||
           filters.year ||
           filters.month;
  };


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
            {/* Personas activas — chips con avatar. Permiten quitar con la X. */}
            {selectedPersonIds.map(pid => {
              const person = persons.find(p => p.person_id === pid);
              const display = person?.display_name || pid;
              const avatarUrl = person?.avatar_url ? `${config.apiUrl}${person.avatar_url}` : null;
              return (
                <span
                  key={`person-${pid}`}
                  className="inline-flex items-center pl-1 pr-3 py-1 rounded-full text-sm bg-lavanda text-noche font-medium select-none"
                  title={`Filtrando por ${display}`}
                >
                  <span className="w-6 h-6 rounded-full bg-pizarra overflow-hidden flex items-center justify-center mr-2 flex-shrink-0">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt={display}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <User className="w-3.5 h-3.5 text-lavanda-archivo" />
                    )}
                  </span>
                  <span className="truncate max-w-[140px]">{display}</span>
                  {onRemovePerson && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onRemovePerson(pid); }}
                      className="ml-2 hover:text-estado-error transition-colors"
                      title="Quitar filtro de persona"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </span>
              );
            })}

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

            {isNatural ? (
              <MentionsInput
                value={naturalMarkup}
                onChange={handleNaturalChange as any}
                onKeyDown={handleNaturalKeyDown}
                placeholder="Pregunta lo que quieras. Usa @nombre para filtrar por persona."
                singleLine
                allowSpaceInQuery
                forceSuggestionsAboveCursor={false}
                className="pensadero-mentions flex-1 min-w-0"
                style={mentionsInputStyle as any}
                a11ySuggestionsListLabel="Personas sugeridas"
                disabled={naturalLoading}
                inputRef={inputRef as React.RefObject<HTMLInputElement>}
              >
                <Mention
                  trigger="@"
                  data={personsMentionsData}
                  appendSpaceOnAdd
                  displayTransform={(_id: string, display: string) => `@${display}`}
                  markup="@[__display__](__id__)"
                  style={mentionPillStyle as any}
                  renderSuggestion={(suggestion: any, _search: string, highlightedDisplay: React.ReactNode, _index: number, focused: boolean) => (
                    <div className="flex items-center gap-2 px-2 py-1">
                      <div className="w-7 h-7 rounded-full bg-pizarra overflow-hidden flex-shrink-0 flex items-center justify-center">
                        {suggestion.avatar_url ? (
                          <img
                            src={`${config.apiUrl}${suggestion.avatar_url}`}
                            alt=""
                            className="w-full h-full object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                          />
                        ) : (
                          <User className="w-4 h-4 text-lavanda-archivo" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`truncate ${focused ? 'text-noche font-medium' : 'text-marfil'}`}>
                          {highlightedDisplay}
                        </div>
                        <div className={`text-xs ${focused ? 'text-noche/70' : 'text-bruma'}`}>
                          {suggestion.count} {suggestion.count === 1 ? 'aparición' : 'apariciones'}
                        </div>
                      </div>
                    </div>
                  )}
                />
              </MentionsInput>
            ) : (
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={handleInputChange}
                onKeyDown={handleKeyPress}
                onFocus={() => query.length > 0 && setShowSuggestions(true)}
                placeholder={
                  allActiveTags.length === 0
                    ? "Escribe para autocompletar etiquetas · Enter busca texto · Shift+Enter crea etiqueta nueva"
                    : "Añade más etiquetas o texto libre…"
                }
                className="flex-1 min-w-0 bg-transparent outline-none text-marfil placeholder-humo transition-all"
                disabled={naturalLoading}
              />
            )}
          </div>

          <div className="flex items-center space-x-2">
            {/* Selector de modelo IA (solo visible en modo Natural).
                Permite elegir el LLM que entiende tus preguntas — util para
                cambiar entre modelos ligeros (gemma3:4b, ~3 GB) y modelos
                grandes (qwen2.5:14b-instruct, ~9 GB) segun la VRAM disponible. */}
            {isNatural && aiAvailableModels.length > 0 && (
              <select
                value={aiSelectedModel}
                onChange={async (e) => {
                  const model = e.target.value;
                  setAiSelectedModel(model);
                  await api.setAiModel(model).catch(() => {});
                }}
                className="hidden md:block bg-grafito border border-pizarra rounded-full px-2.5 py-1 text-xs text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda max-w-[180px]"
                title="Modelo que entiende tus búsquedas en lenguaje natural"
              >
                {aiAvailableModels.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}

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
              disabled={naturalLoading || (isNatural && !naturalMarkup.trim() && !naturalPlainText.trim())}
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
          {/* Indicadores de comportamiento de la búsqueda: si entró Stage 2
              (re-ranking semántico con LLM), conteo y tiempo. Permite al
              usuario entender por qué tarda más o por qué aparecen
              resultados "no literales". */}
          {naturalMetadata && (
            <>
              {naturalMetadata.stage2Applied && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-lavanda/15 text-lavanda text-[11px] font-medium"
                  title={`Stage 2: el LLM refinó los resultados leyendo las descripciones. Tardó ${naturalMetadata.stage2Time ?? '?'}ms.`}
                >
                  <Sparkles className="w-3 h-3" />
                  IA refinó
                </span>
              )}
              {typeof naturalMetadata.primaryCount === 'number' && naturalMetadata.primaryCount > 0 && (
                <span className="text-humo text-[11px]">
                  {naturalMetadata.primaryCount} {naturalMetadata.primaryCount === 1 ? 'resultado claro' : 'resultados claros'}
                  {typeof naturalMetadata.secondaryCount === 'number' && naturalMetadata.secondaryCount > 0 && (
                    <span> · {naturalMetadata.secondaryCount} menos probables</span>
                  )}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Suggestions dropdown — modo Tags */}
      {!isNatural && !isPersonMention && showSuggestions && suggestions.length > 0 && (
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

      {/* Suggestions dropdown — modo @persona (activo en tags y natural) */}
      {isPersonMention && showSuggestions && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-tinta rounded-xl shadow-lg border border-borde-sutil z-10">
          <div className="p-2">
            <div className="text-sm text-humo px-3 py-2 flex items-center gap-1">
              <AtSign className="w-3.5 h-3.5" />
              Personas {personMentionQuery && <span className="text-bruma">· filtrando por "{personMentionQuery}"</span>}
            </div>
            {personSuggestions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-bruma">
                {persons.length === 0
                  ? 'No hay personas entrenadas todavia'
                  : 'Ninguna persona coincide con esa busqueda'}
              </div>
            ) : (
              personSuggestions.map((person, index) => (
                <button
                  key={person.person_id}
                  onClick={() => addPerson(person.person_id)}
                  className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition-colors text-left ${
                    index === selectedSuggestionIndex
                      ? 'bg-lavanda text-white'
                      : 'hover:bg-lavanda-claro hover:bg-opacity-20'
                  }`}
                >
                  <div className="w-7 h-7 rounded-full bg-pizarra overflow-hidden flex-shrink-0 flex items-center justify-center">
                    {person.avatar_url ? (
                      <img
                        src={`${config.apiUrl}${person.avatar_url}`}
                        alt={person.display_name}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <User className="w-4 h-4 text-lavanda-archivo" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className={`block truncate ${
                      index === selectedSuggestionIndex ? "text-noche font-medium" : "text-marfil"
                    }`}>
                      {person.display_name}
                    </span>
                    <span className={`text-xs ${
                      index === selectedSuggestionIndex ? "text-noche/70" : "text-bruma"
                    }`}>
                      {person.count} {person.count === 1 ? 'aparicion' : 'apariciones'}
                    </span>
                  </div>
                </button>
              ))
            )}
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

// ─────────────────────────────────────────────────────────────────────────
// Estilos para react-mentions (modo natural).
//
// La lib usa una capa <input> "real" superpuesta a un <div highlighter> que
// pinta los chips inline. Mantenemos input transparente y dejamos al
// highlighter pintar el texto + chips. `control` rige el wrapper externo;
// `input` el campo invisible; `highlighter` la capa visible.
// ─────────────────────────────────────────────────────────────────────────
// Estilos para react-mentions. Patrón estándar de la lib:
//   - El input lleva el texto visible (color marfil).
//   - El highlighter está SUPERPUESTO con su texto regular en transparente
//     (default); solo los `<strong>` de las mentions se pintan, lo que
//     produce el efecto pill encima del texto subyacente.
// Métricas idénticas en input y highlighter para que el cursor y la pill
// caigan sobre los mismos caracteres.
const MENTIONS_FONT_FAMILY = "'Geist', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const mentionsInputStyle: any = {
  control: {
    backgroundColor: 'transparent',
    fontSize: '14px',
    lineHeight: '1.5',
    fontFamily: MENTIONS_FONT_FAMILY,
    fontWeight: 'normal',
    minHeight: '1.5em',
  },
  input: {
    margin: 0,
    padding: 0,
    border: 0,
    outline: 0,
    color: '#f4eee8',               // marfil — texto VISIBLE aquí
    caretColor: '#C8B6FF',          // lavanda
    backgroundColor: 'transparent',
    fontSize: '14px',
    lineHeight: '1.5',
    fontFamily: MENTIONS_FONT_FAMILY,
  },
  highlighter: {
    margin: 0,
    padding: 0,
    border: 0,
    color: 'transparent',           // texto regular del highlighter no se ve
    fontSize: '14px',
    lineHeight: '1.5',
    fontFamily: MENTIONS_FONT_FAMILY,
    overflow: 'hidden',
  },
  suggestions: {
    zIndex: 50,
    list: {
      backgroundColor: '#151927',                  // tinta
      border: '1px solid #252A42',                 // pizarra
      borderRadius: '12px',
      maxHeight: '320px',
      overflow: 'auto',
      padding: '6px',
      marginTop: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
      minWidth: '280px',
    },
    item: {
      borderRadius: '8px',
      cursor: 'pointer',
    },
  },
};

// Mantenemos el style prop del <Mention> vacío para que el CSS global
// (.pensadero-mentions__highlighter strong) gane y aplique padding+rounded.
const mentionPillStyle: any = {};