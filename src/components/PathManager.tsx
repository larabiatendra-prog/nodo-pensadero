import { useState, useEffect, useRef, useMemo } from 'react';
import {
  FolderOpen, RefreshCw, Plus, Sparkles, Square, AlertTriangle, ChevronRight,
  Folder, MoreHorizontal, Check, RotateCcw, Cpu, Zap, Tag, Unlink, Link2, Trash2, X, ShieldCheck, HardDrive,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../services/api';
import type { VlmModel, CapacidadEscaneo, CapacidadInfo } from '../services/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { config } from '../config';
import ScanContextModal from './ScanContextModal';
import FolderRenameModal from './FolderRenameModal';
import TutorialLetraFija from './TutorialLetraFija';
import { discosDeLaTarjeta, type DiscoAFijar } from '../utils/letrasDiscos';

/**
 * Rutas y escaneo — la sala de maquinas del archivo.
 *
 * Jerarquia: lo primero son las bibliotecas (que hay, si esta conectado, cuanto
 * esta descrito y que hacer con cada una). Al lado, lo que hace un escaneo:
 * interruptores para decidir que trabajos se hacen —y por tanto que recursos
 * se gastan— para todo el archivo, y dentro de cada ruta, lo que esa ruta
 * cambia respecto al conjunto.
 *
 * Antes era una columna de cajas con seis iconos sin rotulo por ruta (uno de
 * ellos, "desvincular", pintado como si fuera el boton principal), un panel de
 * "Informacion" que nadie leia y ningun control sobre que hacia el escaneo.
 */

type Capacidades = Record<CapacidadEscaneo, boolean>;

interface ScanPath {
  id: string;
  path: string;
  displayName?: string;
  isActive: boolean;
  lastScan: Date | null;
  fileCount: number;
  // otro_disco: en esa letra hay un disco que no es el de la biblioteca (el
  // servidor lo reconoce por el numero de serie del volumen) y no se lee.
  status: 'connected' | 'disconnected' | 'otro_disco' | 'scanning' | 'error';
  errorMessage?: string;
  lastError?: string | null;
  visualTotal?: number;     // archivos que el escaneo mira bajo la ruta (live)
  visualScanned?: number;   // de esos, cuantos tienen descripcion visual
  pendientes?: number;      // a cuantos les falta algun trabajo encendido ahora
  /**
   * El disco de esta biblioteca esta ahora en otra ruta (otra letra). Si esa
   * ruta la tiene otra biblioteca: `mismoDisco` dice si es de verdad el mismo
   * disco y, si no, `suDisco` donde esta ahora el de la otra (letras cruzadas).
   */
  sugerencia?: {
    ruta: string;
    ocupadaPor?: { id: string; nombre: string; mismoDisco?: boolean; suDisco?: string | null } | null;
  } | null;
  /** Nombre (etiqueta) y capacidad del disco, la ultima vez que se vio. */
  disco?: { etiqueta: string | null; capacidad: number | null } | null;
  escaneo?: Partial<Capacidades>;       // lo que esta ruta sobrescribe
  escaneoEfectivo?: Capacidades;         // global + sobrescrituras
  /** Disco de copia de seguridad: sus copias exactas se esconden solas. */
  copiaSeguridad?: boolean;
}

interface AiScanState {
  jobId: string | null;
  total: number;
  done: number;
  errors: number;
  currentFile?: string;
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  errorMessage?: string;
  avgMsPerFile?: number;   // media movil por archivo (backend)
  etaMs?: number;          // tiempo restante estimado (backend)
  totalMs?: number;        // tiempo total del job al terminar (scan_done)
  // Capacidades caidas en este escaneo ('faces', 'clip', 'motion'). Un escaneo
  // degradado termina "con exito" pero deja el catalogo incompleto: sin esto,
  // no habia forma de enterarse hasta buscar una cara meses despues.
  degraded?: string[];
  // Volcados que NO se pudieron escribir, con su causa ya traducida por el
  // backend. Un escaneo que no puede guardar esta quemando GPU para nada: el
  // 09/09/2026 se perdieron 9.378 volcados por un disco lleno y el resumen
  // seguia diciendo "Escaneo completado".
  escriturasFallidas?: number;
  causaPrincipal?: { reason: string; hint?: string; code?: string } | null;
}

/** Subcarpeta de una biblioteca, tal como la devuelve /api/scan/inventory. */
interface SubfolderInfo {
  dir: string;
  relPath: string;
  mediaCount: number;
  imageCount: number;
  videoCount: number;
  hasContext: boolean;
  folderName: string | null;
  visualTotal: number;
  visualScanned: number;
  pendientes?: number;
}

/** Al añadir: esa carpeta es el disco de una biblioteca que ya existe. */
interface MismoDisco {
  id: string;
  nombre: string;
  ruta: string;
  nuevaRuta: string;
}

// Nombres legibles de las capacidades que pueden caerse durante un escaneo.
const CAPACIDAD_LABEL: Record<string, string> = {
  faces: 'reconocimiento de caras',
  clip: 'busqueda visual',
  motion: 'movimiento de camara',
};

const IDS: CapacidadEscaneo[] = ['descripcion', 'caras', 'busquedaVisual', 'movimiento', 'proxies'];

/** Por si el backend aun no sirve el catalogo: los mismos textos, en corto. */
const CATALOGO_RESERVA: CapacidadInfo[] = [
  { id: 'descripcion', nombre: 'Descripciones', detalle: 'Qué pasa en cada foto o vídeo. Hace funcionar la búsqueda por lenguaje natural.', recurso: 'GPU', coste: 'alto' },
  { id: 'caras', nombre: 'Caras', detalle: 'Detecta caras y reconoce a las personas que ya conoces.', recurso: 'GPU', coste: 'medio' },
  { id: 'busquedaVisual', nombre: 'Búsqueda visual', detalle: 'Buscar por imagen, parecidos, tomas gemelas y espacios.', recurso: 'GPU', coste: 'bajo' },
  { id: 'movimiento', nombre: 'Movimiento de cámara', detalle: 'Paneos, zooms y cortes en los vídeos.', recurso: 'CPU', coste: 'medio', soloVideo: true },
  { id: 'proxies', nombre: 'Vídeos listos para ver', detalle: 'Prepara al escanear una versión ligera de los vídeos que el navegador no abre. Apagado, se prepara al abrirlos.', recurso: 'GPU (NVENC) y disco', coste: 'medio', soloVideo: true },
];

// Los ajustes rapidos solo tocan el analisis. Preparar videos es otra cosa
// (espacio en disco), y un "Completo" no deberia encenderlo sin decirlo.
const ANALISIS: CapacidadEscaneo[] = ['descripcion', 'caras', 'busquedaVisual', 'movimiento'];
const PRESETS: Array<{ id: string; nombre: string; detalle: string; valores: Partial<Capacidades> }> = [
  {
    id: 'completo', nombre: 'Completo', detalle: 'Todo el análisis encendido',
    valores: { descripcion: true, caras: true, busquedaVisual: true, movimiento: true },
  },
  {
    id: 'ligero', nombre: 'Ligero', detalle: 'Caras y búsqueda visual, sin describir',
    valores: { descripcion: false, caras: true, busquedaVisual: true, movimiento: false },
  },
  {
    id: 'describir', nombre: 'Solo describir', detalle: 'Descripciones, nada más',
    valores: { descripcion: true, caras: false, busquedaVisual: false, movimiento: false },
  },
];

const miles = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** "6 TB", "931 GB": la capacidad como la dice el fabricante (potencias de 1000). */
const capacidadTexto = (bytes: number) => bytes >= 1e12
  ? `${(bytes / 1e12).toLocaleString('es-ES', { maximumFractionDigits: 1 })} TB`
  : `${Math.round(bytes / 1e9)} GB`;

/** Nombre de una biblioteca para comparar si dos se llaman igual. */
const nombreNorm = (p: { displayName?: string; path: string }) => String(p.displayName || p.path).trim().toLowerCase();

/** Vinculada y con SU disco en su sitio (ni fuera ni otro disco en esa letra). */
const estaConectada = (p: ScanPath) => p.isActive && p.status !== 'disconnected' && p.status !== 'otro_disco';

// Formatea una duracion en ms a texto humano corto: "850ms", "2.4s", "3m 12s",
// "1h 5m". Para medias por archivo (< 1 min) preferimos segundos con decimal.
function fmtDuration(ms: number | undefined, decimalSeconds = false): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return decimalSeconds ? `${totalSec.toFixed(1)}s` : `${Math.round(totalSec)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

/** "hace 3 min", "hace 2 días"... para la ultima sincronizacion. */
function haceCuanto(fecha: Date | null): string {
  if (!fecha || isNaN(fecha.getTime())) return 'sin sincronizar';
  const s = Math.max(0, (Date.now() - fecha.getTime()) / 1000);
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}

// ── Piezas ────────────────────────────────────────────────────────────────

function Interruptor({ encendido, onCambiar, etiqueta, deshabilitado = false, pequeno = false }: {
  encendido: boolean;
  onCambiar: (v: boolean) => void;
  etiqueta: string;
  deshabilitado?: boolean;
  pequeno?: boolean;
}) {
  const ancho = pequeno ? 'h-4 w-7' : 'h-5 w-9';
  const bola = pequeno ? 'h-3 w-3' : 'h-4 w-4';
  const recorrido = pequeno ? 'translate-x-[14px]' : 'translate-x-[18px]';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={encendido}
      aria-label={etiqueta}
      disabled={deshabilitado}
      onClick={() => onCambiar(!encendido)}
      className={`relative inline-flex ${ancho} shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda focus-visible:ring-offset-2 focus-visible:ring-offset-noche disabled:opacity-40 disabled:cursor-not-allowed ${
        encendido ? 'bg-lavanda' : 'bg-pizarra'
      }`}
    >
      <span
        className={`inline-block ${bola} rounded-full shadow transition-transform duration-200 ${
          encendido ? `${recorrido} bg-noche` : 'translate-x-0.5 bg-niebla'
        }`}
      />
    </button>
  );
}

function Coste({ recurso, coste }: { recurso: string; coste: string }) {
  const tono = coste === 'alto' ? 'text-melocoton' : coste === 'medio' ? 'text-niebla' : 'text-salvia';
  return (
    <span className="font-mono text-[10px] tracking-wider uppercase text-humo">
      {recurso} · <span className={tono}>{coste}</span>
    </span>
  );
}

/** Menu de "mas acciones" de una ruta: lo que no se usa a diario. */
function MenuRuta({ path, onReescanear, onRenombrar, onUbicacion, onVincular, onCopiaSeguridad, onQuitar, puedeReescanear }: {
  path: ScanPath;
  onReescanear: () => void;
  onRenombrar: () => void;
  onUbicacion: () => void;
  onVincular: () => void;
  onCopiaSeguridad: () => void;
  onQuitar: () => void;
  puedeReescanear: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('mousedown', fuera);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fuera); window.removeEventListener('keydown', esc); };
  }, [abierto]);

  const item = 'w-full flex items-center gap-2.5 px-3 py-2 text-left text-[13px] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const hacer = (fn: () => void) => () => { setAbierto(false); fn(); };
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setAbierto(v => !v)}
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-label="Más acciones"
        className="p-2 rounded-full text-humo hover:text-marfil hover:bg-grafito transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {abierto && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-30 w-60 p-1.5 rounded-xl bg-grafito border border-borde-sutil shadow-xl">
          <button role="menuitem" className={`${item} text-niebla hover:bg-pizarra hover:text-marfil`} onClick={hacer(onReescanear)} disabled={!puedeReescanear}>
            <Zap className="w-4 h-4 text-melocoton" />
            <span>Re-escanear todo<span className="block text-[11px] text-humo">También lo ya escaneado</span></span>
          </button>
          <button role="menuitem" className={`${item} text-niebla hover:bg-pizarra hover:text-marfil`} onClick={hacer(onRenombrar)} disabled={!path.isActive}>
            <Tag className="w-4 h-4" />
            Renombrar carpetas
          </button>
          {/* El disco cambio de letra (D: -> E:) o se movio la carpeta. Añadirla
              como ruta nueva dejaba colgando lo suyo de la vieja. */}
          {path.id !== 'default' && (
            <button role="menuitem" className={`${item} text-niebla hover:bg-pizarra hover:text-marfil`} onClick={hacer(onUbicacion)}>
              <HardDrive className="w-4 h-4" />
              <span>Cambiar ubicación<span className="block text-[11px] text-humo">Si el disco tiene otra letra. No se pierde nada</span></span>
            </button>
          )}
          <button role="menuitem" className={`${item} text-niebla hover:bg-pizarra hover:text-marfil`} onClick={hacer(onVincular)}>
            {path.isActive ? <Unlink className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
            <span>{path.isActive ? 'Desvincular' : 'Volver a vincular'}<span className="block text-[11px] text-humo">{path.isActive ? 'Deja de sincronizarse, sin borrar nada' : 'Vuelve a sincronizarse'}</span></span>
          </button>
          {/* Un disco de backup conectado junto al original duplica todo en la
              galeria. Marcarlo decide de una vez cual se ve, tambien para lo
              que se copie mas adelante. */}
          <button role="menuitemcheckbox" aria-checked={!!path.copiaSeguridad} className={`${item} text-niebla hover:bg-pizarra hover:text-marfil`} onClick={hacer(onCopiaSeguridad)}>
            <ShieldCheck className={`w-4 h-4 ${path.copiaSeguridad ? 'text-lavanda' : ''}`} />
            <span>{path.copiaSeguridad ? 'Dejar de ser copia de seguridad' : 'Es copia de seguridad'}<span className="block text-[11px] text-humo">{path.copiaSeguridad ? 'Sus copias vuelven a contar como duplicados' : 'Si un archivo también está en otro disco, se ve el otro'}</span></span>
          </button>
          {path.id !== 'default' && (
            <>
              <div className="my-1 h-px bg-borde-sutil" />
              <button role="menuitem" className={`${item} text-estado-error hover:bg-estado-error/10`} onClick={hacer(onQuitar)}>
                <Trash2 className="w-4 h-4" />
                Quitar ruta
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface PathManagerProps {
  onSyncComplete?: () => void;
}

export default function PathManager({ onSyncComplete }: PathManagerProps = {}) {
  const [paths, setPaths] = useState<ScanPath[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newPath, setNewPath] = useState('');
  const [showAddPath, setShowAddPath] = useState(false);
  const [scanningPaths, setScanningPaths] = useState<Set<string>>(new Set());
  // Al añadir una carpeta que resulta ser el disco de una biblioteca existente.
  const [mismoDisco, setMismoDisco] = useState<MismoDisco | null>(null);
  // Ruta cuya ubicacion se esta cambiando (formulario en su propia fila).
  const [ubicacion, setUbicacion] = useState<{ id: string; valor: string } | null>(null);
  const [guardandoUbicacion, setGuardandoUbicacion] = useState(false);
  const [recolocando, setRecolocando] = useState<string | null>(null);
  // Tutorial de la letra fija, por biblioteca. Sin tocar: abierto si las letras
  // se han cruzado (ahi es el arreglo), plegado si solo ha cambiado la letra.
  const [tutorialAbierto, setTutorialAbierto] = useState<Record<string, boolean>>({});
  const [comprobandoDiscos, setComprobandoDiscos] = useState(false);

  // Que hace el escaneo: catalogo de trabajos y los globales.
  const [catalogo, setCatalogo] = useState<CapacidadInfo[]>(CATALOGO_RESERVA);
  const [capsGlobal, setCapsGlobal] = useState<Capacidades | null>(null);

  // Estado de escaneo visual con IA por ruta. Map: pathId → estado.
  const [aiScansByPath, setAiScansByPath] = useState<Map<string, AiScanState>>(new Map());
  // Map: jobId → pathId para resolver eventos WebSocket.
  // useRef para evitar stale closure cuando el WS evento llega antes de que
  // React aplique el setState (race condition entre POST /scan/start y el
  // evento scan_start emitido por el backend con setImmediate).
  const jobIdToPathIdRef = useRef<Map<string, string>>(new Map());

  // Estado de salud del VLM (Ollama + modelo). Se consulta al montar.
  const [vlmHealth, setVlmHealth] = useState<{ ollamaRunning: boolean; modelAvailable: boolean; model: string; error?: string } | null>(null);
  const [availableModels, setAvailableModels] = useState<VlmModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');

  // Modal de contexto previo al escaneo individual.
  const [contextModalPathId, setContextModalPathId] = useState<string | null>(null);
  const [contextModalForce, setContextModalForce] = useState(false);

  // Modal de renombrado de carpetas (display name por carpeta).
  const [renameModalPathId, setRenameModalPathId] = useState<string | null>(null);

  // Cola de rutas para el flujo "Escanear todas": el modal se muestra una
  // vez por cada ruta activa antes de lanzar el scan-all.
  const [scanAllQueue, setScanAllQueue] = useState<{ id: string; path: string }[] | null>(null);
  const [scanAllQueueIdx, setScanAllQueueIdx] = useState(0);
  const [scanAllForce, setScanAllForce] = useState(false);

  // Estado del bucle batch "Escanear todas las rutas". Solo uno activo a la vez.
  const [batchScan, setBatchScan] = useState<{ running: boolean; total: number; processed: number; force: boolean } | null>(null);
  // Resumen transitorio al terminar el batch (tiempo total). Se autolimpia.
  const [batchSummary, setBatchSummary] = useState<{ processed: number; total: number; elapsedMs: number; aborted: boolean } | null>(null);

  // --- Rutas desplegadas: sus interruptores propios y sus subcarpetas ---
  // El inventario se pide bajo demanda (al desplegar), no al cargar la pagina,
  // porque recorrer el arbol de una biblioteca grande no es gratis.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [subfolders, setSubfolders] = useState<Map<string, SubfolderInfo[]>>(new Map());
  const [loadingSubfolders, setLoadingSubfolders] = useState<Set<string>>(new Set());

  const toggleSubfolders = async (pathId: string, rootPath: string, conectada: boolean) => {
    const abierto = expandedPaths.has(pathId);
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (abierto) next.delete(pathId); else next.add(pathId);
      return next;
    });
    if (abierto || subfolders.has(pathId) || !conectada) return;

    setLoadingSubfolders(prev => new Set(prev).add(pathId));
    try {
      const r = await api.scanInventory(rootPath);
      if (r.success && r.data) {
        // Solo carpetas con archivos propios: las que solo contienen
        // subcarpetas no son una sesion, son un contenedor.
        const utiles = r.data.folders.filter(f => (f.visualTotal ?? 0) > 0);
        setSubfolders(prev => new Map(prev).set(pathId, utiles));
      }
    } catch {
      toast.error('No se pudo leer el contenido de la ruta');
    } finally {
      setLoadingSubfolders(prev => {
        const next = new Set(prev);
        next.delete(pathId);
        return next;
      });
    }
  };

  // Lanza el escaneo de UNA subcarpeta. Reutiliza /scan/start, que ya acepta
  // cualquier ruta contenida en una biblioteca configurada.
  const handleScanSubfolder = async (dir: string, force: boolean) => {
    try {
      const r: any = await api.startScan(dir, force);
      if (r.success) {
        toast.success(force ? 'Re-escaneando la subcarpeta' : 'Escaneando lo pendiente de la subcarpeta');
      } else {
        toast.error(r.error || 'No se pudo iniciar el escaneo');
      }
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo iniciar el escaneo');
    }
  };

  // WebSocket para progreso en tiempo real. El estado de conexion lo pinta
  // ConnectionBanner desde App; aqui solo interesa el progreso.
  const { progressData } = useWebSocket(config.wsUrl);

  useEffect(() => {
    loadPaths();
    api.getCapacidades().then(r => {
      if (r.success && r.data) {
        if (Array.isArray(r.data.catalogo) && r.data.catalogo.length > 0) setCatalogo(r.data.catalogo);
        setCapsGlobal(r.data.global);
      }
    }).catch(() => {
      // Backend sin interruptores: se pinta como siempre, todo encendido.
      setCapsGlobal({ descripcion: true, caras: true, busquedaVisual: true, movimiento: true, proxies: false });
    });
    // Health del VLM al entrar: diagnostico si Ollama o el modelo no estan.
    api.scanHealth().then(r => {
      if (r.success && r.data) setVlmHealth(r.data);
    }).catch(() => setVlmHealth({ ollamaRunning: false, modelAvailable: false, model: 'gemma4:12b' }));
    api.scanModels().then(r => {
      if (r.success && r.data) {
        setAvailableModels(r.data.models);
        setSelectedModel(r.data.current);
      }
    }).catch(() => {});
    // Resync inicial: si hay un batch corriendo en el backend (porque
    // recargamos el frontend mientras escaneaba), retomamos el indicador.
    api.scanBatchStatus().then(r => {
      if (r.success && r.data && r.data.running) {
        setBatchScan({
          running: true,
          total: r.data.total,
          processed: r.data.processed,
          force: r.data.force,
        });
      }
    }).catch(() => {});
  }, []);

  // Espejos en refs para leer estado/props dentro del efecto de WS SIN meterlos
  // en sus deps (un Map nuevo por render re-disparaba el efecto en bucle).
  const aiScansByPathRef = useRef(aiScansByPath);
  useEffect(() => { aiScansByPathRef.current = aiScansByPath; }, [aiScansByPath]);
  const onSyncCompleteRef = useRef(onSyncComplete);
  useEffect(() => { onSyncCompleteRef.current = onSyncComplete; }, [onSyncComplete]);

  // Escuchar progreso de sincronización Y de escaneo visual IA
  useEffect(() => {
    if (!progressData) return;

    if (progressData.type === 'sync_complete') {
      loadPaths();
      if (onSyncCompleteRef.current) {
        setTimeout(() => {
          onSyncCompleteRef.current?.();
        }, 1000); // Pequeño delay para asegurar que el backend completó todo
      }
    }

    // Resolver pathId desde el ref (sin closure stale) o, como fallback, desde
    // el unico path en estado running.
    const resolvePid = (jobId: string | undefined): string | undefined => {
      if (jobId) {
        const fromRef = jobIdToPathIdRef.current.get(jobId);
        if (fromRef) return fromRef;
      }
      let candidate: string | undefined;
      let count = 0;
      for (const [pid, st] of aiScansByPathRef.current.entries()) {
        if (st.status === 'running') { candidate = pid; count++; }
      }
      if (count === 1 && candidate && jobId) {
        jobIdToPathIdRef.current.set(jobId, candidate);
        return candidate;
      }
      return undefined;
    };

    if (progressData.type === 'scan_start' && progressData.jobId) {
      const pid = resolvePid(progressData.jobId);
      if (pid) {
        setAiScansByPath(prev => {
          const next = new Map(prev);
          next.set(pid, {
            jobId: progressData.jobId!,
            total: 0,
            done: 0,
            errors: 0,
            status: 'running',
            degraded: progressData.degraded,
          });
          return next;
        });
      }
    }

    if (progressData.type === 'scan_progress' && progressData.jobId) {
      const pid = resolvePid(progressData.jobId);
      if (pid) {
        setAiScansByPath(prev => {
          const next = new Map(prev);
          const cur = next.get(pid) || { jobId: progressData.jobId!, total: 0, done: 0, errors: 0, status: 'running' as const };
          next.set(pid, {
            ...cur,
            jobId: progressData.jobId!,
            total: progressData.total ?? cur.total,
            done: progressData.done ?? cur.done,
            errors: progressData.errors ?? cur.errors,
            currentFile: progressData.file ?? cur.currentFile,
            avgMsPerFile: progressData.avgMsPerFile ?? cur.avgMsPerFile,
            etaMs: progressData.etaMs ?? cur.etaMs,
            status: 'running',
          });
          return next;
        });
      }
    }

    if (progressData.type === 'scan_done' && progressData.jobId) {
      const pid = resolvePid(progressData.jobId);
      if (pid) {
        setAiScansByPath(prev => {
          const next = new Map(prev);
          const cur = next.get(pid);
          if (cur) {
            next.set(pid, {
              ...cur,
              total: progressData.total ?? cur.total,
              done: progressData.done ?? cur.done,
              errors: progressData.errors ?? cur.errors,
              // 'error': el escaneo se paro por un fallo fuera de un archivo
              // concreto; antes se quedaba pintado como "escaneando" para siempre.
              status: progressData.estado === 'cancelled' ? 'cancelled' : progressData.estado === 'error' ? 'error' : 'done',
              errorMessage: progressData.estado === 'error' ? (progressData.status || 'El escaneo se ha parado') : cur.errorMessage,
              currentFile: undefined,
              totalMs: progressData.elapsedMs ?? cur.totalMs,
              avgMsPerFile: progressData.avgMsPerFile ?? cur.avgMsPerFile,
              degraded: progressData.degraded ?? cur.degraded,
              escriturasFallidas: progressData.escriturasFallidas ?? cur.escriturasFallidas,
              causaPrincipal: progressData.causaPrincipal ?? cur.causaPrincipal,
            });
          }
          return next;
        });
      }
    }

    // Bucle batch — pre-popular jobId↔pathId al arrancar, actualizar contador
    if (progressData.type === 'batch_scan_start') {
      const items = (progressData as any).items;
      if (Array.isArray(items)) {
        for (const it of items) {
          if (it.jobId && it.pathId) jobIdToPathIdRef.current.set(it.jobId, it.pathId);
        }
      }
      setBatchScan({
        running: true,
        total: (progressData as any).total || 0,
        processed: 0,
        force: !!(progressData as any).force,
      });
    }
    if (progressData.type === 'batch_scan_progress') {
      const idx = (progressData as any).index;
      setBatchScan(prev => prev ? { ...prev, processed: typeof idx === 'number' ? idx : prev.processed } : prev);
    }
    if (progressData.type === 'batch_scan_done') {
      setBatchScan(null);
      setBatchSummary({
        processed: (progressData as any).processed ?? 0,
        total: (progressData as any).total ?? 0,
        elapsedMs: progressData.elapsedMs ?? 0,
        aborted: !!(progressData as any).aborted,
      });
    }

    if (progressData.type === 'scan_error' && progressData.jobId) {
      const pid = resolvePid(progressData.jobId);
      if (pid) {
        setAiScansByPath(prev => {
          const next = new Map(prev);
          const cur = next.get(pid);
          if (cur) {
            next.set(pid, {
              ...cur,
              errors: progressData.errors ?? cur.errors,
              currentFile: progressData.file,
            });
          }
          return next;
        });
      }
    }

    // Refrescar la cobertura cuando termina algo que la cambia. En scan_done el
    // post-sync del backend corre DESPUES de emitir el evento: se da margen.
    if (progressData.type === 'scan_done') {
      setTimeout(() => { loadPaths(); }, 1200);
    } else if (progressData.type === 'batch_scan_done' || progressData.type === 'sync_complete') {
      loadPaths();
    }
  }, [progressData]);

  // Autolimpiar el resumen del batch tras unos segundos.
  useEffect(() => {
    if (!batchSummary) return;
    const t = setTimeout(() => setBatchSummary(null), 12000);
    return () => clearTimeout(t);
  }, [batchSummary]);

  const loadPaths = async () => {
    try {
      const response = await api.getScanPaths();
      if (response.success && response.data) {
        setPaths(response.data.map((path: any) => ({
          ...path,
          lastScan: path.lastScan ? new Date(path.lastScan) : null
        })));
      }
    } catch (error) {
      console.error('Error cargando rutas:', error);
      toast.error('No se pudieron cargar las rutas');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddPath = async () => {
    if (!newPath.trim()) return;
    setMismoDisco(null);
    try {
      const response = await api.addScanPath(newPath.trim());
      if (response.success && response.data) {
        setNewPath('');
        setShowAddPath(false);
        // Se vincula y se sincroniza sola: ya no hay que hacer tres pasos.
        toast.success('Ruta añadida. Sincronizando su contenido…');
        loadPaths();
      }
    } catch (error: any) {
      // Es el disco de una biblioteca que ya existe, con otra letra: lo que
      // toca es cambiar la ubicacion de esa, no añadir otra.
      if (error?.data?.mismoDisco) {
        setMismoDisco(error.data.mismoDisco as MismoDisco);
        return;
      }
      toast.error(error?.message || 'No se pudo añadir la ruta. Comprueba que existe.');
    }
  };

  /** Lleva una biblioteca a otra ruta conservando todo lo suyo. */
  const cambiarUbicacion = async (pathId: string, nuevaRuta: string) => {
    const ruta = nuevaRuta.trim();
    if (!ruta) return;
    setGuardandoUbicacion(true);
    try {
      const r: any = await api.cambiarUbicacionRuta(pathId, ruta);
      if (r.success) {
        setUbicacion(null);
        setMismoDisco(null);
        setShowAddPath(false);
        setNewPath('');
        const n = r.movido?.archivos;
        toast.success(n
          ? `Ubicación cambiada. ${miles(n)} archivos siguen con sus favoritos, notas y colecciones. Sincronizando…`
          : 'Ubicación cambiada. Sincronizando…');
        loadPaths();
      }
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo cambiar la ubicación');
    } finally {
      setGuardandoUbicacion(false);
    }
  };

  /** Letras cruzadas: pone cada disco en su sitio (la que ocupa sale primero). */
  const recolocar = async (pathId: string) => {
    setRecolocando(pathId);
    try {
      const r = await api.recolocarRuta(pathId);
      if (r.success && r.data) {
        const partes = r.data.movimientos.map(m => `«${m.nombre}» → ${m.a}`);
        toast.success(`Cada disco en su sitio: ${partes.join(' · ')}. Sincronizando…`);
        loadPaths();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo poner cada disco en su sitio');
      // Lo que queda (p. ej. dos discos que se han cambiado la letra el uno por
      // el otro) se arregla en Windows: se abre el paso a paso.
      setTutorialAbierto(prev => ({ ...prev, [pathId]: true }));
    } finally {
      setRecolocando(null);
    }
  };

  /**
   * Tras cambiar las letras en Windows: vuelve a mirar donde esta el disco de
   * cada biblioteca (sin reiniciar) y dice si ya los encuentra.
   */
  const comprobarDiscos = async (discos: DiscoAFijar[]) => {
    const ids = [...new Set(discos.flatMap(d => d.bibliotecas))];
    setComprobandoDiscos(true);
    try {
      // Una a una: si no hay disco en su ruta, la respuesta es un "error" que
      // trae la ruta nueva; aqui solo importa que se ha vuelto a mirar.
      for (const id of ids) await api.syncPath(id).catch(() => null);
      const r = await api.getScanPaths();
      const ahora: ScanPath[] = r.success && r.data ? r.data : [];
      const siguen = [...new Map(ids.flatMap(id => discosDeLaTarjeta(ahora, id)).map(d => [d.letraAhora, d])).values()];
      if (siguen.length > 0) {
        toast(`Todavía no ha cambiado: ${siguen.map(d => `${d.etiqueta ? `«${d.etiqueta}»` : 'el disco'} sigue en ${d.letraAhora}`).join(' y ')}. Si ya le has cambiado la letra, espera unos segundos y vuelve a comprobar.`, { icon: '⚠️', duration: 8000 });
      } else if (ahora.some(p => ids.includes(p.id) && p.sugerencia)) {
        toast.success('Discos encontrados en su letra nueva. Pulsa «Usar esa ubicación» en cada biblioteca.', { duration: 6000 });
      } else {
        toast.success('Comprobado.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo comprobar dónde están los discos');
    } finally {
      setComprobandoDiscos(false);
      loadPaths();
    }
  };

  /** Le pone a la biblioteca el nombre de su disco para distinguirla de otra que se llama igual. */
  const renombrarConDisco = async (p: ScanPath) => {
    const etiqueta = p.disco?.etiqueta;
    if (!etiqueta) return;
    const base = (p.displayName || p.path).split(' · ')[0];
    try {
      const r = await api.renombrarRuta(p.id, `${base} · ${etiqueta}`);
      if (r.success) { toast.success('Nombre cambiado'); loadPaths(); }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cambiar el nombre');
    }
  };

  const handleSyncPath = async (pathId: string) => {
    setScanningPaths(prev => new Set([...prev, pathId]));
    try {
      setPaths(prev => prev.map(p => p.id === pathId ? { ...p, status: 'scanning', errorMessage: undefined } : p));
      const response: any = await api.syncPath(pathId);
      if (response.success) {
        // Lectura incompleta (una carpeta sin permiso...): se sincroniza igual,
        // pero se dice.
        if (response.aviso) toast(response.aviso, { icon: '⚠️', duration: 8000 });
        else toast.success(`Sincronizada: ${miles(response.fileCount || 0)} archivos`);
        const r = response.reenlazados;
        if (r?.archivos) toast.success(`${miles(r.archivos)} archivos movidos reconocidos: conservan favoritos, notas y colecciones.`);
      }
      loadPaths();
    } catch (error: any) {
      // Su disco no esta en esa ruta pero si en otra letra: no es un fallo, la
      // tarjeta ya propone «Usar esa ubicación».
      if (error?.data?.sugerencia) {
        toast(`${error.message} Mira la propuesta en su tarjeta.`, { icon: '💽', duration: 6000 });
        loadPaths();
        return;
      }
      setPaths(prev => prev.map(p =>
        p.id === pathId ? { ...p, status: 'error', errorMessage: error?.message || 'No se pudo sincronizar. Comprueba que la ruta existe.' } : p
      ));
      toast.error(error?.message || 'No se pudo sincronizar la ruta');
      loadPaths();
    } finally {
      setScanningPaths(prev => {
        const updated = new Set(prev);
        updated.delete(pathId);
        return updated;
      });
    }
  };

  const handleTogglePath = async (pathId: string, currentStatus: boolean) => {
    try {
      const response: any = await api.togglePath(pathId, !currentStatus);
      if (response.success) {
        // El estado lo dice el servidor (si el disco no esta, no esta), y la
        // galeria se pone al dia sola: el servidor sincroniza esa ruta.
        const d = response.data || {};
        setPaths(prev => prev.map(p =>
          p.id === pathId ? { ...p, isActive: !currentStatus, status: d.status || p.status } : p
        ));
        toast.success(currentStatus
          ? 'Ruta desvinculada: sus archivos dejan de verse. No se ha borrado nada.'
          : d.status === 'connected' ? 'Ruta vinculada. Sincronizando…' : 'Ruta vinculada. Su disco no está conectado.');
      }
    } catch {
      toast.error('No se pudo cambiar la ruta');
    }
  };

  /** Lanza el escaneo de una ruta. Lo que hace lo deciden sus interruptores. */
  const handleAiScan = async (pathId: string, force: boolean = false) => {
    const path = paths.find(p => p.id === pathId);
    if (!path) return;

    setAiScansByPath(prev => {
      const next = new Map(prev);
      next.set(pathId, { jobId: null, total: 0, done: 0, errors: 0, status: 'running' });
      return next;
    });

    try {
      const response: any = await api.startScan(path.path, force);
      if (!response.success) {
        throw new Error(response.error || 'Error iniciando escaneo');
      }
      const jobId = response.jobId;
      if (jobId) {
        // Registrar el mapeo en el ref sincronicamente: los eventos WS que
        // ya hayan llegado encuentran el path correcto.
        jobIdToPathIdRef.current.set(jobId, pathId);
        setAiScansByPath(prev => {
          const next = new Map(prev);
          const cur = next.get(pathId);
          if (cur) next.set(pathId, { ...cur, jobId });
          return next;
        });
      }
    } catch (err: any) {
      setAiScansByPath(prev => {
        const next = new Map(prev);
        next.set(pathId, {
          jobId: null, total: 0, done: 0, errors: 0,
          status: 'error',
          errorMessage: err.message || 'Error desconocido',
        });
        return next;
      });
    }
  };

  /** Llama la API y arranca el scan-all real, tras pasar por los modales de contexto. */
  const executeActualScanAll = async (force: boolean) => {
    if (batchScan?.running) return;
    try {
      const r = await api.startScanAll(force);
      if (!r.success) throw new Error((r as { error?: string }).error || 'Error iniciando escaneo masivo');
      // Cada jobId con SU ruta, tal como la devuelve el servidor. Casarlos por
      // posicion con la lista de aqui pintaba el progreso en la ruta de al lado
      // si alguna tenia todo el escaneo apagado.
      for (const it of r.items || []) {
        if (it.jobId && it.pathId) jobIdToPathIdRef.current.set(it.jobId, it.pathId);
      }
      setBatchScan({ running: true, total: r.count || (r.items || []).length, processed: 0, force });
    } catch (err: any) {
      toast.error(err.message || 'No se pudo empezar el escaneo');
    }
  };

  /** Avanza al siguiente modal de contexto en la cola; si era el último, lanza el scan. */
  const advanceScanAllQueue = () => {
    const nextIdx = scanAllQueueIdx + 1;
    if (nextIdx >= (scanAllQueue?.length ?? 0)) {
      setScanAllQueue(null);
      setScanAllQueueIdx(0);
      executeActualScanAll(scanAllForce);
    } else {
      setScanAllQueueIdx(nextIdx);
    }
  };

  /** Escaneo masivo: un modal de contexto por ruta activa y conectada, y luego el lote. */
  const handleScanAll = (force: boolean) => {
    if (batchScan?.running) return;
    const activePathsList = paths.filter(estaConectada);
    if (activePathsList.length === 0) {
      toast.error('No hay rutas conectadas que escanear');
      return;
    }
    if (force && !confirm('¿Re-escanear TODO el material de todas las rutas, también lo ya escaneado? Puede tardar muchas horas.')) return;
    setScanAllForce(force);
    setScanAllQueue(activePathsList.map(p => ({ id: p.id, path: p.path })));
    setScanAllQueueIdx(0);
  };

  const handleCancelAll = async () => {
    if (!batchScan?.running) return;
    if (!confirm('¿Detener el escaneo? Se guarda lo hecho y no se procesan las rutas restantes.')) return;
    try {
      await api.cancelScanAll();
    } catch {
      // El estado se reseteara con batch_scan_done
    }
  };

  /** Cancela el escaneo de UNA ruta: el backend guarda lo procesado hasta el corte. */
  const handleCancelScan = async (pathId: string) => {
    const scan = aiScansByPath.get(pathId);
    if (!scan || !scan.jobId || scan.status !== 'running') return;
    if (!confirm('¿Detener el escaneo de esta ruta? Lo procesado hasta ahora se guarda.')) return;
    try {
      await api.cancelScan(scan.jobId);
    } catch (err: any) {
      toast.error('No se pudo detener: ' + (err.message || 'desconocido'));
    }
  };

  const handleRemovePath = async (pathId: string) => {
    const p = paths.find(x => x.id === pathId);
    if (!confirm(`¿Quitar la ruta ${p?.path || ''}? Los archivos del disco no se tocan.`)) return;
    try {
      const response = await api.removeScanPath(pathId);
      if (response.success) {
        setPaths(prev => prev.filter(x => x.id !== pathId));
        toast.success('Ruta quitada');
      }
    } catch {
      toast.error('No se pudo quitar la ruta');
    }
  };

  // ── Interruptores ───────────────────────────────────────────────────────

  const efectivasDe = (p: ScanPath): Capacidades => {
    const base = capsGlobal || { descripcion: true, caras: true, busquedaVisual: true, movimiento: true, proxies: true };
    return { ...base, ...(p.escaneo || {}) } as Capacidades;
  };

  const cambiarGlobal = async (parcial: Partial<Capacidades>) => {
    if (!capsGlobal) return;
    const antes = capsGlobal;
    const nuevo = { ...capsGlobal, ...parcial } as Capacidades;
    setCapsGlobal(nuevo);
    try {
      const r = await api.setCapacidadesGlobal(parcial);
      if (r.data?.global) setCapsGlobal(r.data.global);
    } catch (e: any) {
      setCapsGlobal(antes);
      toast.error(e?.message || 'No se pudo guardar');
    }
  };

  /**
   * Cambiar un trabajo en UNA ruta. Si el valor nuevo coincide con el global,
   * la ruta deja de sobrescribirlo (vuelve a heredar): asi, al cambiar el
   * global mas adelante, la ruta lo sigue sin sorpresas.
   */
  const cambiarEnRuta = async (p: ScanPath, cap: CapacidadEscaneo, valor: boolean | null) => {
    const global = capsGlobal ? capsGlobal[cap] : true;
    const enviar = valor === null || valor === global ? null : valor;
    const antes = p.escaneo;
    const propio = { ...(p.escaneo || {}) };
    if (enviar === null) delete propio[cap]; else propio[cap] = enviar;
    setPaths(prev => prev.map(x => x.id === p.id ? { ...x, escaneo: propio } : x));
    try {
      await api.setEscaneoRuta(p.id, { [cap]: enviar });
    } catch (e: any) {
      setPaths(prev => prev.map(x => x.id === p.id ? { ...x, escaneo: antes } : x));
      toast.error(e?.message || 'No se pudo guardar');
    }
  };

  /** Marca o desmarca una ruta como copia de seguridad (ver copias exactas). */
  const cambiarCopiaSeguridad = async (p: ScanPath) => {
    const valor = !p.copiaSeguridad;
    setPaths(prev => prev.map(x => x.id === p.id ? { ...x, copiaSeguridad: valor } : x));
    try {
      await api.setCopiaSeguridadRuta(p.id, valor);
      toast.success(valor
        ? 'Marcada como copia de seguridad: si un archivo también está en otro disco, se ve el otro.'
        : 'Ya no es copia de seguridad: sus copias vuelven a contar como duplicados.');
    } catch (e: any) {
      setPaths(prev => prev.map(x => x.id === p.id ? { ...x, copiaSeguridad: !valor } : x));
      toast.error(e?.message || 'No se pudo guardar');
    }
  };

  const presetActivo = useMemo(() => {
    if (!capsGlobal) return null;
    return PRESETS.find(pr => ANALISIS.every(id => pr.valores[id] === capsGlobal[id]))?.id ?? null;
  }, [capsGlobal]);

  // ── Derivados ───────────────────────────────────────────────────────────

  const vlmCaido = !!vlmHealth && (!vlmHealth.ollamaRunning || !vlmHealth.modelAvailable);

  const totales = useMemo(() => {
    let archivos = 0, total = 0, descritos = 0, pendientes = 0;
    for (const p of paths) {
      archivos += p.fileCount || 0;
      if (p.isActive && typeof p.visualTotal === 'number') {
        total += p.visualTotal;
        descritos += p.visualScanned ?? 0;
        // Lo que queda con los interruptores de ahora; con un servidor viejo
        // que no lo manda, lo que falta por describir.
        pendientes += p.pendientes ?? Math.max(0, p.visualTotal - (p.visualScanned ?? 0));
      }
    }
    return { archivos, total, descritos, pendientes };
  }, [paths]);

  /** Por que no se puede escanear una ruta ahora mismo (null = si se puede). */
  const motivoSinEscaneo = (p: ScanPath): string | null => {
    if (!p.isActive) return 'Ruta desvinculada';
    if (p.status === 'disconnected') return 'El disco no está conectado';
    if (p.status === 'otro_disco') return 'En esta ruta hay otro disco';
    const ef = efectivasDe(p);
    if (!IDS.some(id => ef[id])) return 'Todo el escaneo está apagado en esta ruta';
    if (ef.descripcion && vlmCaido) {
      return !vlmHealth?.ollamaRunning
        ? 'Ollama no responde. Arráncalo o apaga las descripciones'
        : `Falta el modelo: ollama pull ${vlmHealth?.model}`;
    }
    if (aiScansByPath.get(p.id)?.status === 'running') return 'Ya se está escaneando';
    if (batchScan?.running) return 'Hay un escaneo de todas las rutas en marcha';
    return null;
  };

  const puedeEscanearTodo = !batchScan?.running
    && paths.some(p => estaConectada(p) && !motivoSinEscaneo(p));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 text-lavanda animate-spin" />
        <span className="ml-3 text-niebla">Cargando rutas...</span>
      </div>
    );
  }

  const pctGlobal = totales.total > 0 ? Math.round((totales.descritos / totales.total) * 100) : 0;
  const catalogoPorId = new Map(catalogo.map(c => [c.id, c]));

  return (
    <div className="pb-10">
      {/* ── Cabecera ───────────────────────────────────────────────────── */}
      <header className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <h1 className="text-[1.7rem] font-bold text-marfil leading-none">Rutas y escaneo</h1>
          <p className="mt-2 text-sm text-niebla">
            {paths.length === 1 ? '1 biblioteca' : `${paths.length} bibliotecas`}
            {' · '}{miles(totales.archivos)} archivos
            {totales.total > 0 && <> · <span className="text-marfil">{pctGlobal} %</span> descrito</>}
          </p>
        </div>
        {!showAddPath && (
          <button onClick={() => setShowAddPath(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-lavanda text-noche hover:bg-lavanda-claro transition-colors">
            <Plus className="w-4 h-4" />
            Añadir ruta
          </button>
        )}
      </header>

      {showAddPath && (
        <form
          onSubmit={(e) => { e.preventDefault(); handleAddPath(); }}
          className="mb-8 flex items-center gap-2 flex-wrap"
        >
          <FolderOpen className="w-5 h-5 text-lavanda shrink-0" />
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="Ruta de la carpeta, p. ej. D:\Fotos"
            className="flex-1 min-w-[14rem] px-4 py-2 rounded-full bg-tinta border border-pizarra text-marfil placeholder:text-humo focus:outline-none focus:ring-2 focus:ring-lavanda"
            autoFocus
          />
          <button type="submit" disabled={!newPath.trim()} className="px-4 py-2 rounded-full text-sm font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-40 transition-colors">
            Añadir
          </button>
          <button type="button" onClick={() => { setShowAddPath(false); setNewPath(''); setMismoDisco(null); }} className="p-2 rounded-full text-humo hover:text-marfil" aria-label="Cancelar">
            <X className="w-4 h-4" />
          </button>
        </form>
      )}

      {/* La carpeta es el disco de una biblioteca que ya existe, con otra letra:
          lo que toca es moverla, no añadir otra (22/09/2026: E:\(1) WORKS). */}
      {mismoDisco && (
        <div role="alert" className="mb-8 -mt-4 flex items-start gap-3 flex-wrap rounded-xl border border-lavanda/30 bg-lavanda/10 px-4 py-3">
          <HardDrive className="w-4 h-4 mt-0.5 text-lavanda shrink-0" />
          <div className="flex-1 min-w-[14rem]">
            <p className="text-[13px] text-marfil">Ese disco ya está añadido como «{mismoDisco.nombre}».</p>
            <p className="text-[12px] text-niebla break-all">
              Estaba en <span className="font-mono">{mismoDisco.ruta}</span> y ahora está en <span className="font-mono text-marfil">{mismoDisco.nuevaRuta}</span>.
            </p>
            <p className="mt-1 text-[12px] text-niebla">Cambia su ubicación y conservará sus favoritos, notas y colecciones; añadirlo otra vez los dejaría en la ruta vieja.</p>
          </div>
          <button
            onClick={() => cambiarUbicacion(mismoDisco.id, mismoDisco.nuevaRuta)}
            disabled={guardandoUbicacion}
            className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-50 transition-colors"
          >
            Cambiar su ubicación
          </button>
          <button onClick={() => setMismoDisco(null)} className="p-1 rounded-full text-humo hover:text-marfil" aria-label="Cerrar aviso">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Lo que queda por hacer / lo que esta pasando ────────────────── */}
      <section aria-label="Estado del escaneo" className="mb-10 flex items-stretch gap-4">
        <div aria-hidden="true" className="w-px shrink-0 bg-gradient-to-b from-lavanda/70 via-lavanda-archivo/40 to-transparent" />
        <div className="flex-1 flex items-center justify-between gap-4 flex-wrap py-1">
          {batchScan?.running ? (
            <>
              <div className="flex items-center gap-3">
                <RefreshCw className="w-4 h-4 text-lavanda animate-spin" />
                <div>
                  <p className="text-[15px] text-marfil">
                    {batchScan.force ? 'Re-escaneando' : 'Escaneando'} la ruta {Math.min(batchScan.processed + 1, batchScan.total)} de {batchScan.total}
                  </p>
                  <p className="text-[12px] text-humo">Puedes seguir usando la aplicación. Lo hecho se guarda sobre la marcha.</p>
                </div>
              </div>
              <button onClick={handleCancelAll} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-grafito text-niebla hover:text-marfil hover:bg-pizarra transition-colors">
                <Square className="w-3 h-3" fill="currentColor" />
                Detener
              </button>
            </>
          ) : batchSummary ? (
            <div className="flex items-center gap-3">
              <Check className="w-4 h-4 text-salvia" />
              <p className="text-[15px] text-marfil">
                {batchSummary.aborted ? 'Escaneo detenido' : 'Escaneo terminado'}
                <span className="text-niebla"> · {batchSummary.processed} de {batchSummary.total} rutas{batchSummary.elapsedMs > 0 ? ` en ${fmtDuration(batchSummary.elapsedMs)}` : ''}</span>
              </p>
            </div>
          ) : totales.pendientes > 0 ? (
            <>
              <div>
                <p className="text-[15px] text-marfil">
                  <span className="font-semibold">{miles(totales.pendientes)}</span> {totales.pendientes === 1 ? 'archivo por escanear' : 'archivos por escanear'}
                </p>
                <p className="text-[12px] text-humo">
                  {capsGlobal && !capsGlobal.descripcion
                    ? 'Les falta algo de lo que tienes encendido. Las descripciones están apagadas: se hará solo lo demás.'
                    : 'Les falta algo de lo que tienes encendido. Sin descripción no aparecen en la búsqueda por lenguaje natural.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleScanAll(true)}
                  disabled={!puedeEscanearTodo}
                  className="whitespace-nowrap px-3 py-1.5 rounded-full text-xs text-humo hover:text-marfil hover:bg-grafito disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Vuelve a escanear todo, también lo ya escaneado"
                >
                  Re-escanear todo
                </button>
                <button
                  onClick={() => handleScanAll(false)}
                  disabled={!puedeEscanearTodo}
                  className="whitespace-nowrap inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:bg-pizarra disabled:text-humo disabled:cursor-not-allowed transition-colors"
                  title={puedeEscanearTodo ? 'Escanear lo pendiente en todas las rutas conectadas' : 'Ahora mismo no hay ninguna ruta que se pueda escanear'}
                >
                  <Sparkles className="w-4 h-4" />
                  Escanear lo pendiente
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Check className="w-4 h-4 text-salvia" />
                <p className="text-[15px] text-marfil">Todo lo conectado está escaneado</p>
              </div>
              <button
                onClick={() => handleScanAll(false)}
                disabled={!puedeEscanearTodo}
                className="px-3 py-1.5 rounded-full text-xs text-humo hover:text-marfil hover:bg-grafito disabled:opacity-40 transition-colors"
                title="Completa los trabajos encendidos que les falten a los archivos (caras, búsqueda visual...)"
              >
                Completar lo que falte
              </button>
            </>
          )}
        </div>
      </section>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
        {/* ── Bibliotecas ────────────────────────────────────────────────── */}
        <section aria-label="Bibliotecas" className="min-w-0">
          <div className="flex items-baseline justify-between gap-4 mb-3">
            <h2 className="text-[15px] font-semibold text-marfil">Bibliotecas</h2>
            <span className="text-[11px] text-humo">Se sincronizan solas al arrancar y cuando cambia algo en el disco</span>
          </div>

          {paths.length === 0 ? (
            <div className="py-12 text-center border-y border-borde-sutil">
              <FolderOpen className="w-10 h-10 text-lavanda-archivo mx-auto mb-3" />
              <p className="text-niebla">Todavía no hay rutas</p>
              <p className="text-sm text-humo mt-1">Añade la carpeta de un disco para empezar</p>
            </div>
          ) : (
            <ul className="border-y border-borde-sutil divide-y divide-borde-sutil">
              {paths.map((path) => {
                const scan = aiScansByPath.get(path.id);
                const abierta = expandedPaths.has(path.id);
                const conectada = estaConectada(path);
                const total = path.visualTotal ?? 0;
                const descritos = path.visualScanned ?? 0;
                const pct = total > 0 ? Math.round((descritos / total) * 100) : 0;
                const porEscanear = path.pendientes ?? Math.max(0, total - descritos);
                const motivo = motivoSinEscaneo(path);
                const ef = efectivasDe(path);
                const propias = IDS.filter(id => path.escaneo && typeof path.escaneo[id] === 'boolean');
                const nombre = path.displayName && path.displayName !== path.path ? path.displayName : path.path;
                const punto = !path.isActive ? 'bg-humo/50'
                  : path.status === 'error' || path.status === 'otro_disco' ? 'bg-estado-error'
                  : path.status === 'disconnected' ? 'bg-melocoton'
                  : 'bg-salvia';
                // Lo que dijo la ultima sincronizacion (lectura incompleta, otro
                // disco...). Antes el servidor lo guardaba y no se enseñaba.
                const avisoServidor = path.isActive && path.lastError && path.status !== 'disconnected' ? path.lastError : null;
                const editandoUbicacion = ubicacion?.id === path.id;
                const discosTutorial = path.isActive && path.sugerencia ? discosDeLaTarjeta(paths, path.id) : [];
                const cruzadas = path.sugerencia?.ocupadaPor?.mismoDisco === false;

                return (
                  <li key={path.id} className={`py-5 ${path.isActive ? '' : 'opacity-60 hover:opacity-100 transition-opacity'}`}>
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => toggleSubfolders(path.id, path.path, conectada)}
                        className="mt-0.5 p-1 rounded-md text-humo hover:text-marfil hover:bg-grafito transition-colors"
                        title={abierta ? 'Plegar' : 'Qué se escanea aquí y subcarpetas'}
                        aria-expanded={abierta}
                      >
                        <ChevronRight className={`w-4 h-4 transition-transform duration-200 ${abierta ? 'rotate-90' : ''}`} />
                      </button>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${punto} ${path.status === 'scanning' ? 'animate-pulse' : ''}`} aria-hidden="true" />
                          <h3 className="text-[15px] font-semibold text-marfil truncate" title={path.path}>{nombre}</h3>
                          {!path.isActive && <span className="px-2 py-0.5 rounded-full text-[10px] bg-grafito text-humo">desvinculada</span>}
                          {path.copiaSeguridad && (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-lavanda/10 text-lavanda" title="Si un archivo también está en otro disco, se ve el otro">
                              <ShieldCheck className="w-3 h-3" />
                              copia de seguridad
                            </span>
                          )}
                          {path.isActive && path.status === 'disconnected' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] bg-melocoton/15 text-melocoton">disco no conectado</span>
                          )}
                          {path.isActive && path.status === 'otro_disco' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] bg-estado-error/15 text-estado-error">otro disco en esta ruta</span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] text-humo truncate">
                          <span className="font-mono">{path.path}</span>
                          {path.disco && (path.disco.etiqueta || path.disco.capacidad) && (
                            <span title="El disco de esta biblioteca (se reconoce por su número de serie, no por la letra)">
                              {' · disco '}{path.disco.etiqueta ? `«${path.disco.etiqueta}»` : ''}
                              {path.disco.etiqueta && path.disco.capacidad ? ' de ' : ''}
                              {path.disco.capacidad ? capacidadTexto(path.disco.capacidad) : ''}
                            </span>
                          )}
                          {' · '}{path.status === 'scanning' ? 'sincronizando…' : path.lastScan ? `sincronizada ${haceCuanto(path.lastScan)}` : 'sin sincronizar'}
                        </p>
                        {/* Dos bibliotecas que se llaman igual: se confunden. */}
                        {paths.filter(q => q.id !== path.id && nombreNorm(q) === nombreNorm(path)).length > 0 && (
                          <div className="mt-2 text-[11px] text-humo leading-snug">
                            Hay otra biblioteca que se llama igual.
                            {path.disco?.etiqueta ? (
                              <>
                                {' '}Puedes ponerle el nombre de su disco:{' '}
                                <button
                                  onClick={() => renombrarConDisco(path)}
                                  className="text-lavanda underline underline-offset-2 hover:text-lavanda-claro"
                                >
                                  llamarla «{(path.displayName || path.path).split(' · ')[0]} · {path.disco.etiqueta}»
                                </button>.
                              </>
                            ) : null}
                            {(!path.disco?.etiqueta || paths.some(q => q.id !== path.id && q.disco?.etiqueta && q.disco.etiqueta === path.disco?.etiqueta)) && (
                              <>
                                {' '}Si los discos también se llaman igual (o no tienen nombre), puedes cambiarle el nombre al disco en Windows:
                                Explorador → clic derecho en la unidad → «Cambiar nombre», o Administración de discos → clic derecho → «Propiedades».
                                Pensadero no lo pierde: lo reconoce por su número de serie.
                              </>
                            )}
                          </div>
                        )}

                        {conectada && total > 0 ? (
                          <div className="mt-3 flex items-center gap-3 flex-wrap">
                            <div className="h-1 w-40 max-w-full rounded-full bg-pizarra overflow-hidden">
                              <div className={`h-full rounded-full ${pct === 100 ? 'bg-salvia' : 'bg-lavanda'}`} style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-[12px] text-niebla tabular-nums">
                              {pct} % descrito
                              {porEscanear > 0 && <span className="text-humo"> · {miles(porEscanear)} por escanear</span>}
                            </span>
                          </div>
                        ) : path.isActive && path.status === 'disconnected' && !path.sugerencia ? (
                          <p className="mt-2 text-[12px] text-humo">Conecta el disco y se sincroniza solo: lo ya descrito vuelve sin re-escanear. Si al conectarlo tiene otra letra, usa «Cambiar ubicación».</p>
                        ) : null}

                        {/* El disco de esta biblioteca esta en otra letra. Se
                            propone, no se hace solo: la decision es tuya. */}
                        {path.isActive && path.sugerencia && (
                          <div className="mt-3 flex items-start gap-3 flex-wrap rounded-xl border border-lavanda/30 bg-lavanda/10 px-3 py-2.5">
                            <HardDrive className="w-4 h-4 mt-0.5 text-lavanda shrink-0" />
                            {path.sugerencia.ocupadaPor && path.sugerencia.ocupadaPor.mismoDisco === false ? (
                              // Letras cruzadas: dos discos distintos. Antes decia
                              // "son el mismo disco: quita una", y no lo eran.
                              <>
                                <p className="flex-1 min-w-[12rem] text-[12px] text-niebla">
                                  Este disco está ahora en <span className="font-mono text-marfil">{path.sugerencia.ruta}</span>, pero esa ruta la tiene «{path.sugerencia.ocupadaPor.nombre}», que es <b className="text-marfil font-medium">otro disco</b>
                                  {path.sugerencia.ocupadaPor.suDisco
                                    ? <> (ahora en <span className="font-mono text-marfil">{path.sugerencia.ocupadaPor.suDisco}</span>). Windows les ha cruzado las letras: no quites ninguna.</>
                                    : <> y ahora no está conectado. Conéctalo también y podrás poner cada uno en su sitio con un clic. No quites ninguna.</>}
                                </p>
                                {path.sugerencia.ocupadaPor.suDisco && (
                                  <button
                                    onClick={() => recolocar(path.id)}
                                    disabled={recolocando !== null}
                                    className="px-3 py-1 rounded-full text-xs font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-50 transition-colors"
                                  >
                                    {recolocando === path.id ? 'Colocando…' : 'Poner cada disco en su sitio'}
                                  </button>
                                )}
                              </>
                            ) : path.sugerencia.ocupadaPor ? (
                              <p className="flex-1 min-w-[12rem] text-[12px] text-niebla">
                                Este disco está ahora en <span className="font-mono text-marfil">{path.sugerencia.ruta}</span>, pero esa carpeta ya está añadida como «{path.sugerencia.ocupadaPor.nombre}». Son el mismo disco: quita una de las dos.
                              </p>
                            ) : (
                              <>
                                <p className="flex-1 min-w-[12rem] text-[12px] text-niebla">
                                  Este disco está ahora en <span className="font-mono text-marfil">{path.sugerencia.ruta}</span>.
                                </p>
                                <button
                                  onClick={() => cambiarUbicacion(path.id, path.sugerencia!.ruta)}
                                  disabled={guardandoUbicacion}
                                  className="px-3 py-1 rounded-full text-xs font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-50 transition-colors"
                                >
                                  Usar esa ubicación
                                </button>
                              </>
                            )}
                            {/* Que no vuelva a pasar: letra fija en Windows, paso a paso. */}
                            <TutorialLetraFija
                              discos={discosTutorial}
                              abierto={tutorialAbierto[path.id] ?? cruzadas}
                              onAlternar={() => setTutorialAbierto(prev => ({ ...prev, [path.id]: !(prev[path.id] ?? cruzadas) }))}
                              onComprobar={() => comprobarDiscos(discosTutorial)}
                              comprobando={comprobandoDiscos}
                            />
                          </div>
                        )}

                        {avisoServidor && (
                          <p className={`mt-2 text-[12px] ${path.status === 'otro_disco' ? 'text-estado-error' : 'text-melocoton'}`}>{avisoServidor}</p>
                        )}

                        {editandoUbicacion && (
                          <form
                            onSubmit={(e) => { e.preventDefault(); cambiarUbicacion(path.id, ubicacion!.valor); }}
                            className="mt-3 flex items-center gap-2 flex-wrap"
                          >
                            <input
                              type="text"
                              value={ubicacion!.valor}
                              onChange={(e) => setUbicacion({ id: path.id, valor: e.target.value })}
                              aria-label={`Nueva ubicación de ${nombre}`}
                              className="flex-1 min-w-[12rem] px-3 py-1.5 rounded-full bg-tinta border border-pizarra text-[13px] text-marfil font-mono focus:outline-none focus:ring-2 focus:ring-lavanda"
                              autoFocus
                            />
                            <button type="submit" disabled={guardandoUbicacion || !ubicacion!.valor.trim()} className="px-3 py-1.5 rounded-full text-xs font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-40 transition-colors">
                              Cambiar
                            </button>
                            <button type="button" onClick={() => setUbicacion(null)} className="p-1.5 rounded-full text-humo hover:text-marfil" aria-label="Cancelar">
                              <X className="w-4 h-4" />
                            </button>
                            <p className="basis-full text-[11px] text-humo">La misma carpeta en su nueva letra. Se conservan favoritos, notas, colecciones y lo ya escaneado.</p>
                          </form>
                        )}

                        {propias.length > 0 && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            {propias.map(id => (
                              <span key={id} className={`px-2 py-0.5 rounded-full text-[11px] ${ef[id] ? 'bg-lavanda/10 text-lavanda' : 'bg-grafito text-niebla'}`}>
                                {ef[id] ? 'con' : 'sin'} {(catalogoPorId.get(id)?.nombre || id).toLowerCase()}
                              </span>
                            ))}
                          </div>
                        )}

                        {path.errorMessage && (
                          <p className="mt-2 text-[12px] text-estado-error">{path.errorMessage}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <div className="hidden sm:block text-right mr-3">
                          <div className="text-[15px] font-semibold text-marfil tabular-nums leading-tight">{miles(path.fileCount || 0)}</div>
                          <div className="text-[11px] text-humo">archivos</div>
                        </div>
                        {scan?.status === 'running' ? (
                          <button
                            onClick={() => handleCancelScan(path.id)}
                            disabled={!scan.jobId}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-grafito text-niebla hover:text-marfil hover:bg-pizarra transition-colors"
                          >
                            <Square className="w-3 h-3" fill="currentColor" />
                            Detener
                          </button>
                        ) : (
                          <button
                            onClick={() => { setContextModalForce(false); setContextModalPathId(path.id); }}
                            disabled={!!motivo}
                            title={motivo || 'Escanear lo pendiente de esta ruta con los trabajos encendidos'}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-lavanda/15 text-lavanda hover:bg-lavanda hover:text-noche disabled:bg-transparent disabled:text-humo disabled:cursor-not-allowed transition-colors"
                          >
                            <Sparkles className="w-3.5 h-3.5" />
                            Escanear
                          </button>
                        )}
                        <button
                          onClick={() => handleSyncPath(path.id)}
                          disabled={scanningPaths.has(path.id) || !path.isActive}
                          className="p-2 rounded-full text-humo hover:text-marfil hover:bg-grafito disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          title="Sincronizar: buscar archivos nuevos, movidos o borrados"
                          aria-label="Sincronizar"
                        >
                          <RefreshCw className={`w-4 h-4 ${scanningPaths.has(path.id) ? 'animate-spin' : ''}`} />
                        </button>
                        <MenuRuta
                          path={path}
                          puedeReescanear={!motivo}
                          onReescanear={() => { setContextModalForce(true); setContextModalPathId(path.id); }}
                          onRenombrar={() => setRenameModalPathId(path.id)}
                          onUbicacion={() => setUbicacion({ id: path.id, valor: path.sugerencia?.ruta || path.path })}
                          onVincular={() => handleTogglePath(path.id, path.isActive)}
                          onCopiaSeguridad={() => cambiarCopiaSeguridad(path)}
                          onQuitar={() => handleRemovePath(path.id)}
                        />
                      </div>
                    </div>

                    {/* Escaneo en curso o recien terminado de esta ruta */}
                    {scan && scan.status !== 'idle' && (
                      <ProgresoRuta scan={scan} onCerrar={() => setAiScansByPath(prev => { const n = new Map(prev); n.delete(path.id); return n; })} />
                    )}

                    {/* Desplegado: que se escanea aqui y subcarpetas */}
                    {abierta && (
                      <div className="mt-5 ml-9 flex flex-col gap-7">
                        <div>
                          <h4 className="font-mono text-[10px] tracking-wider uppercase text-humo mb-3">Qué se escanea aquí</h4>
                          <ul className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
                            {catalogo.map(c => {
                              const propia = !!path.escaneo && typeof path.escaneo[c.id] === 'boolean';
                              return (
                                <li key={c.id} className="flex items-center gap-3">
                                  <Interruptor
                                    pequeno
                                    encendido={ef[c.id]}
                                    onCambiar={(v) => cambiarEnRuta(path, c.id, v)}
                                    etiqueta={`${c.nombre} en ${nombre}`}
                                  />
                                  <span className={`text-[13px] ${ef[c.id] ? 'text-marfil' : 'text-humo'}`}>{c.nombre}</span>
                                  {propia ? (
                                    <button
                                      onClick={() => cambiarEnRuta(path, c.id, null)}
                                      className="ml-auto inline-flex items-center gap-1 text-[11px] text-lavanda hover:text-lavanda-claro"
                                      title="Volver a lo que diga el ajuste general"
                                    >
                                      <RotateCcw className="w-3 h-3" />
                                      solo aquí
                                    </button>
                                  ) : (
                                    <span className="ml-auto text-[11px] text-humo">como todas</span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>

                        <div className="min-w-0">
                          <h4 className="font-mono text-[10px] tracking-wider uppercase text-humo mb-3">Subcarpetas</h4>
                          {!conectada ? (
                            <p className="text-[12px] text-humo">No se pueden leer con el disco desconectado.</p>
                          ) : loadingSubfolders.has(path.id) ? (
                            <p className="flex items-center gap-2 text-[12px] text-humo">
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              Leyendo…
                            </p>
                          ) : (subfolders.get(path.id) || []).length === 0 ? (
                            <p className="text-[12px] text-humo">Sin subcarpetas con archivos propios.</p>
                          ) : (
                            <ul className="max-h-96 overflow-y-auto -mx-2 pr-1">
                              {(subfolders.get(path.id) || []).map((sf) => {
                                // Lo que falta con los interruptores de ahora (con las caras
                                // encendidas despues, una carpeta descrita al 100 % tambien
                                // tiene trabajo). Servidor viejo: lo que falta por describir.
                                const pendientes = sf.pendientes ?? Math.max(0, sf.visualTotal - sf.visualScanned);
                                const pctSf = sf.visualTotal > 0 ? Math.round((sf.visualScanned / sf.visualTotal) * 100) : 0;
                                return (
                                  <li key={sf.dir} className="group flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-grafito/60 transition-colors">
                                    <Folder className="w-3.5 h-3.5 text-lavanda-archivo shrink-0" />
                                    <div className="min-w-0 flex-1">
                                      <p className="text-[13px] text-niebla truncate" title={sf.dir}>{sf.folderName || sf.relPath}</p>
                                      <p className="text-[11px] text-humo">
                                        {sf.videoCount > 0 && `${sf.videoCount} vídeo${sf.videoCount === 1 ? '' : 's'}`}
                                        {sf.videoCount > 0 && sf.imageCount > 0 && ' · '}
                                        {sf.imageCount > 0 && `${sf.imageCount} foto${sf.imageCount === 1 ? '' : 's'}`}
                                        {sf.hasContext && ' · con contexto'}
                                      </p>
                                    </div>
                                    <span className={`text-[11px] tabular-nums ${pctSf === 100 ? 'text-salvia' : 'text-humo'}`}>{pctSf} %</span>
                                    <button
                                      onClick={() => handleScanSubfolder(sf.dir, false)}
                                      disabled={!!motivo || pendientes === 0}
                                      className="px-2 py-0.5 rounded-full text-[11px] text-lavanda hover:bg-lavanda hover:text-noche disabled:text-humo disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
                                      title={motivo || (pendientes > 1 ? `Escanear los ${pendientes} pendientes` : pendientes === 1 ? 'Escanear el que falta' : 'No queda nada pendiente aquí')}
                                    >
                                      Escanear
                                    </button>
                                    <button
                                      onClick={() => handleScanSubfolder(sf.dir, true)}
                                      disabled={!!motivo}
                                      className="p-1 rounded-full text-humo hover:text-melocoton opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:hidden transition-all"
                                      title="Re-escanear toda la subcarpeta"
                                      aria-label="Re-escanear toda la subcarpeta"
                                    >
                                      <Zap className="w-3.5 h-3.5" />
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ── Que hace el escaneo ──────────────────────────────────────── */}
        <aside aria-label="Qué hace el escaneo" className="mt-12 lg:mt-0 lg:sticky lg:top-2 lg:self-start">
          <div className="flex items-baseline justify-between gap-4 mb-1">
            <h2 className="text-[15px] font-semibold text-marfil">Qué hace el escaneo</h2>
            <Cpu className="w-4 h-4 text-humo" aria-hidden="true" />
          </div>
          <p className="text-[12px] text-humo mb-5">
            Para todas las rutas. Cada una puede cambiarlo al desplegarla. Lo que apagues se puede completar otro día: no se repite lo ya hecho.
          </p>

          <div className="flex flex-wrap gap-1.5 mb-6" role="group" aria-label="Ajustes rápidos">
            {PRESETS.map(pr => (
              <button
                key={pr.id}
                onClick={() => cambiarGlobal(pr.valores)}
                disabled={!capsGlobal}
                aria-pressed={presetActivo === pr.id}
                title={pr.detalle}
                className={`px-3 py-1 rounded-full text-[12px] transition-colors ${
                  presetActivo === pr.id ? 'bg-lavanda text-noche font-medium' : 'bg-grafito text-niebla hover:text-marfil hover:bg-pizarra'
                }`}
              >
                {pr.nombre}
              </button>
            ))}
            {capsGlobal && !presetActivo && (
              <span className="px-3 py-1 rounded-full text-[12px] text-lavanda border border-lavanda/30">A medida</span>
            )}
          </div>

          <ul className="flex flex-col divide-y divide-borde-sutil border-y border-borde-sutil">
            {catalogo.map(c => {
              const on = capsGlobal ? capsGlobal[c.id] : true;
              return (
                <li key={c.id} className="py-4">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className={`text-[14px] font-medium ${on ? 'text-marfil' : 'text-niebla'}`}>{c.nombre}</p>
                      <p className="mt-0.5 text-[12px] leading-snug text-humo">{c.detalle}</p>
                      <div className="mt-1.5"><Coste recurso={c.recurso} coste={c.coste} /></div>
                    </div>
                    <Interruptor
                      encendido={on}
                      onCambiar={(v) => cambiarGlobal({ [c.id]: v } as Partial<Capacidades>)}
                      etiqueta={c.nombre}
                      deshabilitado={!capsGlobal}
                    />
                  </div>

                  {/* El modelo solo importa si se describe. */}
                  {c.id === 'descripcion' && on && (
                    <div className="mt-3">
                      {vlmCaido && (
                        <p className="mb-2 flex items-start gap-1.5 text-[11px] text-melocoton leading-snug">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                          {!vlmHealth?.ollamaRunning
                            ? 'Ollama no responde: sin él no se puede describir.'
                            : <>Falta el modelo. En una terminal: <span className="font-mono">ollama pull {vlmHealth?.model}</span></>}
                        </p>
                      )}
                      {availableModels.length > 0 && (() => {
                        const TIER_LABEL: Record<VlmModel['tier'], string> = {
                          produccion: 'Producción',
                          experimento: 'Experimento',
                          legacy: 'Legacy / fallback',
                          otro: 'Otros instalados',
                          no_cabe: 'No caben en esta GPU (16 GB)',
                        };
                        const TIER_ORDER: VlmModel['tier'][] = ['produccion', 'experimento', 'legacy', 'otro', 'no_cabe'];
                        const elegido = availableModels.find(m => m.name === selectedModel);
                        return (
                          <>
                            <label className="flex items-center gap-2 text-[11px] text-humo">
                              Modelo
                              <select
                                value={selectedModel}
                                onChange={async (e) => {
                                  const model = e.target.value;
                                  setSelectedModel(model);
                                  await api.setScanModel(model).catch(() => toast.error('No se pudo cambiar el modelo'));
                                }}
                                className="flex-1 min-w-0 bg-tinta border border-pizarra rounded-lg px-2 py-1 text-[12px] text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
                              >
                                {TIER_ORDER.filter(t => availableModels.some(m => m.tier === t)).map(tier => (
                                  <optgroup key={tier} label={TIER_LABEL[tier]}>
                                    {availableModels.filter(m => m.tier === tier).map(m => (
                                      <option key={m.name} value={m.name} disabled={!m.installed}>
                                        {m.label}{m.installed ? '' : ' (sin descargar)'}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            </label>
                            {elegido?.notes && <p className="mt-1.5 text-[11px] text-humo leading-snug">{elegido.notes}</p>}
                          </>
                        );
                      })()}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>
      </div>

      {/* Modal de contexto — escaneo de una ruta */}
      {contextModalPathId && (() => {
        const target = paths.find(p => p.id === contextModalPathId);
        if (!target) return null;
        return (
          <ScanContextModal
            isOpen={true}
            rootPath={target.path}
            onClose={() => setContextModalPathId(null)}
            confirmLabel={contextModalForce ? 'Re-escanear todo' : 'Lanzar escaneo'}
            onConfirm={() => {
              handleAiScan(contextModalPathId, contextModalForce);
              setContextModalPathId(null);
            }}
          />
        );
      })()}

      {/* Modal de renombrado de carpetas (display name por carpeta) */}
      {renameModalPathId && (() => {
        const target = paths.find(p => p.id === renameModalPathId);
        if (!target) return null;
        return (
          <FolderRenameModal
            isOpen={true}
            rootPath={target.path}
            onClose={() => setRenameModalPathId(null)}
            onSaved={() => onSyncComplete?.()}
          />
        );
      })()}

      {/* Modal de contexto — flujo de todas las rutas (una por vez) */}
      {scanAllQueue && scanAllQueueIdx < scanAllQueue.length && (
        <ScanContextModal
          isOpen={true}
          rootPath={scanAllQueue[scanAllQueueIdx].path}
          onClose={() => { setScanAllQueue(null); setScanAllQueueIdx(0); }}
          onConfirm={advanceScanAllQueue}
          onSkip={advanceScanAllQueue}
          onSkipAll={() => {
            setScanAllQueue(null);
            setScanAllQueueIdx(0);
            executeActualScanAll(scanAllForce);
          }}
          confirmLabel={scanAllQueueIdx === scanAllQueue.length - 1 ? 'Lanzar escaneo' : 'Siguiente ruta'}
          stepInfo={{ current: scanAllQueueIdx + 1, total: scanAllQueue.length }}
        />
      )}
    </div>
  );
}

/** Progreso de un escaneo dentro de la fila de su ruta. */
function ProgresoRuta({ scan, onCerrar }: { scan: AiScanState; onCerrar: () => void }) {
  const pct = scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : 0;
  const titulo = scan.status === 'running'
    ? (scan.total > 0 ? `Escaneando · ${miles(scan.done)} de ${miles(scan.total)}` : 'Preparando el escaneo…')
    : scan.status === 'done' ? `Escaneo terminado${scan.totalMs ? ` en ${fmtDuration(scan.totalMs)}` : ''}`
    : scan.status === 'cancelled' ? 'Escaneo detenido'
    : 'No se pudo empezar';

  return (
    <div className="mt-4 ml-9">
      <div className="flex items-center gap-3 flex-wrap">
        {scan.status === 'running'
          ? <Sparkles className="w-3.5 h-3.5 text-lavanda animate-pulse" />
          : scan.status === 'done' ? <Check className="w-3.5 h-3.5 text-salvia" />
          : <AlertTriangle className="w-3.5 h-3.5 text-melocoton" />}
        <span className="text-[13px] text-marfil">{titulo}</span>
        {scan.status === 'running' && scan.etaMs ? <span className="text-[12px] text-humo">quedan ~{fmtDuration(scan.etaMs)}</span> : null}
        {scan.status === 'running' && scan.avgMsPerFile ? <span className="text-[12px] text-humo">· {fmtDuration(scan.avgMsPerFile, true)} por archivo</span> : null}
        {scan.status === 'done' && scan.done > 0 && <span className="text-[12px] text-humo">{miles(scan.done)} archivos</span>}
        {scan.errors > 0 && <span className="text-[12px] text-estado-error">{scan.errors} con error</span>}
        {scan.status !== 'running' && (
          <button onClick={onCerrar} className="ml-auto p-1 rounded-full text-humo hover:text-marfil" aria-label="Cerrar aviso">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {scan.status === 'running' && scan.total > 0 && (
        <div className="mt-2 h-1 rounded-full bg-pizarra overflow-hidden max-w-md">
          <div className="h-full rounded-full bg-lavanda transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}
      {scan.currentFile && scan.status === 'running' && (
        <p className="mt-1.5 font-mono text-[11px] text-humo truncate">{scan.currentFile}</p>
      )}
      {/* Degradado: corre igual, pero esos campos saldran vacios. Decirlo
          mientras pasa, no meses despues. */}
      {scan.degraded && scan.degraded.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-melocoton">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          Va sin {scan.degraded.map(d => CAPACIDAD_LABEL[d] || d).join(', ')}: se pidió pero no ha arrancado. Se completará en otro escaneo cuando funcione.
        </p>
      )}
      {/* No se ha podido GUARDAR: peor que degradado, el trabajo se tira. */}
      {!!scan.escriturasFallidas && scan.escriturasFallidas > 0 && (
        <div className="mt-2 flex items-start gap-1.5 text-[12px] text-estado-error">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">No se ha podido guardar: {scan.escriturasFallidas} volcado(s) fallaron. Ese trabajo se pierde.</p>
            {scan.causaPrincipal && (
              <p className="mt-0.5 opacity-90">{scan.causaPrincipal.reason}{scan.causaPrincipal.hint ? ` ${scan.causaPrincipal.hint}` : ''}</p>
            )}
          </div>
        </div>
      )}
      {scan.errorMessage && <p className="mt-1.5 text-[12px] text-estado-error">{scan.errorMessage}</p>}
    </div>
  );
}
