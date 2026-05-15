import React, { useState, useEffect, useRef } from 'react';
import {
  Tag,
  Search,
  Edit2,
  Trash2,
  Save,
  X,
  Undo,
  Clock,
  Hash,
  Folder,
  Filter,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Check,
  Download
} from 'lucide-react';
import { api } from '../services/api';
import { MediaFile } from '../types';

interface TagItem {
  id: string;
  name: string;
  count: number;
  color?: string;
  category?: string;
  lastModified?: Date;
  files?: string[]; // IDs de archivos con esta etiqueta
}

interface TagAction {
  id: string;
  type: 'rename' | 'delete' | 'merge' | 'create' | 'bulk_edit';
  timestamp: Date;
  oldValue?: any;
  newValue?: any;
  affectedTags: string[];
  affectedFiles: number;
  canUndo: boolean;
}

interface TagManagerProps {
  mediaFiles: MediaFile[];
  onFilesUpdate: (files: MediaFile[]) => void;
}

export default function TagManager({ mediaFiles, onFilesUpdate }: TagManagerProps) {
  const [allTags, setAllTags] = useState<TagItem[]>([]);  // Todas las tags (para búsqueda)
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());  // Tags activas para gestionar
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);  // Índice destacado en sugerencias
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());  // Para fusionar
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'count' | 'date'>('name');
  const [history, setHistory] = useState<TagAction[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLDivElement>(null);

  // Cargar etiquetas desde los archivos
  useEffect(() => {
    loadTags();
    loadHistory();
  }, [mediaFiles]);

  // Click outside para cerrar sugerencias
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Sugerencias filtradas (excluye las ya activas)
  const suggestions = allTags
    .filter(tag =>
      tag.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !activeTagIds.has(tag.id)
    )
    .slice(0, 10);  // Limitar a 10 sugerencias

  // Reset highlighted index cuando cambian las sugerencias
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [searchQuery]);

  // Tags activas para mostrar en el panel de gestión
  const activeTags = allTags
    .filter(tag => activeTagIds.has(tag.id))
    .sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'count':
          return b.count - a.count;
        case 'date':
          return (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0);
        default:
          return 0;
      }
    });

  const loadTags = () => {
    setIsLoading(true);

    // Extraer todas las etiquetas únicas de los archivos
    const tagMap = new Map<string, TagItem>();

    mediaFiles.forEach(file => {
      file.tags.forEach(tagName => {
        if (tagMap.has(tagName)) {
          const existing = tagMap.get(tagName)!;
          existing.count++;
          existing.files?.push(file.id);
        } else {
          // Determinar categoría automática basada en el nombre
          const category = detectCategory(tagName);

          tagMap.set(tagName, {
            id: generateTagId(tagName),
            name: tagName,
            count: 1,
            category,
            lastModified: new Date(),
            files: [file.id]
          });
        }
      });
    });

    setAllTags(Array.from(tagMap.values()));
    setIsLoading(false);
  };

  const loadHistory = async () => {
    try {
      // Cargar historial desde localStorage
      const savedHistory = localStorage.getItem('tagHistory');
      if (savedHistory) {
        const parsed = JSON.parse(savedHistory);
        // Filtrar acciones más antiguas de una semana
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        
        const validHistory = parsed
          .filter((action: any) => new Date(action.timestamp) > oneWeekAgo)
          .map((action: any) => ({
            ...action,
            timestamp: new Date(action.timestamp)
          }));
        
        setHistory(validHistory);
      }
    } catch (error) {
      console.error('Error loading tag history:', error);
    }
  };

  const saveHistory = (newHistory: TagAction[]) => {
    setHistory(newHistory);
    localStorage.setItem('tagHistory', JSON.stringify(newHistory));
  };

  const detectCategory = (tagName: string): string => {
    const name = tagName.toLowerCase();
    
    if (name.includes('persona') || name.includes('people') || name.includes('person')) {
      return 'Personas';
    } else if (name.includes('lugar') || name.includes('location') || name.includes('place')) {
      return 'Lugares';
    } else if (name.includes('evento') || name.includes('event')) {
      return 'Eventos';
    } else if (name.includes('proyecto') || name.includes('project')) {
      return 'Proyectos';
    } else if (name.includes('año') || name.includes('year') || /^\d{4}$/.test(name)) {
      return 'Fechas';
    } else if (name.includes('tipo') || name.includes('type') || name.includes('format')) {
      return 'Formato';
    }
    
    return 'General';
  };

  const generateTagId = (name: string): string => {
    // Normalizar el nombre
    const normalized = name.toLowerCase().trim().replace(/\s+/g, '_');
    // Crear un hash simple del nombre original para evitar colisiones
    const hash = Math.abs(name.split('').reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0)).toString(36);
    return `tag_${normalized}_${hash}`;
  };

  // Manejar navegación con teclado en sugerencias
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions || suggestions.length === 0) {
      if (e.key === 'ArrowDown' && searchQuery.length > 0) {
        setShowSuggestions(true);
        setHighlightedIndex(0);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev =>
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(prev =>
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
          addTagToActive(suggestions[highlightedIndex]);
        }
        break;
      case 'Escape':
        setShowSuggestions(false);
        setHighlightedIndex(-1);
        break;
    }
  };

  // Añadir etiqueta a las activas para gestionar
  const addTagToActive = (tag: TagItem) => {
    setActiveTagIds(prev => new Set([...prev, tag.id]));
    setSearchQuery('');
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  };

  // Quitar etiqueta de las activas
  const removeTagFromActive = (tagId: string) => {
    setActiveTagIds(prev => {
      const newSet = new Set(prev);
      newSet.delete(tagId);
      return newSet;
    });
    // También quitar de selectedTags si estaba seleccionada para fusión
    setSelectedTags(prev => {
      const newSet = new Set(prev);
      newSet.delete(tagId);
      return newSet;
    });
  };

  const handleRenameTag = async (tagId: string, oldName: string, newName: string) => {
    if (!newName.trim() || newName === oldName) {
      setEditingTag(null);
      return;
    }

    // Verificar si el nuevo nombre ya existe
    const existingTag = allTags.find(t => t.name.toLowerCase() === newName.toLowerCase() && t.id !== tagId);
    const currentTag = allTags.find(t => t.id === tagId);
    if (!currentTag) return;

    const affectedFileIds = currentTag.files || [];

    if (existingTag) {
      // Ofrecer la opción de fusionar
      const shouldMerge = confirm(
        `La etiqueta "${newName}" ya existe con ${existingTag.count} archivo(s).\n\n` +
        `¿Deseas fusionar "${oldName}" (${currentTag.count} archivo(s)) con la etiqueta existente?\n\n` +
        `Esto combinará ambas etiquetas en "${newName}".`
      );

      if (!shouldMerge) {
        return;
      }

      // Actualizar archivos para usar el nombre existente
      const updatedFiles = mediaFiles.map(file => {
        if (file.tags.includes(oldName)) {
          const newTags = file.tags.filter(tag => tag !== oldName);
          if (!newTags.includes(newName)) {
            newTags.push(newName);
          }
          return { ...file, tags: newTags };
        }
        return file;
      });

      // Combinar los archivos de ambas etiquetas
      const combinedFiles = new Set([
        ...(existingTag.files || []),
        ...(currentTag.files || [])
      ]);

      try {
        // Persistir en backend
        await api.bulkUpdateTags({
          fileIds: affectedFileIds,
          removeTags: [oldName],
          addTags: [newName]
        });

        // Actualizar etiquetas locales
        const updatedTags = allTags
          .filter(tag => tag.id !== tagId)
          .map(tag =>
            tag.id === existingTag.id
              ? {
                  ...tag,
                  count: combinedFiles.size,
                  files: Array.from(combinedFiles),
                  lastModified: new Date()
                }
              : tag
          );

        // Guardar en historial como fusión
        const action: TagAction = {
          id: `action_${Date.now()}`,
          type: 'merge',
          timestamp: new Date(),
          oldValue: [oldName, newName],
          newValue: newName,
          affectedTags: [tagId, existingTag.id],
          affectedFiles: combinedFiles.size,
          canUndo: true
        };

        saveHistory([action, ...history]);
        setAllTags(updatedTags);
        onFilesUpdate(updatedFiles);
        setEditingTag(null);
        removeTagFromActive(tagId);

      } catch (error) {
        console.error('Error al fusionar etiquetas:', error);
        alert('Error al fusionar las etiquetas. Por favor, inténtalo de nuevo.');
      }

    } else {
      // No existe conflicto, renombrar normalmente
      const updatedFiles = mediaFiles.map(file => ({
        ...file,
        tags: file.tags.map(tag => tag === oldName ? newName : tag)
      }));

      try {
        // Persistir en backend: quitar antigua, añadir nueva
        await api.bulkUpdateTags({
          fileIds: affectedFileIds,
          removeTags: [oldName],
          addTags: [newName]
        });

        // Actualizar etiquetas locales
        const updatedTags = allTags.map(tag =>
          tag.id === tagId
            ? { ...tag, name: newName, lastModified: new Date() }
            : tag
        );

        // Guardar en historial
        const action: TagAction = {
          id: `action_${Date.now()}`,
          type: 'rename',
          timestamp: new Date(),
          oldValue: oldName,
          newValue: newName,
          affectedTags: [tagId],
          affectedFiles: currentTag.count || 0,
          canUndo: true
        };

        saveHistory([action, ...history]);
        setAllTags(updatedTags);
        onFilesUpdate(updatedFiles);
        setEditingTag(null);

      } catch (error) {
        console.error('Error al renombrar etiqueta:', error);
        alert('Error al renombrar la etiqueta. Por favor, inténtalo de nuevo.');
      }
    }
  };

  const handleDeleteTag = async (tagId: string, tagName: string) => {
    const tagToDelete = allTags.find(t => t.id === tagId);
    if (!confirm(`¿Estás seguro de eliminar la etiqueta "${tagName}"? Se eliminará de ${tagToDelete?.count || 0} archivo(s).`)) {
      return;
    }

    const affectedFileIds = tagToDelete?.files || [];

    // Actualizar archivos localmente
    const updatedFiles = mediaFiles.map(file => ({
      ...file,
      tags: file.tags.filter(tag => tag !== tagName)
    }));

    try {
      // Persistir en el backend
      await api.bulkUpdateTags({
        fileIds: affectedFileIds,
        removeTags: [tagName]
      });

      // Guardar en historial
      const action: TagAction = {
        id: `action_${Date.now()}`,
        type: 'delete',
        timestamp: new Date(),
        oldValue: tagToDelete,
        affectedTags: [tagId],
        affectedFiles: tagToDelete?.count || 0,
        canUndo: true
      };

      saveHistory([action, ...history]);
      setAllTags(allTags.filter(tag => tag.id !== tagId));
      onFilesUpdate(updatedFiles);
      // Quitar de las activas y seleccionadas
      removeTagFromActive(tagId);

    } catch (error) {
      console.error('Error al eliminar etiqueta:', error);
      alert('Error al eliminar la etiqueta. Por favor, inténtalo de nuevo.');
    }
  };

  const handleMergeTags = async () => {
    if (selectedTags.size < 2) {
      alert('Selecciona al menos 2 etiquetas para fusionar');
      return;
    }

    const selectedTagNames = Array.from(selectedTags).map(id =>
      allTags.find(t => t.id === id)?.name
    ).filter(Boolean) as string[];

    const newName = prompt(
      `Fusionar etiquetas: ${selectedTagNames.join(', ')}\n\nNombre de la nueva etiqueta:`,
      selectedTagNames[0]
    );

    if (!newName) return;

    // Recopilar IDs de archivos afectados
    const affectedFileIds = new Set<string>();
    allTags.filter(t => selectedTags.has(t.id)).forEach(tag => {
      tag.files?.forEach(fileId => affectedFileIds.add(fileId));
    });

    const fileIdsArray = Array.from(affectedFileIds);

    // Actualizar archivos localmente
    const updatedFiles = mediaFiles.map(file => {
      const hasAnyTag = selectedTagNames.some(tagName => file.tags.includes(tagName));
      if (hasAnyTag) {
        const otherTags = file.tags.filter(tag => !selectedTagNames.includes(tag));
        return {
          ...file,
          tags: [...otherTags, newName]
        };
      }
      return file;
    });

    // Persistir cambios en el backend
    try {
      // Eliminar las etiquetas antiguas y añadir la nueva
      await api.bulkUpdateTags({
        fileIds: fileIdsArray,
        removeTags: selectedTagNames,
        addTags: [newName]
      });

      // Guardar en historial
      const action: TagAction = {
        id: `action_${Date.now()}`,
        type: 'merge',
        timestamp: new Date(),
        oldValue: selectedTagNames,
        newValue: newName,
        affectedTags: Array.from(selectedTags),
        affectedFiles: fileIdsArray.length,
        canUndo: true
      };

      saveHistory([action, ...history]);

      // Actualizar estado local
      onFilesUpdate(updatedFiles);

      // Limpiar selección y quitar tags fusionadas de las activas
      const mergedTagIds = Array.from(selectedTags);
      mergedTagIds.forEach(tagId => removeTagFromActive(tagId));
      setSelectedTags(new Set());

    } catch (error) {
      console.error('Error al fusionar etiquetas:', error);
      alert('Error al fusionar las etiquetas. Por favor, inténtalo de nuevo.');
    }
  };

  const handleUndo = async (actionId: string) => {
    const action = history.find(a => a.id === actionId);
    if (!action || !action.canUndo) return;

    let updatedFiles = [...mediaFiles];

    switch (action.type) {
      case 'rename':
        // Revertir renombrado
        updatedFiles = mediaFiles.map(file => ({
          ...file,
          tags: file.tags.map(tag => 
            tag === action.newValue ? action.oldValue : tag
          )
        }));
        break;

      case 'delete':
        // Restaurar etiqueta eliminada
        const deletedTag = action.oldValue as TagItem;
        updatedFiles = mediaFiles.map(file => {
          if (deletedTag.files?.includes(file.id)) {
            return {
              ...file,
              tags: [...file.tags, deletedTag.name]
            };
          }
          return file;
        });
        break;

      case 'merge':
        // Revertir fusión
        const originalTags = action.oldValue as string[];
        const mergedName = action.newValue as string;
        
        updatedFiles = mediaFiles.map(file => {
          if (file.tags.includes(mergedName)) {
            const otherTags = file.tags.filter(tag => tag !== mergedName);
            // Restaurar las etiquetas originales
            return {
              ...file,
              tags: [...otherTags, ...originalTags]
            };
          }
          return file;
        });
        break;
    }

    // Eliminar acción del historial
    const newHistory = history.filter(a => a.id !== actionId);
    saveHistory(newHistory);
    
    // Aplicar cambios
    onFilesUpdate(updatedFiles);
  };

  const toggleCategory = (category: string) => {
    setExpandedCategories(prev => {
      const newSet = new Set(prev);
      if (newSet.has(category)) {
        newSet.delete(category);
      } else {
        newSet.add(category);
      }
      return newSet;
    });
  };

  const toggleTagSelection = (tagId: string) => {
    setSelectedTags(prev => {
      const newSet = new Set(prev);
      if (newSet.has(tagId)) {
        newSet.delete(tagId);
      } else {
        newSet.add(tagId);
      }
      return newSet;
    });
  };

  // Exportar todas las etiquetas a un archivo TXT
  const handleExportTags = () => {
    // Ordenar etiquetas alfabéticamente
    const sortedTags = [...allTags].sort((a, b) => a.name.localeCompare(b.name, 'es'));

    // Crear contenido del archivo
    const header = [
      '# Base de Datos de Etiquetas — Pensadero',
      `# Fecha de exportación: ${new Date().toLocaleString('es-ES')}`,
      `# Total de etiquetas: ${sortedTags.length}`,
      `# Total de archivos: ${mediaFiles.length}`,
      '#',
      '# Formato: Nombre de etiqueta | Cantidad de archivos | Categoría',
      '# ─────────────────────────────────────────────────────────────',
      ''
    ].join('\n');

    const tagLines = sortedTags.map(tag =>
      `${tag.name} | ${tag.count} archivo${tag.count !== 1 ? 's' : ''} | ${tag.category || 'General'}`
    ).join('\n');

    const content = header + tagLines;

    // Crear y descargar archivo
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `etiquetas_marina_finder_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Categorías disponibles en las tags activas
  const categories = ['all', ...new Set(activeTags.map(t => t.category || 'General'))];

  // Agrupar etiquetas activas por categoría
  const groupedTags = activeTags.reduce((acc, tag) => {
    const category = tag.category || 'General';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(tag);
    return acc;
  }, {} as Record<string, TagItem[]>);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Tag className="w-12 h-12 text-lavanda-archivo mx-auto mb-4 animate-pulse" />
          <p className="text-lavanda-archivo">Cargando etiquetas...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-marfil mb-2">Gestión de Etiquetas</h1>
        <p className="text-lavanda-archivo">
          Administra, organiza y edita las etiquetas de tu biblioteca multimedia
        </p>
      </div>

      {/* Toolbar */}
      <div className="bg-tinta rounded-3xl border border-pizarra p-6 mb-6">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          {/* Search with suggestions */}
          <div className="flex-1 min-w-[300px]" ref={searchRef}>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-lavanda-archivo" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowSuggestions(e.target.value.length > 0);
                }}
                onFocus={() => searchQuery.length > 0 && setShowSuggestions(true)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Buscar etiquetas para gestionar..."
                className="w-full pl-10 pr-4 py-2 border border-pizarra rounded-full focus:outline-none focus:ring-2 focus:ring-lavanda"
              />

              {/* Suggestions dropdown */}
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-tinta border border-pizarra rounded-2xl shadow-lg z-50 max-h-80 overflow-y-auto">
                  <div className="p-2">
                    <p className="text-xs text-lavanda-archivo px-3 py-1 mb-1">
                      Click para activar y gestionar:
                    </p>
                    {suggestions.map((tag, index) => (
                      <button
                        key={tag.id}
                        onClick={() => addTagToActive(tag)}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-xl transition-colors text-left ${
                          index === highlightedIndex
                            ? 'bg-lavanda-claro bg-opacity-30'
                            : 'hover:bg-grafito'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Hash className={`w-3 h-3 ${index === highlightedIndex ? 'text-lavanda' : 'text-lavanda-archivo'}`} />
                          <span className="text-marfil">{tag.name}</span>
                        </div>
                        <span className="text-xs text-lavanda-archivo bg-pizarra px-2 py-0.5 rounded-full">
                          {tag.count} archivo{tag.count !== 1 ? 's' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* No results message */}
              {showSuggestions && searchQuery.length > 0 && suggestions.length === 0 && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-tinta border border-pizarra rounded-2xl shadow-lg z-50 p-4 text-center">
                  <p className="text-sm text-lavanda-archivo">No se encontraron etiquetas con "{searchQuery}"</p>
                </div>
              )}
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3">
            {/* Sort */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="px-4 py-2 border border-pizarra rounded-full focus:outline-none focus:ring-2 focus:ring-lavanda"
            >
              <option value="name">Ordenar por nombre</option>
              <option value="count">Ordenar por uso</option>
              <option value="date">Ordenar por fecha</option>
            </select>

            {/* Export button */}
            <button
              onClick={handleExportTags}
              className="px-4 py-2 rounded-full border border-pizarra hover:bg-grafito transition-colors flex items-center gap-2"
              title="Exportar todas las etiquetas a TXT"
            >
              <Download className="w-4 h-4" />
              Exportar
            </button>

            {/* History button */}
            <button
              onClick={() => setShowHistory(!showHistory)}
              className={`px-4 py-2 rounded-full border ${
                showHistory ? 'bg-grafito border-lavanda' : 'border-pizarra'
              } hover:bg-grafito transition-colors flex items-center gap-2`}
            >
              <Clock className="w-4 h-4" />
              Historial
            </button>
          </div>
        </div>

        {/* Actions bar for merge */}
        {selectedTags.size > 0 && (
          <div className="mt-4 p-3 bg-grafito rounded-2xl flex items-center justify-between">
            <span className="text-sm text-marfil">
              {selectedTags.size} etiqueta{selectedTags.size !== 1 ? 's' : ''} seleccionada{selectedTags.size !== 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleMergeTags}
                className="btn-tertiary text-sm py-2 px-4"
                disabled={selectedTags.size < 2}
              >
                Fusionar
              </button>
              <button
                onClick={() => setSelectedTags(new Set())}
                className="px-4 py-2 text-sm text-lavanda-archivo hover:text-marfil"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* Active tags chips */}
        {activeTags.length > 0 && (
          <div className="mt-4 p-3 bg-pizarra bg-opacity-50 rounded-2xl">
            <div className="flex items-center gap-2 mb-2">
              <Filter className="w-4 h-4 text-lavanda-archivo" />
              <span className="text-sm text-lavanda-archivo font-medium">Etiquetas activas para gestionar:</span>
              <button
                onClick={() => setActiveTagIds(new Set())}
                className="ml-auto text-xs text-lavanda-archivo hover:text-lavanda transition-colors"
              >
                Limpiar todas
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {activeTags.map(tag => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-1 px-3 py-1 bg-tinta border border-pizarra rounded-full text-sm"
                >
                  <Hash className="w-3 h-3 text-lavanda" />
                  <span className="text-marfil">{tag.name}</span>
                  <button
                    onClick={() => removeTagFromActive(tag.id)}
                    className="ml-1 p-0.5 text-lavanda-archivo hover:text-lavanda transition-colors"
                    title="Quitar de la lista"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tags list */}
        <div className="lg:col-span-2">
          <div className="bg-tinta rounded-3xl border border-pizarra">
            {/* Stats */}
            <div className="p-6 border-b border-pizarra">
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center">
                  <p className="text-2xl font-bold text-lavanda">{allTags.length}</p>
                  <p className="text-sm text-lavanda-archivo">Etiquetas totales</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-bruma">{activeTags.length}</p>
                  <p className="text-sm text-lavanda-archivo">Activas para gestión</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-marfil">
                    {activeTags.reduce((sum, tag) => sum + tag.count, 0)}
                  </p>
                  <p className="text-sm text-lavanda-archivo">Archivos afectados</p>
                </div>
              </div>
            </div>

            {/* Tags grouped by category */}
            <div className="p-6">
              {Object.entries(groupedTags).map(([category, categoryTags]) => (
                <div key={category} className="mb-6 last:mb-0">
                  <button
                    onClick={() => toggleCategory(category)}
                    className="flex items-center gap-2 mb-3 text-lavanda-archivo hover:text-marfil transition-colors"
                  >
                    {expandedCategories.has(category) ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                    <Folder className="w-4 h-4" />
                    <span className="font-medium">{category}</span>
                    <span className="text-sm text-lavanda-archivo">({categoryTags.length})</span>
                  </button>

                  {(expandedCategories.has(category) || expandedCategories.size === 0) && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 ml-6">
                      {categoryTags.map(tag => (
                        <div
                          key={tag.id}
                          className={`p-3 rounded-2xl border transition-all ${
                            selectedTags.has(tag.id)
                              ? 'border-lavanda bg-grafito'
                              : 'border-pizarra hover:bg-grafito'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <input
                                type="checkbox"
                                checked={selectedTags.has(tag.id)}
                                onChange={() => toggleTagSelection(tag.id)}
                                className="rounded border-lavanda-archivo text-lavanda focus:ring-lavanda"
                              />
                              <div className="flex-1">
                                {editingTag === tag.id ? (
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="text"
                                      value={editValue}
                                      onChange={(e) => setEditValue(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          handleRenameTag(tag.id, tag.name, editValue);
                                        } else if (e.key === 'Escape') {
                                          setEditingTag(null);
                                        }
                                      }}
                                      className="flex-1 px-2 py-1 border border-lavanda rounded-full text-sm focus:outline-none"
                                      autoFocus
                                    />
                                    <button
                                      onClick={() => handleRenameTag(tag.id, tag.name, editValue)}
                                      className="p-1 text-bruma hover:text-lavanda"
                                    >
                                      <Check className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => setEditingTag(null)}
                                      className="p-1 text-lavanda-archivo hover:text-marfil"
                                    >
                                      <X className="w-4 h-4" />
                                    </button>
                                  </div>
                                ) : (
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <Hash className="w-3 h-3 text-lavanda-archivo" />
                                      <span className="font-medium text-marfil">{tag.name}</span>
                                    </div>
                                    <p className="text-xs text-lavanda-archivo mt-1">
                                      {tag.count} archivo{tag.count !== 1 ? 's' : ''}
                                    </p>
                                  </div>
                                )}
                              </div>
                            </div>

                            {!editingTag && (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => {
                                    setEditingTag(tag.id);
                                    setEditValue(tag.name);
                                  }}
                                  className="p-1 text-lavanda-archivo hover:text-bruma transition-colors"
                                >
                                  <Edit2 className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => handleDeleteTag(tag.id, tag.name)}
                                  className="p-1 text-lavanda-archivo hover:text-lavanda transition-colors"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {activeTags.length === 0 && (
                <div className="text-center py-12">
                  <Tag className="w-12 h-12 text-pizarra mx-auto mb-3" />
                  <p className="text-lavanda-archivo mb-2">No hay etiquetas activas para gestionar</p>
                  <p className="text-sm text-lavanda-archivo">Usa el buscador de arriba para buscar y activar etiquetas</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* History panel */}
        <div className="lg:col-span-1">
          {showHistory && (
            <div className="bg-tinta rounded-3xl border border-pizarra p-6">
              <h3 className="font-semibold text-marfil mb-4 flex items-center gap-2">
                <Clock className="w-5 h-5 text-lavanda" />
                Historial de cambios
              </h3>

              {history.length === 0 ? (
                <p className="text-sm text-lavanda-archivo text-center py-8">
                  No hay acciones recientes
                </p>
              ) : (
                <div className="space-y-3 max-h-[600px] overflow-y-auto">
                  {history.map(action => {
                    const canStillUndo = action.canUndo && 
                      (new Date().getTime() - action.timestamp.getTime()) < 7 * 24 * 60 * 60 * 1000;

                    return (
                      <div
                        key={action.id}
                        className={`p-3 rounded-2xl border ${
                          canStillUndo ? 'border-pizarra' : 'border-pizarra opacity-50'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <p className="text-sm font-medium text-marfil">
                              {action.type === 'rename' && 'Renombrado'}
                              {action.type === 'delete' && 'Eliminado'}
                              {action.type === 'merge' && 'Fusión'}
                              {action.type === 'create' && 'Creado'}
                              {action.type === 'bulk_edit' && 'Edición masiva'}
                            </p>
                            <p className="text-xs text-lavanda-archivo mt-1">
                              {action.type === 'rename' && (
                                <span>"{action.oldValue}" → "{action.newValue}"</span>
                              )}
                              {action.type === 'delete' && (
                                <span>Etiqueta "{action.oldValue?.name}"</span>
                              )}
                              {action.type === 'merge' && (
                                <span>{action.oldValue?.length} etiquetas → "{action.newValue}"</span>
                              )}
                            </p>
                            <p className="text-xs text-lavanda-archivo mt-1">
                              {action.affectedFiles} archivo{action.affectedFiles !== 1 ? 's' : ''}
                            </p>
                            <p className="text-xs text-lavanda-archivo mt-1">
                              {new Date(action.timestamp).toLocaleDateString()} {new Date(action.timestamp).toLocaleTimeString()}
                            </p>
                          </div>

                          {canStillUndo && (
                            <button
                              onClick={() => handleUndo(action.id)}
                              className="p-1 text-bruma hover:text-lavanda transition-colors"
                              title="Deshacer"
                            >
                              <Undo className="w-4 h-4" />
                            </button>
                          )}
                        </div>

                        {!canStillUndo && (
                          <p className="text-xs text-lavanda-claro mt-2 flex items-center gap-1">
                            <AlertCircle className="w-3 h-3" />
                            No se puede deshacer (más de 7 días)
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Quick tips */}
          <div className="bg-grafito rounded-3xl p-6 mt-6">
            <h3 className="font-semibold text-marfil mb-3">Consejos rápidos</h3>
            <ul className="space-y-2 text-sm text-lavanda-archivo">
              <li className="flex items-start gap-2">
                <span className="text-lavanda">•</span>
                Busca etiquetas y haz clic para activarlas y gestionarlas
              </li>
              <li className="flex items-start gap-2">
                <span className="text-lavanda">•</span>
                Selecciona múltiples etiquetas activas para fusionarlas
              </li>
              <li className="flex items-start gap-2">
                <span className="text-lavanda">•</span>
                Los cambios se pueden deshacer durante 7 días
              </li>
              <li className="flex items-start gap-2">
                <span className="text-lavanda">•</span>
                Usa "Limpiar todas" para quitar todas las etiquetas activas
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}