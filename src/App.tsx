import React, { useState, useEffect, useRef } from 'react';
import { Grid, List, LayoutGrid, LayoutList, RefreshCw, Download, Monitor, Shuffle, ChevronLeft, FolderPlus, ArrowLeft } from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';
import { MediaFile, SearchFilters, Collection } from './types';
import { addFilesToCollection, api, createCollection, deleteCollection, deleteFromCollection, getCollectionsByUser, getFavouritesByUser, handleSupabaseFavourite, updateCoverCollection, updateNameCollection } from './services/api';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessionGroups, computeTotalSlots } from './hooks/useSessionGroups';
import { config } from './config';
import { cacheService } from './services/cacheService';

import SearchBar from './components/SearchBar';
import { MoreOptionsMenu } from './components/MoreOptionsMenu';
import { ScrollToTopButton } from './components/ScrollToTopButton';
import { SelectionModeButton } from './components/SelectionModeButton';
import QuickFilters from './components/QuickFilters';
import MediaGrid from './components/MediaGrid';
import MediaModal from './components/MediaModal';
import { FolderScanner } from './components/FolderScanner';
import { CreateCollectionModal } from './components/CreateCollectionModal';
import { AddToCollectionModal } from './components/AddToCollectionModal';
import Statistics from './components/Statistics';
import PresentationMode from './components/PresentationMode';
import ProgressBar from './components/ProgressBar';
import PersonBubbles from './components/PersonBubbles';
import PathManager from './components/PathManager';
import TagManager from './components/TagManager';
import PersonsManager from './components/PersonsManager';
import SynonymsManager from './components/SynonymsManager';

import { CollectionsCarousel } from './components/CollectionsCarousel';
import { CoverImageSelector } from './components/CoverImageSelector';
import { EditCollectionModal } from './components/EditCollectionModal';
import ImageSearchView from './components/ImageSearchView';
import { QuickPreviewOverlay } from './components/QuickPreviewOverlay';
import { normalizePath } from './utils/formatData';

function App() {
  // Uso personal single-user: sin login, sin user.id, sin roles.
  const [activeView, setActiveView] = useState('home');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedFile, setSelectedFile] = useState<MediaFile | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MediaFile[]>([]);
  const [showFolderScanner, setShowFolderScanner] = useState(false);
  const [showCreateCollection, setShowCreateCollection] = useState(false);
  const [showAddToCollection, setShowAddToCollection] = useState(false);
  const [selectedFileForCollection, setSelectedFileForCollection] = useState<string>('');
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const [downloadingCollectionId, setDownloadingCollectionId] = useState<string | null>(null);

  // Presentation mode state
  const [showPresentationMode, setShowPresentationMode] = useState(false);

  // Quick Preview (Space key)
  const [quickPreviewFile, setQuickPreviewFile] = useState<MediaFile | null>(null);
  const hoveredFileIdRef = useRef<string | null>(null);

  // Randomizer state
  const [isRandomized, setIsRandomized] = useState(false);
  const [randomizedOrder, setRandomizedOrder] = useState<string[]>([]); // IDs en orden aleatorio

  // Collection editing state
  const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null);
  const [editingCollectionName, setEditingCollectionName] = useState<string>('');

  // Collection cover editing state
  const [editingCollectionCoverId, setEditingCollectionCoverId] = useState<string | null>(null);
  const [showCoverSelector, setShowCoverSelector] = useState(false);

  // Bulk collection assignment state
  const [showBulkAddToCollection, setShowBulkAddToCollection] = useState(false);

  // Quick filters state (empty array = show all types)
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);

  // Date range filter state
  const [filterDateFrom, setFilterDateFrom] = useState<Date | undefined>();
  const [filterDateTo, setFilterDateTo] = useState<Date | undefined>();

  // Active tags state - separated into included and excluded
  const [includedTags, setIncludedTags] = useState<string[]>([]);
  const [excludedTags, setExcludedTags] = useState<string[]>([]);

  // Person filter state - supports multiple selection (filtra por person_id detectado)
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  // Filtro de color de la rueda HSL. Mantenemos los fileIds que matchearon
  // contra el endpoint /api/search/by-color y el hex objetivo para mostrarlo en UI.
  const [colorFilterFileIds, setColorFilterFileIds] = useState<Set<string> | null>(null);
  const [colorFilterHex, setColorFilterHex] = useState<string | null>(null);

  // Búsqueda natural — fileIds devueltos por el LLM, ordenados por score.
  // Cuando es null no hay búsqueda natural activa. Cuando es array, restringe la grid a esos IDs.
  const [naturalSearchIds, setNaturalSearchIds] = useState<string[] | null>(null);

  // Cuántos de los `naturalSearchIds` pertenecen al tramo "resultados claros"
  // (primary). Los siguientes son "menos probables" (secondary) y se muestran
  // bajo un separador. Se ignora si no hay búsqueda natural activa.
  const [naturalSearchPrimaryCount, setNaturalSearchPrimaryCount] = useState<number>(0);

  // Favorites filter state
  const [showFavoritesOnly, setShowFavoritesOnly] = useState<boolean>(false);

  // Session grouping state
  const [groupingEnabled, setGroupingEnabled] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showAllGroups, setShowAllGroups] = useState<Set<string>>(new Set());

  // Store current search filters to reapply when persons change
  const [currentSearchQuery, setCurrentSearchQuery] = useState<string>('');
  const [currentSearchFilters, setCurrentSearchFilters] = useState<SearchFilters | null>(null);

  // Flag to prevent unnecessary page resets during favorite updates
  const isUpdatingFavoriteRef = useRef(false);

  // WebSocket para progreso de sincronización
  const { isConnected, progressData, clearProgress } = useWebSocket(config.wsUrl);
  const [showProgress, setShowProgress] = useState(false);

  // Infinite scroll state
  const [loadedItemsCount, setLoadedItemsCount] = useState(24);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const ITEMS_PER_LOAD = 24;
  const MAX_LOADED_ITEMS = 1000;

  // Connection state
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [userFavs, setUserFavs] = useState<any[]>([])
  const [updatingFavs, setUpdatingFavs] = useState<boolean>(false)

  // ESC key listener for clearing all filters
  const hasActiveFiltersRef = useRef(false);
  useEffect(() => {
    const handleEscClearFilters = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !hasActiveFiltersRef.current) return;
      // Don't clear filters if any overlay/modal/mode is active
      if (isModalOpen || quickPreviewFile || isSelectionMode || showPresentationMode) return;
      // Don't clear if user is focused on an input/textarea
      const tag = (event.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      clearAllFilters();
    };
    document.addEventListener('keydown', handleEscClearFilters);
    return () => document.removeEventListener('keydown', handleEscClearFilters);
  }, [isModalOpen, quickPreviewFile, isSelectionMode, showPresentationMode]);

  // Quick Preview: track which card is under the cursor
  useEffect(() => {
    const handleMouseOver = (e: MouseEvent) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-file-id]');
      hoveredFileIdRef.current = card ? card.dataset.fileId || null : null;
    };
    document.addEventListener('mouseover', handleMouseOver);
    return () => document.removeEventListener('mouseover', handleMouseOver);
  }, []);

  // Quick Preview: Space toggles overlay, ESC closes
  useEffect(() => {
    const TEXT_INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const active = document.activeElement as HTMLElement | null;
      if (active && (TEXT_INPUT_TAGS.has(active.tagName) || active.isContentEditable)) return;

      if (e.key === ' ') {
        // Don't hijack Space when modal/presentation/selection is active
        if (isModalOpen || showPresentationMode || isSelectionMode) return;

        e.preventDefault();
        if (active && (active.tagName === 'BUTTON' || active.tagName === 'A')) {
          active.blur();
        }

        if (quickPreviewFile) {
          setQuickPreviewFile(null);
        } else if (hoveredFileIdRef.current) {
          const file = mediaFiles.find(f => f.id === hoveredFileIdRef.current);
          if (file) setQuickPreviewFile(file);
        }
      }

      if (e.key === 'Escape' && quickPreviewFile) {
        e.preventDefault();
        e.stopPropagation();
        setQuickPreviewFile(null);
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [quickPreviewFile, mediaFiles, isModalOpen, showPresentationMode, isSelectionMode]);

  // Carga inicial: archivos, colecciones y favoritos (single-user).
  useEffect(() => {
    const init = async () => {
      try {
        const result = await getFavouritesByUser();
        if (result.success && result.data) {
          setUserFavs(result.data);
        }
      } catch (err) {
        console.warn('No se pudieron cargar los favoritos iniciales:', err);
      }
      loadFiles();
      loadCollections();

      // Limpieza de claves antiguas de localStorage que ya no usamos.
      localStorage.removeItem('deletedCollections');
    };
    init();
  }, []);



  // Función centralizada de filtrado con deduplicación y lógica AND estricta
  const applyAllFilters = (
    baseFiles: MediaFile[] = mediaFiles,
    options: {
      searchQuery?: string;
      searchFilters?: SearchFilters;
      tags?: string[];
      excludeTags?: string[];
      types?: string[];
      personIds?: string[];
      favoritesOnly?: boolean;
      skipDedup?: boolean;
      colorFileIds?: Set<string> | null;
    } = {}
  ) => {
    let filtered = [...baseFiles];
    const { searchQuery, searchFilters, tags = [], excludeTags = [], types = selectedTypes, personIds = selectedPersonIds, favoritesOnly = showFavoritesOnly, skipDedup = false, colorFileIds = colorFilterFileIds } = options;

    // 1. Aplicar búsqueda de texto si existe
    if (searchQuery && searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(file =>
        file.name.toLowerCase().includes(query) ||
        file.tags.some(tag => tag.toLowerCase().includes(query))
      );
    }

    // 2. Aplicar filtros de búsqueda (fechas, etc)
    if (searchFilters) {
      if (searchFilters.type && searchFilters.type !== 'all') {
        filtered = filtered.filter(file => file.type === searchFilters.type);
      }
      // Usar extractedDate para filtros de fecha (si existe), sino usar createdAt como fallback
      if (searchFilters.dateFrom) {
        filtered = filtered.filter(file => {
          const dateToCompare = file.extractedDate || file.createdAt;
          return dateToCompare >= searchFilters.dateFrom!;
        });
      }
      if (searchFilters.dateTo) {
        filtered = filtered.filter(file => {
          const dateToCompare = file.extractedDate || file.createdAt;
          return dateToCompare <= searchFilters.dateTo!;
        });
      }
      // Filtros de año y mes usando extractedDate
      if (searchFilters.year) {
        filtered = filtered.filter(file => {
          if (!file.extractedDate) return false;
          return file.extractedDate.getFullYear().toString() === searchFilters.year;
        });
      }
      if (searchFilters.month) {
        filtered = filtered.filter(file => {
          if (!file.extractedDate) return false;
          const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
          const monthIndex = months.findIndex(m => m.toLowerCase() === searchFilters.month?.toLowerCase());
          return monthIndex !== -1 && file.extractedDate.getMonth() === monthIndex;
        });
      }
    }

    // 3. Aplicar filtro de tipos (Quick Filters) - LÓGICA AND
    if (types && types.length > 0 && !types.includes('all')) {
      filtered = filtered.filter(file => {
        // Si hay tipos seleccionados, el archivo DEBE ser uno de esos tipos
        return types.includes(file.type) || (types.includes('export') && file.type === 'document');
      });
    }

    // 4. Aplicar filtro de etiquetas incluidas - LÓGICA AND
    if (tags && tags.length > 0) {
      filtered = filtered.filter(file =>
        tags.every(tag =>
          file.tags.some(fileTag =>
            fileTag.toLowerCase().includes(tag.toLowerCase())
          )
        )
      );
    }

    // 4b. Aplicar filtro de etiquetas excluidas - LÓGICA NOT
    if (excludeTags && excludeTags.length > 0) {
      filtered = filtered.filter(file =>
        excludeTags.every(tag =>
          !file.tags.some(fileTag =>
            fileTag.toLowerCase().includes(tag.toLowerCase())
          )
        )
      );
    }

    // 5. Aplicar filtro de personas detectadas - LÓGICA OR
    // Un archivo matchea si tiene al menos una de las personas seleccionadas en file.faces
    if (personIds && personIds.length > 0) {
      filtered = filtered.filter(file =>
        file.faces?.some(f => personIds.includes(f.person_id))
      );
    }

    // 5b. Filtro por color — fileIds devueltos por /api/search/by-color
    if (colorFileIds && colorFileIds.size > 0) {
      filtered = filtered.filter(file => colorFileIds.has(file.id));
    }

    // 6. Búsqueda natural — restringe a los IDs devueltos por el LLM
    // y ordena según el ranking de score que vino del backend.
    if (naturalSearchIds !== null) {
      const order = new Map(naturalSearchIds.map((id, idx) => [id, idx]));
      filtered = filtered
        .filter(file => order.has(file.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }

    // 7. Aplicar filtro de favoritos
    if (favoritesOnly) {
      filtered = filtered.filter(file => file.isFavorite === true);
    }

    // 8. DEDUPLICACIÓN - Eliminar archivos duplicados por ID
    if (!skipDedup) {
      const seen = new Set<string>();
      filtered = filtered.filter(file => {
        if (seen.has(file.id)) {
          console.warn(`⚠️ Archivo duplicado eliminado: ${file.name} (${file.id})`);
          return false;
        }
        seen.add(file.id);
        return true;
      });
    }

    // console.log(`🔍 Filtrado aplicado: ${baseFiles.length} → ${filtered.length} archivos`);
    // console.log(`   Búsqueda: "${searchQuery || 'ninguna'}"`);
    // console.log(`   Tipos: [${types.join(', ')}]`);
    // console.log(`   Etiquetas incluidas: [${tags.join(', ')}]`);
    // console.log(`   Etiquetas excluidas: [${excludeTags.join(', ')}]`);
    // console.log(`   Personas: [${personIds.join(', ')}]`);
    // console.log(`   Solo favoritos: ${favoritesOnly ? 'Sí' : 'No'}`);

    return filtered;
  };

  // Reapply filters when selectedTypes changes
  useEffect(() => {
    // Skip if we're just updating favorite status to avoid unnecessary recalculation
    if (isUpdatingFavoriteRef.current) {
      console.log('📄 Salteando recalculo de filtros durante actualización de favorito');
      return;
    }

    const filtered = applyAllFilters(mediaFiles, {
      searchQuery: currentSearchQuery,
      searchFilters: currentSearchFilters || undefined,
      tags: includedTags,
      excludeTags: excludedTags,
      types: selectedTypes,
      personIds: selectedPersonIds,
      favoritesOnly: showFavoritesOnly
    });

    // Only reset page if the number of results changed significantly
    const currentCount = filteredFiles.length;
    const newCount = filtered.length;

    setFilteredFiles(filtered);

    // Reset infinite scroll when filter results change significantly (not just property updates)
    if (Math.abs(newCount - currentCount) > 0) {
      resetInfiniteScroll();
      console.log(`📜 Scroll reseteado por cambio de filtros: ${currentCount} -> ${newCount} archivos`);
    }
  }, [mediaFiles, selectedPersonIds, selectedTypes, includedTags, excludedTags, currentSearchQuery, currentSearchFilters, showFavoritesOnly, naturalSearchIds, colorFilterFileIds]);

  // Listener para la tecla ESC para salir del modo selección
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isSelectionMode) {
        exitSelectionMode();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSelectionMode]);

  // FIXED: Listener para swap de IDs temporales
  useEffect(() => {
    const handleCollectionIdSwap = (event: CustomEvent) => {
      const { tempId, serverId } = event.detail;
      console.log(`🔄 Detectado swap de ID: ${tempId} -> ${serverId}`);

      setCollections(prev => prev.map(col =>
        col.id === tempId ? { ...col, id: serverId } : col
      ));
    };

    window.addEventListener('collection-id-swap', handleCollectionIdSwap as EventListener);

    return () => {
      window.removeEventListener('collection-id-swap', handleCollectionIdSwap as EventListener);
    };
  }, []);

  // Cache management on startup
  useEffect(() => {
    validateCache();
    cleanupCache();

    // Set up periodic cache cleanup (every 24 hours)
    const cacheInterval = setInterval(() => {
      cleanupCache();
    }, 24 * 60 * 60 * 1000);

    return () => clearInterval(cacheInterval);
  }, []);

  // Función auxiliar para recargar archivos después de sincronización
  const reloadFilesAfterSync = async () => {
    try {
      setIsLoading(true);
      setConnectionError(null);

      const response = await api.getFiles();
      if (response.success && Array.isArray(response.data)) {
        const files = response.data.map(file => ({
          ...file,
          createdAt: new Date(file.createdAt),
          modifiedAt: new Date(file.modifiedAt),
          extractedDate: file.extractedDate ? new Date(file.extractedDate) : undefined,
          isFavorite: userFavs.some(f => normalizePath(file.fullPath) === normalizePath(f.photo_url))
        }));
        setMediaFiles(files);
        // Apply active filters to new files
        const filtered = applyAllFilters(files, {
          searchQuery: currentSearchQuery,
          searchFilters: currentSearchFilters || undefined,
          tags: includedTags,
          excludeTags: excludedTags,
          types: selectedTypes,
          personIds: selectedPersonIds
        });
        setFilteredFiles(filtered);
        setLastSync(new Date());
        console.log(`✅ ${files.length} archivos cargados después de sincronización`);
      }
    } catch (error) {
      console.error('❌ Error recargando archivos después de sync:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Manejar progreso de WebSocket
  useEffect(() => {
    if (progressData) {
      switch (progressData.type) {
        case 'sync_start':
          setShowProgress(true);
          break;
        case 'sync_progress':
        case 'scan_progress':
          setShowProgress(true);
          break;
        case 'sync_complete':
          // Mantener visible por 3 segundos y luego ocultar
          setTimeout(() => {
            setShowProgress(false);
            clearProgress();
            // Recargar los archivos para mostrar los nuevos
            reloadFilesAfterSync();
          }, 3000);
          break;
        case 'sync_error':
          // Mostrar error por 5 segundos
          setTimeout(() => {
            setShowProgress(false);
            clearProgress();
          }, 5000);
          break;
      }
    }
  }, [progressData, clearProgress]);

  const loadFiles = async (forceSync = false) => {
    try {
      setIsLoading(true);
      setConnectionError(null);

      // Si forceSync es true, primero sincronizar con el servidor
      if (forceSync) {
        console.log('🔄 Forzando sincronización con el servidor...');
        const syncResponse = await api.syncFiles();
        if (syncResponse.success) {
          console.log(`✅ Sincronización completada: ${syncResponse.count} archivos`);
        }
      }

      const response = await api.getFiles();
      if (response.success && response.data) {

        const files = response.data.map(file => ({
          ...file,
          createdAt: new Date(file.createdAt),
          modifiedAt: new Date(file.modifiedAt),
          extractedDate: file.extractedDate ? new Date(file.extractedDate) : undefined,
          isFavorite: userFavs.some(f => normalizePath(file.fullPath) === normalizePath(f.photo_url))
        }));

        //  for (const f of userFavs){
        //   console.log(f.photo_url)
        //   const file = files.find(f => f.fullPath.includes("EDEM fachada.jpeg"))
        //   console.log(normalizePath(file.fullPath) === normalizePath(f.photo_url), normalizePath(file.fullPath), normalizePath(f.photo_url))
        //   console.log(file)
        //  }



        // FIXED: Restaurar favoritos usando sistema híbrido robusto
        console.log('🔄 Restaurando favoritos desde múltiples fuentes...');

        // 1. Verificar favoritos del servidor
        const serverFavorites = files.filter(f => f.isFavorite).length;
        console.log(`📊 Favoritos desde servidor: ${serverFavorites}`);

        // 2. SIEMPRE verificar caché local para favoritos pendientes de sincronización
        const cachedFavorites = cacheService.get('favorites');
        if (cachedFavorites && cachedFavorites.length > 0) {
          console.log(`📦 Cache local contiene ${cachedFavorites.length} favoritos`);

          // Identificar favoritos pendientes de sincronización
          const pendingFavorites = cachedFavorites.filter(
            item => item.metadata.syncStatus === 'pending'
          );

          if (pendingFavorites.length > 0) {
            console.log(`⏳ Detectados ${pendingFavorites.length} favoritos pendientes de sincronización`);

            // Aplicar favoritos pendientes a los archivos localmente
            const pendingIds = new Set(pendingFavorites.map(item => item.data.fileId));
            let appliedCount = 0;

            files.forEach(file => {
              if (pendingIds.has(file.id) && !file.isFavorite) {
                file.isFavorite = true;
                appliedCount++;
              }
            });

            if (appliedCount > 0) {
              console.log(`✅ Aplicados ${appliedCount} favoritos pendientes localmente`);
            }

            // Sincronizar favoritos pendientes con servidor en segundo plano
            syncLocalFavoritesToServer(pendingIds);
          } else {
            console.log('✅ No hay favoritos pendientes de sincronización');
          }

          // Si servidor no tenía favoritos pero cache local sí (recuperación total)
          if (serverFavorites === 0 && cachedFavorites.length > 0) {
            console.log('⚠️ Servidor sin favoritos, restaurando desde caché local completo');
            const allCachedIds = new Set(cachedFavorites.map(item => item.data.fileId));
            let restoredCount = 0;

            files.forEach(file => {
              if (allCachedIds.has(file.id)) {
                file.isFavorite = true;
                restoredCount++;
              }
            });

            console.log(`✅ Restaurados ${restoredCount} favoritos desde caché local`);
            syncLocalFavoritesToServer(allCachedIds);
          }
        } else {
          console.log('📦 No hay caché local de favoritos');
        }

        setMediaFiles(files);
        // Apply active filters to new files
        const filtered = applyAllFilters(files, {
          searchQuery: currentSearchQuery,
          searchFilters: currentSearchFilters || undefined,
          tags: includedTags,
          excludeTags: excludedTags,
          types: selectedTypes,
          personIds: selectedPersonIds
        });
        setFilteredFiles(filtered);
        setLastSync(new Date());
        setConnectionError(null); // Clear any previous errors
      } else {
        // Si no hay archivos, establecer arrays vacíos pero no mostrar error
        setMediaFiles([]);
        setFilteredFiles([]);
      }
    } catch (error) {
      console.error('Error cargando archivos:', error);
      setMediaFiles([]);
      setFilteredFiles([]);
      if (error.message?.includes('fetch') || error.message?.includes('Failed')) {
        setConnectionError('No se puede conectar al servidor. Verifique que el backend esté ejecutándose.');
      } else {
        setConnectionError('Error al cargar archivos del servidor.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const loadCollections = async () => {
    // Cargar desde el servicio de caché unificado
    // const cachedItems = cacheService.get<Collection>('collections');
    // const cachedCollections = cachedItems ? cachedItems.map(item => ({
    //   ...item.data,
    //   createdAt: new Date(item.data.createdAt),
    //   updatedAt: new Date(item.data.updatedAt || item.data.createdAt)
    // })) : [];

    // console.log('🔍 Debug - Cached collections loaded:', cachedCollections.map(c => ({
    //   id: c.id,
    //   name: c.name,
    //   coverImage: c.coverImage,
    //   coverType: c.coverType
    // })));

    // // FIXED: Sincronizar colecciones pendientes antes del merge
    // if (cachedItems && cachedItems.length > 0) {
    //   const pendingCollections = cachedItems.filter(
    //     item => item.metadata.syncStatus === 'pending' || item.metadata.syncStatus === 'dirty'
    //   );

    //   if (pendingCollections.length > 0) {
    //     console.log(`⏳ Detectadas ${pendingCollections.length} colecciones pendientes de sincronización`);
    //     try {
    //       const syncedCount = await cacheService.syncCollectionsToServer();
    //       console.log(`✅ Sincronizadas ${syncedCount} colecciones con el servidor`);
    //     } catch (error) {
    //       console.warn('⚠️ Error sincronizando colecciones pendientes:', error);
    //     }
    //   }
    // }

    // Intentar sincronizar con servidor
    try {
      const response = await getCollectionsByUser();
      console.log('🔍 Debug - Collections response from server:', response);

      if (response.success && response.data) {
        // const serverCols = response.data.map(col => ({
        //   ...col,
        //   createdAt: new Date(col.createdAt),
        //   updatedAt: new Date(col.updatedAt)
        // }));

        // Usar el servicio de caché para merge inteligente
        // const mergedCollections = cacheService.merge(
        //   'collections',
        //   cachedItems || [],
        //   response.data
        // );

        // // Actualizar caché con datos mergeados
        // cacheService.set('collections', mergedCollections, 'server');
        console.log(response.data)
        setCollections(response.data);

        console.log('✅ Colecciones sincronizadas:', response.data.length, 'items');
      } else {
        // Si no hay datos del servidor, usar solo caché
        setCollections([]);
      }
    } catch (error) {
      console.error('Error cargando colecciones del servidor:', error);
      // Mantener colecciones cacheadas en caso de error
      setCollections([]);
    }
  };

  const handleCollectionsReorder = (reorderedCollections: Collection[]) => {
    setCollections(reorderedCollections);
    cacheService.set('collections', reorderedCollections, 'local');
  };

  // Event handlers
  const handleSearch = async (query: string, filters: SearchFilters) => {
    // Save current search query and filters
    setCurrentSearchQuery(query);
    setCurrentSearchFilters(filters);


    // Si tenemos filtros de fecha extraída, usar búsqueda del backend
    if (filters.year || filters.month || filters.dateFrom || filters.dateTo) {
      try {
        setIsLoading(true);
        const response = await api.searchFiles({
          q: query,
          type: filters.selectedTypes && !filters.selectedTypes.includes('all')
            ? filters.selectedTypes.join(',')
            : (filters.type !== 'all' ? filters.type : undefined),
          tags: filters.tags?.join(','),
          year: filters.year,
          month: filters.month,
          dateFrom: filters.dateFrom?.toISOString().split('T')[0],
          dateTo: filters.dateTo?.toISOString().split('T')[0],
          exports: filters.exports
        });

        if (response.success && response.data) {
          let files = response.data.map(file => ({
            ...file,
            createdAt: new Date(file.createdAt),
            modifiedAt: file.modifiedAt ? new Date(file.modifiedAt) : new Date(),
            extractedDate: file.extractedDate ? new Date(file.extractedDate) : undefined
          }));

          // Aplicar TODOS los filtros locales restantes usando la función centralizada
          // Esto garantiza que la lógica AND funcione siempre, sin importar el orden
          files = applyAllFilters(files, {
            searchQuery: '', // Ya filtrado por el backend
            searchFilters: undefined, // Ya filtrado por el backend
            tags: [], // Ya filtrado por el backend
            types: selectedTypes, // Aplicar filtros de tipo localmente
            personIds: selectedPersonIds, // Aplicar filtros de personas
            favoritesOnly: showFavoritesOnly, // Aplicar filtro de favoritos
            skipDedup: true // No deduplicar, el backend ya lo hizo
          });

          setFilteredFiles(files);
        }
        return;
      } catch (error) {
        console.error('Error en búsqueda del backend:', error);
        // Fallback a búsqueda local
      } finally {
        setIsLoading(false);
      }
    }

    // Búsqueda local usando la función centralizada
    const filtered = applyAllFilters(mediaFiles, {
      searchQuery: query,
      searchFilters: filters,
      tags: filters.tags,
      types: selectedTypes
      // colors: selectedColors // TODO: Implementar filtrado por colores
    });

    setFilteredFiles(filtered);
  };


  const handleToggleFavorite = async (fileId: string) => {
    setUpdatingFavs(true);
    const file = mediaFiles.find(f => f.id === fileId);
    if (!file) return;

    // Set flag to prevent unnecessary page resets
    isUpdatingFavoriteRef.current = true;

    try {
      // Update local state immediately for better UX
      const newFavoriteStatus = !file.isFavorite;

      // Update mediaFiles array
      const updatedFiles = mediaFiles.map(f =>
        f.id === fileId
          ? { ...f, isFavorite: newFavoriteStatus }
          : f
      );
      setMediaFiles(updatedFiles);

      // Update filtered files directly to avoid triggering useEffect chain
      setFilteredFiles(prev => {
        const updatedFiltered = prev.map(f =>
          f.id === fileId
            ? { ...f, isFavorite: newFavoriteStatus }
            : f
        );

        // Log that we're updating favorite status without changing page
        console.log(`❤️ Estado de favorito actualizado para ${file.name} sin resetear página`);

        return updatedFiltered;
      });

      // Update selected file if it's the same
      if (selectedFile && selectedFile.id === fileId) {
        setSelectedFile({ ...selectedFile, isFavorite: newFavoriteStatus });
      }

      // Actualizar en backend (single-user)
      try {
        const favs = await handleSupabaseFavourite(file.fullPath!, '', userFavs)
        setUserFavs(favs ?? [])

      } catch {
        console.log("Error al intentar actualizar el estado favorito")
      }

    } finally {
      // Reset flag to allow normal filter recalculations
      isUpdatingFavoriteRef.current = false;
      setTimeout(() => {
        setUpdatingFavs(false)
      }, 1000)
    }
  };

  const handleDownload = async (file: MediaFile) => {
    try {
      console.log(`📥 Iniciando descarga de: ${file.name}`);

      // Añadir archivo a la lista de descargas en progreso
      setDownloadingFiles(prev => new Set([...prev, file.id]));

      // Descargar el archivo del backend
      const blob = await api.downloadFile(file.id);

      // Crear URL temporal para el blob
      const url = window.URL.createObjectURL(blob);

      // Crear elemento <a> invisible para trigger la descarga
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name; // Nombre del archivo
      link.style.display = 'none';

      // Añadir al DOM, hacer clic y remover
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Limpiar URL temporal
      window.URL.revokeObjectURL(url);

      console.log(`✅ Descarga completada: ${file.name}`);

    } catch (error) {
      console.error('Error descargando archivo:', error);
      alert(`Error al descargar ${file.name}. Por favor, intenta de nuevo.`);
    } finally {
      // Remover archivo de la lista de descargas en progreso
      setDownloadingFiles(prev => {
        const updated = new Set(prev);
        updated.delete(file.id);
        return updated;
      });
    }
  };

  const handleOpenPath = async (fileId: string) => {
    try {
      console.log(`📂 Abriendo ruta del archivo: ${fileId}`);

      const response = await fetch(`${config.apiUrl}/api/files/${fileId}/open-path`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();

      if (result.success) {
        console.log(`✅ Carpeta abierta exitosamente: ${result.path}`);
        // Mostrar notificación opcional
        // alert(`Carpeta abierta: ${result.path}`);
      } else {
        console.error('❌ Error al abrir carpeta:', result.error);
        alert(`Error al abrir la carpeta: ${result.error}`);
      }

    } catch (error) {
      console.error('Error abriendo ruta:', error);
      alert('Error al abrir la ruta del archivo. Por favor, intenta de nuevo.');
    }
  };

  // Logout eliminado: uso personal sin auth.

  // Selection mode functions
  const handleFileClick = (file: MediaFile, event?: React.MouseEvent) => {
    // Si es Ctrl+Click, entrar en modo selección múltiple
    if (event?.ctrlKey || event?.metaKey) {
      event.preventDefault();

      // Activar modo selección si no está activo
      if (!isSelectionMode) {
        setIsSelectionMode(true);
        setSelectedFiles(new Set([file.id]));
      } else {
        // Toggle la selección del archivo
        setSelectedFiles(prev => {
          const updated = new Set(prev);
          if (updated.has(file.id)) {
            updated.delete(file.id);
            // Si no quedan archivos seleccionados, salir del modo
            if (updated.size === 0) {
              setIsSelectionMode(false);
            }
          } else {
            updated.add(file.id);
          }
          return updated;
        });
      }
      return;
    }

    // Si está en modo selección y es click normal, seleccionar/deseleccionar
    if (isSelectionMode) {
      setSelectedFiles(prev => {
        const updated = new Set(prev);
        if (updated.has(file.id)) {
          updated.delete(file.id);
          // Si no quedan archivos seleccionados, salir del modo
          if (updated.size === 0) {
            setIsSelectionMode(false);
          }
        } else {
          updated.add(file.id);
        }
        return updated;
      });
      return;
    }

    // Click normal - abrir modal
    setSelectedFile(file);
    setIsModalOpen(true);
  };

  const exitSelectionMode = () => {
    setIsSelectionMode(false);
    setSelectedFiles(new Set());
  };

  const selectAllFiles = () => {
    const allFiles = getAllDisplayFiles(); // Select all files, not just current page
    setSelectedFiles(new Set(allFiles.map(file => file.id)));
  };

  const selectLoadedFiles = () => {
    const loadedFiles = getDisplayFiles(); // Select loaded files (with infinite scroll)
    const currentSelection = new Set(selectedFiles);
    loadedFiles.forEach(file => currentSelection.add(file.id));
    setSelectedFiles(currentSelection);
    console.log(`✅ Seleccionados ${loadedFiles.length} archivos cargados`);
  };

  const clearAllSelections = () => {
    setSelectedFiles(new Set());
  };

  // Randomizer functions - Optimized to work with IDs instead of full objects
  const shuffleArray = <T,>(array: T[]): T[] => {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  };

  // Generate randomized order of file IDs
  const generateRandomizedOrder = (files: MediaFile[]): string[] => {
    return shuffleArray(files.map(file => file.id));
  };

  // Get base files for randomization without applying randomization
  const getBaseDisplayFiles = () => {
    let files: MediaFile[] = [];

    switch (activeView) {
      case 'home':
      default:
        if (selectedCollectionId) {
          // When a collection is selected in home view, get collection files
          const collection = collections.find(c => c.id === selectedCollectionId);
          if (collection) {
            // 1. First get all files that belong to the collection
            const collectionFiles = mediaFiles.filter(file => collection.mediaFiles.includes(normalizePath(file.fullPath!)));

            // 2. Apply all active filters to the collection files
            files = applyAllFilters(collectionFiles, {
              searchQuery: currentSearchQuery,
              searchFilters: currentSearchFilters || undefined,
              tags: includedTags,
              excludeTags: excludedTags,
              types: selectedTypes,
              personIds: selectedPersonIds,
              favoritesOnly: showFavoritesOnly
            });

            // 3. Apply natural sorting to collection files
            files = files.sort((a, b) => {
              // Primary: Sort by extracted date (if different)
              const dateA = extractDateFromFilename(a.name);
              const dateB = extractDateFromFilename(b.name);
              if (dateA !== dateB) {
                return dateB - dateA; // Descending (newest first)
              }

              // Secondary: Natural name comparison for files with same date
              const nameCompare = optimizedNameCompare(a.name, b.name);
              if (nameCompare !== 0) {
                return nameCompare;
              }

              // Tertiary: ID as tiebreaker for stability
              return normalizePath(a.fullPath!).localeCompare(normalizePath(b.fullPath!));
            });

            console.log(`🗂️ Colección "${collection.name}": ${files.length} de ${collectionFiles.length} archivos (filtrados y ordenados)`);
          }
        } else {
          // Normal filtered files when no collection is selected
          files = filteredFiles;
        }
        break;
    }

    // Apply default sorting for home view without collection
    if (activeView === 'home' && !selectedCollectionId) {
      // Store the sorted files result for optimization
      files = sortedFiles;
    }

    return files;
  };

  const toggleRandomizer = () => {
    if (isRandomized) {
      // Restaurar orden original
      setIsRandomized(false);
      setRandomizedOrder([]);
      resetInfiniteScroll();
      console.log('🔀 Randomizador desactivado - Orden original restaurado');
    } else {
      // Activar randomización - generar orden completo una sola vez
      const filesToRandomize = getBaseDisplayFiles();
      const newRandomOrder = generateRandomizedOrder(filesToRandomize);
      setRandomizedOrder(newRandomOrder);
      setIsRandomized(true);
      resetInfiniteScroll();
      console.log(`🔀 Randomizador activado - ${filesToRandomize.length} archivos mezclados (orden completo precomputado)`);
    }
  };

  const handleBulkDownload = async () => {
    if (selectedFiles.size === 0) return;

    if (selectedFiles.size === 1) {
      // Single file download
      const fileId = Array.from(selectedFiles)[0];
      const file = mediaFiles.find(f => f.id === fileId);
      if (file) {
        await handleDownload(file);
      }
      return;
    }

    // Multiple files - download as ZIP
    try {
      console.log(`📦 Iniciando descarga ZIP de ${selectedFiles.size} archivos`);
      setIsDownloadingZip(true);

      const response = await api.downloadMultipleFiles(Array.from(selectedFiles));

      // Create download link
      const url = window.URL.createObjectURL(response);
      const link = document.createElement('a');
      link.href = url;
      link.download = `archivos_${new Date().toISOString().split('T')[0]}.zip`;
      link.style.display = 'none';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      window.URL.revokeObjectURL(url);
      console.log(`✅ Descarga ZIP completada`);

      // Clear selections after successful download
      setSelectedFiles(new Set());

    } catch (error) {
      console.error('Error descargando archivos:', error);
      alert('Error al crear el archivo ZIP. Por favor, intenta de nuevo.');
    } finally {
      setIsDownloadingZip(false);
    }
  };

  const handleFolderUpload = (files: any[]) => {
    // Aquí procesaríamos los archivos seleccionados
    console.log('Archivos para subir:', files);
    alert(`Se han seleccionado ${files.length} archivos para procesar`);
    setShowFolderScanner(false);
  };

  const handleCreateCollection = async (
    name: string,
    description: string,
    coverImage?: { type: 'system' | 'custom'; value: string },
    smart?: { rules: any[]; combinator: 'AND' | 'OR' }
  ) => {
    // Create collection locally first with unique temp ID
    const clientTempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newCollection: any = {
      id: clientTempId, // Temporary ID - also sent to server to prevent duplicates
      name,
      description,
      mediaFiles: [],
      coverImage: coverImage?.value,
      coverType: coverImage?.type,
      createdAt: new Date(),
      updatedAt: new Date(),
      isPublic: false,
      createdBy: ''
    };
    // Smart Folder: persistir los campos extra para que createCollection los envie al backend
    if (smart && smart.rules.length > 0) {
      newCollection.type = 'smart';
      newCollection.rules = smart.rules;
      newCollection.rule_combinator = smart.combinator;
    }

    console.log('🔍 Debug - Nueva colección creada localmente:', newCollection);

    // Update local state immediately
    const updatedCollections = [...collections, newCollection];
    setCollections(updatedCollections);

    // Guardar en el servicio de caché unificado
    // try {
    //   console.log('🔍 Debug - Saving collection with cover:', {
    //     id: newCollection.id,
    //     name: newCollection.name,
    //     coverImage: newCollection.coverImage,
    //     coverType: newCollection.coverType
    //   });
    //   cacheService.updateItem('collections', newCollection.id, newCollection, 'local');
    //   console.log(`💾 Colección "${name}" guardada en caché unificado`);
    //   alert(`Colección "${name}" creada exitosamente`);
    // } catch (error) {
    //   console.error('Error guardando colección en caché unificado:', error);
    // }

    // FIXED: Try to sync with server (sin eliminar temporal si falla)
    try {
      const response = await createCollection(newCollection);
      // if (response.success && response.data) {
      //   // Replace temp collection with server response
      //   const serverCollection = {
      //     ...response.data,
      //     createdAt: new Date(response.data.createdAt),
      //     updatedAt: new Date(response.data.updatedAt),
      //     isPublic: false,
      //     createdBy: user?.id || ''
      //   };

      //   setCollections(prev => prev.map(col =>
      //     col.id === newCollection.id ? serverCollection : col
      //   ));

      //   // FIXED: El swap de IDs lo hace automáticamente swapCollectionId en cacheService
      //   // cuando syncPendingItems detecta un temp_ y lo sincroniza exitosamente

      //   console.log(`✅ Colección "${name}" sincronizada con servidor (${serverCollection.id})`);
      // }
    } catch (error) {
      console.warn('⚠️ Error sincronizando colección con servidor (quedará pendiente):', error);
      // FIXED: NO eliminamos la temporal, queda como pending para reintentos
    }
  };

  const handleAddToCollection = (fileId: string) => {
    setSelectedFileForCollection(fileId);
    setShowAddToCollection(true);
  };

  const handleAddFileToCollection = async (collectionId: string) => {
    try {
      const response = await addFilesToCollection(collectionId, [selectedFileForCollection]);
      if (response.success) {
        const updatedCollections = collections.map(collection => {
          if (collection.id === collectionId) {
            return {
              ...collection,
              mediaFiles: [...collection.mediaFiles, selectedFileForCollection],
              updatedAt: new Date()
            };
          }
          return collection;
        });

        setCollections(updatedCollections);

        // Actualizar caché unificado
        // const updatedCollection = updatedCollections.find(c => c.id === collectionId);
        // if (updatedCollection) {
        //   cacheService.updateItem('collections', collectionId, updatedCollection, 'server');
        //   console.log('✅ Colección actualizada en caché unificado después de agregar archivo');
        // }

        // const collection = collections.find(c => c.id === collectionId);
        // alert(`Archivo añadido a la colección "${collection?.name}"`);
      }
    } catch (error: any) {
      console.error('Error añadiendo archivo a colección:', error);

      // // Verificar si es error de límite de colección
      // if (error.status === 413) {
      //   alert(error.message || 'Esta colección ha alcanzado el límite de 500 archivos.');
      //   return; // No intentar actualizar localmente
      // }

      // // Try to update locally even if server fails (solo para otros errores)
      // const updatedCollections = collections.map(collection => {
      //   if (collection.id === collectionId) {
      //     return {
      //       ...collection,
      //       mediaFiles: [...collection.mediaFiles, selectedFileForCollection],
      //       updatedAt: new Date()
      //     };
      //   }
      //   return collection;
      // });

      // setCollections(updatedCollections);

      // // Actualizar caché unificado en modo local (pendiente de sincronización)
      // const updatedCollection = updatedCollections.find(c => c.id === collectionId);
      // if (updatedCollection) {
      //   cacheService.updateItem('collections', collectionId, updatedCollection, 'local');
      //   console.log('⚠️ Colección actualizada localmente (pendiente de sincronización)');
      // }

      // const collection = collections.find(c => c.id === collectionId);
      // alert(`Archivo añadido localmente a "${collection?.name}" (sincronización pendiente)`);
    }
  };

  const handleRemoveFromCollection = async (file: string) => {
    if (!selectedCollectionId) return;

    try {

      const response = await deleteFromCollection(selectedCollectionId, file);
      if (response.success) {
        // Update collections state
        const updatedCollections = collections.map(collection => {
          if (collection.id === selectedCollectionId) {
            return {
              ...collection,
              mediaFiles: collection.mediaFiles.filter(fId => fId !== file),
              updatedAt: new Date()
            };
          }
          return collection;
        });

        setCollections(updatedCollections);

        // // Update unified cache
        // const updatedCollection = updatedCollections.find(c => c.id === selectedCollectionId);
        // if (updatedCollection) {
        //   cacheService.updateItem('collections', selectedCollectionId, updatedCollection, 'server');
        //   console.log('✅ Colección actualizada en caché unificado después de eliminar archivo');
        // }

        // const collection = collections.find(c => c.id === selectedCollectionId);
        // console.log(`✅ Archivo eliminado de la colección "${collection?.name}"`);
      }
    } catch (error) {
      console.error('Error eliminando archivo de colección:', error);

      // // Try to update locally even if server fails
      // const updatedCollections = collections.map(collection => {
      //   if (collection.id === selectedCollectionId) {
      //     return {
      //       ...collection,
      //       mediaFiles: collection.mediaFiles.filter(fId => fId !== fileId),
      //       updatedAt: new Date()
      //     };
      //   }
      //   return collection;
      // });

      // setCollections(updatedCollections);

      // // Update unified cache in local mode (pending sync)
      // const updatedCollection = updatedCollections.find(c => c.id === selectedCollectionId);
      // if (updatedCollection) {
      //   cacheService.updateItem('collections', selectedCollectionId, updatedCollection, 'local');
      //   console.log('⚠️ Colección actualizada localmente (pendiente de sincronización)');
      // }

      // const collection = collections.find(c => c.id === selectedCollectionId);
      // console.log(`⚠️ Archivo eliminado localmente de "${collection?.name}" (sincronización pendiente)`);
    }
  };

  const handleDownloadCollection = async (collectionId: string, e?: React.MouseEvent) => {
    console.log(`📦 Iniciando descarga de colección: ${collectionId}`);

    if (e) {
      e.stopPropagation(); // Prevent opening the collection
    }

    const collection = collections.find(c => c.id === collectionId);
    if (!collection) {
      console.error(`❌ Colección no encontrada: ${collectionId}`);
      toast.error('Colección no encontrada');
      return;
    }

    console.log(`📂 Colección encontrada: "${collection.name}" con ${collection.mediaFiles.length} archivos`);

    try {
      // Set downloading state and show initial toast
      setDownloadingCollectionId(collectionId);
      toast.loading(`Preparando descarga de "${collection.name}"...`, { id: collectionId });

      // Get all files in the collection
      const collectionFiles = mediaFiles.filter(file =>
        collection.mediaFiles.includes(normalizePath(file.fullPath!))
      );

      console.log(`📄 Archivos filtrados: ${collectionFiles.length} de ${collection.mediaFiles.length}`);

      if (collectionFiles.length === 0) {
        console.warn('⚠️ No hay archivos válidos para descargar en la colección');
        toast.error('Esta colección no tiene archivos para descargar', { id: collectionId });
        setDownloadingCollectionId(null);
        return;
      }

      // Update toast with file count
      toast.loading(`Comprimiendo ${collectionFiles.length} archivos...`, { id: collectionId });
      console.log('🚀 Iniciando creación de ZIP...');

      // Create a ZIP file with all collection files
      const fileIds = collectionFiles.map(f => f.id);
      console.log('📋 IDs de archivos para ZIP:', fileIds);

      const blob = await api.downloadMultipleFiles(fileIds);

      console.log(`📦 ZIP creado, tamaño: ${blob.size} bytes`);

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const filename = `${collection.name.replace(/[^a-z0-9\s]/gi, '_')}_collection.zip`;
      link.download = filename;

      console.log(`💾 Descargando como: ${filename}`);

      // Trigger download
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      window.URL.revokeObjectURL(url);

      console.log(`✅ Colección "${collection.name}" descargada exitosamente`);

      // Keep loading toast visible briefly before showing success
      setTimeout(() => {
        toast.success(`Colección "${collection.name}" descargada exitosamente`, { id: collectionId });
      }, 100);

    } catch (error) {
      console.error('❌ Error descargando colección:', error);

      // More detailed error handling
      if (error instanceof TypeError && error.message.includes('fetch')) {
        toast.error('Error de conexión: No se puede conectar al servidor. ¿Está el backend ejecutándose?', { id: collectionId });
      } else if (error instanceof Error) {
        toast.error(`Error al descargar la colección: ${error.message}`, { id: collectionId });
      } else {
        toast.error('Error desconocido al descargar la colección', { id: collectionId });
      }
    } finally {
      setDownloadingCollectionId(null);
      console.log('🔄 Descarga finalizada (limpieza completada)');
    }
  };

  const handleDeleteCollection = async (collectionId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent opening the collection

    const collection = collections.find(c => c.id === collectionId);
    if (!collection) return;

    // Confirm deletion
    const confirmDelete = window.confirm(
      `¿Estás seguro de que quieres eliminar la colección "${collection.name}"?\n\nEsta acción es permanente y no se puede deshacer.`
    );

    if (!confirmDelete) return;

    try {
      // Delete from backend server
      console.log(`🗑️ Intentando eliminar colección ${collectionId}...`);
      const response = await deleteCollection(collectionId);

      // // Remove from cache unificado
      // cacheService.removeItem('collections', collectionId);
      // console.log('✅ Colección eliminada del cache unificado');

      // Remove from active collections
      setCollections(collections.filter(c => c.id !== collectionId));

      // If we were viewing this collection, go back to collections list
      if (selectedCollectionId === collectionId) {
        setSelectedCollectionId(null);
      }

      // // Clean up any localStorage references
      // try {
      //   const collectionsCache = JSON.parse(localStorage.getItem('collectionsCache') || '{}');
      //   if (collectionsCache[collectionId]) {
      //     delete collectionsCache[collectionId];
      //     localStorage.setItem('collectionsCache', JSON.stringify(collectionsCache));
      //   }
      // } catch (err) {
      //   console.warn('Error cleaning localStorage cache:', err);
      // }

      //console.log(`✅ Colección "${collection.name}" eliminada permanentemente`);

    } catch (error) {
      console.error('Error eliminando colección:', error);

      // Si el servidor no responde, preguntar si eliminar localmente
      const deleteLocally = window.confirm(
        `No se pudo conectar con el servidor.\n\nPonte en contacto con un administrador de la plataforma`
      );

      // if (deleteLocally) {
      //   // Remove from cache unificado
      //   cacheService.removeItem('collections', collectionId);
      //   console.log('⚠️ Colección eliminada localmente del cache unificado');

      //   // Remove from active collections
      //   setCollections(collections.filter(c => c.id !== collectionId));

      //   // If we were viewing this collection, go back to collections list
      //   if (selectedCollectionId === collectionId) {
      //     setSelectedCollectionId(null);
      //   }

      //   // Clean up any localStorage references
      //   try {
      //     const collectionsCache = JSON.parse(localStorage.getItem('collectionsCache') || '{}');
      //     if (collectionsCache[collectionId]) {
      //       delete collectionsCache[collectionId];
      //       localStorage.setItem('collectionsCache', JSON.stringify(collectionsCache));
      //     }
      //   } catch (err) {
      //     console.warn('Error cleaning localStorage cache:', err);
      //   }

      //   console.log(`⚠️ Colección "${collection.name}" eliminada localmente (pendiente sincronización)`);
      // }
    }
  };

  // Functions for editing collection names
  const handleCancelEditCollection = () => {
    setEditingCollectionId(null);
    setEditingCollectionName('');
  };

  const handleSaveCollectionName = async (collectionId: string, newName: string) => {
    const trimmedName = newName.trim();

    try {
      // Update in cache first (optimistic update)
      const updatedCollections = collections.map(c =>
        c.id === collectionId
          ? { ...c, name: trimmedName, updatedAt: new Date() }
          : c
      );

      // Update local state immediately
      setCollections(updatedCollections);

      // Update cache service
      const updatedCollection = updatedCollections.find(c => c.id === collectionId);
      if (updatedCollection) {
        cacheService.updateItem('collections', collectionId, updatedCollection, 'local');
      }

      // Reset editing state
      setEditingCollectionId(null);
      setEditingCollectionName('');

      console.log(`✅ Colección renombrada a "${trimmedName}"`);

      // Try to update in backend (non-blocking)
      try {
        const response = await updateNameCollection(collectionId, trimmedName);
        if (response.success) {
          console.log('✅ Cambios sincronizados con el servidor');
          // // Update cache service to mark as synced
          // if (updatedCollection) {
          //   cacheService.updateItem('collections', collectionId, updatedCollection, 'server');
          // }
        } else {
          console.warn('Error actualizando el nomnbre de la colección:');
        }
      } catch (backendError) {
        console.warn('Error actualizando el nomnbre de la colección:');
        // The local change is still applied
      }

    } catch (error) {
      console.error('Error actualizando nombre de colección:', error);
      alert(`Error al actualizar el nombre de la colección`);
    }
  };

  // Cover image editing functions
  const handleEditCollectionCover = (collectionId: string) => {
    setEditingCollectionCoverId(collectionId);
    setShowCoverSelector(true);
  };

  const handleCoverImageUpdate = async (coverData: { type: 'system' | 'custom'; value: string }) => {
    if (!editingCollectionCoverId) return;

    try {
      const updatedCollection = {
        ...collections.find(c => c.id === editingCollectionCoverId)!,
        coverImage: coverData.value,
        coverType: coverData.type,
        updatedAt: new Date()
      };

      console.log(`🎨 Updating cover for collection ${updatedCollection}:`, coverData);

      // // Update backend server
      const response = await updateCoverCollection(editingCollectionCoverId, coverData.value);

      if (!response.success) {
        throw new Error('Error updating cover on server');
      }

      // // Update cache unificado
      // cacheService.updateItem('collections', editingCollectionCoverId, updatedCollection);
      // console.log('✅ Collection cover updated in unified cache');

      // // Update local state
      setCollections(collections.map(c =>
        c.id === editingCollectionCoverId ? updatedCollection : c
      ));

      // console.log(`✅ Collection cover updated successfully`);

    } catch (error) {
      console.error('Error updating collection cover:', error);

      // // Fallback to local update if server is unavailable
      // const updatedCollection = {
      //   ...collections.find(c => c.id === editingCollectionCoverId)!,
      //   coverImage: coverData.value,
      //   coverType: coverData.type,
      //   updatedAt: new Date()
      // };

      // // Update cache unificado
      // cacheService.updateItem('collections', editingCollectionCoverId, updatedCollection);
      // console.log('⚠️ Collection cover updated locally in unified cache');

      // // Update local state
      // setCollections(collections.map(c =>
      //   c.id === editingCollectionCoverId ? updatedCollection : c
      // ));
    } finally {
      setEditingCollectionCoverId(null);
      setShowCoverSelector(false);
    }
  };

  // Bulk collection assignment function
  const handleCreateNewCollectionFromModal = () => {
    setShowAddToCollection(false);
    setShowBulkAddToCollection(false);
    setShowCreateCollection(true);
  };

  const handleBulkAddToCollection = async (collectionId: string) => {
    if (selectedFiles.size === 0) return;

    const urls = Array.from(selectedFiles).map(fileId => {
      const file = mediaFiles.find(f => f.id === fileId);
      return file ? normalizePath(file.fullPath!) : "";
    });

    try {
      const response = await addFilesToCollection(collectionId, urls);
      if (response.success) {
        const updatedCollections = collections.map(collection => {
          if (collection.id === collectionId) {
            return {
              ...collection,
              mediaFiles: [...collection.mediaFiles, ...urls],
              updatedAt: new Date()
            };
          }
          return collection;
        });

        setCollections(updatedCollections);
      }

      // // Update backend server
      // const response = await api.addFilesToCollection(collectionId, fileIds);

      // if (!response.success) {
      //   throw new Error(response.message || 'Error adding files to collection on server');
      // }

      // // Update local collection state
      // const updatedCollections = collections.map(collection => {
      //   if (collection.id === collectionId) {
      //     const newMediaFiles = [...new Set([...collection.mediaFiles, ...fileIds])];
      //     const updatedCollection = {
      //       ...collection,
      //       mediaFiles: newMediaFiles,
      //       updatedAt: new Date()
      //     };

      //     // Update cache unificado
      //     cacheService.updateItem('collections', collectionId, updatedCollection);

      //     return updatedCollection;
      //   }
      //   return collection;
      // });

      // setCollections(updatedCollections);

      // // Clear selections and exit selection mode
      // setSelectedFiles(new Set());
      // setIsSelectionMode(false);
      // setShowBulkAddToCollection(false);

      // const collectionName = collections.find(c => c.id === collectionId)?.name;
      // console.log(`✅ ${fileIds.length} files added to collection "${collectionName}" successfully`);

    } catch (error: any) {
      console.error('Error adding files to collection:', error);

      // // Verificar si es error de límite de colección
      // if (error.status === 413) {
      //   alert(error.message || 'Esta colección ha alcanzado el límite de 500 archivos.');
      //   return; // No actualizar localmente
      // }

      // // Fallback to local update if server is unavailable
      // const updatedCollections = collections.map(collection => {
      //   if (collection.id === collectionId) {
      //     const fileIds = Array.from(selectedFiles);
      //     const newMediaFiles = [...new Set([...collection.mediaFiles, ...fileIds])];
      //     const updatedCollection = {
      //       ...collection,
      //       mediaFiles: newMediaFiles,
      //       updatedAt: new Date()
      //     };

      //     // Update cache unificado
      //     cacheService.updateItem('collections', collectionId, updatedCollection);

      //     return updatedCollection;
      //   }
      //   return collection;
      // });

      // setCollections(updatedCollections);

      // // Clear selections and exit selection mode
      // setSelectedFiles(new Set());
      // setIsSelectionMode(false);
      // setShowBulkAddToCollection(false);

      // const collectionName = collections.find(c => c.id === collectionId)?.name;
      // console.log(`⚠️ ${selectedFiles.size} files added to collection "${collectionName}" locally`);
    }
  };


  // Function to cleanup and validate cache
  const cleanupCache = () => {
    try {
      // FIXED: Usar el servicio de caché unificado que ya tiene lógica TTL
      cacheService.cleanup();
      console.log('🧹 Cache unificado limpiado (TTL aplicado)');

      // FIXED: Limpiar sistema legacy de una vez por todas
      // Solo eliminar si existen, no intentar parsear
      if (localStorage.getItem('favoritesCache')) {
        localStorage.removeItem('favoritesCache');
        console.log('🗑️ Sistema legacy de favoritos eliminado');
      }

      if (localStorage.getItem('collectionsCache')) {
        localStorage.removeItem('collectionsCache');
        console.log('🗑️ Sistema legacy de colecciones eliminado');
      }

      // Obtener estadísticas del nuevo sistema
      const stats = cacheService.getStats();
      console.log('📊 Estado del caché unificado:', stats);

    } catch (error) {
      console.error('Error cleaning cache:', error);
      // Si hay error, limpiar todo para evitar corrupción
      cacheService.clearAll();
      localStorage.removeItem('favoritesCache');
      localStorage.removeItem('collectionsCache');
      console.log('🗑️ Todo el caché limpiado debido a error/corrupción');
    }
  };

  // Función de validación delegada al servicio de caché unificado
  const validateCache = () => {
    try {
      const stats = cacheService.getStats();

      // Validar integridad de cada tipo de caché
      Object.keys(stats).forEach(key => {
        const items = cacheService.get(key);
        if (items && items.some(item => !item.id || !item.metadata)) {
          console.warn(`⚠️ Detectados items inválidos en ${key}, limpiando...`);
          const validItems = items.filter(item => item.id && item.metadata);
          cacheService.set(key, validItems.map(i => i.data), 'local');
        }
      });

      console.log('✅ Caché unificado validado', stats);

    } catch (error) {
      console.error('❌ Validación del caché unificado falló:', error);
      cacheService.clearAll();
      console.log('🗑️ Caché unificado limpiado y será reconstruido');
    }
  };

  const handleTagClick = (tag: string) => {
    // Añadir etiqueta a las incluidas si no está ya en ninguna lista
    const isIncluded = includedTags.includes(tag);
    const isExcluded = excludedTags.includes(tag);

    if (!isIncluded && !isExcluded) {
      // Tag no activa → añadir a incluidas
      const newIncluded = [...includedTags, tag];
      handleTagsChange({ included: newIncluded, excluded: excludedTags });
      console.log(`🏷️ Etiqueta "${tag}" añadida como INCLUIDA`);
    }
    // Si ya está activa, no hacemos nada desde handleTagClick (el ciclo se maneja en SearchBar)
  };

  // Función para sincronizar favoritos locales al servidor
  const syncLocalFavoritesToServer = async (favoriteIds: Set<string>) => {
    console.log('🔄 Sincronizando favoritos locales al servidor...');

    let syncCount = 0;
    const syncPromises = Array.from(favoriteIds).map(async (fileId) => {
      try {
        const response = await api.updateFile(fileId, { isFavorite: true });
        if (response.success) {
          syncCount++;
        }
      } catch (error) {
        console.warn(`⚠️ Error sincronizando favorito ${fileId}:`, error);
      }
    });

    await Promise.allSettled(syncPromises);
    console.log(`✅ Sincronizados ${syncCount}/${favoriteIds.size} favoritos al servidor`);
  };

  const handleTagsChange = (tags: { included: string[]; excluded: string[] }) => {
    setIncludedTags(tags.included);
    setExcludedTags(tags.excluded);

    // Usar función centralizada con todos los filtros activos
    const filtered = applyAllFilters(mediaFiles, {
      searchQuery: currentSearchQuery,
      searchFilters: currentSearchFilters || undefined,
      tags: tags.included,
      excludeTags: tags.excluded,
      types: selectedTypes,
      favoritesOnly: showFavoritesOnly
    });

    // Only reset page if the number of results changed
    const currentCount = filteredFiles.length;
    const newCount = filtered.length;

    setFilteredFiles(filtered);

    // Reset infinite scroll when filter results change (not just property updates)
    if (newCount !== currentCount) {
      resetInfiniteScroll();
      console.log(`📜 Scroll reseteado por cambio de etiquetas: ${currentCount} -> ${newCount} (incluidas: ${tags.included.length}, excluidas: ${tags.excluded.length})`);
    }
  };

  // Clear all active filters
  const clearAllFilters = () => {
    setCurrentSearchQuery('');
    setCurrentSearchFilters(null);
    setFilterDateFrom(undefined);
    setFilterDateTo(undefined);
    setIncludedTags([]);
    setExcludedTags([]);
    setSelectedTypes([]);
    setSelectedPersonIds([]);
    setShowFavoritesOnly(false);
    setNaturalSearchIds(null);
    setColorFilterFileIds(null);
    setColorFilterHex(null);

    resetInfiniteScroll();
  };

  // Handler para resultados de búsqueda por IA (chatbot)
  const handleAIFilters = (aiResponse: any) => {
    console.log('🤖 Aplicando resultados de búsqueda IA:', aiResponse);

    // Nueva estructura: aiResponse tiene { results, intent, metadata }
    if (aiResponse.results?.length > 0) {
      console.log(`🔍 Mostrando ${aiResponse.results.length} resultados de búsqueda IA`);

      // Función para normalizar paths (extraer parte relativa después de "Biblioteca Clips\" o "Biblioteca Fotos\" etc.)
      const normalizePath = (path: string): string => {
        if (!path) return '';
        // Buscar patrones comunes y extraer la parte relativa
        const patterns = [
          /Biblioteca Clips[\\\/](.+)$/i,
          /Biblioteca Fotos[\\\/](.+)$/i,
          /Biblioteca Exports[\\\/](.+)$/i,
          /Biblioteca_Prueba_Pensadero[\\\/](.+)$/i
        ];
        for (const pattern of patterns) {
          const match = path.match(pattern);
          if (match) return match[1].replace(/\\/g, '/');
        }
        // Si no coincide ningún patrón, devolver el path normalizado
        return path.replace(/\\/g, '/');
      };

      // Crear mapa de scores con paths normalizados
      const scoreMap = new Map(
        aiResponse.results.map((r: any) => [normalizePath(r.filePath), r.score])
      );

      // Filtrar mediaFiles comparando paths normalizados
      const matches = mediaFiles
        .filter(file => {
          const normalizedPath = normalizePath(file.path);
          return scoreMap.has(normalizedPath);
        })
        .sort((a, b) => {
          const scoreA = scoreMap.get(normalizePath(a.path)) || 0;
          const scoreB = scoreMap.get(normalizePath(b.path)) || 0;
          return scoreB - scoreA;
        });

      console.log(`🔍 DEBUG: mediaFiles count: ${mediaFiles.length}, matches: ${matches.length}`);

      if (matches.length > 0) {
        // NO tocamos la barra de filtros, solo mostramos resultados
        setFilteredFiles(matches);
        resetInfiniteScroll();
        console.log(`✅ Mostrando ${matches.length} archivos (ordenados por relevancia)`);
      } else {
        console.log('⚠️ No se encontraron coincidencias en mediaFiles');
        // Mostrar array vacío para indicar "sin resultados"
        setFilteredFiles([]);
        resetInfiniteScroll();
      }
    } else {
      console.log('⚠️ La búsqueda no devolvió resultados');
      setFilteredFiles([]);
      resetInfiniteScroll();
    }
  };

  // Quick filters handlers
  const handleTypeSelection = (type: string) => {
    let newSelectedTypes: string[];

    if (selectedTypes.includes(type)) {
      // Deselect type
      newSelectedTypes = selectedTypes.filter(t => t !== type);
    } else {
      // Select type
      newSelectedTypes = [...selectedTypes, type];
    }
    // Empty array = show all types (no need to set ['all'])

    setSelectedTypes(newSelectedTypes);
    applyQuickFilters(newSelectedTypes);
  };

  const applyQuickFilters = (types: string[]) => {
    // Usar función centralizada con todos los filtros activos
    const filtered = applyAllFilters(mediaFiles, {
      searchQuery: currentSearchQuery,
      searchFilters: currentSearchFilters || undefined,
      tags: includedTags,
      excludeTags: excludedTags,
      types: types,
      favoritesOnly: showFavoritesOnly
    });

    // Only reset page if the number of results changed
    const currentCount = filteredFiles.length;
    const newCount = filtered.length;

    setFilteredFiles(filtered);

    // Reset infinite scroll when filter results change (not just property updates)
    if (newCount !== currentCount) {
      resetInfiniteScroll();
      console.log(`📜 Scroll reseteado por cambio de filtros rápidos: ${currentCount} -> ${newCount} archivos`);
    }
  };

  const handleDateRangeChange = (from: Date | undefined, to: Date | undefined) => {
    setFilterDateFrom(from);
    setFilterDateTo(to);

    // Update search filters so the useEffect re-applies filtering
    setCurrentSearchFilters(prev => ({
      ...prev,
      dateFrom: from,
      dateTo: to,
    }));
  };

  const handleFavoritesToggle = () => {
    const newFavoritesState = !showFavoritesOnly;
    setShowFavoritesOnly(newFavoritesState);

    console.log(`❤️ Filtro de favoritos ${newFavoritesState ? 'activado' : 'desactivado'}`);

    // Los filtros se aplicarán automáticamente a través del useEffect que observa showFavoritesOnly
  };

  // Función para extraer fecha YYMMDD del nombre del archivo
  const extractDateFromFilename = (filename: string): number => {
    // Buscar patrón YYMMDD en el nombre del archivo (6 dígitos consecutivos después de un guión y espacio)
    const match = filename.match(/- (\d{6})/);
    if (match) {
      const dateStr = match[1];
      // Convertir YYMMDD a un número para comparación (más grande = más reciente)
      // Asumimos que YY > 50 es 19XX, y YY <= 50 es 20XX
      const yy = parseInt(dateStr.substring(0, 2));
      const mm = parseInt(dateStr.substring(2, 4));
      const dd = parseInt(dateStr.substring(4, 6));

      const year = yy > 50 ? 1900 + yy : 2000 + yy;

      // Retornar como número YYYYMMDD para facilitar comparación
      return year * 10000 + mm * 100 + dd;
    }
    return 0; // Si no tiene fecha, va al final
  };

  // Intl.Collator reutilizable para mejor rendimiento
  const collator = React.useMemo(() => new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base'
  }), []);

  // Extractor optimizado de número de sufijo (n) para patrones como "(1)", "(2)", etc.
  const extractSuffixNumber = (filename: string): number => {
    const match = filename.match(/\((\d+)\)[^)]*$/);
    return match ? parseInt(match[1], 10) : 0;
  };

  // Comparador optimizado que maneja patrones (n) manualmente y usa collator como fallback
  const optimizedNameCompare = (nameA: string, nameB: string): number => {
    const suffixA = extractSuffixNumber(nameA);
    const suffixB = extractSuffixNumber(nameB);

    // Si ambos tienen sufijo numérico, comparar numéricamente
    if (suffixA > 0 && suffixB > 0) {
      // Verificar que el prefijo base sea igual (todo menos el sufijo)
      const baseA = nameA.replace(/\(\d+\)[^)]*$/, '');
      const baseB = nameB.replace(/\(\d+\)[^)]*$/, '');

      if (baseA === baseB) {
        return suffixA - suffixB;
      }
    }

    // Fallback a collator para casos complejos
    return collator.compare(nameA, nameB);
  };

  // Optimized sorted files using useMemo for performance
  // Only sorts when in home view without collection selected
  const sortedFiles = React.useMemo(() => {
    // Only apply optimized sorting for home view without collection
    if (activeView !== 'home' || selectedCollectionId) {
      return filteredFiles;
    }

    if (!filteredFiles || filteredFiles.length === 0) {
      return [];
    }

    // Schwartzian transform: map → sort → map back
    // Pre-compute all values to avoid repeated calculations during sort
    return filteredFiles
      .map((file, originalIndex) => ({
        file,
        date: extractDateFromFilename(file.name),
        originalIndex, // For stable sorting fallback
        id: file.id
      }))
      .sort((a, b) => {
        // Primary: Sort by date (descending - newest first)
        if (a.date !== b.date) {
          return b.date - a.date;
        }

        // Secondary: Optimized name comparison for same dates
        const nameCompare = optimizedNameCompare(a.file.name, b.file.name);
        if (nameCompare !== 0) {
          return nameCompare;
        }

        // Tertiary: Deterministic tiebreaker by ID for stability
        return a.id.localeCompare(b.id);
      })
      .map(item => item.file); // Extract back to original file objects

  }, [filteredFiles, activeView, selectedCollectionId, extractDateFromFilename, optimizedNameCompare]);

  const getAllDisplayFiles = () => {
    // Get base files first
    let files = getBaseDisplayFiles();

    // Apply randomization if active
    if (isRandomized && randomizedOrder.length > 0) {
      // Orden aleatorio precomputado - usar Map para O(1) lookup
      const fileMap = new Map(files.map(file => [file.id, file]));
      files = randomizedOrder
        .map(id => fileMap.get(id))
        .filter((file): file is MediaFile => file !== undefined);
    }

    return files;
  };

  const getDisplayFiles = () => {
    const allFiles = getAllDisplayFiles();
    // Limit to loadedItemsCount with a maximum of MAX_LOADED_ITEMS
    const itemsToShow = Math.min(loadedItemsCount, MAX_LOADED_ITEMS);
    return allFiles.slice(0, itemsToShow);
  };

  const loadMoreItems = () => {
    const allFiles = getAllDisplayFiles();
    const useGrouping = groupingEnabled && viewMode === 'grid';
    const totalSlots = useGrouping
      ? computeTotalSlots(allFiles, expandedGroups, showAllGroups)
      : allFiles.length;
    if (loadedItemsCount < totalSlots && loadedItemsCount < MAX_LOADED_ITEMS) {
      const newCount = Math.min(
        loadedItemsCount + ITEMS_PER_LOAD,
        totalSlots,
        MAX_LOADED_ITEMS
      );
      setLoadedItemsCount(newCount);
      console.log(`📜 Cargando más items: ${newCount} de ${totalSlots}`);
    }
  };

  // ── Smart Empty State: "remove-one" diagnostic ─────────────────────────
  const computeFilterDiagnostic = () => {
    // Determine unfiltered base
    let baseFiles = mediaFiles;
    if (selectedCollectionId) {
      const col = collections.find(c => c.id === selectedCollectionId);
      if (col) baseFiles = mediaFiles.filter(f => col.mediaFiles.includes(f.id));
    }
    if (baseFiles.length === 0) return null;

    // Current options (explicit — avoids closure defaults being used when we omit a key)
    const opts = {
      searchQuery: currentSearchQuery,
      searchFilters: currentSearchFilters || undefined,
      tags: includedTags,
      excludeTags: excludedTags,
      types: selectedTypes,
      personIds: selectedPersonIds,
      favoritesOnly: showFavoritesOnly,
    };

    const candidates: { label: string; chipText: string; onRemove: () => void; count: number }[] = [];

    // Each included tag
    for (const tag of includedTags) {
      const count = applyAllFilters(baseFiles, { ...opts, tags: includedTags.filter(t => t !== tag) }).length;
      if (count > 0) candidates.push({ label: 'Quitar etiqueta', chipText: tag, count, onRemove: () => setIncludedTags(prev => prev.filter(t => t !== tag)) });
    }
    // Each excluded tag
    for (const tag of excludedTags) {
      const count = applyAllFilters(baseFiles, { ...opts, excludeTags: excludedTags.filter(t => t !== tag) }).length;
      if (count > 0) candidates.push({ label: 'Dejar de excluir', chipText: tag, count, onRemove: () => setExcludedTags(prev => prev.filter(t => t !== tag)) });
    }
    // Type filter
    if (selectedTypes.length > 0) {
      const count = applyAllFilters(baseFiles, { ...opts, types: [] }).length;
      if (count > 0) candidates.push({ label: 'Mostrar todos los tipos', chipText: selectedTypes.join(', '), count, onRemove: () => setSelectedTypes([]) });
    }
    // Quitar persona individualmente del filtro
    for (const pid of selectedPersonIds) {
      const count = applyAllFilters(baseFiles, { ...opts, personIds: selectedPersonIds.filter(o => o !== pid) }).length;
      if (count > 0) candidates.push({ label: 'Quitar filtro', chipText: pid, count, onRemove: () => setSelectedPersonIds(prev => prev.filter(o => o !== pid)) });
    }
    // Favorites
    if (showFavoritesOnly) {
      const count = applyAllFilters(baseFiles, { ...opts, favoritesOnly: false }).length;
      if (count > 0) candidates.push({ label: 'Mostrar todos', chipText: 'solo favoritos', count, onRemove: () => setShowFavoritesOnly(false) });
    }
    // Search query
    if (currentSearchQuery?.trim()) {
      const count = applyAllFilters(baseFiles, { ...opts, searchQuery: '' }).length;
      if (count > 0) candidates.push({ label: 'Quitar búsqueda', chipText: `"${currentSearchQuery}"`, count, onRemove: () => setCurrentSearchQuery('') });
    }
    // Date range (lives inside currentSearchFilters)
    if (currentSearchFilters?.dateFrom || currentSearchFilters?.dateTo) {
      const noDate = { ...currentSearchFilters, dateFrom: undefined, dateTo: undefined };
      const count = applyAllFilters(baseFiles, { ...opts, searchFilters: noDate }).length;
      if (count > 0) candidates.push({
        label: 'Quitar filtro de fechas', chipText: 'rango de fechas', count,
        onRemove: () => { setFilterDateFrom(undefined); setFilterDateTo(undefined); setCurrentSearchFilters(prev => prev ? { ...prev, dateFrom: undefined, dateTo: undefined } : null); },
      });
    }

    candidates.sort((a, b) => b.count - a.count);
    return candidates.length > 0 ? candidates.slice(0, 3) : null;
  };

  const resetInfiniteScroll = () => {
    setLoadedItemsCount(ITEMS_PER_LOAD);
    setIsLoadingMore(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ── Session grouping ──────────────────────────────────────────────────────
  const useGrouping = groupingEnabled && viewMode === 'grid';

  // useSessionGroups se llama aquí (nivel de componente) para cumplir reglas de hooks
  const sessionItems = useSessionGroups(
    getAllDisplayFiles(),
    useGrouping,
    expandedGroups,
    showAllGroups,
    loadedItemsCount
  );

  const handleExpandGroup = (key: string) => {
    setExpandedGroups(prev => new Set([...prev, key]));
  };

  const handleCollapseGroup = (key: string) => {
    setExpandedGroups(prev => { const next = new Set(prev); next.delete(key); return next; });
    setShowAllGroups(prev => { const next = new Set(prev); next.delete(key); return next; });
  };

  const handleShowMoreGroup = (key: string) => {
    setShowAllGroups(prev => new Set([...prev, key]));
  };

  const handleSelectSessionFiles = (files: MediaFile[]) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      files.forEach(f => next.add(f.id));
      return next;
    });
  };
  // ─────────────────────────────────────────────────────────────────────────

  // Add scroll listener for infinite scroll
  useEffect(() => {
    const handleScroll = () => {
      if (isLoadingMore || isLoading) return;

      const scrollPosition = window.innerHeight + window.scrollY;
      const threshold = document.body.offsetHeight - 500;
      const allFiles = getAllDisplayFiles();
      const isGrouping = groupingEnabled && viewMode === 'grid';
      const totalSlots = isGrouping
        ? computeTotalSlots(allFiles, expandedGroups, showAllGroups)
        : allFiles.length;

      if (scrollPosition >= threshold &&
        loadedItemsCount < totalSlots &&
        loadedItemsCount < MAX_LOADED_ITEMS &&
        !isLoadingMore) {
        setIsLoadingMore(true);

        // Simulate loading delay for smoother UX
        setTimeout(() => {
          const newCount = Math.min(
            loadedItemsCount + ITEMS_PER_LOAD,
            totalSlots,
            MAX_LOADED_ITEMS
          );
          setLoadedItemsCount(newCount);
          setIsLoadingMore(false);
          console.log(`📜 Items cargados: ${newCount} de ${totalSlots}`);
        }, 300);
      }
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [loadedItemsCount, isLoadingMore, isLoading, filteredFiles, activeView, selectedCollectionId, isRandomized, randomizedOrder, groupingEnabled, viewMode, expandedGroups, showAllGroups]);

  // Reset infinite scroll when switching views or collections
  useEffect(() => {
    resetInfiniteScroll();
    console.log(`📜 Scroll reseteado por cambio de vista/colección`);
  }, [activeView, selectedCollectionId]);

  // Clear selected collection when leaving home view
  useEffect(() => {
    if (activeView !== 'home') {
      setSelectedCollectionId(null);
    }
  }, [activeView]);

  // Update randomized order when base files change and randomizer is active
  useEffect(() => {
    if (isRandomized) {
      const filesToRandomize = getBaseDisplayFiles();
      const newRandomOrder = generateRandomizedOrder(filesToRandomize);
      setRandomizedOrder(newRandomOrder);
      console.log(`🔄 Orden aleatorio actualizado - ${filesToRandomize.length} archivos`);
    }
  }, [mediaFiles, filteredFiles, activeView, selectedCollectionId, isRandomized]);

  const renderMainContent = () => {
    try {
      switch (activeView) {

        case 'statistics':
          return (
            <div>
              <button
                onClick={() => setActiveView('home')}
                className="flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Volver</span>
              </button>
              <Statistics />
            </div>
          );

        case 'tags':
          // Single-user: TagManager siempre disponible
          if (true) {
            return (
              <div>
                <button
                  onClick={() => setActiveView('home')}
                  className="flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Volver</span>
                </button>
                <TagManager
                  mediaFiles={mediaFiles}
                  onFilesUpdate={(updatedFiles) => {
                    setMediaFiles(updatedFiles);
                    setFilteredFiles(updatedFiles);
                  }}
                />
              </div>
            );
          } else {
            return (
              <div className="text-center py-12">
                <h3 className="text-lg font-medium text-marfil mb-2">Acceso Denegado</h3>
                <p className="text-lavanda-archivo">No tienes permisos para acceder a la gestión de etiquetas</p>
              </div>
            );
          }

        case 'synonyms':
          return <SynonymsManager onBack={() => setActiveView('home')} />;

        case 'persons':
          return (
            <PersonsManager
              onBack={() => setActiveView('home')}
              mediaFiles={mediaFiles}
              onSelectFile={(file) => setSelectedFile(file)}
              onFilterByPerson={(personId) => {
                setSelectedPersonIds([personId]);
                setActiveView('home');
              }}
            />
          );

        case 'paths':
          // Single-user: PathManager siempre disponible
          if (true) {
            return (
              <div>
                <button
                  onClick={() => setActiveView('home')}
                  className="flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Volver</span>
                </button>
                <PathManager onSyncComplete={() => {
                  console.log('🔄 Sincronización completada, recargando archivos...');
                  loadFiles(false); // Recargar archivos sin forzar sincronización
                }} />
              </div>
            );
          } else {
            return (
              <div className="text-center py-12">
                <h3 className="text-lg font-medium text-slate-900 mb-2">Acceso Denegado</h3>
                <p className="text-slate-600">No tienes permisos para acceder a esta sección</p>
              </div>
            );
          }

        case 'admin':
          return (
            <div>
              <button
                onClick={() => setActiveView('home')}
                className="flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Volver</span>
              </button>
              <h1 className="text-2xl font-bold text-slate-900 mb-8">Panel de Administración</h1>
              <p className="text-slate-600">Gestiona usuarios, permisos y configuración del sistema</p>
            </div>
          );

        case 'imageSearch':
          return (
            <ImageSearchView
              onFileClick={handleFileClick}
              onToggleFavorite={handleToggleFavorite}
              onDownload={handleDownload}
              onAddToCollection={handleAddToCollection}
              downloadingFiles={downloadingFiles}
              isSelectionMode={isSelectionMode}
              selectedFiles={selectedFiles}
              isAdmin={true}
              onBack={() => setActiveView('home')}
            />
          );

        case 'home':
        default:
          const displayFiles = getDisplayFiles();
          const title = '';

          return (
            <div>
              {/* Header */}
              <div className="flex items-center justify-between mb-4 md:mb-8 flex-wrap gap-2 md:gap-0">
                <div className="flex items-center space-x-4 flex-1 min-w-0 pr-4">
                  {title && <h1 className="text-2xl font-bold text-slate-900">{title}</h1>}
                  {/* Search bar integrada en el header - ocupando todo el espacio disponible */}
                  {activeView === 'home' && (
                    <div className="flex-1">
                      <SearchBar
                        onSearch={handleSearch}
                        includedTags={includedTags}
                        excludedTags={excludedTags}
                        onTagsChange={handleTagsChange}
                        onNaturalSearch={(fileIds, _intent, primaryCount) => {
                          setNaturalSearchIds(fileIds);
                          setNaturalSearchPrimaryCount(typeof primaryCount === 'number' ? primaryCount : (fileIds?.length ?? 0));
                        }}
                      />
                    </div>
                  )}
                </div>

                {/* View toggle */}
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => loadFiles(true)}
                    className="p-2 rounded-full text-lavanda-archivo hover:bg-pizarra transition-colors"
                    title="Sincronizar archivos"
                  >
                    <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                  </button>
                  <button
                    onClick={toggleRandomizer}
                    className={`p-2 rounded-full transition-colors ${isRandomized
                      ? 'text-lavanda bg-lavanda bg-opacity-10 hover:bg-opacity-20'
                      : 'text-lavanda-archivo hover:bg-pizarra'
                      }`}
                    title={isRandomized ? "Desactivar randomizador - Volver al orden original" : "Activar randomizador - Mostrar archivos en orden aleatorio"}
                  >
                    <Shuffle className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setShowPresentationMode(true)}
                    className="p-2 rounded-full text-lavanda-archivo hover:bg-pizarra transition-colors"
                    title="Modo Presentación - Reproducir videos en pantalla completa"
                    disabled={getAllDisplayFiles().filter(f => f.type === 'video').length === 0}
                  >
                    <Monitor className={`w-4 h-4 ${getAllDisplayFiles().filter(f => f.type === 'video').length === 0 ? 'text-slate-300' : ''}`} />
                  </button>
                  {/* MoreOptionsMenu vive en el header global, no aquí. */}
                </div>
              </div>

              {/* Quick Filters - solo en vista home */}
              {activeView === 'home' && (
                <div className="flex items-center gap-2 flex-wrap mb-3 md:mb-6">
                  <QuickFilters
                    selectedTypes={selectedTypes}
                    onTypeSelection={handleTypeSelection}
                    dateFrom={filterDateFrom}
                    dateTo={filterDateTo}
                    onDateRangeChange={handleDateRangeChange}
                    showFavoritesOnly={showFavoritesOnly}
                    onFavoritesToggle={handleFavoritesToggle}
                    groupingEnabled={groupingEnabled}
                    onGroupingChange={(enabled) => {
                      setGroupingEnabled(enabled);
                      if (enabled) {
                        setExpandedGroups(new Set());
                        setShowAllGroups(new Set());
                      }
                    }}
                    groupingDisabled={viewMode !== 'grid'}
                    onColorFilterChange={(fileIds, hex) => {
                      setColorFilterFileIds(fileIds);
                      setColorFilterHex(hex);
                    }}
                    colorFilterHex={colorFilterHex}
                  />
                  {hasActiveFilters && (
                    <button
                      onClick={clearAllFilters}
                      className="flex items-center gap-1 px-3 py-1.5 md:py-2 rounded-full text-sm font-medium bg-lavanda-archivo/15 text-lavanda-archivo hover:bg-estado-error/20 hover:text-estado-error transition-colors whitespace-nowrap"
                      title="Limpiar todos los filtros (Esc)"
                    >
                      <span className="text-base leading-none">&times;</span>
                      <span className="hidden sm:inline">Limpiar</span>
                    </button>
                  )}
                </div>
              )}

              {/* Organization Bubbles - solo en vista home */}
              {activeView === 'home' && (
                <div className="mb-3 md:mb-6">
                  <PersonBubbles
                    selectedPersonIds={selectedPersonIds}
                    onSelectionChange={setSelectedPersonIds}
                  />
                </div>
              )}

              {/* [MF-COLLECTIONS-CAROUSEL-START] */}
              {activeView === 'home' && (
                selectedCollectionId ? (
                  <div className="mb-8">
                    <div className="flex items-center gap-4 mb-4">
                      <button
                        onClick={() => setSelectedCollectionId(null)}
                        className="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors"
                        aria-label="Volver a Inicio"
                      >
                        <ChevronLeft className="w-5 h-5" />
                        <span>Volver a Inicio</span>
                      </button>
                      <div className="flex items-center gap-3">
                        <h2 className="text-xl font-semibold text-slate-900">
                          {collections.find(c => c.id === selectedCollectionId)?.name}
                        </h2>
                        {selectedCollectionId && (
                          <div className="flex items-center gap-2 text-sm">
                            {hasActiveFilters ? (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-lavanda/10 text-lavanda">
                                <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                                    d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                                </svg>
                                {collectionFilteredCount} de {collectionTotalCount} archivos
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-600">
                                {collectionTotalCount} {collectionTotalCount === 1 ? 'archivo' : 'archivos'}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <CollectionsCarousel
                    collections={collections}
                    onCollectionSelect={(id) => setSelectedCollectionId(id)}
                    onCreateCollection={() => setShowCreateCollection(true)}
                    onEditCollection={(id) => {
                      const col = collections.find(c => c.id === id);
                      if (col) { setEditingCollectionId(id); setEditingCollectionName(col.name); }
                    }}
                    onDeleteCollection={(id) => {
                      const e = { stopPropagation: () => { } } as React.MouseEvent;
                      handleDeleteCollection(id, e);
                    }}
                    onDownloadCollection={handleDownloadCollection}
                    onEditCover={handleEditCollectionCover}
                    onCollectionsReorder={handleCollectionsReorder}
                    downloadingCollectionId={downloadingCollectionId}
                    mediaFiles={mediaFiles}
                  />
                )
              )}
              {/* [MF-COLLECTIONS-CAROUSEL-END] */}

              {/* Connection error alert */}
              {connectionError && (
                <div className="mb-6 card-primary">
                  <div className="flex items-center">
                    <div className="flex-shrink-0">
                      <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="ml-3">
                      <p className="text-sm text-yellow-700">
                        <strong>Problema de conexión:</strong> {connectionError}
                      </p>
                    </div>
                    <div className="ml-auto">
                      <button
                        onClick={() => loadFiles(true)}
                        className="text-sm text-yellow-600 hover:text-yellow-700 underline"
                      >
                        Reintentar
                      </button>
                    </div>
                  </div>
                </div>
              )}


              {/* Selection Mode Indicator - Only show when no files selected */}
              {isSelectionMode && selectedFiles.size === 0 && (
                <div className="mb-6 card-primary">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      <span className="text-blue-700 flex items-center text-xs md:text-sm">
                        <span className="w-2 h-2 bg-bruma rounded-full mr-2 animate-pulse"></span>
                        <span className="font-medium">Modo selección activo</span><span className="hidden sm:inline"> - Haz click en archivos para seleccionar</span>
                      </span>
                      <button
                        onClick={selectAllFiles}
                        className="text-sm text-blue-600 hover:text-blue-700 underline"
                      >
                        Seleccionar todos ({allDisplayFiles.length})
                      </button>
                      <button
                        onClick={exitSelectionMode}
                        className="text-sm text-blue-600 hover:text-blue-700 underline"
                      >
                        Salir (ESC)
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Floating Action Buttons for Selection Mode */}
              {isSelectionMode && selectedFiles.size > 0 && (
                <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 md:gap-3 bg-tinta/95 backdrop-blur-sm shadow-2xl rounded-full px-3 py-2 md:px-6 md:py-3 border border-borde-sutil">
                  {/* Counter Badge */}
                  <div className="flex items-center gap-2 pr-3 border-r border-borde-sutil">
                    <div className="w-8 h-8 bg-bruma text-noche rounded-full flex items-center justify-center font-semibold text-sm">
                      {selectedFiles.size}
                    </div>
                  </div>

                  {/* Select Loaded Files Button */}
                  <button
                    onClick={selectLoadedFiles}
                    className="w-9 h-9 md:w-12 md:h-12 rounded-full bg-grafito hover:bg-lavanda-claro text-bruma hover:text-noche flex items-center justify-center transition-colors"
                    title={`Seleccionar archivos cargados (${getDisplayFiles().length})`}
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
                      <path d="M7 12l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>

                  {/* Select All Button */}
                  <button
                    onClick={selectAllFiles}
                    className="w-9 h-9 md:w-12 md:h-12 rounded-full bg-lavanda-claro hover:bg-melocoton text-noche flex items-center justify-center transition-colors"
                    title={`Seleccionar todos (${allDisplayFiles.length})`}
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
                      <path d="M7 12l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>

                  {/* Add to Collection Button */}
                  <button
                    onClick={() => setShowBulkAddToCollection(true)}
                    className="w-9 h-9 md:w-12 md:h-12 rounded-full bg-lavanda-claro hover:bg-melocoton text-lavanda-archivo flex items-center justify-center transition-colors"
                    title="Añadir a colección"
                  >
                    <FolderPlus className="w-5 h-5" />
                  </button>

                  {/* Download Button */}
                  <button
                    onClick={handleBulkDownload}
                    disabled={isDownloadingZip}
                    className={`w-9 h-9 md:w-12 md:h-12 rounded-full text-noche flex items-center justify-center transition-colors ${isDownloadingZip
                      ? 'bg-pizarra text-lavanda-archivo cursor-not-allowed'
                      : 'bg-lavanda hover:bg-opacity-90'
                      }`}
                    title="Descargar seleccionados"
                  >
                    {isDownloadingZip ? (
                      <div className="w-5 h-5 border-2 border-lavanda-archivo border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Download className="w-5 h-5" />
                    )}
                  </button>

                  {/* Divider */}
                  <div className="w-px h-8 bg-borde-sutil mx-1 hidden sm:block"></div>

                  {/* Exit Button */}
                  <button
                    onClick={exitSelectionMode}
                    className="w-9 h-9 md:w-12 md:h-12 rounded-full bg-estado-error hover:bg-estado-error/80 text-noche flex items-center justify-center transition-colors"
                    title="Salir (ESC)"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M6 18L18 6M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              )}


              {/* Content */}
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-8 h-8 text-blue-600 animate-spin" />
                  <span className="ml-3 text-slate-600">Cargando archivos del servidor...</span>
                </div>
              ) : allDisplayFiles.length > 0 ? (
                <>
                  <MediaGrid
                    files={displayFiles}
                    viewMode={viewMode}
                    onFileClick={handleFileClick}
                    onToggleFavorite={handleToggleFavorite}
                    onDownload={handleDownload}
                    onAddToCollection={handleAddToCollection}
                    onRemoveFromCollection={selectedCollectionId ? handleRemoveFromCollection : undefined}
                    onOpenPath={handleOpenPath}
                    downloadingFiles={downloadingFiles}
                    isSelectionMode={isSelectionMode}
                    selectedFiles={selectedFiles}
                    isAdmin={true}
                    updatingFavs={updatingFavs}
                    sessionItems={useGrouping ? sessionItems : undefined}
                    onExpandGroup={handleExpandGroup}
                    onCollapseGroup={handleCollapseGroup}
                    onShowMoreGroup={handleShowMoreGroup}
                    onSelectSessionFiles={handleSelectSessionFiles}
                    secondaryStartIndex={
                      naturalSearchIds !== null && naturalSearchPrimaryCount > 0 && naturalSearchPrimaryCount < displayFiles.length
                        ? naturalSearchPrimaryCount
                        : undefined
                    }
                  />

                  {/* Infinite Scroll Indicators */}
                  {!isLoading && isLoadingMore && loadedItemsCount < totalSlotsForRender && (
                    <div className="flex justify-center py-8">
                      <div className="flex items-center gap-3">
                        <RefreshCw className="w-5 h-5 animate-spin text-lavanda" />
                        <span className="text-lavanda-archivo">
                          Cargando más... ({loadedItemsCount} de {allDisplayFiles.length})
                        </span>
                      </div>
                    </div>
                  )}

                  {!isLoading && !isLoadingMore && loadedItemsCount >= totalSlotsForRender && allDisplayFiles.length > ITEMS_PER_LOAD && (
                    <div className="text-center py-6">
                      <p className="text-sm text-lavanda-archivo">
                        ✓ Todos los archivos cargados ({allDisplayFiles.length})
                      </p>
                    </div>
                  )}

                  {!isLoading && loadedItemsCount >= MAX_LOADED_ITEMS && allDisplayFiles.length > MAX_LOADED_ITEMS && (
                    <div className="text-center py-6 bg-lavanda-claro/10 rounded-lg mx-4">
                      <p className="text-sm text-lavanda-archivo">
                        ⚠️ Límite de visualización alcanzado ({MAX_LOADED_ITEMS} de {allDisplayFiles.length} archivos)
                      </p>
                      <p className="text-xs text-lavanda-archivo/70 mt-1">
                        Usa los filtros para refinar tu búsqueda
                      </p>
                    </div>
                  )}

                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                  {connectionError ? (
                    <>
                      <div className="w-16 h-16 bg-lavanda-claro rounded-full flex items-center justify-center mx-auto mb-4">
                        <List className="w-8 h-8 text-slate-400" />
                      </div>
                      <h3 className="text-lg font-medium text-slate-900 mb-2">Sin conexión al servidor</h3>
                      <p className="text-slate-600 mb-4">No se pueden cargar los archivos. Verifica que el backend esté ejecutándose.</p>
                      <button onClick={() => loadFiles(true)} disabled={isLoading} className="btn-primary disabled:opacity-50">
                        {isLoading ? 'Conectando...' : 'Reintentar conexión'}
                      </button>
                    </>
                  ) : filterDiagnostic && filterDiagnostic.length > 0 ? (
                    <div className="bg-lavanda-claro/20 border border-lavanda-claro rounded-3xl shadow-sm p-6 max-w-md mx-auto text-left">
                      <h3 className="text-base font-bold text-marfil mb-1">Sin resultados con esta combinación</h3>
                      <p className="text-sm text-lavanda-archivo mb-4">Prueba quitando uno de estos filtros:</p>
                      <div className="space-y-2">
                        {filterDiagnostic.map((sug, i) => (
                          <button
                            key={i}
                            onClick={() => { sug.onRemove(); resetInfiniteScroll(); }}
                            className="w-full flex items-center gap-2 px-3 py-2.5 bg-tinta border border-lavanda-claro rounded-full hover:bg-lavanda-claro/10 transition-all duration-200 group"
                          >
                            <span className="text-sm text-lavanda-archivo group-hover:text-marfil transition-colors">{sug.label}</span>
                            <span className="inline-flex items-center px-3 py-0.5 rounded-full text-sm bg-lavanda text-noche font-medium">{sug.chipText}</span>
                            <span className="text-xs text-lavanda-archivo ml-auto">~{sug.count.toLocaleString()} archivos</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="w-16 h-16 bg-lavanda-claro rounded-full flex items-center justify-center mx-auto mb-4">
                        <List className="w-8 h-8 text-slate-400" />
                      </div>
                      <h3 className="text-lg font-medium text-slate-900 mb-2">
                        {showFavoritesOnly ? 'No hay favoritos con estos filtros' : 'No se encontraron archivos'}
                      </h3>
                      <p className="text-slate-600">
                        {showFavoritesOnly ? 'Marca archivos como favoritos o cambia los filtros' : 'Intenta cambiar los filtros de búsqueda'}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          );
      }
    } catch (error) {
      console.error('Error rendering main content:', error);
      return (
        <div className="p-4 bg-lavanda-claro text-marfil rounded-3xl">
          <h2 className="font-bold">Error rendering content</h2>
          <p>View: {activeView}</p>
          <p>Error: {error?.toString()}</p>
        </div>
      );
    }
  };

  // Single-user: sin login gating.

  // Calculate display data for infinite scroll
  const allDisplayFiles = getAllDisplayFiles();
  const totalSlotsForRender = useGrouping
    ? computeTotalSlots(allDisplayFiles, expandedGroups, showAllGroups)
    : allDisplayFiles.length;

  // Smart Empty State diagnostic (only computed when results are empty)
  const filterDiagnostic = !isLoading && allDisplayFiles.length === 0 && mediaFiles.length > 0
    ? computeFilterDiagnostic()
    : null;

  // Get selected collection data
  const selectedCollection = selectedCollectionId ? collections.find(c => c.id === selectedCollectionId) : null;
  const allCollectionFiles = selectedCollection
    ? mediaFiles.filter(file => selectedCollection.mediaFiles.includes(normalizePath(file.fullPath!)))
    : [];

  // Check if any filters are active
  const hasActiveFilters = Boolean(
    currentSearchQuery ||
    currentSearchFilters ||
    filterDateFrom ||
    filterDateTo ||
    includedTags.length > 0 ||
    excludedTags.length > 0 ||
    selectedTypes.length > 0 ||
    selectedPersonIds.length > 0 ||
    naturalSearchIds !== null ||
    showFavoritesOnly ||
    colorFilterHex !== null
  );
  hasActiveFiltersRef.current = hasActiveFilters;

  // Calculate filtered vs total files in collection
  const collectionFilteredCount = selectedCollectionId ? allDisplayFiles.length : 0;
  const collectionTotalCount = allCollectionFiles.length;

  return (
    <div className="min-h-screen bg-noche">
      <Toaster
        position="bottom-center"
        containerStyle={{
          bottom: '6rem', // Same as bottom-24 (6rem) for the floating selection bar
        }}
        toastOptions={{
          duration: 4000,
          style: {
            background: '#252A42', // pizarra
            color: '#F5F1FF',      // marfil
            borderRadius: '24px',
            padding: '16px 20px',
            fontSize: '14px',
            fontFamily: 'Geist, system-ui, sans-serif',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4)',
            animation: 'slideIn 0.3s ease-out',
            transition: 'all 0.2s ease-out',
          },
          success: {
            style: {
              background: '#C8B6FF', // lavanda
              color: '#0F111A',      // noche
            },
            iconTheme: {
              primary: '#0F111A',
              secondary: '#C8B6FF',
            },
          },
          error: {
            style: {
              background: '#E58B9B', // estado-error
              color: '#0F111A',
            },
            iconTheme: {
              primary: '#0F111A',
              secondary: '#E58B9B',
            },
          },
          loading: {
            duration: Infinity, // Keep loading toast until replaced
            style: {
              background: '#8EA4FF', // bruma
              color: '#0F111A',
            },
            iconTheme: {
              primary: '#0F111A',
              secondary: '#8EA4FF',
            },
          },
        }}
      />

      {/* Header global: logo a la izquierda, MoreOptionsMenu a la derecha.
          Disponible desde cualquier vista — no quedarse atrapado en
          Estadísticas/Rutas/Etiquetas. Inicio = clic en el logo. */}
      <header className="sticky top-0 z-30 bg-tinta/80 backdrop-blur border-b border-borde-sutil">
        <div className="px-4 md:px-8 py-2.5 flex items-center justify-between gap-3">
          <button
            onClick={() => {
              setActiveView('home');
              setShowFavoritesOnly(false);
              setSelectedCollectionId(null);
            }}
            className="flex items-center gap-2.5 group"
            title="Ir al inicio"
          >
            <img src="/pensadero-logo.png" alt="Pensadero" className="h-8 w-8 rounded-lg" />
            <span className="font-sans font-semibold text-marfil tracking-tight group-hover:text-lavanda transition-colors">
              Pensadero
            </span>
          </button>
          {/* Nav global. Siempre visible aunque la vista activa no sea home. */}
          <MoreOptionsMenu
            activeView={activeView}
            onViewChange={(view) => {
              // Volver de cualquier vista al cambiar también limpia foco de favoritos/colección
              setShowFavoritesOnly(false);
              setSelectedCollectionId(null);
              setActiveView(view);
            }}
          />
        </div>
      </header>

      <main className="bg-noche">
        <div className="p-4 md:p-8">
          {renderMainContent()}
        </div>
      </main>

      {/* Quick Preview Overlay (Space key) */}
      {quickPreviewFile && (
        <QuickPreviewOverlay
          file={quickPreviewFile}
          onClose={() => setQuickPreviewFile(null)}
        />
      )}

      <MediaModal
        file={selectedFile}
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedFile(null);
        }}
        onToggleFavorite={handleToggleFavorite}
        onDownload={handleDownload}
        onAddToCollection={handleAddToCollection}
        allFiles={allDisplayFiles}
        onFileSelect={(newFile) => {
          setSelectedFile(newFile);
        }}
        onTagClick={handleTagClick}
        onPersonFilter={(personId) => {
          setSelectedPersonIds([personId]);
          setActiveView('home');
        }}
        onBackgroundRemoved={async (newFileId, newFileName) => {
          // Mostrar toast de éxito
          toast.success(`Imagen sin fondo creada: ${newFileName}`, {
            duration: 4000,
            icon: '✂️'
          });
          // Recargar archivos para incluir el nuevo archivo
          await loadFiles(false);
          // Opcionalmente: mostrar el nuevo archivo
          const newFile = mediaFiles.find(f => f.id === newFileId);
          if (newFile) {
            console.log('📸 Nuevo archivo disponible:', newFileName);
          }
        }}
      />

      {showFolderScanner && (
        <FolderScanner
          onClose={() => setShowFolderScanner(false)}
          onUpload={handleFolderUpload}
        />
      )}

      <CreateCollectionModal
        isOpen={showCreateCollection}
        onClose={() => setShowCreateCollection(false)}
        onCreate={handleCreateCollection}
        mediaFiles={mediaFiles}
      />

      <EditCollectionModal
        isOpen={editingCollectionId !== null}
        collectionId={editingCollectionId || ''}
        currentName={editingCollectionName}
        onClose={handleCancelEditCollection}
        onSave={handleSaveCollectionName}
        existingNames={collections.map(c => c.name)}
        smart={(() => {
          const c = collections.find(c => c.id === editingCollectionId);
          if (c && c.type === 'smart') {
            return { rules: (c.rules || []) as any, combinator: (c.rule_combinator || 'AND') as any };
          }
          return null;
        })()}
        onSaveSmart={async (id, newName, rules, combinator) => {
          try {
            await api.updateCollection(id, { name: newName, rules, rule_combinator: combinator });
            // Refrescar colecciones desde backend para obtener mediaFiles resueltos
            const r: any = await getCollectionsByUser();
            if (r.success && Array.isArray(r.data)) {
              setCollections(r.data.map((c: any) => ({
                ...c,
                createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
                updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
              })));
            }
            setEditingCollectionId(null);
            setEditingCollectionName('');
          } catch (e: any) {
            console.error('Error guardando Smart Folder:', e);
            alert('Error guardando: ' + (e.message || 'desconocido'));
          }
        }}
      />

      {showAddToCollection && (
        <AddToCollectionModal
          isOpen={showAddToCollection}
          onClose={() => setShowAddToCollection(false)}
          collections={collections}
          onAddToCollection={handleAddFileToCollection}
          onCreateNewCollection={handleCreateNewCollectionFromModal}
          fileId={selectedFileForCollection}
        />
      )}

      <PresentationMode
        videos={getAllDisplayFiles()}
        isOpen={showPresentationMode}
        onClose={() => setShowPresentationMode(false)}
      />

      {/* Barra de progreso para sincronización */}
      <ProgressBar
        isVisible={showProgress}
        percentage={progressData?.percentage || 0}
        status={progressData?.status || 'Preparando...'}
        stats={progressData?.stats}
        onClose={() => {
          setShowProgress(false);
          clearProgress();
        }}
      />

      {/* Cover Image Selector */}
      <CoverImageSelector
        selectedCover={editingCollectionCoverId ? {
          type: collections.find(c => c.id === editingCollectionCoverId)?.coverType || 'system',
          value: collections.find(c => c.id === editingCollectionCoverId)?.coverImage || ''
        } : undefined}
        onCoverSelect={handleCoverImageUpdate}
        systemImages={mediaFiles}
        collectionFiles={editingCollectionCoverId ? mediaFiles.filter(file =>
          collections.find(c => c.id === editingCollectionCoverId)?.mediaFiles.includes(file.id)
        ) : undefined}
        isOpen={showCoverSelector}
        onClose={() => {
          setShowCoverSelector(false);
          setEditingCollectionCoverId(null);
        }}
      />

      {/* Bulk Add to Collection Modal */}
      <AddToCollectionModal
        isOpen={showBulkAddToCollection}
        onClose={() => setShowBulkAddToCollection(false)}
        collections={collections}
        onAddToCollection={handleBulkAddToCollection}
        onCreateNewCollection={handleCreateNewCollectionFromModal}
        fileIds={Array.from(selectedFiles)}
      />

      {/* Floating Action Buttons Container */}
      <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2">

        {/* Selection Mode Button */}
        {/* <SelectionModeButton
            isSelectionMode={isSelectionMode}
            selectedCount={selectedFiles.size}
            onToggle={() => {
              setIsSelectionMode(!isSelectionMode);
              // Si desactivamos el modo, limpiamos la selección
              if (isSelectionMode) {
                setSelectedFiles(new Set());
              }
            }}
          /> */}

        {/* Scroll to Top Button */}
        {/* <ScrollToTopButton /> */}

        {/* User FAB eliminado: uso personal sin auth */}
      </div>

    </div>
  );
}

export default App;