import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { List, RefreshCw, Download, Monitor, Shuffle, ChevronLeft, FolderPlus, ArrowLeft, Lock, Loader2 } from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';
import { noteFor } from './utils/mediaNotes';
import Ecos from './components/Ecos';
import { calcularEcos, type Eco } from './utils/ecos';
import { MediaFile, SearchFilters, Collection } from './types';
import { addFilesToCollection, api, createCollection, deleteCollection, deleteFromCollection, getCollectionsByUser, getFavouritesByUser, alternarFavorito, updateCoverCollection, updateNameCollection } from './services/api';
import { useWebSocket } from './hooks/useWebSocket';
import { actualizarGrupo, useGrupos } from './hooks/useGrupos';
import { cumple, filtroDe, minimoDe, niveles, presenciaPorDia, type FiltroGrupo } from './utils/grupos';
import { useSessionGroups, computeTotalSlots } from './hooks/useSessionGroups';
import { config } from './config';

import SearchBar, { SearchBarHandle } from './components/SearchBar';
import TimelineWave, { monthIndexOf } from './components/TimelineWave';
import { MoreOptionsMenu } from './components/MoreOptionsMenu';
import { ScrollToTopButton } from './components/ScrollToTopButton';
import QuickFilters from './components/QuickFilters';
import MediaGrid from './components/MediaGrid';
import MediaModal from './components/MediaModal';
import SessionNoteModal from './components/SessionNoteModal';
import { CreateCollectionModal } from './components/CreateCollectionModal';
import { AddToCollectionModal } from './components/AddToCollectionModal';
import Statistics from './components/Statistics';
import PresentationMode from './components/PresentationMode';
import Loader from './components/Loader';
import PersonBubbles from './components/PersonBubbles';
import PathManager from './components/PathManager';
import TagManager from './components/TagManager';
import PersonsManager from './components/PersonsManager';
import SynonymsManager from './components/SynonymsManager';
import CollectionsView from './components/CollectionsView';
import SpacesManager from './components/SpacesManager';
import PersonLife from './components/PersonLife';
import DuplicatesView from './components/DuplicatesView';
import CopiasExactas from './components/CopiasExactas';
import AvisoCopias from './components/AvisoCopias';
import AvisoProxies from './components/AvisoProxies';
import Carta from './components/Carta';
import OcultosView from './components/OcultosView';
import PapeleraView from './components/PapeleraView';
import Portada, { type OpcionesEntrar } from './components/Portada';

import { CoverImageSelector } from './components/CoverImageSelector';
import { EditCollectionModal } from './components/EditCollectionModal';
import { QuickPreviewOverlay } from './components/QuickPreviewOverlay';
import { ConnectionBanner } from './components/ConnectionBanner';
import { getFileSortDate } from './utils/filenameParser';
import { normalizePath } from './utils/formatData';
import { aTextoDiaLocal, finDelDia } from './utils/dateUtils';
import { etiquetasNormalizadas, frecuenciasCatalogo, llevaEtiquetaNormalizada, sugerirAcotar } from './utils/acotar';
import { normalizeText } from './utils/smartTags';
import type { Quitar, Valor } from './utils/pista';
import { leerFrame, type ContextoLote, type Muestra, type VistaProgreso } from './utils/progresoProceso';

// ── Routing por URL (Eje B) ────────────────────────────────────────────────
// Mapa vista interna -> ruta. El inverso (ruta -> vista) lo hace viewFromPath.
// Modulo (no dentro de App) para que el shim setActiveView sea estable.
const VIEW_TO_PATH: Record<string, string> = {
  home: '/', paths: '/rutas', persons: '/personas', spaces: '/espacios',
  collections: '/colecciones', statistics: '/estadisticas',
  tags: '/etiquetas', synonyms: '/sinonimos',
  duplicates: '/gemelas',
  copias: '/gemelas/copias',
  ocultos: '/ocultos',
  papelera: '/papelera',
  admin: '/admin',
};

// Deriva el nombre de vista interno desde el pathname. El switch de
// renderMainContent NO cambia: sigue leyendo `activeView`. Las rutas con
// parametro (/persona/:id, /colecciones/:id, /favoritos, /archivo/:id) mapean
// a 'home' porque son la galeria filtrada o un modal sobre ella.
function viewFromPath(pathname: string): string {
  if (pathname === '/') return 'home';
  if (pathname.startsWith('/rutas')) return 'paths';
  if (pathname.startsWith('/personas')) return 'persons';
  if (pathname.startsWith('/persona/') && pathname.endsWith('/vida')) return 'personLife';
  if (pathname.startsWith('/persona/')) return 'home';       // home filtrado por persona
  if (pathname.startsWith('/espacios')) return 'spaces';
  if (pathname.startsWith('/gemelas/copias')) return 'copias';
  if (pathname.startsWith('/gemelas')) return 'duplicates';
  if (pathname.startsWith('/ocultos')) return 'ocultos';
  if (pathname.startsWith('/papelera')) return 'papelera';
  if (pathname === '/colecciones') return 'collections';
  if (pathname.startsWith('/colecciones/')) return 'home';   // home con coleccion abierta
  if (pathname.startsWith('/estadisticas')) return 'statistics';
  if (pathname.startsWith('/etiquetas')) return 'tags';
  if (pathname.startsWith('/sinonimos')) return 'synonyms';
  if (pathname.startsWith('/favoritos')) return 'home';      // home filtrado por favoritos
  if (pathname.startsWith('/archivo/')) return 'home';       // modal sobre home (refresh directo)
  if (pathname.startsWith('/admin')) return 'admin';
  return '__notfound__';
}

// Normaliza para comparar: minusculas y sin acentos. Sin esto "Fenix" no
// encuentra "260906_La Fènix" ni "cumpleanos" a "Cumpleaños". El backend ya
// normalizaba asi; el filtro local no, y las dos busquedas no daban lo mismo.
/**
 * Claves de pertenencia de una coleccion. Una coleccion manual guarda RUTAS
 * normalizadas; una Smart Folder recibe del servidor los IDS ya resueltos.
 * Aceptar solo una de las dos hacia que las Smart Folders con material se
 * abrieran vacias.
 */
const clavesDeColeccion = (col: { mediaFiles?: string[] }) => new Set(col.mediaFiles || []);
const estaEnColeccion = (claves: Set<string>, f: MediaFile) =>
  claves.has(f.id) || (!!f.fullPath && claves.has(normalizePath(f.fullPath)));

const normalizaTexto = (s: unknown) => String(s ?? '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '');

// \u2500\u2500 Busqueda por imagen o video arrastrado \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Por tipo y, si el navegador no lo sabe (.mts, .m2ts de camara), por extension.
const EXT_VIDEO_ARRASTRADO = /\.(mp4|mov|m4v|mkv|avi|webm|mts|m2ts|ts|mpg|mpeg|wmv|3gp|mxf|dv|vob|flv|ogv)$/i;
const EXT_IMAGEN_ARRASTRADA = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i;
const esVideoArrastrado = (f: File) => f.type.startsWith('video/') || EXT_VIDEO_ARRASTRADO.test(f.name);
const esImagenArrastrada = (f: File) => f.type.startsWith('image/') || EXT_IMAGEN_ARRASTRADA.test(f.name);

const leerComoDataURL = (file: File) => new Promise<string | null>((resolve) => {
  const reader = new FileReader();
  reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
  reader.onerror = () => resolve(null);
  reader.readAsDataURL(file);
});

/**
 * Un fotograma peque\u00f1o del video arrastrado, para ense\u00f1ar con que se busca.
 * Lo saca el navegador; si no sabe abrir ese video (HEVC, ProRes, .mts), no
 * hay vista previa y la busqueda sigue igual (el servidor usa ffmpeg).
 */
const fotogramaDeVideo = (file: File) => new Promise<string | null>((resolve) => {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'metadata';
  let hecho = false;
  const fin = (r: string | null) => {
    if (hecho) return;
    hecho = true;
    clearTimeout(tope);
    v.removeAttribute('src');
    URL.revokeObjectURL(url);
    resolve(r);
  };
  const tope = setTimeout(() => fin(null), 5000);
  v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 0) / 2); };
  v.onseeked = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = Math.round(160 * ((v.videoHeight / v.videoWidth) || 0.5625));
      const ctx = c.getContext('2d');
      if (!ctx) return fin(null);
      ctx.drawImage(v, 0, 0, c.width, c.height);
      fin(c.toDataURL('image/jpeg', 0.7));
    } catch {
      fin(null);
    }
  };
  v.onerror = () => fin(null);
  v.src = url;
});

function App() {
  // Uso personal single-user: sin login, sin user.id, sin roles.

  // ── Routing por URL (Eje B) ──────────────────────────────────────────────
  // La vista activa se DERIVA de la URL; `setActiveView` es un shim que navega.
  // Asi todos los call-sites historicos (setActiveView('home'), etc.) siguen
  // funcionando sin tocarlos, pero la fuente de verdad es location/navigate.
  const navigate = useNavigate();
  const location = useLocation();

  // El modal /archivo/:id se abre SOBRE una vista de fondo guardada en
  // location.state.backgroundLocation. La galeria de fondo NO se desmonta:
  // derivamos vista/filtros de la location de fondo, no de /archivo/:id. Sin
  // fondo (refresh directo) el modal cae sobre home.
  const backgroundLocation = (location.state as { backgroundLocation?: typeof location } | null)?.backgroundLocation;
  const displayLocation = backgroundLocation || location;

  const activeView = viewFromPath(displayLocation.pathname);
  // Shim estable: conserva la firma setActiveView(view) pero navega.
  const setActiveView = React.useCallback((view: string) => {
    navigate(VIEW_TO_PATH[view] ?? '/');
  }, [navigate]);

  // Ref a la location actual (raw): la usa openFile para anclar el modal sobre
  // la vista desde la que se abrio sin recrear el handler en cada navegacion.
  const locationRef = useRef(location);
  useEffect(() => { locationRef.current = location; }, [location]);

  // Abre el modal de un archivo navegando a /archivo/:id. backgroundLocation =
  // la vista actual → la galeria queda montada debajo y al cerrar se vuelve a
  // ella (scroll y paginas de scroll infinito intactos).
  const openFile = React.useCallback((file: MediaFile) => {
    navigate(`/archivo/${encodeURIComponent(file.id)}`, { state: { backgroundLocation: locationRef.current } });
  }, [navigate]);
  // Lo mismo solo con el id: una copia exacta escondida no esta en mediaFiles
  // y el modal la pide al servidor.
  const abrirPorId = React.useCallback((id: string) => {
    navigate(`/archivo/${encodeURIComponent(id)}`, { state: { backgroundLocation: locationRef.current } });
  }, [navigate]);
  const [viewMode] = useState<'grid' | 'list'>('grid');
  const [selectedFile, setSelectedFile] = useState<MediaFile | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Modal por deep-link (/archivo/:id) cuando el archivo aun no esta en mediaFiles.
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MediaFile[]>([]);
  const [showCreateCollection, setShowCreateCollection] = useState(false);
  const [showAddToCollection, setShowAddToCollection] = useState(false);
  const [selectedFileForCollection, setSelectedFileForCollection] = useState<string>('');
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());
  // IDs de archivos con un escaneo visual de un solo archivo en curso (boton de la tarjeta)
  const [scanningFiles, setScanningFiles] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const [downloadingCollectionId, setDownloadingCollectionId] = useState<string | null>(null);
  // Muestra la animacion 'listo' brevemente al terminar una descarga.
  const [downloadDone, setDownloadDone] = useState(false);
  const downloadDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tomas gemelas apartadas: fuera de la galeria, intactas en disco. Se cargan
  // una vez al arrancar; la vista de gemelas es quien las cambia.
  const [descartadas, setDescartadas] = useState<Set<string>>(new Set());
  useEffect(() => {
    api.getDescartes()
      .then(r => { if (r.success && Array.isArray(r.data)) setDescartadas(new Set(r.data)); })
      .catch(() => { /* sin backend nuevo: la galeria no filtra nada */ });
  }, []);

  const cambiarDescartes = React.useCallback(async (fileIds: string[], descartar: boolean) => {
    const r = await api.setDescartes(fileIds, descartar);
    if (r.success && Array.isArray(r.data)) setDescartadas(new Set(r.data));
  }, []);

  // Presentation mode state
  const [showPresentationMode, setShowPresentationMode] = useState(false);
  // Archivos que reproduce el modo presentacion. null = todo lo que se ve
  // ahora (boton de la barra); con valor, los de una sesion concreta.
  const [presentationFiles, setPresentationFiles] = useState<MediaFile[] | null>(null);

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
  // Grupos de personas activos (@familia). Como decide cada grupo que archivos
  // son suyos (cuantos tienen que salir, en la toma o en el dia) vive con el
  // grupo, no aqui: ver utils/grupos.ts.
  const [gruposActivos, setGruposActivos] = useState<string[]>([]);
  const grupos = useGrupos();
  const presenciaDia = React.useMemo(() => presenciaPorDia(mediaFiles), [mediaFiles]);
  const filtrosGrupo = React.useMemo<FiltroGrupo[]>(
    () => gruposActivos
      .map(id => grupos.find(g => g.id === id))
      .filter((g): g is NonNullable<typeof g> => !!g)
      .map(filtroDe),
    [gruposActivos, grupos],
  );
  // Filtro de color de la rueda HSL. Mantenemos los fileIds que matchearon
  // contra el endpoint /api/search/by-color y el hex objetivo para mostrarlo en UI.
  const [colorFilterFileIds, setColorFilterFileIds] = useState<Set<string> | null>(null);
  // Reposo activo: eco abierto (filtra la galeria a sus archivos) y ocultado
  // del dia. Se guarda la FECHA, no un booleano: manana vuelve solo.
  const [ecoActivo, setEcoActivo] = useState<Eco | null>(null);
  const [ecosOcultosEl, setEcosOcultosEl] = useState<string>(() => {
    try { return localStorage.getItem('pensadero.ecosOcultosEl') || ''; } catch { return ''; }
  });
  const [colorFilterHex, setColorFilterHex] = useState<string | null>(null);
  // Busqueda por imagen similar: array ordenado por similitud (la mas parecida
  // primero). Se trata como un orden, no como un Set, para que la galeria
  // muestre los resultados ranqueados (mismo patron que naturalSearchIds).
  // Se dispara arrastrando una imagen sobre la vista home (drag & drop).
  const [imageSearchFileIds, setImageSearchFileIds] = useState<string[] | null>(null);
  const [imageSearchPreview, setImageSearchPreview] = useState<string | null>(null);
  // Con que se busco (para el aviso de resultados): imagen o video y su nombre.
  const [imageSearchConsulta, setImageSearchConsulta] = useState<{ nombre: string; esVideo: boolean } | null>(null);
  // Busqueda en marcha: se ve mientras el servidor mira la imagen o el video.
  // Sin esto, tras soltar el archivo no pasaba nada visible durante segundos.
  const [buscandoParecidas, setBuscandoParecidas] = useState<{ nombre: string; esVideo: boolean; preview: string | null; lenta: boolean } | null>(null);
  const busquedaImagenRef = useRef<{ n: number; ctrl: AbortController | null }>({ n: 0, ctrl: null });
  // Estado del drag & drop: cuenta de entradas para gestionar enter/leave en
  // elementos anidados sin oscilar el overlay.
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const dragCounterRef = useRef(0);

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

  // Notas humanas: nota por sesion colapsada (keyed por session key) y nota
  // por archivo (keyed por file.id). Persisten en notes_persistent.json.
  const [sessionNotes, setSessionNotes] = useState<Record<string, string>>({});
  const [fileNotes, setFileNotes] = useState<Record<string, string>>({});
  // Sesion cuya nota se esta editando (abre SessionNoteModal).
  const [editingSessionNote, setEditingSessionNote] = useState<{ key: string; label: { line1: string; line2: string } } | null>(null);

  // Guarda (optimista) la nota de una sesion. Texto vacio = borrar.
  const handleSaveSessionNote = React.useCallback(async (key: string, note: string) => {
    const text = note.trim();
    setSessionNotes((prev) => {
      const next = { ...prev };
      if (text) next[key] = text; else delete next[key];
      return next;
    });
    try {
      await api.saveNote('session', key, text);
    } catch (err) {
      console.warn('No se pudo guardar la nota de sesion:', err);
    }
  }, []);

  // Estable (deps []): abre el editor de nota de sesion. Inline-arrow antes en
  // el render rompia el memo de todas las SessionCard.
  const handleEditSessionNote = React.useCallback((key: string, label: { line1: string; line2: string }) => {
    setEditingSessionNote({ key, label });
  }, []);


  // Play de una sesion colapsada: modo presentacion con solo esos archivos.
  // Estable (useCallback) porque SessionCard esta memoizada y compara callbacks
  // por referencia.
  const handlePlaySession = React.useCallback((files: MediaFile[]) => {
    setPresentationFiles(files);
    setShowPresentationMode(true);
  }, []);

  const handleClosePresentation = React.useCallback(() => {
    setShowPresentationMode(false);
    setPresentationFiles(null);
  }, []);

  // Guarda (optimista) la nota de un archivo. Texto vacio = borrar.
  // Se guarda bajo la identidad PORTABLE (mediaKey) para que la nota sobreviva
  // a un cambio de letra de unidad; `legacyKey` hace que el backend retire la
  // entrada vieja por id, y asi no queden dos notas del mismo archivo.
  const handleSaveFileNote = React.useCallback(async (fileId: string, note: string, mediaKey?: string) => {
    const text = note.trim();
    const key = mediaKey || fileId;
    const legacy = mediaKey && mediaKey !== fileId ? fileId : undefined;
    setFileNotes((prev) => {
      const next = { ...prev };
      if (text) next[key] = text; else delete next[key];
      if (legacy) delete next[legacy];
      return next;
    });
    try {
      await api.saveNote('file', key, text, legacy);
    } catch (err) {
      console.warn('No se pudo guardar la nota del archivo:', err);
    }
  }, []);

  // Store current search filters to reapply when persons change
  const [currentSearchQuery, setCurrentSearchQuery] = useState<string>('');
  // Terminos de busqueda de texto libre (chips grises de la barra). Se combinan
  // en AND entre si y con tags/personas/etc. Espejo de los chips que vive en
  // SearchBar; llega via filters.textTerms en onSearch.
  const [currentSearchTerms, setCurrentSearchTerms] = useState<string[]>([]);
  const [currentSearchFilters, setCurrentSearchFilters] = useState<SearchFilters | null>(null);

  // Flag to prevent unnecessary page resets during favorite updates
  const isUpdatingFavoriteRef = useRef(false);

  // WebSocket para progreso de sincronización
  const { isConnected, progressData, clearProgress } = useWebSocket(config.wsUrl);

  /**
   * Overlay silenciado por el usuario para ESTE proceso. Sin esto, ocultarlo no
   * sirve de nada: el siguiente archivo emite otro frame de progreso y lo vuelve
   * a abrir medio segundo despues. Se levanta sola cuando el proceso termina,
   * asi que el proximo escaneo vuelve a avisar.
   */
  const progresoSilenciadoRef = useRef(false);

  /**
   * Portada: se ve al abrir la aplicacion y hace de pantalla de carga mientras
   * se indexa. Una vez por pestaña: recargar trabajando no la devuelve. Solo
   * en la raiz: un enlace directo a un archivo o a Rutas va a lo suyo. Desde el
   * menu se puede volver a abrir cuando se quiera.
   */
  const [portada, setPortada] = useState<null | { desdeMenu: boolean }>(() => {
    try {
      if (window.location.pathname !== '/') return null;
      return sessionStorage.getItem('pensadero.portadaVista') ? null : { desdeMenu: false };
    } catch {
      return { desdeMenu: false };
    }
  });

  /**
   * Parada del overlay de progreso.
   *
   * Intenta cancelar un escaneo de verdad (el de vision local, que si es
   * cancelable y guarda lo procesado). Si lo que corre es la indexacion del
   * arranque —que no es un job y no se puede interrumpir— al menos devuelve la
   * aplicacion: un overlay bloqueante del que no se puede salir es una carcel,
   * y hasta ahora la unica salida era recargar la pagina.
   */
  const detenerProgreso = React.useCallback(async () => {
    let cancelado = false;
    try {
      const r = await api.cancelScanAll();
      cancelado = !!(r && r.success);
    } catch { /* no habia escaneo masivo en curso */ }

    if (!cancelado) {
      try {
        const jobs = await api.listScanJobs();
        const enCurso = Array.isArray(jobs?.data)
          ? jobs.data.filter((j: { jobId?: string; status?: string }) => j && j.status === 'running')
          : [];
        for (const j of enCurso) {
          if (j.jobId) { await api.cancelScan(j.jobId); cancelado = true; }
        }
      } catch { /* sin jobs: no hay nada que cancelar */ }
    }

    progresoSilenciadoRef.current = true;
    setShowProgress(false);
    clearProgress();
    toast.success(cancelado
      ? 'Escaneo detenido. Lo procesado hasta ahora se ha guardado.'
      : 'No habia escaneo que detener. La indexacion del arranque sigue en segundo plano.');
  }, [clearProgress]);
  const [showProgress, setShowProgress] = useState(false);
  // Lo que pinta la pantalla de progreso: fase, cuantos de cuantos, tiempos y
  // archivo. Solo lo alimentan frames de indexado (sync_*) y escaneo (scan_*):
  // un frame ajeno (persons_refresh, reidentify_*) no puede tocarla. La ref
  // guarda la misma vista para leer la anterior sin esperar al render.
  const [vistaProgreso, setVistaProgreso] = useState<VistaProgreso | null>(null);
  const vistaProgresoRef = useRef<VistaProgreso | null>(null);
  const muestrasProgresoRef = useRef<Muestra[]>([]);
  // Escaneo de todas las rutas en lote: en que ruta va. Cada ruta es un job
  // con su propio scan_done; sin esto, cada uno cerraria la pantalla.
  const loteEscaneoRef = useRef<ContextoLote>({ activo: false, indice: 0, total: 0 });

  // Infinite scroll state
  const [loadedItemsCount, setLoadedItemsCount] = useState(96);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const INITIAL_ITEMS = 96;        // primer pintado con buffer (menos saltos al empezar)
  const ITEMS_PER_LOAD = 48;       // tamano de cada recarga incremental
  const MAX_LOADED_ITEMS = 20000;  // tope de seguridad (un solo usuario)

  // Connection state
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [userFavs, setUserFavs] = useState<any[]>([])
  const [updatingFavs, setUpdatingFavs] = useState<boolean>(false)

  // Espejos en refs de estado que leen los handlers pasados a las tarjetas
  // memoizadas. Permite envolver esos handlers en useCallback con deps=[] (refs
  // estables) en vez de deps que cambian a menudo (mediaFiles, userFavs...). Asi
  // el handler conserva identidad estable y el memo de MediaCard no se rompe en
  // cada toggle de favorito/scan; a la vez lee SIEMPRE el valor actual via .current.
  const userFavsRef = useRef(userFavs);
  useEffect(() => { userFavsRef.current = userFavs; }, [userFavs]);
  const mediaFilesRef = useRef(mediaFiles);
  useEffect(() => { mediaFilesRef.current = mediaFiles; }, [mediaFiles]);
  const selectedFileRef = useRef(selectedFile);
  useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);
  const scanningFilesRef = useRef(scanningFiles);
  useEffect(() => { scanningFilesRef.current = scanningFiles; }, [scanningFiles]);
  const isSelectionModeRef = useRef(isSelectionMode);
  useEffect(() => { isSelectionModeRef.current = isSelectionMode; }, [isSelectionMode]);

  // Ref a la barra de busqueda: clearAllFilters la usa para resetear el estado
  // interno (texto tecleado, pregunta natural) que no viaja por props.
  const searchBarRef = useRef<SearchBarHandle>(null);

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

  // Esc colapsa la sesion abierta. Capture phase + stopImmediatePropagation
  // para tener prioridad sobre el Esc que limpia filtros: primero colapsas,
  // un segundo Esc ya limpia filtros.
  const expandedGroupsRef = useRef(expandedGroups);
  expandedGroupsRef.current = expandedGroups;
  useEffect(() => {
    const handleEscCollapse = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || expandedGroupsRef.current.size === 0) return;
      if (isModalOpen || quickPreviewFile || isSelectionMode || showPresentationMode) return;
      const tag = (event.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      event.stopImmediatePropagation();
      setExpandedGroups(new Set());
      setShowAllGroups(new Set());
    };
    document.addEventListener('keydown', handleEscCollapse, true);
    return () => document.removeEventListener('keydown', handleEscCollapse, true);
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
      // favs locales: pasamos la lista recien cargada directamente a
      // loadFiles para evitar la race condition con setUserFavs (el estado
      // no se propaga al closure de loadFiles en la misma vuelta, lo que
      // dejaba isFavorite en false tras refrescar/reiniciar).
      let favs: any[] = [];
      try {
        const result = await getFavouritesByUser();
        if (result.success && result.data) {
          favs = result.data;
          setUserFavs(result.data);
        }
      } catch (err) {
        console.warn('No se pudieron cargar los favoritos iniciales:', err);
      }
      loadFiles(false, favs);
      loadCollections();

      // Cargar notas humanas (archivo + sesion). Best-effort: si falla, la app
      // funciona igual sin notas.
      api.getNotes().then((res) => {
        if (res.success && res.data) {
          setFileNotes(res.data.files || {});
          setSessionNotes(res.data.sessions || {});
        }
      }).catch(() => {});

      // Limpieza de claves antiguas de localStorage que ya no usamos.
      localStorage.removeItem('deletedCollections');
    };
    init();
  }, []);

  // ── Sincronizacion URL -> estado navegacional ─────────────────────────────
  // Estas rutas con parametro mapean a 'home' filtrado. Derivamos el filtro
  // desde la URL (una sola direccion: la URL manda). Clave en displayLocation
  // para que un modal /archivo/:id abierto encima NO altere los filtros de fondo.

  // /colecciones/:id -> coleccion abierta. Cualquier otra ruta la cierra (su
  // ciclo de vida esta atado 1:1 a la ruta).
  useEffect(() => {
    const p = displayLocation.pathname;
    const id = p.startsWith('/colecciones/') ? decodeURIComponent(p.slice('/colecciones/'.length)) : null;
    setSelectedCollectionId(prev => (prev === id ? prev : id));
  }, [displayLocation.pathname]);

  // /persona/:id -> home filtrado por esa persona (punto de entrada / deep-link).
  // No limpia al salir: el filtro de persona es "pegajoso" como ya lo era antes
  // (clearAllFilters / Esc lo limpian). Selecciones multiples via burbujas/@
  // siguen en estado local y no se reflejan en la URL (deuda conocida).
  useEffect(() => {
    const p = displayLocation.pathname;
    if (!p.startsWith('/persona/')) return;
    // /persona/:id/vida es otra vista: no toca el filtro de la galeria.
    if (p.endsWith('/vida')) return;
    const pid = decodeURIComponent(p.slice('/persona/'.length));
    if (!pid) return;
    setSelectedPersonIds(prev => (prev.length === 1 && prev[0] === pid ? prev : [pid]));
  }, [displayLocation.pathname]);

  // /favoritos -> home filtrado por favoritos (punto de entrada / deep-link).
  useEffect(() => {
    if (displayLocation.pathname.startsWith('/favoritos')) setShowFavoritesOnly(true);
  }, [displayLocation.pathname]);

  // Titulo del documento por vista.
  useEffect(() => {
    const titles: Record<string, string> = {
      home: 'Pensadero', paths: 'Rutas · Pensadero', persons: 'Personas · Pensadero',
      spaces: 'Espacios · Pensadero', collections: 'Colecciones · Pensadero',
      duplicates: 'Tomas gemelas · Pensadero', copias: 'Copias exactas · Pensadero', ocultos: 'Material oculto · Pensadero',
      papelera: 'Papelera · Pensadero',
      personLife: 'Línea de vida · Pensadero',
      statistics: 'Estadísticas · Pensadero',
      tags: 'Etiquetas · Pensadero', synonyms: 'Sinónimos · Pensadero',
      admin: 'Admin · Pensadero',
      __notfound__: 'No encontrado · Pensadero',
    };
    document.title = titles[activeView] ?? 'Pensadero';
  }, [activeView]);

  // ── Modal de archivo dirigido por la URL (/archivo/:id) ───────────────────
  // Id de archivo presente en la URL real (no la de fondo) — null si no hay modal.
  const fileIdInRoute = location.pathname.startsWith('/archivo/')
    ? decodeURIComponent(location.pathname.slice('/archivo/'.length))
    : null;

  // Resuelve el MediaFile: primero en mediaFiles ya cargado; si no esta (refresh
  // directo o archivo fuera del filtro actual) lo pide a la API con estado de
  // carga/error. Re-corre al cambiar mediaFiles para refrescar la card del modal
  // (p.ej. tras togglear favorito o re-escanear).
  useEffect(() => {
    if (!fileIdInRoute) {
      setIsModalOpen(false);
      setSelectedFile(null);
      setModalError(null);
      setModalLoading(false);
      return;
    }
    const found = mediaFilesRef.current.find(f => f.id === fileIdInRoute);
    if (found) {
      setSelectedFile(found);
      setIsModalOpen(true);
      setModalError(null);
      setModalLoading(false);
      return;
    }
    // Ya cargado por API en una pasada anterior (no esta en la grid filtrada).
    if (selectedFileRef.current?.id === fileIdInRoute) {
      setIsModalOpen(true);
      // Limpiar estados de error/carga como hacen las otras ramas: si quedo un
      // modalError pendiente (id invalido previo) taparia este modal valido.
      setModalError(null);
      setModalLoading(false);
      return;
    }
    let cancelled = false;
    setModalLoading(true);
    setModalError(null);
    api.getFile(fileIdInRoute)
      .then((res: any) => {
        if (cancelled) return;
        if (res.success && res.data) {
          const mapped: MediaFile = {
            ...res.data,
            createdAt: new Date(res.data.createdAt),
            modifiedAt: new Date(res.data.modifiedAt),
            extractedDate: res.data.extractedDate ? new Date(res.data.extractedDate) : undefined,
            isFavorite: userFavsRef.current.some(f => normalizePath(res.data.fullPath) === normalizePath(f.photo_url)),
          };
          setSelectedFile(mapped);
          setIsModalOpen(true);
        } else {
          setModalError('No se encontró el archivo solicitado.');
        }
      })
      .catch(() => { if (!cancelled) setModalError('No se pudo cargar el archivo.'); })
      .finally(() => { if (!cancelled) setModalLoading(false); });
    return () => { cancelled = true; };
  }, [fileIdInRoute, mediaFiles]);



  // Función centralizada de filtrado con deduplicación y lógica AND estricta
  const applyAllFilters = (
    baseFiles: MediaFile[] = mediaFiles,
    options: {
      searchQuery?: string;
      searchTerms?: string[];
      searchFilters?: SearchFilters;
      tags?: string[];
      excludeTags?: string[];
      types?: string[];
      personIds?: string[];
      favoritesOnly?: boolean;
      skipDedup?: boolean;
      colorFileIds?: Set<string> | null;
      imageSearchIds?: string[] | null;
      grupos?: FiltroGrupo[];
    } = {}
  ) => {
    let filtered = [...baseFiles];

    // Tomas gemelas apartadas: nunca en la galeria. Va lo primero porque no es
    // un filtro del usuario sino una decision ya tomada sobre el material.
    if (descartadas.size > 0) {
      filtered = filtered.filter(f => !descartadas.has(f.id));
    }
    const { searchQuery, searchTerms = currentSearchTerms, searchFilters, tags = [], excludeTags = [], types = selectedTypes, personIds = selectedPersonIds, favoritesOnly = showFavoritesOnly, skipDedup = false, colorFileIds = colorFilterFileIds, imageSearchIds = imageSearchFileIds, grupos: gruposFiltro = filtrosGrupo } = options;

    // Coincidencia de texto (substring, sin acentos) sobre nombre, nombre de
    // presentacion, CARPETA contenedora y tags. La carpeta es lo que hace
    // encontrable el material de camara: "Ondara" encuentra "P1248278.MP4".
    const matchesText = (file: MediaFile, q: string) =>
      normalizaTexto(file.name).includes(q) ||
      normalizaTexto(file.displayName).includes(q) ||
      normalizaTexto(file.folderName).includes(q) ||
      etiquetasNormalizadas(file).some(tag => tag.includes(q));

    // 1. Búsqueda de texto suelta (query única; p.ej. fallback de natural).
    if (searchQuery && searchQuery.trim()) {
      const query = normalizaTexto(searchQuery);
      filtered = filtered.filter(file => matchesText(file, query));
    }

    // 1b. Términos de texto libre (chips grises). AND: cada término debe
    // coincidir. Naturaleza distinta a `tags` (que es coincidencia exacta).
    if (Array.isArray(searchTerms) && searchTerms.length > 0) {
      for (const term of searchTerms) {
        const q = normalizaTexto(term).trim();
        if (!q) continue;
        filtered = filtered.filter(file => matchesText(file, q));
      }
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
        // "Hasta el 10" incluye el 10 entero, tambien lo que no es medianoche.
        const hasta = finDelDia(searchFilters.dateTo);
        filtered = filtered.filter(file => {
          const dateToCompare = file.extractedDate || file.createdAt;
          return dateToCompare <= hasta;
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
        return types.includes(file.type);
      });
    }

    // 4. Etiquetas incluidas (AND) y excluidas (NOT). Por trozo y sin tildes
    // (llevaEtiqueta): "alegria" y "alegría" son la misma, y el embudo
    // «Acotar» cuenta con este mismo filtro.
    if (tags && tags.length > 0) {
      const incluidas = tags.map(normalizeText);
      filtered = filtered.filter(file => incluidas.every(tag => llevaEtiquetaNormalizada(file, tag)));
    }
    if (excludeTags && excludeTags.length > 0) {
      const excluidas = excludeTags.map(normalizeText);
      filtered = filtered.filter(file => !excluidas.some(tag => llevaEtiquetaNormalizada(file, tag)));
    }

    // 5. Aplicar filtro de personas detectadas - LÓGICA AND
    // Un archivo matchea solo si contiene TODAS las personas seleccionadas en file.faces
    if (personIds && personIds.length > 0) {
      filtered = filtered.filter(file => {
        const faceIds = new Set(file.faces?.map(f => f.person_id) ?? []);
        return personIds.every(pid => faceIds.has(pid));
      });
    }

    // 5-bis. Grupos (@familia): cada grupo con su propia tolerancia. Varios
    // grupos a la vez se suman como todo lo demas (AND).
    if (gruposFiltro && gruposFiltro.length > 0) {
      filtered = filtered.filter(file => gruposFiltro.every(g => cumple(file, g, presenciaDia)));
    }

    // 5b. Filtro por color — fileIds devueltos por /api/search/by-color
    if (colorFileIds && colorFileIds.size > 0) {
      filtered = filtered.filter(file => colorFileIds.has(file.id));
    }

    // 5b-bis. Eco abierto: el archivo propuso algo y se ha pulsado. Es un
    // filtro mas, con la misma salida que los demas (limpiar filtros).
    if (ecoActivo && ecoActivo.fileIds.length > 0) {
      const delEco = new Set(ecoActivo.fileIds);
      filtered = filtered.filter(file => delEco.has(file.id));
    }

    // 5c. Busqueda por imagen (SigLIP-2) — array de fileIds ordenado por
    // similitud descendente. Mantenemos ese orden en la galeria (mismo
    // patron que naturalSearchIds): primero las mas parecidas.
    if (imageSearchIds && imageSearchIds.length > 0) {
      const order = new Map(imageSearchIds.map((id, idx) => [id, idx]));
      filtered = filtered
        .filter(file => order.has(file.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
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
  }, [mediaFiles, selectedPersonIds, filtrosGrupo, presenciaDia, selectedTypes, includedTags, excludedTags, currentSearchQuery, currentSearchFilters, showFavoritesOnly, naturalSearchIds, colorFilterFileIds, imageSearchFileIds, ecoActivo, descartadas]);

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

  // La copia de favoritos y colecciones que se guardaba en el navegador
  // (cacheService) ya no existe: el servidor es la unica fuente. Se borra lo
  // que dejo aqui para que no ocupe ni confunda.
  useEffect(() => {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('pensadero_cache_') || k === 'favoritesCache' || k === 'collectionsCache') localStorage.removeItem(k);
      }
    } catch { /* sin almacenamiento local: nada que borrar */ }
  }, []);

  // Señal para que PersonBubbles vuelva a pedir /api/persons cuando el
  // catalogo se recarga (sync_complete, persons_refresh...). Al abrir
  // Pensadero el backend ya escucha pero el agregado de personas todavia
  // esta vacio (se calcula al terminar el sync inicial); sin esto la barra
  // se quedaba en "sin personas" hasta refrescar la pagina a mano.
  const [personsRefreshKey, setPersonsRefreshKey] = useState(0);

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
        setPersonsRefreshKey(k => k + 1);
        console.log(`✅ ${files.length} archivos cargados después de sincronización`);
      }
    } catch (error) {
      console.error('❌ Error recargando archivos después de sync:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Manejar progreso de WebSocket. El timeout de auto-ocultado se guarda en una
  // ref y se limpia en el cleanup: sin esto, cada nuevo mensaje reprogramaba un
  // setTimeout suelto (recargas duplicadas) y podía hacer setState tras el
  // desmontaje. clearProgress es estable (useCallback) → el efecto solo
  // re-corre cuando cambia progressData.
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quietReloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Recarga silenciosa (sin barra) coalescida: para refrescos por carpeta tras
  // promote/etiquetado (catalog_refresh) o cambios de registry (persons_refresh).
  const scheduleQuietReload = () => {
    if (quietReloadRef.current) clearTimeout(quietReloadRef.current);
    quietReloadRef.current = setTimeout(() => {
      quietReloadRef.current = null;
      reloadFilesAfterSync();
    }, 800);
  };

  useEffect(() => {
    if (!progressData) return;
    const t = progressData.type as string;

    // Frames de refresco silencioso: actualizar home SIN tocar la barra global.
    // reidentify_done: un re-id (p.ej. el que dispara promote para propagar la
    // persona) cambio los catalogos → recargar para ver las nuevas apariciones.
    if (t === 'persons_refresh' || t === 'catalog_refresh' || t === 'reidentify_done') {
      scheduleQuietReload();
      return;
    }
    // Sincronizacion que lanza el vigilante de discos (se ha copiado o movido
    // algo): sin pantalla de progreso, que saltaria en cada copia; al terminar
    // la galeria se recarga en silencio.
    if (progressData.enSegundoPlano && t.startsWith('sync_')) {
      if (t === 'sync_complete') scheduleQuietReload();
      return;
    }

    // Watchdog: si tras mostrarse no llega ningun frame en 2 min, ocultar.
    // Cubre un cierre perdido por una reconexion WS. Es largo a proposito:
    // cargar los modelos o describir un video 4K puede pasar de 30 s sin frames.
    const armWatchdog = () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        setShowProgress(false);
        clearProgress();
      }, 120000);
    };
    const pintar = (v: VistaProgreso | null) => {
      vistaProgresoRef.current = v;
      setVistaProgreso(v);
    };
    // Cierre con la vista de "terminado" a la vista unos segundos.
    const cerrarEn = (ms: number, recargar: boolean) => {
      progresoSilenciadoRef.current = false;
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
      progressTimerRef.current = setTimeout(() => {
        progressTimerRef.current = null;
        setShowProgress(false);
        clearProgress();
        if (recargar) reloadFilesAfterSync();
      }, ms);
    };

    // Lote de escaneo: se apunta en que ruta va; no pinta por si solo.
    if (t === 'batch_scan_start') {
      loteEscaneoRef.current = { activo: true, indice: 0, total: progressData.total ?? 0 };
      return;
    }
    if (t === 'batch_scan_progress') {
      loteEscaneoRef.current = { ...loteEscaneoRef.current, activo: true, indice: progressData.index ?? 0 };
      return;
    }
    if (t === 'batch_scan_done') {
      const lote = loteEscaneoRef.current;
      loteEscaneoRef.current = { activo: false, indice: 0, total: 0 };
      const previa = vistaProgresoRef.current;
      if (previa) {
        pintar({
          ...previa,
          tipo: 'escaneo',
          terminado: true,
          fase: 'listo',
          micro: 'IA · VISIÓN LOCAL',
          cap: progressData.aborted ? 'Escaneo detenido' : 'Escaneo completado',
          sub: `${progressData.processed ?? 0} de ${progressData.total ?? lote.total} rutas`,
          cifras: [],
          duracionMs: progressData.elapsedMs,
        });
      }
      cerrarEn(4000, false);
      return;
    }

    const vista = leerFrame(vistaProgresoRef.current, progressData, muestrasProgresoRef.current, loteEscaneoRef.current);
    if (!vista) return;
    pintar(vista);

    if (vista.terminado) {
      // Si algo ha ido mal (sin guardar, sin caras, error) se deja leer mas rato.
      const ms = t === 'sync_error' || vista.aviso ? 9000 : 3500;
      cerrarEn(ms, t === 'sync_complete');
    } else {
      // Si el usuario lo aparto, no se lo devolvemos a la cara en cada archivo.
      if (!progresoSilenciadoRef.current) setShowProgress(true);
      armWatchdog();
    }
    // OJO: sin cleanup que cancele los timers en cada cambio de progressData.
    // El cleanup anterior cancelaba el timer de ocultar si llegaba CUALQUIER
    // frame dentro de la ventana de 3s → la barra se quedaba colgada.
  }, [progressData, clearProgress]);

  // Limpieza de timers SOLO al desmontar el componente.
  useEffect(() => () => {
    if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    if (quietReloadRef.current) clearTimeout(quietReloadRef.current);
    if (downloadDoneTimerRef.current) clearTimeout(downloadDoneTimerRef.current);
  }, []);

  const loadFiles = async (forceSync = false, favsOverride?: any[]) => {
    // favs efectivos: el override de la carga inicial gana al estado (que
    // aun no se ha propagado al closure en ese momento).
    const favs = favsOverride ?? userFavs;
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
          isFavorite: favs.some(f => normalizePath(file.fullPath) === normalizePath(f.photo_url))
        }));

        //  for (const f of userFavs){
        //   console.log(f.photo_url)
        //   const file = files.find(f => f.fullPath.includes("EDEM fachada.jpeg"))
        //   console.log(normalizePath(file.fullPath) === normalizePath(f.photo_url), normalizePath(file.fullPath), normalizePath(f.photo_url))
        //   console.log(file)
        //  }



        // Los favoritos los dice el servidor y nadie mas. Aqui se leia ademas
        // una copia antigua en el navegador que ya nunca se actualizaba: si el
        // servidor no tenia ninguno, volvia a poner los de esa copia.
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
      const mensaje = error instanceof Error ? error.message : '';
      if (mensaje.includes('fetch') || mensaje.includes('Failed')) {
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

  const handleCollectionsReorder = async (reorderedCollections: Collection[]) => {
    setCollections(reorderedCollections);
    // Antes el orden solo se guardaba en el navegador: al recargar, o desde
    // otro navegador, volvia el de antes.
    const r = await api.reorderCollections(reorderedCollections.map(c => c.id));
    if (!r.success) {
      toast.error('No se ha podido guardar el nuevo orden de las colecciones');
      loadCollections();
    }
  };

  // Event handlers
  const handleSearch = async (query: string, filters: SearchFilters) => {
    // Save current search query and filters
    setCurrentSearchQuery(query);
    setCurrentSearchFilters(filters);
    // Terminos de texto libre (chips grises). Si vienen en filters, espejarlos;
    // si no, conservar los actuales. Se usan ABAJO de forma sincrona (el estado
    // aun no se ha actualizado en esta misma llamada).
    const terms = filters.textTerms ?? currentSearchTerms;
    if (filters.textTerms !== undefined) setCurrentSearchTerms(filters.textTerms);


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
          // Dia LOCAL: toISOString daba el dia anterior (UTC) en España.
          dateFrom: filters.dateFrom ? aTextoDiaLocal(filters.dateFrom) : undefined,
          dateTo: filters.dateTo ? aTextoDiaLocal(filters.dateTo) : undefined,
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
            searchTerms: terms, // Chips de texto: filtrar localmente (no van al backend)
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

    // Búsqueda local usando la función centralizada. Las excluidas van
    // explicitas: sin ellas, añadir un texto dejaba de excluir hasta que se
    // tocaba otra etiqueta.
    const filtered = applyAllFilters(mediaFiles, {
      searchQuery: query,
      searchTerms: terms,
      searchFilters: filters,
      tags: filters.tags,
      excludeTags: excludedTags,
      types: selectedTypes,
    });

    setFilteredFiles(filtered);
  };


  // useCallback con deps=[]: lee mediaFiles/userFavs via ref y actualiza con
  // setters funcionales, asi el handler conserva identidad estable y el memo de
  // las tarjetas NO se rompe en cada toggle (solo se repinta la tarjeta tocada).
  const handleToggleFavorite = React.useCallback(async (fileId: string) => {
    setUpdatingFavs(true);
    const file = mediaFilesRef.current.find(f => f.id === fileId);
    if (!file) { setUpdatingFavs(false); return; }

    // Set flag to prevent unnecessary page resets
    isUpdatingFavoriteRef.current = true;

    try {
      const newFavoriteStatus = !file.isFavorite;

      // map preserva la identidad de los archivos NO tocados → solo la tarjeta
      // afectada se re-renderiza (las demas pasan el fast-path del memo).
      setMediaFiles(prev => prev.map(f => f.id === fileId ? { ...f, isFavorite: newFavoriteStatus } : f));
      setFilteredFiles(prev => prev.map(f => f.id === fileId ? { ...f, isFavorite: newFavoriteStatus } : f));
      setSelectedFile(prev => prev && prev.id === fileId ? { ...prev, isFavorite: newFavoriteStatus } : prev);

      // Actualizar en backend (single-user)
      try {
        const favs = await alternarFavorito(file.fullPath!, '', userFavsRef.current)
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
  }, []);

  const handleDownload = React.useCallback(async (file: MediaFile) => {
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
  }, []);

  // Escaneo visual de un único archivo desde el botón de su tarjeta. Espera al
  // backend (sincrono) y luego re-lee solo ese archivo para refrescar su card
  // sin recargar toda la galería.
  const handleScanFile = React.useCallback(async (file: MediaFile) => {
    if (scanningFilesRef.current.has(file.id)) return;
    const targetPath = file.fullPath;
    if (!targetPath) {
      toast.error('No se puede determinar la ruta del archivo');
      return;
    }
    setScanningFiles(prev => new Set([...prev, file.id]));
    toast.loading(`Escaneando "${file.name}"...`, { id: `scan-${file.id}` });
    try {
      const res = await api.scanFile(targetPath);
      if (!res.success) throw new Error((res as any).error || 'Error escaneando');

      // Re-leer la metadata actualizada de ese archivo y mezclarla en el estado.
      const fresh: any = await api.getFile(file.id);
      if (fresh.success && fresh.data) {
        const mapped: MediaFile = {
          ...fresh.data,
          createdAt: new Date(fresh.data.createdAt),
          modifiedAt: new Date(fresh.data.modifiedAt),
          extractedDate: fresh.data.extractedDate ? new Date(fresh.data.extractedDate) : undefined,
          isFavorite: userFavsRef.current.some(f => normalizePath(fresh.data.fullPath) === normalizePath(f.photo_url)),
        };
        setMediaFiles(prev => prev.map(f => (f.id === file.id ? mapped : f)));
        // Si el modal está abierto sobre este archivo, refrescarlo también.
        setSelectedFile(prev => (prev && prev.id === file.id ? mapped : prev));
      }
      toast.success(`"${file.name}" escaneado`, { id: `scan-${file.id}` });
    } catch (err: any) {
      toast.error(err.message || 'Error escaneando el archivo', { id: `scan-${file.id}` });
    } finally {
      setScanningFiles(prev => {
        const updated = new Set(prev);
        updated.delete(file.id);
        return updated;
      });
    }
  }, []);

  const handleOpenPath = React.useCallback(async (fileId: string) => {
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
  }, []);

  // Logout eliminado: uso personal sin auth.

  // Selection mode functions
  const handleFileClick = React.useCallback((file: MediaFile, event?: React.MouseEvent) => {
    // Si es Ctrl+Click, entrar en modo selección múltiple
    if (event?.ctrlKey || event?.metaKey) {
      event.preventDefault();

      // Activar modo selección si no está activo
      if (!isSelectionModeRef.current) {
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
    if (isSelectionModeRef.current) {
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

    // Click normal - abrir el modal navegando a /archivo/:id (sobre la vista
    // actual, sin desmontar la galeria de fondo).
    openFile(file);
  }, [openFile]);

  /**
   * Candado. Lo oculto sale de la galeria al pulsar (sin esperar al servidor,
   * que desde ese momento tampoco lo entrega) y durante unos segundos se puede
   * deshacer sin clave: un candado puesto por error no deberia costar la
   * contraseña. Si el servidor no lo guarda, vuelve a su sitio y se dice.
   */
  const ocultarArchivos = React.useCallback(async (ids: string[]) => {
    const unicos = Array.from(new Set(ids.filter(Boolean)));
    if (unicos.length === 0) return;
    const fuera = new Set(unicos);
    const antes = mediaFilesRef.current;
    setMediaFiles(prev => prev.filter(f => !fuera.has(f.id)));
    setSelectedFiles(prev => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      unicos.forEach(id => next.delete(id));
      return next;
    });
    try {
      const r = await api.ocultar(unicos);
      const n = r.data?.ocultados ?? unicos.length;
      const token = r.data?.deshacer || null;
      toast((t) => (
        <span className="flex items-center gap-3 text-sm">
          <Lock className="w-4 h-4 shrink-0" />
          <span>{n === 1 ? 'Oculto bajo candado' : `${n} archivos ocultos bajo candado`}</span>
          {token && (
            <button
              className="px-2 py-0.5 rounded-full bg-lavanda text-noche text-xs font-medium"
              onClick={async () => {
                toast.dismiss(t.id);
                try {
                  await api.deshacerOcultado(token);
                  toast.success('Vuelve a estar a la vista');
                } catch (e: any) {
                  toast.error(e?.message || 'Ya no se puede deshacer');
                }
              }}
            >
              Deshacer
            </button>
          )}
        </span>
      ), { duration: 8000 });
    } catch (e: any) {
      setMediaFiles(antes);
      toast.error(e?.message || 'No se pudo ocultar');
    }
  }, []);

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
            const clavesCol = clavesDeColeccion(collection);
            const collectionFiles = mediaFiles.filter(file => estaEnColeccion(clavesCol, file));

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
              const dateA = getFileSortDate(a);
              const dateB = getFileSortDate(b);
              if (dateA !== dateB) {
                return dateB - dateA; // Descending (newest first)
              }

              // Mismo dia: por hora de la camara (ver el orden de la galeria).
              if (a.fechaMinuto != null && b.fechaMinuto != null && a.fechaMinuto !== b.fechaMinuto) {
                return a.fechaMinuto - b.fechaMinuto;
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

      // El navegador la guarda en disco mientras llega (ver api.descargarZip).
      const { disponibles, total } = await api.descargarZip(Array.from(selectedFiles));
      toast.success(disponibles < total
        ? `Descargando ${disponibles} de ${total}: el resto no está disponible ahora`
        : `Descargando ${disponibles} archivos en un ZIP`);

      // Clear selections after successful download
      setSelectedFiles(new Set());
      flashDownloadDone();

    } catch (error) {
      console.error('Error descargando archivos:', error);
      toast.error(`No se ha podido descargar: ${error instanceof Error ? error.message : 'error desconocido'}`);
    } finally {
      setIsDownloadingZip(false);
    }
  };

  // Animacion 'listo' breve tras una descarga correcta.
  const flashDownloadDone = () => {
    setDownloadDone(true);
    if (downloadDoneTimerRef.current) clearTimeout(downloadDoneTimerRef.current);
    downloadDoneTimerRef.current = setTimeout(() => {
      downloadDoneTimerRef.current = null;
      setDownloadDone(false);
    }, 1600);
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

    // La colección se crea en el servidor y la provisional (temp_) se cambia
    // por la de verdad, con su id. Antes se quedaba la provisional hasta
    // recargar la página: añadirle archivos, renombrarla o borrarla fallaba
    // sin decir nada porque el servidor no conocía ese id.
    const response = await createCollection(newCollection);
    if (response.success && response.data && response.data.id) {
      const creada = {
        ...response.data,
        createdAt: new Date(response.data.createdAt || Date.now()),
        updatedAt: new Date(response.data.updatedAt || Date.now()),
      };
      setCollections(prev => prev.map(col => (col.id === clientTempId ? creada : col)));
    } else {
      setCollections(prev => prev.filter(col => col.id !== clientTempId));
      toast.error(`No se ha podido crear la colección${response.error ? `: ${response.error}` : ''}`);
    }
  };

  const handleAddToCollection = React.useCallback((fileId: string) => {
    setSelectedFileForCollection(fileId);
    setShowAddToCollection(true);
  }, []);

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

  const handleRemoveFromCollection = React.useCallback(async (file: string) => {
    if (!selectedCollectionId) return;

    try {

      const response = await deleteFromCollection(selectedCollectionId, file);
      if (response.success) {
        // `file` es la ruta del archivo, pero la coleccion lo tiene por su id
        // (asi llega del servidor) o por su ruta (lo añadido en grupo en esta
        // sesion): se quita de las dos formas. Antes solo por la ruta, y el
        // archivo seguia en pantalla hasta recargar.
        const archivo = mediaFiles.find(f => f.fullPath && normalizePath(f.fullPath) === file);
        const fuera = new Set([file, ...(archivo ? [archivo.id] : [])]);
        const updatedCollections = collections.map(collection => {
          if (collection.id === selectedCollectionId) {
            return {
              ...collection,
              mediaFiles: collection.mediaFiles.filter(fId => !fuera.has(fId)),
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
      } else {
        toast.error('No se ha podido quitar de la colección');
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
  }, [selectedCollectionId, collections, mediaFiles]);

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
      const clavesCol = clavesDeColeccion(collection);
      const collectionFiles = mediaFiles.filter(file => estaEnColeccion(clavesCol, file));

      console.log(`📄 Archivos filtrados: ${collectionFiles.length} de ${collection.mediaFiles.length}`);

      if (collectionFiles.length === 0) {
        console.warn('⚠️ No hay archivos válidos para descargar en la colección');
        toast.error('Esta colección no tiene archivos para descargar', { id: collectionId });
        setDownloadingCollectionId(null);
        return;
      }

      // El navegador la guarda en disco mientras llega (ver api.descargarZip);
      // el ZIP se llama como la colección.
      const fileIds = collectionFiles.map(f => f.id);
      const { disponibles, total } = await api.descargarZip(fileIds, collection.name);
      flashDownloadDone();
      toast.success(disponibles < total
        ? `Descargando "${collection.name}": ${disponibles} de ${total} (el resto no está disponible ahora)`
        : `Descargando "${collection.name}" (${disponibles} ${disponibles === 1 ? 'archivo' : 'archivos'})`, { id: collectionId });

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

    // Solo se quita de la pantalla si el servidor la ha borrado: antes se
    // quitaba siempre, y si el servidor fallaba volvia a aparecer al recargar.
    const response = await deleteCollection(collectionId);
    if (!response.success) {
      toast.error(`No se ha podido borrar la colección "${collection.name}"${response.error ? `: ${response.error}` : ''}`);
      return;
    }
    setCollections(prev => prev.filter(c => c.id !== collectionId));
    if (selectedCollectionId === collectionId) {
      setSelectedCollectionId(null);
    }
  };

  // Functions for editing collection names
  const handleCancelEditCollection = () => {
    setEditingCollectionId(null);
    setEditingCollectionName('');
  };

  const handleSaveCollectionName = async (collectionId: string, newName: string) => {
    const trimmedName = newName.trim();
    const previas = collections;
    setCollections(prev => prev.map(c => (c.id === collectionId ? { ...c, name: trimmedName, updatedAt: new Date() } : c)));
    setEditingCollectionId(null);
    setEditingCollectionName('');
    // Si el servidor no lo guarda se vuelve al nombre de antes y se dice.
    // Antes solo salia un aviso en la consola y la pantalla enseñaba un
    // nombre que al recargar desaparecia.
    const response = await updateNameCollection(collectionId, trimmedName);
    if (!response.success) {
      setCollections(previas);
      toast.error('No se ha podido renombrar la colección');
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
  /**
   * Busca lo parecido a una imagen o a un video usando SigLIP-2:
   *   - max=50 resultados, fotos y videos (un video puntua por el momento que
   *     mas se parece; si lo arrastrado es un video, se miran varios momentos)
   *   - minSimilarity=0.75: medido el 23/09/2026 sobre el archivo real, una
   *     foto ajena no pasa de 0,61-0,81 y una del archivo reenviada por
   *     WhatsApp da 0,97; por debajo de 0,75 es ruido
   *   - mantenemos el orden de similitud que viene del backend
   * Disparado por drag & drop sobre la vista home. Mientras busca se ve un
   * aviso con lo arrastrado; la ultima busqueda manda (otra la sustituye).
   */
  const executeImageSearch = async (file: File) => {
    const esVideo = esVideoArrastrado(file);
    const yo = ++busquedaImagenRef.current.n;
    busquedaImagenRef.current.ctrl?.abort();
    const ctrl = new AbortController();
    busquedaImagenRef.current.ctrl = ctrl;
    const vigente = () => busquedaImagenRef.current.n === yo;

    setBuscandoParecidas({ nombre: file.name, esVideo, preview: null, lenta: false });
    // La vista previa se hace mientras el servidor busca, no despues.
    const previa = (esVideo ? fotogramaDeVideo(file) : leerComoDataURL(file)).catch(() => null);
    previa.then(p => { if (vigente()) setBuscandoParecidas(b => (b ? { ...b, preview: p } : b)); });
    // Si tarda, decir por que: la primera vez se carga el modelo visual.
    const avisoLenta = setTimeout(() => {
      if (vigente()) setBuscandoParecidas(b => (b ? { ...b, lenta: true } : b));
    }, 5000);

    try {
      const r = await api.searchByImage(file, 50, 0.75, ctrl.signal);
      if (!vigente()) return;
      if (r.success && Array.isArray(r.data) && r.data.length > 0) {
        setImageSearchFileIds(r.data.map((x: any) => x.fileId));
        setImageSearchPreview(await previa);
        setImageSearchConsulta({ nombre: file.name, esVideo });
        setNaturalSearchIds(null);
        setActiveView('home');
      } else {
        toast(esVideo
          ? 'Nada de tu archivo se parece lo bastante a ese vídeo (umbral 75 %).'
          : 'Nada de tu archivo se parece lo bastante a esa imagen (umbral 75 %).', { icon: '🔍' });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || !vigente()) return;
      console.error('[image-search] error:', err);
      toast.error('No se ha podido buscar: ' + (err?.message || 'error desconocido'));
    } finally {
      clearTimeout(avisoLenta);
      if (vigente()) {
        setBuscandoParecidas(null);
        busquedaImagenRef.current.ctrl = null;
      }
    }
  };

  const cancelarBusquedaImagen = () => {
    busquedaImagenRef.current.n++;
    busquedaImagenRef.current.ctrl?.abort();
    busquedaImagenRef.current.ctrl = null;
    setBuscandoParecidas(null);
  };

  // Drag & drop global: solo activo cuando estamos en la vista home. Si el
  // usuario suelta una imagen en cualquier zona, dispara busqueda por
  // similitud. PreventDefault en window evita que el navegador abra la
  // imagen como si fuera una nueva pestaña.
  useEffect(() => {
    if (activeView !== 'home') {
      // En vistas que no son home, solo bloqueamos el comportamiento por
      // defecto del navegador (abrir el archivo) sin mostrar overlay ni
      // procesar la imagen.
      const blockDefault = (e: DragEvent) => { e.preventDefault(); };
      window.addEventListener('dragover', blockDefault);
      window.addEventListener('drop', blockDefault);
      return () => {
        window.removeEventListener('dragover', blockDefault);
        window.removeEventListener('drop', blockDefault);
      };
    }

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragCounterRef.current++;
      if (dragCounterRef.current === 1) setIsDraggingImage(true);
    };
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setIsDraggingImage(false);
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDraggingImage(false);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const consulta = Array.from(files).find(f => esImagenArrastrada(f) || esVideoArrastrado(f));
      if (consulta) {
        executeImageSearch(consulta);
      } else {
        toast.error('Para buscar parecidas, arrastra una imagen o un vídeo.');
      }
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [activeView]);

  const clearAllFilters = () => {
    setCurrentSearchQuery('');
    setCurrentSearchTerms([]);
    setCurrentSearchFilters(null);
    setFilterDateFrom(undefined);
    setFilterDateTo(undefined);
    setIncludedTags([]);
    setExcludedTags([]);
    setSelectedTypes([]);
    setSelectedPersonIds([]);
    setGruposActivos([]);
    setShowFavoritesOnly(false);
    setNaturalSearchIds(null);
    setColorFilterFileIds(null);
    setColorFilterHex(null);
    setEcoActivo(null);
    setImageSearchFileIds(null);
    setImageSearchPreview(null);
    setImageSearchConsulta(null);

    // Resetear estado interno de la barra (texto/pregunta natural sin enviar)
    searchBarRef.current?.reset();

    resetInfiniteScroll();
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

    // Si hay busqueda por imagen activa o natural, NO reordenar por fecha:
    // ambos vienen ya ordenados por relevancia (similitud o score del LLM).
    // Re-ordenarlos por fecha destruye el unico orden util.
    if ((imageSearchFileIds && imageSearchFileIds.length > 0) || naturalSearchIds !== null) {
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
        date: getFileSortDate(file),
        originalIndex, // For stable sorting fallback
        id: file.id
      }))
      .sort((a, b) => {
        // Primary: Sort by date (descending - newest first)
        if (a.date !== b.date) {
          return b.date - a.date;
        }

        // Dentro del mismo dia, la HORA de la camara: sin esto, dos camaras en
        // el mismo evento salian en dos bloques (todas las IMG_ y luego todas
        // las P...) en vez de intercaladas como ocurrio.
        const ha = a.file.fechaMinuto;
        const hb = b.file.fechaMinuto;
        if (ha != null && hb != null && ha !== hb) return ha - hb;

        // Secondary: Optimized name comparison for same dates
        const nameCompare = optimizedNameCompare(a.file.name, b.file.name);
        if (nameCompare !== 0) {
          return nameCompare;
        }

        // Tertiary: Deterministic tiebreaker by ID for stability
        return a.id.localeCompare(b.id);
      })
      .map(item => item.file); // Extract back to original file objects

  }, [filteredFiles, activeView, selectedCollectionId, optimizedNameCompare, imageSearchFileIds, naturalSearchIds]);

  // ── «Acotar» y la pista de la barra ──────────────────────────────────────
  // Todo el archivo esta en memoria y se filtra aqui, asi que el embudo se
  // calcula en el cliente: medido sobre 16.283 archivos, de 2 a 16 ms.
  const catalogoVisible = React.useMemo(
    () => (descartadas.size > 0 ? mediaFiles.filter(f => !descartadas.has(f.id)) : mediaFiles),
    [mediaFiles, descartadas],
  );
  const frecuenciasEtiquetas = React.useMemo(() => frecuenciasCatalogo(catalogoVisible), [catalogoVisible]);
  // Dentro de una coleccion no: lo que se ve alli no es filteredFiles.
  const sugerenciasAcotar = React.useMemo(() => (
    activeView === 'home' && !selectedCollectionId
      ? sugerirAcotar({
        subconjunto: filteredFiles,
        catalogo: catalogoVisible,
        frecuencias: frecuenciasEtiquetas,
        activas: [...includedTags, ...excludedTags],
        textos: currentSearchTerms,
        personas: selectedPersonIds,
      })
      : []
  ), [activeView, selectedCollectionId, filteredFiles, catalogoVisible, frecuenciasEtiquetas, includedTags, excludedTags, currentSearchTerms, selectedPersonIds]);

  /**
   * Lo que se veria cambiando un termino por otro (quitar un texto o una
   * etiqueta, poner una etiqueta, una persona o un texto), con el resto de
   * filtros tal cual. Lo usa la barra para la promocion silenciosa y para el
   * recuento de cada pista.
   */
  const probarCambio = React.useCallback((quitar: Quitar | null, poner: Valor | { clase: 'texto'; valor: string }) => {
    let terms = currentSearchTerms;
    let tags = includedTags;
    let personIds = selectedPersonIds;
    if (quitar?.clase === 'texto') terms = terms.filter(t => t !== quitar.valor);
    if (quitar?.clase === 'etiqueta') tags = tags.filter(t => t !== quitar.valor);
    if (poner.clase === 'texto') terms = [...terms, poner.valor];
    if (poner.clase === 'etiqueta') tags = [...tags, poner.valor];
    if (poner.clase === 'persona' && !personIds.includes(poner.id)) personIds = [...personIds, poner.id];
    let base = mediaFiles;
    if (selectedCollectionId) {
      const col = collections.find(c => c.id === selectedCollectionId);
      if (col) {
        const claves = clavesDeColeccion(col);
        base = mediaFiles.filter(f => estaEnColeccion(claves, f));
      }
    }
    return applyAllFilters(base, {
      searchQuery: currentSearchQuery,
      searchTerms: terms,
      searchFilters: currentSearchFilters || undefined,
      tags,
      excludeTags: excludedTags,
      types: selectedTypes,
      personIds,
      favoritesOnly: showFavoritesOnly,
    });
    // Estable mientras no cambie ningun filtro: la barra recalcula la pista con esto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaFiles, descartadas, collections, selectedCollectionId, currentSearchQuery, currentSearchTerms, currentSearchFilters, includedTags, excludedTags, selectedTypes, selectedPersonIds, filtrosGrupo, presenciaDia, showFavoritesOnly, naturalSearchIds, colorFilterFileIds, imageSearchFileIds, ecoActivo]);

  // ── Timeline-onda (pasiva) del home ─────────────────────────────────────
  // Solo cuando el grid esta en orden cronologico real: home, sin coleccion,
  // sin orden aleatorio y sin busqueda (imagen/natural traen su propio orden).
  // Ecos del dia. Solo en el inicio, sin busqueda ni filtros de conjunto: el
  // archivo habla cuando no le estas preguntando otra cosa.
  const hoyClave = new Date().toDateString();
  // Cada "otros" suma uno: otra seleccion del mismo dia. No se guarda; al
  // volver a entrar el archivo propone la de siempre.
  const [ecosGiro, setEcosGiro] = useState(0);
  const ecos = React.useMemo(() => {
    if (activeView !== 'home' || selectedCollectionId) return [];
    if (ecosOcultosEl === hoyClave) return [];
    if (naturalSearchIds !== null || imageSearchFileIds || colorFilterFileIds) return [];
    if (!mediaFiles || mediaFiles.length === 0) return [];
    try {
      return calcularEcos(mediaFiles, { giro: ecosGiro, notaDe: (f) => noteFor(fileNotes, f) });
    } catch (err) {
      // Un eco es un extra: si falla el calculo, la galeria sigue igual.
      console.warn('No se pudieron calcular los ecos:', err);
      return [];
    }
  }, [mediaFiles, activeView, selectedCollectionId, ecosOcultosEl, hoyClave, naturalSearchIds, imageSearchFileIds, colorFilterFileIds, ecosGiro, fileNotes]);

  const ocultarEcos = React.useCallback(() => {
    const hoy = new Date().toDateString();
    setEcosOcultosEl(hoy);
    setEcoActivo(null);
    try { localStorage.setItem('pensadero.ecosOcultosEl', hoy); } catch { /* modo privado: se oculta solo esta sesion */ }
  }, []);

  const showTimeline = activeView === 'home'
    && !selectedCollectionId
    && !isRandomized
    && (!imageSearchFileIds || imageSearchFileIds.length === 0)
    && naturalSearchIds === null;

  const timelineDateValues = React.useMemo(() => {
    if (!showTimeline) return [];
    return sortedFiles.map(f => getFileSortDate(f));
  }, [showTimeline, sortedFiles]);

  // ── Saltar a fecha al pinchar la onda ───────────────────────────────────
  // Busca el primer archivo de ese mes, carga lo necesario (scroll infinito) y
  // ancla el scroll a su tarjeta via data-file-id. Si la tarjeta no aparece
  // (agrupacion colapsada, fuera de DOM), cae a scroll proporcional con `frac`.
  const handleTimelineSeek = React.useCallback((monthIndex: number, frac: number) => {
    const idx = timelineDateValues.findIndex(v => monthIndexOf(v) === monthIndex);
    const proportionalFallback = () => {
      const max = document.body.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.max(0, frac * max), behavior: 'smooth' });
    };
    if (idx < 0) { proportionalFallback(); return; }

    const fileId = sortedFiles[idx]?.id;
    // Cargar hasta el objetivo (+ colchon) si el scroll infinito aun no llego.
    const needed = Math.min(idx + ITEMS_PER_LOAD, MAX_LOADED_ITEMS);
    if (needed > loadedItemsCount) setLoadedItemsCount(needed);

    // Con agrupacion el indice plano no mapea al DOM: scroll proporcional directo.
    if (groupingEnabled && viewMode === 'grid') { proportionalFallback(); return; }

    let tries = 0;
    const tryScroll = () => {
      const el = fileId ? document.querySelector(`[data-file-id="${CSS.escape(fileId)}"]`) : null;
      if (el) { (el as HTMLElement).scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
      if (tries++ < 40) { requestAnimationFrame(tryScroll); return; }
      proportionalFallback();
    };
    requestAnimationFrame(tryScroll);
  }, [timelineDateValues, sortedFiles, loadedItemsCount, groupingEnabled, viewMode]);

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

  /**
   * Cuantos archivos saldrian con cada minimo del grupo (y en los dos modos),
   * con todos los demas filtros puestos. Lo pinta el selector del chip.
   */
  const contarGrupo = (id: string) => {
    const grupo = grupos.find(g => g.id === id);
    if (!grupo) return null;
    const base = applyAllFilters(mediaFiles, {
      searchQuery: currentSearchQuery,
      searchFilters: currentSearchFilters || undefined,
      tags: includedTags,
      excludeTags: excludedTags,
      types: selectedTypes,
      personIds: selectedPersonIds,
      favoritesOnly: showFavoritesOnly,
      grupos: filtrosGrupo.filter(f => f.id !== id),
    });
    return { ...niveles(base, grupo.miembros, presenciaDia), minimo: minimoDe(grupo) };
  };

  // ── Smart Empty State: "remove-one" diagnostic ─────────────────────────
  const computeFilterDiagnostic = () => {
    // Determine unfiltered base
    let baseFiles = mediaFiles;
    if (selectedCollectionId) {
      const col = collections.find(c => c.id === selectedCollectionId);
      if (col) {
        const clavesCol = clavesDeColeccion(col);
        baseFiles = mediaFiles.filter(f => estaEnColeccion(clavesCol, f));
      }
    }
    if (baseFiles.length === 0) return null;

    // Current options (explicit — avoids closure defaults being used when we omit a key)
    const opts = {
      searchQuery: currentSearchQuery,
      searchTerms: currentSearchTerms,
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
    // Grupos: primero lo menos drastico, pedir menos gente; si ni con uno
    // sale nada, quitar el grupo.
    for (const f of filtrosGrupo) {
      const grupo = grupos.find(g => g.id === f.id);
      if (!grupo) continue;
      const otros = filtrosGrupo.filter(o => o.id !== f.id);
      const sinEl = applyAllFilters(baseFiles, { ...opts, grupos: otros });
      const porNivel = niveles(sinEl, f.miembros, presenciaDia)[f.modo];
      let menos = -1;
      for (let k = f.minimo - 1; k >= 1; k--) if (porNivel[k - 1] > 0) { menos = k; break; }
      if (menos > 0) {
        const n = menos;
        candidates.push({
          label: 'Pedir menos gente', chipText: `${grupo.nombre}: ${n} de ${f.miembros.length}`, count: porNivel[n - 1],
          onRemove: () => { actualizarGrupo(grupo.id, { minimo: n }).catch(() => {}); },
        });
      } else if (sinEl.length > 0) {
        candidates.push({ label: 'Quitar grupo', chipText: grupo.nombre, count: sinEl.length, onRemove: () => setGruposActivos(prev => prev.filter(o => o !== f.id)) });
      }
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
    setLoadedItemsCount(INITIAL_ITEMS);
    setIsLoadingMore(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ── Session grouping ──────────────────────────────────────────────────────
  // Con una busqueda por imagen activa se ven los resultados uno a uno, en
  // orden de parecido: agruparlos por sesion escondia en una tarjeta de evento
  // justo las fotos y los videos que se estaban buscando.
  const useGrouping = groupingEnabled && viewMode === 'grid'
    && !(imageSearchFileIds && imageSearchFileIds.length > 0);

  // useSessionGroups se llama aquí (nivel de componente) para cumplir reglas de hooks
  const sessionItems = useSessionGroups(
    getAllDisplayFiles(),
    useGrouping,
    expandedGroups,
    showAllGroups,
    loadedItemsCount
  );

  // Estables (deps []): setters funcionales. Necesarias para que el memo de
  // SessionCard (onExpand/onSelectAll) y las tarjetas se mantenga.
  const handleExpandGroup = React.useCallback((key: string) => {
    setExpandedGroups(prev => new Set([...prev, key]));
  }, []);

  const handleCollapseGroup = React.useCallback((key: string) => {
    setExpandedGroups(prev => { const next = new Set(prev); next.delete(key); return next; });
    setShowAllGroups(prev => { const next = new Set(prev); next.delete(key); return next; });
  }, []);

  // Colapsa todas las sesiones abiertas (Esc o click en el fondo de la grid).
  const handleCollapseAll = React.useCallback(() => {
    setExpandedGroups(new Set());
    setShowAllGroups(new Set());
  }, []);

  const handleShowMoreGroup = React.useCallback((key: string) => {
    setShowAllGroups(prev => new Set([...prev, key]));
  }, []);

  const handleSelectSessionFiles = React.useCallback((files: MediaFile[]) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      files.forEach(f => next.add(f.id));
      return next;
    });
  }, []);
  // ─────────────────────────────────────────────────────────────────────────

  // Add scroll listener for infinite scroll
  useEffect(() => {
    const handleScroll = () => {
      if (isLoadingMore || isLoading) return;

      const scrollPosition = window.innerHeight + window.scrollY;
      // Precarga por delante: disparamos la siguiente tanda cuando aun faltan
      // ~2 pantallas para el fondo, no pegados al borde. Asi el contenido ya
      // esta montado antes de que el usuario llegue (sin "golpes" de carga).
      const threshold = document.body.offsetHeight - window.innerHeight * 2;
      const allFiles = getAllDisplayFiles();
      const isGrouping = groupingEnabled && viewMode === 'grid';
      const totalSlots = isGrouping
        ? computeTotalSlots(allFiles, expandedGroups, showAllGroups)
        : allFiles.length;

      if (scrollPosition >= threshold &&
        loadedItemsCount < totalSlots &&
        loadedItemsCount < MAX_LOADED_ITEMS) {
        // Sin retardo artificial: en local la carga es inmediata y el margen
        // de 2 pantallas la hace invisible. El re-suscribir del efecto al
        // cambiar loadedItemsCount evita disparos duplicados.
        const newCount = Math.min(
          loadedItemsCount + ITEMS_PER_LOAD,
          totalSlots,
          MAX_LOADED_ITEMS
        );
        setLoadedItemsCount(newCount);
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
              <Statistics
                files={mediaFiles}
                onTagClick={(tag) => { handleTagClick(tag); setActiveView('home'); }}
                onTypeClick={(type) => { setSelectedTypes([type]); setActiveView('home'); }}
                onYearClick={(year) => { setCurrentSearchFilters(prev => ({ ...(prev || {}), year })); setActiveView('home'); }}
                onPersonClick={(personId) => navigate('/persona/' + encodeURIComponent(personId))}
                onMonthClick={(year, month) => {
                  const from = new Date(year, month, 1, 0, 0, 0, 0);
                  const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
                  handleDateRangeChange(from, to);
                  setActiveView('home');
                }}
                onColorClick={async (hex) => {
                  try {
                    const r = await api.searchByColor(hex);
                    if (r.success && Array.isArray(r.data)) {
                      setColorFilterFileIds(new Set(r.data.map((d: any) => d.fileId)));
                      setColorFilterHex(hex);
                      setActiveView('home');
                    }
                  } catch (e) {
                    console.error('[stats] búsqueda por color:', e);
                  }
                }}
              />
            </div>
          );

        case 'tags':
          // Single-user: TagManager siempre disponible
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

        case 'synonyms':
          return <SynonymsManager onBack={() => setActiveView('home')} />;

        case 'ocultos':
          return <OcultosView onBack={() => navigate('/')} />;

        case 'papelera':
          return <PapeleraView onBack={() => navigate('/')} />;

        case 'duplicates':
          return (
            <DuplicatesView
              files={mediaFiles}
              descartadas={descartadas}
              notas={fileNotes}
              tecladoActivo={!(isModalOpen || modalLoading || modalError || quickPreviewFile || showPresentationMode)}
              onBack={() => navigate('/')}
              onCambiarApartado={(a) => navigate(a === 'copias' ? '/gemelas/copias' : '/gemelas')}
              onSelectFile={openFile}
              onCambiarDescartes={cambiarDescartes}
            />
          );

        case 'copias':
          return (
            <CopiasExactas
              onBack={() => navigate('/')}
              onAbrir={abrirPorId}
              onCambiarApartado={(a) => navigate(a === 'copias' ? '/gemelas/copias' : '/gemelas')}
            />
          );

        // Linea de vida: /persona/:id/vida. El id sale de la URL para que el
        // enlace se pueda compartir y sobreviva a un refresco.
        case 'personLife': {
          const ruta = displayLocation.pathname;
          const pid = decodeURIComponent(
            ruta.slice('/persona/'.length, ruta.length - '/vida'.length)
          );
          return (
            <PersonLife
              personId={pid}
              files={mediaFiles}
              onBack={() => navigate('/')}
              onSelectFile={openFile}
              onVerEnGaleria={(id) => navigate('/persona/' + encodeURIComponent(id))}
            />
          );
        }

        case 'spaces':
          return (
            <SpacesManager
              onBack={() => setActiveView('home')}
              mediaFiles={mediaFiles}
              onSelectFile={openFile}
              onFilterBySpace={(_spaceId) => {
                // Por simpleza inicial: solo cerrar vista (filter por espacio
                // requeriria un nuevo estado en App, pendiente para fase futura).
                setActiveView('home');
              }}
            />
          );

        case 'collections':
          return (
            <CollectionsView
              onBack={() => setActiveView('home')}
              collections={collections}
              mediaFiles={mediaFiles}
              onCollectionSelect={(id) => navigate('/colecciones/' + encodeURIComponent(id))}
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
            />
          );

        case 'persons':
          return (
            <PersonsManager
              onBack={() => setActiveView('home')}
              mediaFiles={mediaFiles}
              onSelectFile={openFile}
              onFilterByPerson={(personId) => navigate('/persona/' + encodeURIComponent(personId))}
              onVerLineaDeVida={(personId) => navigate('/persona/' + encodeURIComponent(personId) + '/vida')}
              onVerGrupo={(grupoId) => {
                // Como "ver a esta persona": el grupo solo, sin caras sueltas.
                setSelectedPersonIds([]);
                setGruposActivos([grupoId]);
                navigate('/');
              }}
            />
          );

        case 'paths':
          // Single-user: PathManager siempre disponible
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

        case '__notfound__':
          return (
            <div className="text-center py-16">
              <h3 className="text-lg font-medium text-marfil mb-2">Página no encontrada</h3>
              <p className="text-lavanda-archivo mb-4">La ruta solicitada no existe.</p>
              <button
                onClick={() => navigate('/')}
                className="inline-flex items-center gap-1 px-4 py-2 rounded-full text-sm font-medium bg-lavanda text-noche hover:bg-opacity-90 transition-colors"
              >
                Volver al inicio
              </button>
            </div>
          );

        case 'home':
        default: {
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
                        ref={searchBarRef}
                        onSearch={handleSearch}
                        includedTags={includedTags}
                        excludedTags={excludedTags}
                        onTagsChange={handleTagsChange}
                        selectedPersonIds={selectedPersonIds}
                        onAddPerson={(pid) => {
                          // Functional setState: si runNaturalSearch llama dos
                          // veces seguidas (dos @mentions), la versión por copia
                          // capturaba `selectedPersonIds` stale y el segundo set
                          // sobreescribía al primero. Con prev=>... ambos se
                          // acumulan.
                          setSelectedPersonIds(prev => prev.includes(pid) ? prev : [...prev, pid]);
                        }}
                        onRemovePerson={(pid) => {
                          setSelectedPersonIds(prev => prev.filter(id => id !== pid));
                        }}
                        grupos={grupos}
                        gruposActivos={gruposActivos}
                        onAddGroup={(id) => setGruposActivos(prev => prev.includes(id) ? prev : [...prev, id])}
                        onRemoveGroup={(id) => setGruposActivos(prev => prev.filter(o => o !== id))}
                        contarGrupo={contarGrupo}
                        acotar={sugerenciasAcotar}
                        probar={probarCambio}
                        totalResultados={filteredFiles.length}
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

              {/* Indicador "Búsqueda por imagen similar activa" — visible solo
                  en home cuando se ha disparado desde el menú de tres puntos.
                  Muestra el numero de resultados y el orden por similitud. */}
              {activeView === 'home' && imageSearchFileIds !== null && (
                <div className="mb-3 flex items-center gap-3 px-3 py-2 rounded-full bg-lavanda/10 border border-lavanda/30 w-fit">
                  {imageSearchPreview
                    ? <img src={imageSearchPreview} alt="" className="w-8 h-8 rounded object-cover border border-lavanda/40" />
                    : <span className="w-8 h-8 rounded border border-lavanda/40 flex items-center justify-center text-lavanda text-xs">{imageSearchConsulta?.esVideo ? '▶' : '▣'}</span>}
                  <span className="text-sm text-marfil">
                    {/* Lo que se ve, no lo que devolvio el servidor: los filtros activos (tipo, persona...) se aplican encima. */}
                    {filteredFiles.length === 0
                      ? `Tus filtros esconden ${imageSearchFileIds.length === 1 ? 'la más parecida' : `las ${imageSearchFileIds.length} más parecidas`} ${imageSearchConsulta?.esVideo ? 'a ese vídeo' : 'a esa imagen'}`
                      : `${filteredFiles.length === 1 ? 'La más parecida' : `Las ${filteredFiles.length} más parecidas`} ${imageSearchConsulta?.esVideo ? 'a ese vídeo' : 'a esa imagen'} (por similitud, ≥ 75 %)`}
                    {filteredFiles.length > 0 && filteredFiles.length < imageSearchFileIds.length && (
                      <span className="text-lavanda-archivo"> · {imageSearchFileIds.length - filteredFiles.length} más que tus filtros no dejan ver</span>
                    )}
                  </span>
                  <button
                    onClick={() => { setImageSearchFileIds(null); setImageSearchPreview(null); setImageSearchConsulta(null); }}
                    className="ml-1 p-1 rounded-full text-lavanda-archivo hover:text-marfil hover:bg-lavanda/20"
                    title="Limpiar búsqueda por imagen"
                  >
                    <span className="text-base leading-none">&times;</span>
                  </button>
                </div>
              )}

              {/* Organization Bubbles - solo en vista home */}
              {activeView === 'home' && (
                <div className="mb-3 md:mb-6">
                  <PersonBubbles
                    selectedPersonIds={selectedPersonIds}
                    onSelectionChange={setSelectedPersonIds}
                    grupos={grupos}
                    gruposActivos={gruposActivos}
                    onGruposChange={setGruposActivos}
                    onVerLineaDeVida={(pid) => navigate('/persona/' + encodeURIComponent(pid) + '/vida')}
                    refreshKey={personsRefreshKey}
                  />
                </div>
              )}

              {/* El carrusel de colecciones se movio a la vista dedicada
                  "Colecciones" (accesible desde el menu de tres puntos).
                  Aqui en home solo se muestra la cabecera del detalle cuando
                  el usuario abre una coleccion concreta. "Volver" regresa a
                  la vista Colecciones. */}
              {activeView === 'home' && selectedCollectionId && (
                <div className="mb-8">
                  <div className="flex items-center gap-4 mb-4">
                    <button
                      onClick={() => {
                        setSelectedCollectionId(null);
                        setActiveView('collections');
                      }}
                      className="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors"
                      aria-label="Volver a Colecciones"
                    >
                      <ChevronLeft className="w-5 h-5" />
                      <span>Volver a Colecciones</span>
                    </button>
                    <div className="flex items-center gap-3">
                      <h2 className="text-xl font-semibold text-slate-900">
                        {collections.find(c => c.id === selectedCollectionId)?.name}
                      </h2>
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
                    </div>
                  </div>
                </div>
              )}

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

                  {/* Candado para toda la seleccion */}
                  <button
                    onClick={() => { const ids = Array.from(selectedFiles); exitSelectionMode(); ocultarArchivos(ids); }}
                    className="w-9 h-9 md:w-12 md:h-12 rounded-full bg-grafito hover:bg-pizarra text-lavanda flex items-center justify-center transition-colors"
                    title="Ocultar seleccionados bajo candado"
                  >
                    <Lock className="w-5 h-5" />
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


              {/* Reposo activo: el archivo propone antes de que preguntes. */}
              {/* La carta va ENCIMA de los ecos: primero lo que el archivo
                  tiene que decir, y debajo lo que tiene que enseñar. */}
              {!isLoading && (
                <Carta files={mediaFiles} onSelectFile={openFile} />
              )}
              {!isLoading && ecos.length > 0 && (
                <Ecos
                  ecos={ecos}
                  activoId={ecoActivo ? ecoActivo.id : null}
                  onAbrir={(eco) => { setEcoActivo(eco); resetInfiniteScroll(); }}
                  onCerrar={() => { setEcoActivo(null); resetInfiniteScroll(); }}
                  onDescartar={ocultarEcos}
                  onBarajar={() => { setEcosGiro(g => g + 1); if (ecoActivo) { setEcoActivo(null); resetInfiniteScroll(); } }}
                  giro={ecosGiro}
                />
              )}

              {/* Content */}
              {isLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader variant="cargando" />
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
                    onScanFile={handleScanFile}
                    onOcultar={ocultarArchivos}
                    scanningFiles={scanningFiles}
                    downloadingFiles={downloadingFiles}
                    isSelectionMode={isSelectionMode}
                    selectedFiles={selectedFiles}
                    isAdmin={true}
                    updatingFavs={updatingFavs}
                    sessionItems={useGrouping ? sessionItems : undefined}
                    onExpandGroup={handleExpandGroup}
                    onCollapseGroup={handleCollapseGroup}
                    onCollapseAll={handleCollapseAll}
                    onShowMoreGroup={handleShowMoreGroup}
                    onSelectSessionFiles={handleSelectSessionFiles}
                    sessionNotes={sessionNotes}
                    onEditSessionNote={handleEditSessionNote}
                    onPlaySession={handlePlaySession}
                    fileNotes={fileNotes}
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
    ? mediaFiles.filter(file => estaEnColeccion(clavesDeColeccion(selectedCollection), file))
    : [];

  // Check if any filters are active
  const hasActiveFilters = Boolean(
    currentSearchQuery ||
    currentSearchTerms.length > 0 ||
    currentSearchFilters ||
    filterDateFrom ||
    filterDateTo ||
    includedTags.length > 0 ||
    excludedTags.length > 0 ||
    selectedTypes.length > 0 ||
    selectedPersonIds.length > 0 ||
    gruposActivos.length > 0 ||
    naturalSearchIds !== null ||
    showFavoritesOnly ||
    colorFilterHex !== null ||
    imageSearchPreview !== null
  );
  hasActiveFiltersRef.current = hasActiveFilters;

  // Calculate filtered vs total files in collection
  const collectionFilteredCount = selectedCollectionId ? allDisplayFiles.length : 0;
  const collectionTotalCount = allCollectionFiles.length;

  return (
    <div className="min-h-screen bg-noche">
      {/* Estado del backend. Sin esto, una caida se veia como una pantalla
          congelada indistinguible de "esta trabajando". */}
      {portada && (
        <Portada
          desdeMenu={portada.desdeMenu}
          archivosCargados={!isLoading && mediaFiles.length > 0}
          onEntrar={(opciones: OpcionesEntrar) => {
            try { sessionStorage.setItem('pensadero.portadaVista', '1'); } catch { /* modo privado */ }
            // Entrar sin esperar: el indexado sigue, pero su pantalla de
            // progreso no debe aparecer justo despues de haber decidido no esperar.
            if (opciones.sinEsperar) progresoSilenciadoRef.current = true;
            setPortada(null);
            if (opciones.destino === 'rutas') { navigate('/rutas'); return; }
            if (opciones.fileId) {
              const f = mediaFilesRef.current.find(x => x.id === opciones.fileId);
              if (f) openFile(f);
            }
          }}
        />
      )}
      {/* La portada ya dice si el servidor esta despertando: el aviso rojo
          sobre ella solo asustaria. */}
      {!portada && <ConnectionBanner isConnected={isConnected} />}

      {/* Overlay de drag & drop: visible cuando el usuario arrastra una
          imagen sobre Pensadero estando en la vista home. pointer-events-none
          para que el drop llegue al window y no se "coma" el evento. */}
      {isDraggingImage && activeView === 'home' && (
        <div className="fixed inset-0 z-[100] bg-noche/85 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="bg-tinta border-4 border-dashed border-lavanda rounded-3xl px-12 py-10 flex flex-col items-center gap-4 shadow-2xl">
            <svg className="w-20 h-20 text-lavanda" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-2xl font-medium text-marfil">Suelta aquí para buscar lo parecido</p>
            <p className="text-sm text-lavanda-archivo">Una imagen o un vídeo: encontrará las fotos y los vídeos más parecidos de tu archivo</p>
          </div>
        </div>
      )}

      {/* Busqueda en marcha: lo arrastrado y que se esta buscando. Sin esto,
          tras soltar el archivo no se veia nada durante segundos (la primera
          vez se carga el modelo visual) y parecia que no habia pasado nada. */}
      {buscandoParecidas && (
        <div className="fixed inset-0 z-[100] bg-noche/60 backdrop-blur-[2px] flex items-center justify-center" role="status" aria-live="polite">
          <div className="bg-tinta border border-lavanda/40 rounded-3xl px-8 py-7 flex flex-col items-center gap-4 shadow-2xl max-w-sm mx-4 text-center">
            <div className="relative">
              {buscandoParecidas.preview
                ? <img src={buscandoParecidas.preview} alt="" className="w-28 h-28 rounded-2xl object-cover border border-lavanda/40" />
                : <div className="w-28 h-28 rounded-2xl border border-lavanda/40 bg-grafito flex items-center justify-center text-3xl text-lavanda">{buscandoParecidas.esVideo ? '▶' : '▣'}</div>}
              <Loader2 className="absolute -right-2 -bottom-2 w-8 h-8 p-1.5 rounded-full bg-lavanda text-noche animate-spin" />
            </div>
            <div>
              <p className="text-lg font-medium text-marfil">Buscando lo parecido…</p>
              <p className="text-xs text-niebla mt-1 break-all">{buscandoParecidas.nombre}</p>
              <p className="text-sm text-lavanda-archivo mt-2">
                {buscandoParecidas.esVideo
                  ? 'Mirando varios momentos del vídeo y comparándolos con tu archivo.'
                  : 'Comparando la imagen con las fotos y los vídeos de tu archivo.'}
              </p>
              {buscandoParecidas.lenta && (
                <p className="text-xs text-niebla mt-2">
                  {buscandoParecidas.esVideo
                    ? 'Un vídeo grande tarda un poco más, y la primera búsqueda carga además el modelo visual.'
                    : 'La primera búsqueda tarda un poco más: se está cargando el modelo visual.'}
                </p>
              )}
            </div>
            <button
              onClick={cancelarBusquedaImagen}
              className="text-sm px-4 py-1.5 rounded-full border border-lavanda/40 text-lavanda-claro hover:bg-lavanda/15"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

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

      {/* Header global eliminado: la navegacion vive ahora en la burbuja
          flotante Pensadero (esquina inferior-derecha). Asi se recupera el
          espacio vertical superior para el contenido. */}

      <main className="bg-noche">
        <div className={`p-4 md:p-8${showTimeline ? ' md:pr-24' : ''}`}>
          {renderMainContent()}
        </div>
      </main>

      {/* Onda vertical (pasiva) de densidad temporal a la derecha del home */}
      {showTimeline && timelineDateValues.length > 1 && (
        <TimelineWave sortedDateValues={timelineDateValues} loadedCount={loadedItemsCount} onSeek={handleTimelineSeek} />
      )}

      {/* Quick Preview Overlay (Space key) */}
      {quickPreviewFile && (
        <QuickPreviewOverlay
          file={quickPreviewFile}
          onClose={() => setQuickPreviewFile(null)}
        />
      )}

      {editingSessionNote && (
        <SessionNoteModal
          isOpen={true}
          sessionKey={editingSessionNote.key}
          label={editingSessionNote.label}
          initialNote={sessionNotes[editingSessionNote.key] || ''}
          onClose={() => setEditingSessionNote(null)}
          onSave={handleSaveSessionNote}
        />
      )}

      <MediaModal
        file={selectedFile}
        isOpen={isModalOpen}
        note={noteFor(fileNotes, selectedFile) || ''}
        onSaveNote={handleSaveFileNote}
        onOpenPath={handleOpenPath}
        onOcultar={(f) => {
          const bg = (location.state as { backgroundLocation?: typeof location } | null)?.backgroundLocation;
          navigate(bg ? (bg as any) : '/');
          ocultarArchivos([f.id]);
        }}
        onClose={() => {
          // Volver a la vista de fondo si existe; si no (deep-link directo), a home.
          const bg = (location.state as { backgroundLocation?: typeof location } | null)?.backgroundLocation;
          navigate(bg ? (bg as any) : '/');
        }}
        onToggleFavorite={handleToggleFavorite}
        onDownload={handleDownload}
        onAddToCollection={handleAddToCollection}
        allFiles={allDisplayFiles}
        onFileSelect={(newFile) => {
          // Navegar entre archivos preservando la vista de fondo. replace para no
          // apilar una entrada de historial por cada archivo visitado.
          const bg = (location.state as { backgroundLocation?: typeof location } | null)?.backgroundLocation;
          navigate(`/archivo/${encodeURIComponent(newFile.id)}`, { state: bg ? { backgroundLocation: bg } : undefined, replace: true });
        }}
        onTagClick={handleTagClick}
        onPersonFilter={(personId) => {
          // Como una etiqueta: el filtro se activa en el acto (tambien si la
          // galeria de fondo ya era /persona/:id y el filtro se habia limpiado,
          // donde la URL no cambia). Ir a /persona/:id cierra la ficha;
          // replace para que la ficha no quede en el historial.
          setSelectedPersonIds([personId]);
          navigate('/persona/' + encodeURIComponent(personId), { replace: true });
        }}
      />

      {/* Estado de carga del modal cuando se abre por deep-link (/archivo/:id)
          y el archivo aun no esta cargado. */}
      {modalLoading && (
        <div className="fixed inset-0 z-[120] bg-noche/80 backdrop-blur-sm flex items-center justify-center">
          <Loader variant="cargando" showCaption={false} />
        </div>
      )}

      {/* Error: el archivo de la URL no existe o no se pudo cargar. */}
      {modalError && (
        <div className="fixed inset-0 z-[120] bg-noche/90 backdrop-blur-sm flex flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-marfil">{modalError}</p>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 rounded-full text-sm font-medium bg-lavanda text-noche hover:bg-opacity-90 transition-colors"
          >
            Volver al inicio
          </button>
        </div>
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
        videos={presentationFiles ?? getAllDisplayFiles()}
        isOpen={showPresentationMode}
        onClose={handleClosePresentation}
      />

      {/* Overlay de progreso (bloqueante) para escaneo / sincronización */}
      {showProgress && !portada && (
        <Loader
          fullscreen
          variant={vistaProgreso?.terminado ? 'listo' : (vistaProgreso?.tipo ?? 'sync')}
          micro={vistaProgreso?.micro}
          cap={vistaProgreso?.cap}
          sub={vistaProgreso?.sub}
          vista={vistaProgreso ?? undefined}
          onCancel={vistaProgreso?.terminado ? undefined : detenerProgreso}
          cancelLabel={vistaProgreso?.tipo === 'escaneo' ? 'Detener' : 'Ocultar'}
        />
      )}

      {/* Overlay de descarga (bloqueante) para ZIP / colección */}
      {(isDownloadingZip || downloadingCollectionId || downloadDone) && (
        <Loader
          fullscreen
          variant={downloadDone ? 'listo' : 'descarga'}
          cap={downloadDone ? 'Descarga lista' : undefined}
        />
      )}

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

      {/* Floating Action Buttons Container.
          Orden visual: [ ↑ ScrollToTop ] [ Burbuja Pensadero ]. La burbuja es
          el elemento principal (siempre presente); la flecha es contextual
          (solo con scroll). La burbuja es z-50 y se renderiza DESPUES que los
          modales: a igual z-index gana el ultimo en el DOM, asi que el
          contenedor se OCULTA mientras haya CUALQUIER overlay/dialogo a
          pantalla completa o el modo seleccion activo; si no, la burbuja
          taparia su contenido y seguiria clickable encima. Mantener esta lista
          al dia con los modales z-50 nuevos. */}
      {!(
        isModalOpen || showPresentationMode || quickPreviewFile || modalLoading || modalError || isDraggingImage
        || showCreateCollection || editingCollectionId !== null || showCoverSelector
        || showAddToCollection || showBulkAddToCollection
        || editingSessionNote || (isSelectionMode && selectedFiles.size > 0)
      ) && (
        <>
        {/* Avisos de abajo a la izquierda, solo en la home: copias exactas por
            decidir y videos sin version ligera. Apilados (el primero, abajo).
            Se esconden con los mismos overlays que la burbuja de la derecha. */}
        {activeView === 'home' && !portada && (
          <div className="fixed bottom-6 left-6 z-40 w-[calc(100vw-3rem)] max-w-[340px] flex flex-col-reverse gap-3">
            <AvisoCopias recarga={mediaFiles} onRevisar={() => navigate('/gemelas/copias')} />
            <AvisoProxies recarga={mediaFiles} onAjustes={() => navigate(VIEW_TO_PATH.statistics)} />
          </div>
        )}
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3">
          {/* Scroll to Top Button — solo en home */}
          {activeView === 'home' && <ScrollToTopButton />}

          {/* Navegacion global: punto unico de acceso (sustituye al header). */}
          <MoreOptionsMenu
            activeView={activeView}
            variant="bubble"
            placement="top"
            onViewChange={(view) => {
              // Cambiar de vista limpia foco de favoritos/colección (igual que
              // hacia el logo del antiguo header).
              setShowFavoritesOnly(false);
              setSelectedCollectionId(null);
              // "Inicio" promete "galería principal": limpiar tambien el filtro
              // de persona pegajoso (/persona/:id) y el resto de filtros activos,
              // o la home apareceria filtrada pese a la etiqueta.
              if (view === 'portada') { setPortada({ desdeMenu: true }); return; }
              if (view === 'home') clearAllFilters();
              setActiveView(view);
            }}
          />
        </div>
        </>
      )}

    </div>
  );
}

export default App;