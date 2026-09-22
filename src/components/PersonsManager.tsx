import React, { useEffect, useMemo, useRef, useState } from 'react';
import { User, Plus, Trash2, Upload, Star, RefreshCw, X, ArrowLeft, ImagePlus, Brain, AlertTriangle, CheckCircle, Sparkles, Search, Users, ExternalLink, Pencil, GitMerge, UserPlus, Check, Camera, Loader2 } from 'lucide-react';
import { api } from '../services/api';
import { API_CONFIG, config } from '../config';
import { useWebSocket } from '../hooks/useWebSocket';
import { slugifyPersonId } from '../utils/persons';
import Avatar from './Avatar';
import Loader from './Loader';
import PersonaAcciones from './PersonaAcciones';
import GrupoEditor from './GrupoEditor';
import { GrupoAvatares } from './GrupoChip';
import { actualizarGrupo, useGrupos } from '../hooks/useGrupos';
import { cumple, filtroDe, minimoDe, presenciaPorDia } from '../utils/grupos';
import type { GrupoPersonas } from '../types';
import toast from 'react-hot-toast';

interface Person {
  person_id: string;
  display_name: string;
  aliases: string[];
  avatar_path: string | null;
  avatar_url: string | null;
}

interface PersonPhoto {
  filename: string;
  url: string;
}

interface PersonsManagerProps {
  onBack?: () => void;
  // Galeria por persona: lista completa de mediaFiles cargados en la app y
  // callbacks para abrir el modal de archivo / filtrar la home por persona.
  mediaFiles?: import('../types').MediaFile[];
  onSelectFile?: (file: import('../types').MediaFile) => void;
  onFilterByPerson?: (personId: string) => void;
  /** Abre la linea de vida de la persona (/persona/:id/vida). */
  onVerLineaDeVida?: (personId: string) => void;
  /** Lleva a la home filtrada por el grupo. */
  onVerGrupo?: (grupoId: string) => void;
}

/**
 * Gestor de personas. Permite:
 *  - Listar las personas del registry
 *  - Crear/editar/eliminar entradas (display_name, aliases)
 *  - Subir fotos de referencia (que en el futuro alimentarán el modelo
 *    de reconocimiento facial cuando se integre)
 *  - Marcar una foto como avatar principal
 *
 * NO hace reconocimiento facial automático — eso entra en una segunda
 * iteración con InsightFace u otro modelo de embeddings faciales.
 */
export default function PersonsManager({ onBack, mediaFiles, onSelectFile, onFilterByPerson, onVerLineaDeVida, onVerGrupo }: PersonsManagerProps) {
  // Grupos ("Familia"...). editandoGrupo: null = cerrado; 'nuevo' = crear uno.
  const grupos = useGrupos();
  const [editandoGrupo, setEditandoGrupo] = useState<GrupoPersonas | 'nuevo' | null>(null);
  const [gruposIniciales, setGruposIniciales] = useState<string[]>([]);
  const [persons, setPersons] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [photos, setPhotos] = useState<PersonPhoto[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Estado del servicio de reconocimiento facial (InsightFace via Python)
  const [faceStatus, setFaceStatus] = useState<{ ready: boolean; unavailable: boolean; lastError: string | null; threshold: number; trainedPersons: number } | null>(null);
  // Entrenamiento en curso por persona
  const [trainingIds, setTrainingIds] = useState<Set<string>>(new Set());

  // Estado del job de re-identificacion retroactiva
  type ReidStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  interface ReidJob {
    jobId: string | null;
    status: ReidStatus;
    total: number;
    done: number;
    changed: number;
    skippedNoDetections: number;
    catalogsWritten: number;
    folder?: string;                      // carpeta actual (R5)
    perPerson?: Record<string, number>;   // caras nuevas por persona (R5)
    startedAt?: number;                   // para ETA (R5)
    errorMessage?: string;
  }
  const IDLE_REID_JOB: ReidJob = { jobId: null, status: 'idle', total: 0, done: 0, changed: 0, skippedNoDetections: 0, catalogsWritten: 0 };
  const [reidJob, setReidJob] = useState<ReidJob>(IDLE_REID_JOB);

  const { progressData } = useWebSocket(config.wsUrl);

  // Vista actual: gestion de personas vs. descubrimiento de caras desconocidas
  const [view, setView] = useState<'persons' | 'clusters'>('persons');
  // Token de cache-bust de avatares: se incrementa al cambiar un avatar para
  // forzar recarga (el avatar.jpg se sobrescribe en el mismo path).
  const [avatarBust, setAvatarBust] = useState(0);
  // Elegir foto de perfil: la persona cuyas caras se estan mirando.
  const [avatarPicker, setAvatarPicker] = useState<Person | null>(null);
  const [guardandoAvatar, setGuardandoAvatar] = useState<string | null>(null);
  // Fusionar persona<->persona (M5a): absorber otra persona en selectedPerson.
  const [mergePersonOpen, setMergePersonOpen] = useState(false);
  /** Persona sobre la que se decide que hacer (olvidar / ocultar / borrar sus archivos). */
  const [accionesDe, setAccionesDe] = useState<Person | null>(null);
  /** Caras olvidadas: el descubrimiento no las propone. Se pueden volver a proponer. */
  const [olvidadas, setOlvidadas] = useState(0);
  const [mergeLoserId, setMergeLoserId] = useState<string | null>(null);
  const [mergeQuery, setMergeQuery] = useState('');
  const [mergingPersons, setMergingPersons] = useState(false);
  interface FaceCluster {
    cluster_id: string;
    face_count: number;            // nº de caras (detecciones)
    file_count?: number;           // nº de archivos distintos (lo que cuenta el home)
    avg_score: number;
    dominant_age: string | null;
    dominant_gender: string | null;
    sample_count: number;
    samples_meta?: Array<{ folder: string; basename: string; det_score: number }>;
  }
  const [clusters, setClusters] = useState<FaceCluster[] | null>(null);
  const [clusterJob, setClusterJob] = useState<{
    status: 'idle' | 'running' | 'done' | 'error';
    processed: number;
    unknown: number;
    clustersFound: number;
    errorMessage?: string;
  }>({ status: 'idle', processed: 0, unknown: 0, clustersFound: 0 });

  // Modal de promote: convertir cluster en persona
  const [promotingCluster, setPromotingCluster] = useState<FaceCluster | null>(null);
  const [promoteForm, setPromoteForm] = useState({ person_id: '', display_name: '', aliases: '' });
  const [promoting, setPromoting] = useState(false);
  // Indices de samples que el usuario marca como "no es esta persona". El backend
  // recalcula el centroide solo con las muestras incluidas.
  const [excludedIndices, setExcludedIndices] = useState<Set<number>>(new Set());

  // Modo seleccion multiple para fusionar clusters duplicados (misma persona
  // dividida en varios clusters por diferencias de iluminacion/angulo/edad).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedClusterIds, setSelectedClusterIds] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);

  // Orden del grid de clusters: por numero de apariciones (default) o por
  // similitud entre centroides (clusters parecidos quedan agrupados).
  type ClusterOrderMode = 'count' | 'similarity';
  const [clusterOrderMode, setClusterOrderMode] = useState<ClusterOrderMode>('count');
  const [similarityGroups, setSimilarityGroups] = useState<{
    groups: Array<{ group_id: string; cluster_ids: string[]; max_similarity: number }>;
    ungrouped: string[];
  } | null>(null);
  const [loadingSimilarity, setLoadingSimilarity] = useState(false);

  // Form state
  const [newPersonId, setNewPersonId] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newAliases, setNewAliases] = useState('');

  // Rediseño: búsqueda y filtro del grid de personas.
  const [query, setQuery] = useState('');
  // Los filtros parten el registry por lo unico que lo parte de verdad: si la
  // persona sale o no sale en el archivo. Los de antes (Todas / Confirmadas /
  // Por entrenar) miraban 'tiene avatar', y como las 133 tenian avatar, dos de
  // los tres chips daban exactamente la misma lista y el tercero salia vacio.
  type PersonFilter = 'material' | 'vacias' | 'todas';
  const [personFilter, setPersonFilter] = useState<PersonFilter>('material');
  type PersonOrden = 'apariciones' | 'reciente' | 'nombre';
  const [orden, setOrden] = useState<PersonOrden>('apariciones');
  /** Fichas vacias marcadas para borrar en lote. */
  const [seleccionVacias, setSeleccionVacias] = useState<Set<string>>(new Set());
  const [borrandoLote, setBorrandoLote] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Numero de archivos en los que aparece cada persona, calculado client-side
  // desde mediaFiles. Una persona con varias caras en un mismo archivo cuenta 1.
  const filesPerPerson = useMemo(() => {
    const counts = new Map<string, number>();
    if (!mediaFiles) return counts;
    for (const f of mediaFiles) {
      if (!f.faces) continue;
      const ids = new Set(f.faces.map(face => face.person_id).filter(Boolean) as string[]);
      for (const id of ids) {
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    return counts;
  }, [mediaFiles]);

  // Última aparición (timestamp más reciente) y nº de sesiones (carpetas
  // distintas) por persona, derivado de mediaFiles. La carpeta es la sesión
  // en Pensadero, así que cuenta carpetas únicas donde aparece la persona.
  const personStats = useMemo(() => {
    const last = new Map<string, number>();
    const folders = new Map<string, Set<string>>();
    if (!mediaFiles) return { last, sessions: new Map<string, number>() };
    for (const f of mediaFiles) {
      if (!f.faces) continue;
      const ids = new Set(f.faces.map(face => face.person_id).filter(Boolean) as string[]);
      if (ids.size === 0) continue;
      const t = (f.extractedDate || f.modifiedAt || f.createdAt);
      const ts = t ? new Date(t).getTime() : 0;
      const folder = f.fullPath ? f.fullPath.replace(/[\\/][^\\/]*$/, '') : '';
      for (const id of ids) {
        if (ts > (last.get(id) || 0)) last.set(id, ts);
        if (folder) {
          if (!folders.has(id)) folders.set(id, new Set());
          folders.get(id)!.add(folder);
        }
      }
    }
    const sessions = new Map<string, number>();
    folders.forEach((set, id) => sessions.set(id, set.size));
    return { last, sessions };
  }, [mediaFiles]);

  // "hace X" legible a partir de un timestamp.
  function relativeTime(ts: number | undefined): string {
    if (!ts) return 'sin apariciones';
    const diff = Date.now() - ts;
    const d = Math.floor(diff / 86400000);
    if (d <= 0) return 'hoy';
    if (d === 1) return 'ayer';
    if (d < 7) return `hace ${d} días`;
    if (d < 30) { const w = Math.floor(d / 7); return `hace ${w} ${w === 1 ? 'semana' : 'semanas'}`; }
    if (d < 365) { const m = Math.floor(d / 30); return `hace ${m} ${m === 1 ? 'mes' : 'meses'}`; }
    const y = Math.floor(d / 365); return `hace ${y} ${y === 1 ? 'año' : 'años'}`;
  }

  // Una persona se considera "confirmada" cuando tiene avatar (referencia
  // establecida); el resto está "por entrenar". Señal real y derivable.

  // Degradado estable por persona para el fallback del avatar (sin foto).
  const GRADS = [
    'linear-gradient(140deg,#2b2347,#6b5aa0 60%,#c8b6ff)',
    'linear-gradient(160deg,#151927,#3a3060 70%,#8ea4ff)',
    'linear-gradient(150deg,#3a2a2a,#7c5a52 60%,#f2b8a0)',
    'linear-gradient(150deg,#1d2a25,#46604f 65%,#9cb7a5)',
    'linear-gradient(160deg,#0f111a,#252a42 70%,#7c6bb2)',
    'linear-gradient(135deg,#1a2138,#37507e 60%,#8ea4ff)',
    'linear-gradient(150deg,#2e1f2a,#6b4a5a 60%,#e58b9b)',
    'linear-gradient(150deg,#2a2418,#6b5a36 60%,#e6c177)',
  ];
  const gradFor = (id: string) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return GRADS[h % GRADS.length];
  };
  // Inicial para el fallback del avatar sobre el degradado (estilo del diseño).
  const firstInitial = (n: string) => (n.trim()[0] || '?').toUpperCase();

  // Personas filtradas/ordenadas para el grid (búsqueda + chips).
  const filteredPersons = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = persons.filter(p => {
      const tieneMaterial = (filesPerPerson.get(p.person_id) || 0) > 0;
      if (personFilter === 'material' && !tieneMaterial) return false;
      if (personFilter === 'vacias' && tieneMaterial) return false;
      if (q && !(p.display_name.toLowerCase().includes(q) || p.aliases.some(a => a.toLowerCase().includes(q)))) return false;
      return true;
    });
    const porApariciones = (a: Person, b: Person) =>
      (filesPerPerson.get(b.person_id) || 0) - (filesPerPerson.get(a.person_id) || 0);
    const criterio: Record<PersonOrden, (a: Person, b: Person) => number> = {
      apariciones: porApariciones,
      reciente: (a, b) => (personStats.last.get(b.person_id) || 0) - (personStats.last.get(a.person_id) || 0) || porApariciones(a, b),
      nombre: (a, b) => a.display_name.localeCompare(b.display_name, 'es'),
    };
    return base.sort(criterio[orden]);
  }, [persons, query, personFilter, orden, filesPerPerson, personStats]);

  const archivosPorGrupo = useMemo(() => {
    const cuenta = new Map<string, number>();
    if (!mediaFiles || grupos.length === 0) return cuenta;
    const presencia = presenciaPorDia(mediaFiles);
    for (const g of grupos) {
      const filtro = filtroDe(g);
      let n = 0;
      for (const f of mediaFiles) if (cumple(f, filtro, presencia)) n++;
      cuenta.set(g.id, n);
    }
    return cuenta;
  }, [grupos, mediaFiles]);

  /** Mete o saca a alguien de un grupo desde su ficha. */
  const alternarEnGrupo = (grupo: GrupoPersonas, personId: string) => {
    const dentro = grupo.miembros.includes(personId);
    if (dentro && grupo.miembros.length <= 2) {
      toast.error(`«${grupo.nombre}» se quedaría con una sola persona. Si ya no lo quieres, bórralo desde Grupos → Editar.`);
      return;
    }
    const miembros = dentro ? grupo.miembros.filter(m => m !== personId) : [...grupo.miembros, personId];
    actualizarGrupo(grupo.id, { miembros }).catch((err: Error) => toast.error(err.message || 'No se ha podido cambiar el grupo'));
  };

  const unidentifiedCount = useMemo(
    () => (clusters || []).reduce((a, c) => a + (c.face_count || 0), 0),
    [clusters]
  );

  /**
   * Censo del registry. Es lo que un mando de control tiene que decir de un
   * vistazo, y no coincide con "personas registradas": de 133 fichas, 62
   * salen en algun archivo y 71 no salen en ninguno — restos de sesiones de
   * descubrimiento ("Alumna random", "Alguien") que engordaban el recuento y
   * no se distinguian porque todas las fichas se pintaban igual.
   */
  const censo = useMemo(() => {
    let caras = 0;
    for (const f of (mediaFiles || [])) caras += (f.faces || []).length;
    const conMaterial: Person[] = [];
    const vacias: Person[] = [];
    for (const pp of persons) {
      if ((filesPerPerson.get(pp.person_id) || 0) > 0) conMaterial.push(pp);
      else vacias.push(pp);
    }
    // Tope de apariciones: da la escala de la barrita de cada ficha.
    const tope = conMaterial.reduce((m, pp) => Math.max(m, filesPerPerson.get(pp.person_id) || 0), 0);
    return { caras, conMaterial, vacias, tope };
  }, [persons, filesPerPerson, mediaFiles]);

  /**
   * Borra en lote las fichas marcadas. Solo se ofrece sobre fichas VACIAS:
   * borrar a alguien con material arrastra sus etiquetas de cara por todos
   * los catalogos, y eso no es limpieza sino una decision de archivo — esa
   * sigue estando una a una, dentro de su ficha.
   */
  async function borrarFichasVacias() {
    const ids = [...seleccionVacias];
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Se van a borrar ${ids.length} ${ids.length === 1 ? 'ficha' : 'fichas'} sin una sola aparición en el archivo.\n\n`
      + 'No se toca ningún archivo ni ninguna etiqueta: estas personas no salen en ninguno.'
    );
    if (!ok) return;
    setBorrandoLote(true);
    const fallidas: string[] = [];
    try {
      for (const id of ids) {
        try { await api.deletePerson(id); } catch { fallidas.push(id); }
      }
      setSeleccionVacias(new Set());
      await loadPersons();
      if (fallidas.length) setError(`No se pudieron borrar ${fallidas.length} fichas: ${fallidas.join(', ')}`);
    } finally {
      setBorrandoLote(false);
    }
  }

  // Estilos de cristal (glassmorphism) del design system.
  const glass: React.CSSProperties = {
    background: 'rgba(28,32,51,0.55)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(245,241,255,0.12)', boxShadow: '0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(245,241,255,0.10)',
  };
  const glassSoft: React.CSSProperties = {
    background: 'rgba(37,42,66,0.32)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(245,241,255,0.12)',
  };
  const glassStrong: React.CSSProperties = {
    background: 'rgba(21,25,39,0.82)', backdropFilter: 'blur(26px)', WebkitBackdropFilter: 'blur(26px)',
    border: '1px solid rgba(245,241,255,0.12)', boxShadow: '0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(245,241,255,0.10)',
  };

  useEffect(() => {
    loadPersons();
    loadFaceStatus();
    api.getOlvidadas().then(r => setOlvidadas(r.data?.total ?? 0)).catch(() => {});
  }, []);

  // Cargar clusters automáticamente cuando el servicio está listo, para que la
  // tira "Sin identificar" del rediseño aparezca sin entrar a la gestión.
  useEffect(() => {
    if (faceStatus?.ready && clusters === null) loadClusters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceStatus?.ready]);

  // Polling automatico mientras el daemon no esta listo. Cada llamada a
  // loadFaceStatus dispara init() en background en el backend, asi que basta
  // con consultar el status periodicamente. Se detiene en cuanto ready=true.
  useEffect(() => {
    if (faceStatus?.ready || faceStatus?.unavailable) return;
    const interval = setInterval(() => { loadFaceStatus(); }, 3000);
    return () => clearInterval(interval);
  }, [faceStatus?.ready, faceStatus?.unavailable]);

  // Escuchar eventos de re-identificacion para actualizar la barra de progreso
  useEffect(() => {
    if (!progressData) return;
    const d: any = progressData;
    if (!d.type || !String(d.type).startsWith('reidentify_')) return;
    // R6: ignorar re-ids de FONDO. Si en esta pantalla no hay un re-id propio en
    // curso (idle), no dejamos que un re-id disparado por assign-face secuestre
    // el banner con su progreso.
    if (reidJob.status === 'idle') return;
    if (reidJob.jobId && d.jobId && d.jobId !== reidJob.jobId) return;

    if (d.type === 'reidentify_start') {
      setReidJob(prev => ({ ...prev, status: 'running' }));
    } else if (d.type === 'reidentify_progress') {
      setReidJob(prev => ({
        ...prev,
        status: 'running',
        total: d.total ?? prev.total,
        done: d.done ?? prev.done,
        changed: d.changed ?? prev.changed,
        skippedNoDetections: d.skippedNoDetections ?? prev.skippedNoDetections,
        catalogsWritten: d.catalogsWritten ?? prev.catalogsWritten,
        folder: typeof d.folder === 'string' ? d.folder : prev.folder, // R5: carpeta actual
      }));
    } else if (d.type === 'reidentify_done') {
      // El backend manda type 'reidentify_done' tambien al cancelar (con status
      // que contiene "cancelada"): lo detectamos para usar el estado 'cancelled'.
      const wasCancelled = typeof d.status === 'string' && /cancel/i.test(d.status);
      setReidJob(prev => ({
        ...prev,
        status: wasCancelled ? 'cancelled' : 'done',
        total: d.total ?? prev.total,
        done: d.done ?? prev.done,
        changed: d.changed ?? prev.changed,
        skippedNoDetections: d.skippedNoDetections ?? prev.skippedNoDetections,
        catalogsWritten: d.catalogsWritten ?? prev.catalogsWritten,
        perPerson: d.perPerson ?? prev.perPerson, // R5: delta por persona
      }));
      // Refrescar status (el trainedPersons no cambia pero por consistencia)
      loadFaceStatus();
    } else if (d.type === 'reidentify_error') {
      setReidJob(prev => ({ ...prev, status: 'error', errorMessage: d.error || 'Error desconocido' }));
    }
  }, [progressData, reidJob.jobId, reidJob.status]);

  async function handleReidentify() {
    setError(null);
    setReidJob({ ...IDLE_REID_JOB, status: 'running', startedAt: Date.now() });
    try {
      const r: any = await api.reidentifyAll();
      if (!r.success) throw new Error(r.error || 'Error iniciando re-identificacion');
      if (r.jobId) setReidJob(prev => ({ ...prev, jobId: r.jobId }));
    } catch (err: any) {
      setReidJob({ ...IDLE_REID_JOB, status: 'error', errorMessage: err.message || 'Error' });
    }
  }

  // R3: cancelar el re-id en curso (el backend ya soportaba cancelJob; la UI no
  // lo exponia). El job emitira reidentify_done con "cancelada"; lo reflejamos ya.
  async function handleCancelReidentify() {
    if (!reidJob.jobId) return;
    try {
      await api.cancelReidentify(reidJob.jobId);
      setReidJob(prev => ({ ...prev, status: 'cancelled' }));
    } catch (err: any) {
      setError(err.message || 'No se pudo cancelar');
    }
  }

  // R4: fallback por polling. Si se pierde el frame WS terminal (reconexion de
  // 5s durante un re-id largo), consultamos el estado del job para no quedarnos
  // "ejecutando" para siempre. Un 404 = job terminado y ya liberado → cerrar.
  useEffect(() => {
    if (reidJob.status !== 'running' || !reidJob.jobId) return;
    const id = reidJob.jobId;
    const interval = setInterval(async () => {
      try {
        const r: any = await api.reidentifyStatus(id);
        if (!r.success || !r.data) return;
        const j = r.data;
        const terminal = j.status === 'done' || j.status === 'cancelled' || j.status === 'error';
        setReidJob(prev => (prev.jobId !== id || prev.status !== 'running') ? prev : ({
          ...prev,
          status: terminal ? j.status : 'running',
          total: j.total ?? prev.total,
          done: j.done ?? prev.done,
          changed: j.changed ?? prev.changed,
          skippedNoDetections: j.skippedNoDetections ?? prev.skippedNoDetections,
          catalogsWritten: j.catalogsWritten ?? prev.catalogsWritten,
          perPerson: j.perPerson ?? prev.perPerson,
          errorMessage: j.errorMessage ?? prev.errorMessage,
        }));
      } catch (err: any) {
        if (err && err.status === 404) {
          setReidJob(prev => (prev.jobId === id && prev.status === 'running') ? ({ ...prev, status: 'done' }) : prev);
        }
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [reidJob.status, reidJob.jobId]);

  // R5: ETA del re-id estimada en cliente (elapsed/done extrapolado a total).
  function reidEtaText(): string | null {
    if (reidJob.status !== 'running' || !reidJob.startedAt || reidJob.done <= 0 || reidJob.total <= 0) return null;
    const elapsed = Date.now() - reidJob.startedAt;
    const rate = reidJob.done / elapsed;
    if (rate <= 0) return null;
    const remMs = (reidJob.total - reidJob.done) / rate;
    if (!isFinite(remMs) || remMs <= 0) return null;
    const s = Math.round(remMs / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `~${m}m ${s % 60}s` : `~${s}s`;
  }

  // Listener WS para clustering
  useEffect(() => {
    if (!progressData) return;
    const d: any = progressData;
    if (!d.type || !String(d.type).startsWith('cluster_')) return;

    if (d.type === 'cluster_start') {
      setClusterJob({ status: 'running', processed: 0, unknown: 0, clustersFound: 0 });
    } else if (d.type === 'cluster_progress') {
      setClusterJob(prev => ({
        ...prev,
        status: 'running',
        processed: d.processed ?? prev.processed,
        unknown: d.unknown ?? prev.unknown,
        clustersFound: d.clusters ?? prev.clustersFound,
      }));
    } else if (d.type === 'cluster_done') {
      setClusterJob({
        status: 'done',
        processed: d.total ?? 0,
        unknown: d.unknown ?? 0,
        clustersFound: d.clustersCount ?? 0,
      });
      // Recargar la lista ahora que esta cacheada en backend
      loadClusters();
    }
  }, [progressData]);

  async function loadClusters() {
    try {
      const r: any = await api.listFaceClusters();
      if (r.success && r.data?.clusters) {
        setClusters(r.data.clusters);
      } else if (r.jobId) {
        // Job en marcha, esperamos WS
        setClusterJob({ status: 'running', processed: 0, unknown: 0, clustersFound: 0 });
      }
    } catch (err: any) {
      setClusterJob({ status: 'error', processed: 0, unknown: 0, clustersFound: 0, errorMessage: err.message });
    }
  }

  async function handleRefreshClusters() {
    setClusters(null);
    setSimilarityGroups(null); // se recalcula cuando vuelvan los nuevos clusters
    setClusterJob({ status: 'running', processed: 0, unknown: 0, clustersFound: 0 });
    try {
      await api.refreshFaceClusters();
    } catch (err: any) {
      setClusterJob({ status: 'error', processed: 0, unknown: 0, clustersFound: 0, errorMessage: err.message });
    }
  }

  function openPromote(cluster: FaceCluster) {
    setPromotingCluster(cluster);
    setPromoteForm({ person_id: '', display_name: '', aliases: '' });
    setExcludedIndices(new Set());
  }

  function toggleSampleExclusion(index: number) {
    setExcludedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // Normaliza una ruta (Windows o POSIX) para comparacion case-insensitive
  function normalizePath(p: string): string {
    return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function openSampleFile(meta: { folder: string; basename: string }) {
    if (!mediaFiles || !onSelectFile) {
      setError('no se puede abrir el archivo desde aqui');
      return;
    }
    const expected = normalizePath(`${meta.folder}/${meta.basename}`);
    const target = mediaFiles.find(f => {
      const fp = f.fullPath ? normalizePath(f.fullPath) : '';
      return fp === expected;
    });
    if (target) {
      onSelectFile(target);
    } else {
      setError(`archivo "${meta.basename}" no encontrado en la biblioteca cargada`);
    }
  }

  // Busca una persona YA registrada que coincida con el nombre tecleado, por
  // person_id (slug) o por display_name (case-insensitive). Si hay match, el
  // promote ADJUNTA el cluster a esa persona en vez de fallar con 409.
  function findExistingPersonByName(display: string) {
    const slug = slugifyPersonId(display);
    const lc = display.trim().toLowerCase();
    return persons.find((p: any) =>
      (slug && p.person_id === slug) ||
      (p.display_name && String(p.display_name).trim().toLowerCase() === lc)
    ) || null;
  }

  async function handlePromote() {
    if (!promotingCluster) return;
    const display = promoteForm.display_name.trim();
    if (!display) {
      setError('Escribe un nombre para la persona');
      return;
    }
    const matched = findExistingPersonByName(display);
    const id = matched ? matched.person_id : slugifyPersonId(display);
    if (!id) {
      setError('El nombre debe tener al menos una letra o numero');
      return;
    }
    if (promotingCluster.sample_count > 0 && excludedIndices.size >= promotingCluster.sample_count) {
      setError('no puedes excluir todas las muestras');
      return;
    }
    setPromoting(true);
    setError(null);
    try {
      const aliases = promoteForm.aliases.split(',').map(a => a.trim()).filter(Boolean);
      const r: any = await api.promoteFaceCluster(promotingCluster.cluster_id, {
        person_id: id,
        // En attach NO mandamos nombre/aliases: el backend conserva los existentes.
        display_name: matched ? undefined : display,
        aliases: matched ? undefined : aliases,
        attach_to_existing: !!matched,
        excluded_sample_indices: Array.from(excludedIndices).sort((a, b) => a - b),
      });
      if (!r.success) throw new Error(r.error || 'Error promoviendo cluster');
      setPromotingCluster(null);
      // Quitar el cluster promovido de la lista local + recargar personas y faceStatus
      setClusters(prev => prev ? prev.filter(c => c.cluster_id !== promotingCluster.cluster_id) : prev);
      await loadPersons();
      await loadFaceStatus();
      // Si la vista por similitud esta activa, recalcular grupos (el promovido
      // ya no existe en el cache; los grupos que lo contenian se reorganizan)
      if (similarityGroups) await loadSimilarityGroups();
    } catch (err: any) {
      setError(err.message || 'Error promoviendo cluster');
    } finally {
      setPromoting(false);
    }
  }

  function clusterSampleUrl(clusterId: string, sampleIndex: number): string {
    // faceClusterSampleUrl ya devuelve la URL completa (base + /api/persons/...).
    return api.faceClusterSampleUrl(clusterId, sampleIndex);
  }

  function toggleSelectMode() {
    setSelectMode(prev => {
      if (prev) setSelectedClusterIds(new Set());
      return !prev;
    });
  }

  function toggleClusterSelection(clusterId: string) {
    setSelectedClusterIds(prev => {
      const next = new Set(prev);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });
  }

  async function loadSimilarityGroups() {
    setLoadingSimilarity(true);
    try {
      const r: any = await api.listClusterSimilarityGroups();
      if (r.success && r.data) {
        setSimilarityGroups(r.data);
      } else {
        setSimilarityGroups({ groups: [], ungrouped: [] });
      }
    } catch (err: any) {
      setError(err.message || 'Error cargando similitud');
      setSimilarityGroups({ groups: [], ungrouped: [] });
    } finally {
      setLoadingSimilarity(false);
    }
  }

  async function handleQuickMergeGroup(clusterIds: string[]) {
    if (clusterIds.length < 2) return;
    if (!confirm(`¿Fusionar estos ${clusterIds.length} clusters en uno solo? Despues podras nombrar la persona.`)) return;
    setMerging(true);
    setError(null);
    try {
      const r: any = await api.mergeFaceClusters(clusterIds);
      if (!r.success || !r.data) throw new Error(r.error || 'Error fusionando');
      setClusters(prev => {
        if (!prev) return prev;
        const filtered = prev.filter(c => !clusterIds.includes(c.cluster_id));
        return [r.data, ...filtered];
      });
      // Refrescar grupos de similitud tras el merge (el merged es nuevo cluster)
      await loadSimilarityGroups();
      openPromote(r.data);
    } catch (err: any) {
      setError(err.message || 'Error fusionando grupo');
    } finally {
      setMerging(false);
    }
  }

  async function handleMerge() {
    const ids = Array.from(selectedClusterIds);
    if (ids.length < 2) {
      setError('selecciona al menos 2 clusters');
      return;
    }
    // Confirmacion: el merge combina N grupos en uno y es dificil de deshacer.
    // Antes esta via (multi-select) NO confirmaba, mientras la de grupo si →
    // riesgo de fusion accidental con un clic.
    if (!confirm(`¿Fusionar estos ${ids.length} grupos de caras en uno solo? Se combinaran en una sola persona.`)) return;
    setMerging(true);
    setError(null);
    try {
      const r: any = await api.mergeFaceClusters(ids);
      if (!r.success || !r.data) throw new Error(r.error || 'Error fusionando clusters');
      // Actualizar lista local: quitar originales, anteponer merged
      setClusters(prev => {
        if (!prev) return prev;
        const filtered = prev.filter(c => !ids.includes(c.cluster_id));
        return [r.data, ...filtered];
      });
      setSelectedClusterIds(new Set());
      setSelectMode(false);
      // Invalidar grupos de similitud: el merged cambia el panorama
      if (similarityGroups) await loadSimilarityGroups();
      // Abrir promote directamente sobre el merged para flujo continuo
      openPromote(r.data);
    } catch (err: any) {
      setError(err.message || 'Error fusionando clusters');
    } finally {
      setMerging(false);
    }
  }

  async function loadFaceStatus() {
    try {
      const r = await api.faceServiceStatus();
      if (r.success && r.data) setFaceStatus(r.data);
    } catch {
      setFaceStatus({ ready: false, unavailable: true, lastError: 'No se pudo consultar', threshold: 0.5, trainedPersons: 0 });
    }
  }

  useEffect(() => {
    if (selectedPerson) {
      loadPhotos(selectedPerson.person_id);
    } else {
      setPhotos([]);
    }
  }, [selectedPerson]);

  async function loadPersons(): Promise<Person[]> {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPersonsRegistry();
      if (res.success && Array.isArray(res.data)) {
        setPersons(res.data);
        return res.data;
      } else {
        setPersons([]);
        return [];
      }
    } catch (err: any) {
      setError(err.message || 'Error cargando personas');
      return [];
    } finally {
      setLoading(false);
    }
  }

  async function loadPhotos(personId: string) {
    try {
      const res = await api.listPersonPhotos(personId);
      if (res.success && Array.isArray(res.data)) {
        setPhotos(res.data);
      } else {
        setPhotos([]);
      }
    } catch {
      setPhotos([]);
    }
  }

  async function handleCreate() {
    setError(null);
    const display = newDisplayName.trim();
    if (!display) {
      setError('Escribe un nombre');
      return;
    }
    const id = slugifyPersonId(display);
    if (!id) {
      setError('El nombre debe tener al menos una letra o numero');
      return;
    }
    const aliases = newAliases.split(',').map(a => a.trim()).filter(Boolean);

    try {
      const res = await api.upsertPerson({
        person_id: id,
        display_name: display,
        aliases,
      });
      if (!res.success) throw new Error(res.error || 'Error creando persona');
      setShowCreate(false);
      setNewPersonId('');
      setNewDisplayName('');
      setNewAliases('');
      await loadPersons();
    } catch (err: any) {
      setError(err.message || 'Error creando persona');
    }
  }

  async function handleUpdateAliases(person: Person, aliases: string[]) {
    try {
      await api.upsertPerson({ person_id: person.person_id, aliases });
      const fresh = await loadPersons();
      if (selectedPerson?.person_id === person.person_id) {
        const updated = fresh.find(p => p.person_id === person.person_id);
        if (updated) setSelectedPerson(updated);
      }
    } catch (err: any) {
      setError(err.message || 'Error actualizando');
    }
  }

  async function handleUpdateDisplayName(person: Person, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === person.display_name) return;
    try {
      await api.upsertPerson({ person_id: person.person_id, display_name: trimmed });
      await loadPersons();
      if (selectedPerson?.person_id === person.person_id) {
        setSelectedPerson({ ...selectedPerson, display_name: trimmed });
      }
    } catch (err: any) {
      setError(err.message || 'Error actualizando nombre');
    }
  }

  // Antes era un confirm "¿Eliminar a X y todas sus fotos?", que se podia leer
  // como que borraba sus fotos del archivo (solo borraba las de referencia).
  // Ahora abre el panel que separa olvidar, ocultar sus archivos y borrarlos.
  function handleDelete(person: Person) {
    setAccionesDe(person);
  }

  async function volverAProponer() {
    try {
      await api.vaciarOlvidadas();
      setOlvidadas(0);
    } catch (err: any) {
      setError(err.message || 'No se pudieron volver a proponer');
    }
  }

  async function handleUploadPhoto(personId: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    // Marcar como "entrenando" visualmente — el backend dispara el train automático
    if (faceStatus?.ready) {
      setTrainingIds(prev => new Set(prev).add(personId));
    }
    try {
      for (const f of Array.from(files)) {
        await api.uploadPersonPhoto(personId, f);
      }
      await loadPhotos(personId);
      await loadPersons();
      // Refrescar status después de 3s para reflejar nuevo trainedPersons count
      setTimeout(() => {
        loadFaceStatus();
        setTrainingIds(prev => {
          const next = new Set(prev);
          next.delete(personId);
          return next;
        });
      }, 3000);
    } catch (err: any) {
      setError(err.message || 'Error subiendo foto');
      setTrainingIds(prev => {
        const next = new Set(prev);
        next.delete(personId);
        return next;
      });
    }
  }

  async function handleRetrain(personId: string) {
    setError(null);
    setTrainingIds(prev => new Set(prev).add(personId));
    try {
      const r = await api.trainPerson(personId);
      if (!r.success) throw new Error(r.error || 'Error entrenando');
      await loadFaceStatus();
    } catch (err: any) {
      setError(err.message || 'Error entrenando');
    } finally {
      setTrainingIds(prev => {
        const next = new Set(prev);
        next.delete(personId);
        return next;
      });
    }
  }

  async function handleDeletePhoto(personId: string, filename: string) {
    if (!confirm('¿Eliminar esta foto de referencia?')) return;
    try {
      await api.deletePersonPhoto(personId, filename);
      await loadPhotos(personId);
      await loadPersons();
    } catch (err: any) {
      setError(err.message || 'Error eliminando foto');
    }
  }

  /**
   * Caras de una persona en el archivo, ordenadas por lo bien que saldrian de
   * retrato: cara grande y con buena confianza del detector. La bbox viene en
   * pixeles del fotograma original y la miniatura es ese mismo fotograma a otra
   * escala, asi que el recorte se puede hacer en el navegador (ver RecorteCara)
   * sin pedirle al servidor 48 recortes — cada uno de un video es un ffmpeg.
   */
  const carasDe = (personId: string) => {
    const out: Array<{
      file: import('../types').MediaFile;
      bbox: number[];
      faceIndex: number;
      ancho: number;
      alto: number;
      score: number;
    }> = [];
    for (const f of mediaFiles || []) {
      const dims = dimensionesDe(f);
      if (!dims) continue;
      const cajas = (f as unknown as { face_boxes?: Array<{ bbox?: number[]; person_id?: string | null; det_score?: number | null; face_index?: number }> }).face_boxes || [];
      cajas.forEach((b, i) => {
        if (b.person_id !== personId || !Array.isArray(b.bbox) || b.bbox.length !== 4) return;
        const [x1, y1, x2, y2] = b.bbox;
        const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        if (area <= 0) return;
        out.push({
          file: f,
          bbox: b.bbox,
          faceIndex: typeof b.face_index === 'number' ? b.face_index : i,
          ancho: dims.ancho,
          alto: dims.alto,
          // Area por confianza: una cara enorme y borrosa no es mejor retrato
          // que una mediana y nitida.
          score: area * (typeof b.det_score === 'number' ? b.det_score : 0.5),
        });
      });
    }
    out.sort((x, y) => y.score - x.score);
    // Una cara por archivo: doce fotogramas seguidos del mismo plano son la
    // misma foto doce veces, y llenaban la rejilla sin dar a elegir nada.
    const vistos = new Set<string>();
    const unicas = [];
    for (const c of out) {
      if (vistos.has(c.file.id)) continue;
      vistos.add(c.file.id);
      unicas.push(c);
      if (unicas.length >= 48) break;
    }
    return unicas;
  };

  /** Retrato desde una cara del archivo: el servidor recorta del original. */
  async function handleAvatarDesdeCara(
    personId: string, file: import('../types').MediaFile, faceIndex: number, clave: string,
  ) {
    const carpeta = (file.fullPath || '').replace(/[\\/][^\\/]*$/, '');
    if (!carpeta) { setError('ese archivo no tiene ruta en disco'); return; }
    setGuardandoAvatar(clave);
    try {
      await api.setPersonAvatarFromDetection(personId, {
        folder: carpeta,
        basename: file.name,
        face_index: faceIndex,
      });
      const list = await loadPersons();
      if (Array.isArray(list)) {
        const updated = list.find((x: any) => x.person_id === personId);
        if (updated) {
          if (selectedPerson?.person_id === personId) setSelectedPerson(updated);
          setAvatarPicker(prev => (prev && prev.person_id === personId ? updated : prev));
        }
      }
      setAvatarBust(b => b + 1);
    } catch (err: any) {
      setError(err.message || 'No se pudo recortar esa cara');
    } finally {
      setGuardandoAvatar(null);
    }
  }

  async function handleSetAvatar(personId: string, filename: string) {
    try {
      await api.setPersonAvatar(personId, filename);
      const list = await loadPersons();
      // Refrescar el selectedPerson desde la lista nueva: el panel de detalle
      // mostraba estado viejo (su avatar/badge no se movia hasta reseleccionar).
      if (Array.isArray(list) && selectedPerson) {
        const updated = list.find((p: any) => p.person_id === selectedPerson.person_id);
        if (updated) setSelectedPerson(updated);
      }
      // Cache-bust: el avatar.jpg se reescribe en el mismo path.
      setAvatarBust(b => b + 1);
    } catch (err: any) {
      setError(err.message || 'Error');
    }
  }

  // M5a: fusiona la persona elegida (loser) en selectedPerson (survivor): mezcla
  // centroides, copia fotos, reasigna sus caras y elimina la loser.
  async function handleMergePersons() {
    if (!selectedPerson || !mergeLoserId || mergeLoserId === selectedPerson.person_id) return;
    setMergingPersons(true);
    setError(null);
    try {
      const r: any = await api.mergePersons(selectedPerson.person_id, mergeLoserId);
      if (!r.success) throw new Error(r.error || 'Error fusionando personas');
      setMergePersonOpen(false);
      setMergeLoserId(null);
      setMergeQuery('');
      const list = await loadPersons();
      if (Array.isArray(list)) {
        const surv = list.find((p: any) => p.person_id === selectedPerson.person_id);
        setSelectedPerson(surv || null);
      }
      setAvatarBust(b => b + 1);
      await loadFaceStatus();
    } catch (err: any) {
      setError(err.message || 'Error fusionando personas');
    } finally {
      setMergingPersons(false);
    }
  }

  function avatarSrc(person: Person): string | null {
    if (!person.avatar_url) return null;
    if (person.avatar_url.startsWith('http')) return person.avatar_url;
    return `${API_CONFIG.apiUrl.replace(/\/api$/, '')}${person.avatar_url}`;
  }

  function photoSrc(photo: PersonPhoto): string {
    return `${API_CONFIG.apiUrl.replace(/\/api$/, '')}${photo.url}`;
  }

  return (
    <div className="relative">
      {/* Glows ambientales del rediseño (contenidos, no tapan el chrome de la app) */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden -z-10">
        <div className="absolute rounded-full" style={{ width: 540, height: 540, top: -200, left: -160, filter: 'blur(95px)', background: 'radial-gradient(circle, rgba(200,182,255,0.18), transparent 70%)' }} />
        <div className="absolute rounded-full" style={{ width: 640, height: 640, bottom: -260, right: -200, filter: 'blur(105px)', background: 'radial-gradient(circle, rgba(142,164,255,0.14), transparent 70%)' }} />
      </div>

      {/* Header */}
      <header className="flex items-center gap-4 mb-5 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          {onBack && (
            <button
              onClick={onBack}
              className="flex items-center gap-1 mb-3 text-sm font-medium text-lavanda hover:text-marfil transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Volver</span>
            </button>
          )}
          <h1 className="text-[1.75rem] font-bold tracking-tight text-marfil leading-none">Personas</h1>
          <p className="mt-1 text-[0.8125rem] text-niebla">
            El registro de quién sale en tu archivo y cómo lo reconoce la máquina.
          </p>
        </div>
        <div className="flex items-center gap-2.5 rounded-full px-4 h-[46px] w-80 max-w-full" style={glass}>
          <Search className="w-[18px] h-[18px] text-lavanda-archivo shrink-0" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Busca una persona…"
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-marfil text-sm placeholder:text-lavanda-archivo"
          />
        </div>
      </header>

      {/* Panel de estado: lo que HAY, no lo que se ha registrado. Antes esto
          era un chip suelto ("133 entrenadas") que contaba fichas, no personas
          con material — y de esas 133, 71 no salen en ningún archivo. */}
      <div className="mb-5 rounded-2xl px-5 py-4 flex flex-wrap items-center gap-x-9 gap-y-4" style={glass}>
        <Cifra valor={censo.caras} etiqueta="caras detectadas" />
        <Cifra valor={censo.conMaterial.length} etiqueta="personas con material" acento />
        <Cifra
          valor={censo.vacias.length}
          etiqueta="fichas vacías"
          aviso
          onClick={censo.vacias.length > 0 ? () => { setPersonFilter('vacias'); setQuery(''); } : undefined}
        />
        <Cifra
          valor={unidentifiedCount}
          etiqueta="caras sin nombre"
          aviso
          onClick={unidentifiedCount > 0 ? () => { setView('clusters'); if (!clusters) loadClusters(); } : undefined}
        />
        <span className="flex-1 min-w-[8px]" />
        {faceStatus && (
          <div
            className="flex items-center gap-2.5 rounded-full px-3.5 h-9"
            style={glassSoft}
            title={faceStatus.ready ? 'InsightFace activo (CUDA si está disponible)' : (faceStatus.unavailable ? (faceStatus.lastError || 'Servicio no disponible') : 'Iniciando servicio…')}
          >
            <span className={`w-2 h-2 rounded-full ${faceStatus.ready ? 'bg-estado-exito' : faceStatus.unavailable ? 'bg-estado-error' : 'bg-estado-aviso animate-pulse'}`} />
            <span className="font-mono text-[11px] text-niebla">
              {faceStatus.ready
                ? `InsightFace · ${faceStatus.trainedPersons} entrenadas · umbral ${typeof faceStatus.threshold === 'number' ? faceStatus.threshold.toFixed(2) : '—'}`
                : faceStatus.unavailable ? 'IA no disponible' : 'IA iniciando…'}
            </span>
          </div>
        )}
      </div>

      {/* Barra de acciones (según vista) */}
      <div className="flex items-center flex-wrap gap-2 mb-5">
        {view === 'persons' ? (
          <>
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-lavanda text-noche text-[13px] font-semibold hover:bg-lavanda-claro transition-colors"
            >
              <Plus className="w-4 h-4" />
              Añadir persona
            </button>
            <button
              onClick={() => { setGruposIniciales([]); setEditandoGrupo('nuevo'); }}
              style={glassSoft}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium text-niebla hover:text-marfil transition-colors"
              title="Juntar varias personas con un nombre (Familia, Rodaje…) para buscarlas con @nombre"
            >
              <Users className="w-4 h-4" />
              Nuevo grupo
            </button>
            {faceStatus?.ready && faceStatus.trainedPersons > 0 && (
              <button
                onClick={handleReidentify}
                disabled={reidJob.status === 'running'}
                style={glassSoft}
                className={`inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium transition-colors ${reidJob.status === 'running' ? 'cursor-wait text-lavanda' : 'text-niebla hover:text-marfil'}`}
                title="Recalcular matches en fotos ya escaneadas tras añadir o entrenar personas"
              >
                <Sparkles className={`w-4 h-4 ${reidJob.status === 'running' ? 'animate-pulse' : ''}`} />
                Re-identificar
              </button>
            )}
            {faceStatus?.ready && (
              <button
                onClick={() => { setView('clusters'); if (!clusters) loadClusters(); }}
                style={glassSoft}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium text-niebla hover:text-marfil transition-colors"
                title="Gestión avanzada de caras sin identificar (orden por similitud, fusión múltiple)"
              >
                <Users className="w-4 h-4" />
                Caras sin nombre
              </button>
            )}
          </>
        ) : (
          <>
            <button
              onClick={() => setView('persons')}
              style={glassSoft}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium text-niebla hover:text-marfil transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Ver personas
            </button>
            {clusters && clusters.length >= 2 && (
              <button
                onClick={toggleSelectMode}
                disabled={merging}
                className={`inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium transition-colors ${selectMode ? 'bg-melocoton text-noche hover:bg-melocoton/90' : 'text-niebla hover:text-marfil'}`}
                style={selectMode ? undefined : glassSoft}
                title={selectMode ? 'Salir del modo seleccion' : 'Seleccionar varios clusters para fusionarlos'}
              >
                <Users className="w-4 h-4" />
                {selectMode ? 'Cancelar' : 'Fusionar similares'}
              </button>
            )}
            <button
              onClick={handleRefreshClusters}
              disabled={clusterJob.status === 'running' || selectMode}
              style={glassSoft}
              className={`inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium transition-colors ${clusterJob.status === 'running' || selectMode ? 'cursor-not-allowed text-lavanda/50' : 'text-niebla hover:text-marfil'}`}
              title="Recalcular clusters desde cero (descarta cache)"
            >
              <RefreshCw className={`w-4 h-4 ${clusterJob.status === 'running' ? 'animate-spin' : ''}`} />
              Re-clusterizar
            </button>
          </>
        )}
        <span className="flex-1" />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-pizarra border border-red-400/30 rounded-2xl text-sm text-red-300 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-200"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Estado del reconocimiento facial — solo cuando NO está listo (el chip de la barra cubre el caso activo) */}
      {faceStatus && !faceStatus.ready && (
        <div className={`mb-6 p-4 rounded-2xl border flex items-start gap-3 ${
          faceStatus.ready
            ? 'bg-pizarra border-pizarra'
            : 'bg-pizarra border-bruma/40'
        }`}>
          {faceStatus.ready ? (
            <Brain className="w-5 h-5 text-lavanda flex-shrink-0 mt-0.5" />
          ) : faceStatus.unavailable ? (
            <AlertTriangle className="w-5 h-5 text-bruma flex-shrink-0 mt-0.5" />
          ) : (
            <Brain className="w-5 h-5 text-lavanda flex-shrink-0 mt-0.5 animate-pulse" />
          )}
          <div className="flex-1 text-sm">
            {faceStatus.ready ? (
              <>
                <p className="font-medium text-marfil mb-0.5">
                  Reconocimiento facial activo
                  {faceStatus.trainedPersons > 0 && (
                    <span className="ml-2 text-xs text-lavanda-archivo">· {faceStatus.trainedPersons} {faceStatus.trainedPersons === 1 ? 'persona entrenada' : 'personas entrenadas'}</span>
                  )}
                </p>
                <p className="text-xs text-lavanda-archivo">
                  Al subir fotos, el sistema entrena automáticamente. Umbral de similitud: {faceStatus.threshold}.
                </p>
              </>
            ) : faceStatus.unavailable ? (
              <>
                <p className="font-medium text-marfil mb-0.5">Reconocimiento facial no disponible</p>
                <p className="text-xs text-lavanda-archivo">
                  {faceStatus.lastError || 'Servicio Python (InsightFace) no responde. Puedes seguir registrando personas; el reconocimiento automático en los escaneos se activará cuando arregles el servicio.'}
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-marfil mb-0.5">Cargando reconocimiento facial</p>
                <p className="text-xs text-lavanda-archivo">
                  Iniciando el servicio InsightFace. Tardará unos segundos.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Banner de progreso/resumen de re-identificacion */}
      {reidJob.status !== 'idle' && (
        <div className="mb-6 p-4 bg-pizarra border border-lavanda/30 rounded-2xl">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Sparkles className={`w-4 h-4 text-lavanda ${reidJob.status === 'running' ? 'animate-pulse' : ''}`} />
              <span className="text-sm font-medium text-marfil">
                {reidJob.status === 'running' && 'Re-identificando biblioteca...'}
                {reidJob.status === 'done' && 'Re-identificacion completada'}
                {reidJob.status === 'error' && 'Error en re-identificacion'}
                {reidJob.status === 'cancelled' && 'Re-identificacion cancelada'}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-lavanda-archivo">
                {reidJob.total > 0 ? `${reidJob.done}/${reidJob.total}` : 'preparando...'}
                {reidJob.status === 'running' && reidEtaText() ? ` · ${reidEtaText()}` : ''}
              </span>
              {reidJob.status === 'running' && reidJob.jobId && (
                <button onClick={handleCancelReidentify} className="text-xs text-estado-error hover:underline">
                  Cancelar
                </button>
              )}
            </div>
          </div>
          {reidJob.total > 0 && reidJob.status === 'running' && (
            <>
              <div className="w-full bg-grafito rounded-full h-2 overflow-hidden mb-1">
                <div
                  className="bg-gradient-to-r from-lavanda to-lavanda-claro h-full transition-all duration-300"
                  style={{ width: `${Math.round((reidJob.done / reidJob.total) * 100)}%` }}
                />
              </div>
              {reidJob.folder && (
                <p className="text-xs text-bruma truncate">en {reidJob.folder.split(/[\\/]/).pop()}</p>
              )}
            </>
          )}
          {(reidJob.status === 'done' || reidJob.status === 'cancelled') && (
            <div className="text-xs text-lavanda-archivo space-y-0.5">
              <p>{reidJob.changed} {reidJob.changed === 1 ? 'foto actualizada' : 'fotos actualizadas'} con nuevos matches.</p>
              <p>{reidJob.catalogsWritten} {reidJob.catalogsWritten === 1 ? 'carpeta reescrita' : 'carpetas reescritas'}.</p>
              {reidJob.perPerson && Object.keys(reidJob.perPerson).length > 0 && (
                <p className="text-marfil">
                  Nuevas caras: {Object.entries(reidJob.perPerson).sort((a, b) => b[1] - a[1]).slice(0, 6)
                    .map(([pid, n]) => `${persons.find((p: any) => p.person_id === pid)?.display_name || pid} (${n})`).join(', ')}
                </p>
              )}
              {reidJob.skippedNoDetections > 0 && (
                <p className="text-bruma">
                  {reidJob.skippedNoDetections} {reidJob.skippedNoDetections === 1 ? 'entrada antigua' : 'entradas antiguas'} sin embeddings persistidos — necesitan re-escaneo (Rutas → escanear con IA) para entrar en la re-identificacion.
                </p>
              )}
            </div>
          )}
          {reidJob.status === 'error' && reidJob.errorMessage && (
            <p className="text-xs text-estado-error">{reidJob.errorMessage}</p>
          )}
          {(reidJob.status === 'done' || reidJob.status === 'error' || reidJob.status === 'cancelled') && (
            <button
              onClick={() => setReidJob(IDLE_REID_JOB)}
              className="mt-2 text-xs text-lavanda-archivo hover:text-marfil"
            >
              Cerrar
            </button>
          )}
        </div>
      )}

      {/* Modal: crear persona */}
      {showCreate && (
        <div className="fixed inset-0 bg-noche/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-tinta rounded-3xl border border-pizarra p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-marfil">Nueva persona</h2>
              <button onClick={() => { setShowCreate(false); setError(null); }} className="text-lavanda-archivo hover:text-marfil">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">
                  Nombre <span className="text-bruma">*</span>
                </label>
                <input
                  type="text"
                  value={newDisplayName}
                  onChange={e => setNewDisplayName(e.target.value)}
                  placeholder="Ester Garcia, Jose Carlos..."
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                  autoFocus
                />
                {newDisplayName.trim() && (
                  <p className="text-xs text-bruma mt-1">
                    ID interno: <span className="font-mono text-lavanda-archivo">{slugifyPersonId(newDisplayName) || '(invalido)'}</span>
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Aliases (separados por coma)</label>
                <input
                  type="text"
                  value={newAliases}
                  onChange={e => setNewAliases(e.target.value)}
                  placeholder="Ester, Esti"
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                />
                <p className="text-xs text-lavanda-archivo mt-1">Otros nombres con los que se le conoce. Ayuda al LLM en busquedas.</p>
              </div>
            </div>
            {error && (
              <p className="mt-3 text-xs text-estado-error">{error}</p>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => { setShowCreate(false); setError(null); }}
                className="px-4 py-2 text-lavanda-archivo hover:text-marfil"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreate}
                className="px-4 py-2 bg-lavanda text-white rounded-full hover:bg-lavanda-claro font-medium"
              >
                Crear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Vista de clusters de caras desconocidas */}
      {view === 'clusters' && (
        <div>
          {clusterJob.status === 'running' && (
            <div className="mb-4 p-3 bg-pizarra border border-lavanda/30 rounded-2xl flex items-center gap-2 text-sm">
              <Search className="w-4 h-4 text-lavanda animate-pulse" />
              <span className="text-marfil">
                Buscando caras frecuentes...{' '}
                <span className="text-lavanda-archivo">
                  {clusterJob.processed} fotos procesadas · {clusterJob.unknown} caras desconocidas · {clusterJob.clustersFound} clusters
                </span>
              </span>
            </div>
          )}
          {clusterJob.status === 'error' && (
            <div className="mb-4 p-3 bg-pizarra border border-red-400/30 rounded-2xl text-sm text-red-300">
              {clusterJob.errorMessage || 'Error en clustering'}
            </div>
          )}
          {clusters !== null && clusters.length === 0 && clusterJob.status !== 'running' && (
            <div className="bg-tinta rounded-3xl border border-pizarra p-12 text-center">
              <Search className="w-12 h-12 text-lavanda-archivo mx-auto mb-3" />
              <p className="text-marfil font-medium mb-1">No hay clusters de caras desconocidas</p>
              <p className="text-sm text-lavanda-archivo">
                O todas las caras ya estan identificadas, o no hay suficientes apariciones (minimo 3 por persona).
              </p>
              <p className="text-xs text-bruma mt-2">
                Las fotos escaneadas antes del 2026-05-19 no tienen embeddings persistidos — necesitan re-scan con IA para entrar aqui.
              </p>
            </div>
          )}
          {clusters && clusters.length > 0 && (() => {
            const renderClusterCard = (c: FaceCluster) => {
              const selected = selectedClusterIds.has(c.cluster_id);
              const onClick = selectMode
                ? () => toggleClusterSelection(c.cluster_id)
                : () => openPromote(c);
              return (
                <button
                  key={c.cluster_id}
                  onClick={onClick}
                  className={`group bg-tinta rounded-3xl border-2 overflow-hidden transition-colors text-left ${
                    selectMode
                      ? selected
                        ? 'border-melocoton'
                        : 'border-pizarra hover:border-melocoton/50'
                      : 'border-pizarra hover:border-lavanda'
                  }`}
                >
                  <div className="relative aspect-square bg-pizarra overflow-hidden">
                    <img
                      src={clusterSampleUrl(c.cluster_id, 0)}
                      alt={`Cluster ${c.cluster_id}`}
                      className={`w-full h-full object-cover transition-transform ${!selectMode && 'group-hover:scale-105'}`}
                      loading="lazy"
                      onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                    />
                    {selectMode && (
                      <div className={`absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center border-2 ${
                        selected ? 'bg-melocoton border-melocoton' : 'bg-noche/60 border-marfil/60 backdrop-blur-sm'
                      }`}>
                        {selected && <CheckCircle className="w-5 h-5 text-noche" />}
                      </div>
                    )}
                    {c.cluster_id.startsWith('merged_') && !selectMode && (
                      <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-melocoton/90 text-noche text-xs font-medium">
                        fusionado
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <p className="text-marfil font-medium text-sm">
                      {c.face_count} {c.face_count === 1 ? 'cara' : 'caras'}
                      {typeof c.file_count === 'number' && (
                        <span className="text-lavanda-archivo font-normal"> · {c.file_count} {c.file_count === 1 ? 'archivo' : 'archivos'}</span>
                      )}
                    </p>
                    <p className="text-xs text-lavanda-archivo mt-0.5">
                      {[c.dominant_gender, c.dominant_age].filter(Boolean).join(' · ') || 'sin demografia'}
                    </p>
                  </div>
                </button>
              );
            };

            const showSimilarity = clusterOrderMode === 'similarity' && !selectMode;

            return (
              <>
                {selectMode ? (
                  <div className="mb-4 p-3 bg-pizarra border border-melocoton/40 rounded-2xl flex items-center justify-between gap-3 sticky top-0 z-10">
                    <p className="text-sm text-marfil">
                      <span className="text-melocoton font-medium">{selectedClusterIds.size} {selectedClusterIds.size === 1 ? 'cluster seleccionado' : 'clusters seleccionados'}</span>
                      {selectedClusterIds.size < 2 && <span className="text-bruma"> · selecciona al menos 2 para fusionar</span>}
                    </p>
                    <button
                      onClick={handleMerge}
                      disabled={selectedClusterIds.size < 2 || merging}
                      className={`px-4 py-1.5 rounded-full text-sm font-medium ${
                        selectedClusterIds.size < 2 || merging
                          ? 'bg-melocoton/30 text-noche/50 cursor-not-allowed'
                          : 'bg-melocoton text-noche hover:bg-melocoton/90'
                      }`}
                    >
                      {merging ? 'Fusionando...' : `Fusionar ${selectedClusterIds.size}`}
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="mb-3 text-sm text-lavanda-archivo">
                      {clusters.length} {clusters.length === 1 ? 'persona desconocida frecuente' : 'personas desconocidas frecuentes'} en tu archivo.
                      Pulsa una para asignarle un nombre y añadirla al registry.
                      {olvidadas > 0 && (
                        <span className="block mt-1 text-humo">
                          {olvidadas === 1 ? 'Hay 1 persona olvidada que no se te propone.' : `Hay ${olvidadas} personas olvidadas que no se te proponen.`}{' '}
                          <button onClick={volverAProponer} className="underline underline-offset-2 hover:text-niebla">Volver a proponerlas</button>
                        </span>
                      )}
                    </p>
                    <div className="mb-4 flex items-center gap-2 text-sm flex-wrap">
                      <span className="text-lavanda-archivo">Ordenar por:</span>
                      <button
                        onClick={() => setClusterOrderMode('count')}
                        className={`px-3 py-1 rounded-full font-medium transition-colors ${
                          clusterOrderMode === 'count'
                            ? 'bg-lavanda text-white'
                            : 'bg-pizarra text-lavanda hover:bg-lavanda/30'
                        }`}
                      >
                        Apariciones
                      </button>
                      <button
                        onClick={() => {
                          setClusterOrderMode('similarity');
                          if (!similarityGroups) loadSimilarityGroups();
                        }}
                        className={`px-3 py-1 rounded-full font-medium transition-colors ${
                          clusterOrderMode === 'similarity'
                            ? 'bg-lavanda text-white'
                            : 'bg-pizarra text-lavanda hover:bg-lavanda/30'
                        }`}
                      >
                        Similitud
                      </button>
                      {clusterOrderMode === 'similarity' && (
                        <span className="text-xs text-bruma">
                          · clusters parecidos aparecen juntos. Posibles duplicados de la misma persona.
                        </span>
                      )}
                    </div>
                  </>
                )}

                {showSimilarity ? (
                  loadingSimilarity ? (
                    <div className="p-8 text-center text-lavanda-archivo text-sm">
                      <RefreshCw className="w-5 h-5 animate-spin inline mr-2" />
                      Calculando similitudes...
                    </div>
                  ) : similarityGroups ? (
                    <>
                      {similarityGroups.groups.length === 0 && (
                        <div className="mb-6 p-4 bg-pizarra/40 border border-pizarra rounded-2xl text-sm text-lavanda-archivo">
                          No se han detectado grupos de clusters parecidos. Cada cluster parece una persona distinta.
                        </div>
                      )}
                      {similarityGroups.groups.map(g => {
                        const groupClusters = g.cluster_ids
                          .map(id => clusters.find(c => c.cluster_id === id))
                          .filter(Boolean) as FaceCluster[];
                        if (groupClusters.length === 0) return null;
                        return (
                          <div key={g.group_id} className="mb-6 pb-6 border-b border-pizarra">
                            <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                              <h3 className="text-sm font-semibold text-marfil">
                                Grupo similar
                                <span className="text-lavanda-archivo font-normal ml-2">
                                  ({groupClusters.length} clusters · similitud {(g.max_similarity * 100).toFixed(0)}%)
                                </span>
                              </h3>
                              <button
                                onClick={() => handleQuickMergeGroup(g.cluster_ids)}
                                disabled={merging}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                                  merging
                                    ? 'bg-melocoton/20 text-melocoton/50 cursor-wait'
                                    : 'bg-melocoton text-noche hover:bg-melocoton/90'
                                }`}
                                title="Fusionar todos los clusters de este grupo en uno solo"
                              >
                                <Users className="w-3.5 h-3.5" />
                                Fusionar este grupo
                              </button>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                              {groupClusters.map(renderClusterCard)}
                            </div>
                          </div>
                        );
                      })}
                      {similarityGroups.ungrouped.length > 0 && (
                        <div>
                          <h3 className="mb-3 text-sm font-semibold text-marfil">
                            Sin grupo similar
                            <span className="text-lavanda-archivo font-normal ml-2">
                              ({similarityGroups.ungrouped.length})
                            </span>
                          </h3>
                          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                            {similarityGroups.ungrouped
                              .map(id => clusters.find(c => c.cluster_id === id))
                              .filter(Boolean)
                              .map(c => renderClusterCard(c as FaceCluster))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : null
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {clusters.map(renderClusterCard)}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Modal: promote cluster a persona */}
      {promotingCluster && (
        <div className="fixed inset-0 bg-noche/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-tinta rounded-3xl border border-pizarra p-6 w-full max-w-3xl my-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-marfil">Convertir en persona</h2>
              <button onClick={() => { setPromotingCluster(null); setError(null); }} className="text-lavanda-archivo hover:text-marfil">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mb-4">
              <p className="text-marfil font-medium text-sm">
                {promotingCluster.face_count} {promotingCluster.face_count === 1 ? 'cara' : 'caras'}
                {typeof promotingCluster.file_count === 'number' && ` en ${promotingCluster.file_count} ${promotingCluster.file_count === 1 ? 'archivo' : 'archivos'}`}
              </p>
              <p className="text-lavanda-archivo text-xs mt-0.5">
                {[promotingCluster.dominant_gender, promotingCluster.dominant_age].filter(Boolean).join(' · ') || 'sin demografia'}
                {promotingCluster.sample_count > 0 && (
                  <>
                    {' · '}
                    {promotingCluster.sample_count - excludedIndices.size} de {promotingCluster.sample_count} muestras incluidas
                  </>
                )}
              </p>
              <p className="text-xs text-bruma mt-1">
                Pulsa una muestra para excluirla si no es la misma persona. El centroide se calcula con las muestras incluidas.
              </p>
            </div>
            {promotingCluster.sample_count > 0 && (
              <div className="mb-5 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                {Array.from({ length: promotingCluster.sample_count }).map((_, i) => {
                  const excluded = excludedIndices.has(i);
                  const meta = promotingCluster.samples_meta?.[i];
                  const canOpen = !!meta && !!mediaFiles && !!onSelectFile;
                  return (
                    <div
                      key={i}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleSampleExclusion(i)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSampleExclusion(i); } }}
                      title={meta ? `${meta.basename} · score ${meta.det_score.toFixed(2)} · ${excluded ? 'pulsa para incluir' : 'pulsa para excluir'}` : (excluded ? 'pulsa para incluir' : 'pulsa para excluir')}
                      className={`relative aspect-square rounded-xl overflow-hidden border-2 transition-all cursor-pointer ${
                        excluded
                          ? 'border-red-400/70 bg-pizarra opacity-50'
                          : 'border-grafito bg-pizarra hover:border-lavanda'
                      }`}
                    >
                      <img
                        src={clusterSampleUrl(promotingCluster.cluster_id, i)}
                        alt={`Muestra ${i + 1}`}
                        className={`w-full h-full object-cover ${excluded ? 'grayscale' : ''}`}
                        loading="lazy"
                        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                      />
                      {excluded && (
                        <div className="absolute inset-0 flex items-center justify-center bg-noche/40 pointer-events-none">
                          <X className="w-8 h-8 text-red-300 drop-shadow-[0_0_4px_rgba(0,0,0,0.8)]" strokeWidth={3} />
                        </div>
                      )}
                      {canOpen && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openSampleFile(meta!); }}
                          title={`Abrir ${meta!.basename} en la galeria`}
                          className="absolute top-1 right-1 p-1 rounded-md bg-noche/70 hover:bg-lavanda text-marfil hover:text-noche backdrop-blur-sm transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">
                  Nombre <span className="text-bruma">*</span>
                </label>
                <input
                  type="text"
                  value={promoteForm.display_name}
                  onChange={e => setPromoteForm(f => ({ ...f, display_name: e.target.value }))}
                  placeholder="Ester Garcia, Jose Carlos..."
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                  autoFocus
                />
                {promoteForm.display_name.trim() && (() => {
                  const m = findExistingPersonByName(promoteForm.display_name);
                  if (m) {
                    return (
                      <p className="text-xs text-salvia mt-1">
                        Ya existe <span className="font-medium">{m.display_name}</span>: estas {promotingCluster.face_count} {promotingCluster.face_count === 1 ? 'cara' : 'caras'} se <span className="font-medium">añadiran</span> a esa persona (sin crear un duplicado).
                      </p>
                    );
                  }
                  return (
                    <p className="text-xs text-bruma mt-1">
                      ID interno: <span className="font-mono text-lavanda-archivo">{slugifyPersonId(promoteForm.display_name) || '(invalido)'}</span>
                    </p>
                  );
                })()}
              </div>
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Aliases (separados por coma)</label>
                <input
                  type="text"
                  value={promoteForm.aliases}
                  onChange={e => setPromoteForm(f => ({ ...f, aliases: e.target.value }))}
                  placeholder="Ester, Esti"
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                />
              </div>
            </div>
            {error && (
              <p className="mt-3 text-xs text-estado-error">{error}</p>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => { setPromotingCluster(null); setError(null); }}
                disabled={promoting}
                className="px-4 py-2 text-lavanda-archivo hover:text-marfil"
              >
                Cancelar
              </button>
              {(() => {
                const allExcluded = promotingCluster.sample_count > 0 && excludedIndices.size >= promotingCluster.sample_count;
                const matched = findExistingPersonByName(promoteForm.display_name);
                const validName = matched ? true : !!slugifyPersonId(promoteForm.display_name);
                const disabled = promoting || !validName || allExcluded;
                const label = promoting
                  ? (matched ? 'Añadiendo...' : 'Creando...')
                  : allExcluded ? 'Incluye al menos una muestra'
                  : matched ? `Añadir a ${matched.display_name}` : 'Crear persona';
                return (
                  <button
                    onClick={handlePromote}
                    disabled={disabled}
                    className={`px-4 py-2 rounded-full font-medium ${
                      disabled
                        ? 'bg-lavanda/30 text-marfil/50 cursor-not-allowed'
                        : 'bg-lavanda text-white hover:bg-lavanda-claro'
                    }`}
                  >
                    {label}
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Modal: fusionar otra persona en selectedPerson (M5a) — z por encima del detalle */}
      {accionesDe && (
        <PersonaAcciones
          persona={accionesDe}
          onCerrar={() => setAccionesDe(null)}
          onOlvidada={async () => {
            if (selectedPerson?.person_id === accionesDe.person_id) setSelectedPerson(null);
            setAccionesDe(null);
            api.getOlvidadas().then(r => setOlvidadas(r.data?.total ?? 0)).catch(() => {});
            await loadPersons();
          }}
        />
      )}

      {mergePersonOpen && selectedPerson && (
        <div className="fixed inset-0 bg-noche/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="bg-tinta rounded-3xl border border-pizarra p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-marfil">Fusionar en {selectedPerson.display_name}</h2>
              <button onClick={() => setMergePersonOpen(false)} className="text-lavanda-archivo hover:text-marfil"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-xs text-bruma mb-3">
              Elige otra persona: sus caras y fotos pasaran a <span className="text-marfil font-medium">{selectedPerson.display_name}</span> y esa persona se eliminara. No se puede deshacer.
            </p>
            <input
              type="text"
              value={mergeQuery}
              onChange={e => setMergeQuery(e.target.value)}
              placeholder="Buscar persona..."
              className="w-full mb-3 px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
              autoFocus
            />
            <div className="max-h-64 overflow-y-auto space-y-1">
              {persons
                .filter(p => p.person_id !== selectedPerson.person_id && (!mergeQuery.trim() || p.display_name.toLowerCase().includes(mergeQuery.trim().toLowerCase())))
                .map(p => (
                  <button
                    key={p.person_id}
                    onClick={() => setMergeLoserId(p.person_id)}
                    className={`w-full flex items-center gap-2 p-2 rounded-xl text-left transition-colors ${
                      mergeLoserId === p.person_id ? 'bg-lavanda/20 ring-1 ring-lavanda' : 'hover:bg-pizarra'
                    }`}
                  >
                    <div className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center bg-pizarra shrink-0">
                      <Avatar url={avatarSrc(p)} name={p.display_name} bust={avatarBust} iconClassName="w-4 h-4" />
                    </div>
                    <span className="text-sm text-marfil truncate">{p.display_name}</span>
                  </button>
                ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setMergePersonOpen(false)} disabled={mergingPersons} className="px-4 py-2 text-lavanda-archivo hover:text-marfil">Cancelar</button>
              <button
                onClick={handleMergePersons}
                disabled={!mergeLoserId || mergingPersons}
                className={`px-4 py-2 rounded-full font-medium ${
                  !mergeLoserId || mergingPersons ? 'bg-lavanda/30 text-marfil/50 cursor-not-allowed' : 'bg-lavanda text-white hover:bg-lavanda-claro'
                }`}
              >
                {mergingPersons ? 'Fusionando...' : (mergeLoserId ? `Fusionar "${persons.find((p: any) => p.person_id === mergeLoserId)?.display_name || ''}" aqui` : 'Elige una persona')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Vista principal (rediseño) ===== */}
      {view === 'persons' && (
        <>
          {/* Filtros + orden + recuento */}
          <div className="flex items-center flex-wrap gap-2.5 mb-6">
            {(([
              ['material', 'Con material', censo.conMaterial.length],
              ['vacias', 'Fichas vacías', censo.vacias.length],
              ['todas', 'Todas', persons.length],
            ]) as [PersonFilter, string, number][]).map(([key, label, n]) => {
              const active = personFilter === key;
              return (
                <button
                  key={key}
                  onClick={() => setPersonFilter(key)}
                  style={active ? undefined : glassSoft}
                  className={`inline-flex items-center gap-2 h-9 px-4 rounded-full text-[13px] font-medium transition-colors ${active ? 'bg-lavanda text-noche' : 'text-niebla hover:text-marfil'}`}
                >
                  {label}
                  <span className={`font-mono text-[11px] ${active ? 'text-noche/60' : 'text-humo'}`}>{n}</span>
                </button>
              );
            })}
            <span className="flex-1" />
            {/* Orden: una lista de 133 caras sin orden explicito es un muro. */}
            <div className="flex items-center gap-1 rounded-full px-1 h-9" style={glassSoft}>
              {(([['apariciones', 'más vistas'], ['reciente', 'recientes'], ['nombre', 'A-Z']]) as [PersonOrden, string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setOrden(key)}
                  className={`h-7 px-3 rounded-full text-[12px] transition-colors ${orden === key ? 'bg-lavanda/20 text-lavanda' : 'text-humo hover:text-niebla'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="font-mono text-[11px] tracking-wide text-humo">{filteredPersons.length} de {persons.length}</span>
          </div>

          {/* Grupos: varias personas con un nombre, para buscarlas juntas. */}
          {personFilter !== 'vacias' && (
            <section className="mb-9">
              <div className="flex items-baseline gap-3 mb-3.5 flex-wrap">
                <span className="font-mono text-[11px] tracking-wider uppercase text-humo">Grupos</span>
                <span className="text-xs text-lavanda-archivo">
                  Varias personas con un nombre. Se buscan juntas con <span className="font-mono">@nombre</span>.
                </span>
              </div>
              {grupos.length === 0 ? (
                <div className="rounded-xl px-5 py-4 flex items-center gap-4 flex-wrap" style={glassSoft}>
                  <Users className="w-5 h-5 text-lavanda shrink-0" />
                  <p className="text-[13px] text-niebla flex-1 min-w-[240px] leading-relaxed">
                    Junta a la familia, al equipo de rodaje o a los del pueblo y búscalos de una vez
                    con <span className="font-mono text-lavanda-archivo">@familia</span>. También puedes
                    elegir varias caras en la home y guardarlas como grupo.
                  </p>
                  <button
                    onClick={() => { setGruposIniciales([]); setEditandoGrupo('nuevo'); }}
                    className="h-9 px-4 rounded-full bg-lavanda text-noche text-[13px] font-semibold hover:bg-lavanda-claro"
                  >
                    Crear el primero
                  </button>
                </div>
              ) : (
                <div className="flex gap-3.5 flex-wrap">
                  {grupos.map(g => {
                    const total = g.miembros.length;
                    const minimo = minimoDe(g);
                    const n = archivosPorGrupo.get(g.id) ?? 0;
                    return (
                      <div key={g.id} className="w-[230px] rounded-xl p-4 flex flex-col gap-3" style={glassSoft}>
                        <GrupoAvatares grupo={g} persons={persons} tam={40} max={4} borde="border-grafito" />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-marfil truncate">{g.nombre}</p>
                          <p className="text-[11px] text-humo mt-0.5 truncate" title={g.miembros.map(id => persons.find(p => p.person_id === id)?.display_name || id).join(', ')}>
                            {total} {total === 1 ? 'persona' : 'personas'} · {minimo === total ? 'todos' : `${minimo} de ${total}`} {g.modo === 'dia' ? 'el mismo día' : 'en el mismo archivo'}
                          </p>
                          <p className="text-[11px] text-lavanda-archivo mt-0.5">
                            {total < 2 ? 'Le falta gente: edítalo o bórralo' : `${n.toLocaleString('es-ES')} ${n === 1 ? 'archivo' : 'archivos'}`}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          {onVerGrupo && total > 0 && (
                            <button
                              onClick={() => onVerGrupo(g.id)}
                              className="flex-1 h-8 rounded-full bg-lavanda text-noche text-[12px] font-semibold hover:bg-lavanda-claro"
                            >
                              Ver
                            </button>
                          )}
                          <button
                            onClick={() => setEditandoGrupo(g)}
                            className="flex-1 h-8 rounded-full text-[12px] font-medium text-niebla hover:text-marfil"
                            style={glassSoft}
                          >
                            Editar
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Sin identificar (preview de clusters) */}
          {faceStatus?.ready && clusters && clusters.length > 0 && (
            <section className="mb-9">
              <div className="flex items-baseline gap-3 mb-3.5 flex-wrap">
                <span className="font-mono text-[11px] tracking-wider uppercase text-humo">Sin identificar</span>
                <span className="text-xs text-lavanda-archivo">{unidentifiedCount} caras en {clusters.length} grupos — nómbralos para entrenar el reconocimiento</span>
              </div>
              <div className="flex gap-3.5 overflow-x-auto pb-2.5 px-0.5">
                {clusters.slice(0, 12).map(c => {
                  const shown = Math.max(1, Math.min(c.sample_count || 0, 3));
                  return (
                    <div key={c.cluster_id} className="flex-none w-[194px] rounded-xl p-4 flex flex-col gap-3.5" style={glassSoft}>
                      <div className="flex items-center">
                        {Array.from({ length: shown }).map((_, i) => (
                          <div
                            key={i}
                            className="w-[54px] h-[54px] rounded-full overflow-hidden bg-pizarra border-2 border-grafito"
                            style={{ marginLeft: i ? -18 : 0, boxShadow: i === 0 ? '0 3px 9px rgba(0,0,0,.45)' : undefined }}
                          >
                            <img src={clusterSampleUrl(c.cluster_id, i)} alt="" className="w-full h-full object-cover" loading="lazy" onError={e => { (e.target as HTMLImageElement).style.opacity = '0.3'; }} />
                          </div>
                        ))}
                        {c.face_count > 3 && (
                          <div className="w-[34px] h-[34px] rounded-full bg-pizarra border-2 border-grafito -ml-3.5 flex items-center justify-center font-mono text-[11px] text-niebla">+{c.face_count - 3}</div>
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-marfil">{c.face_count} {c.face_count === 1 ? 'cara' : 'caras'}</p>
                        <p className="text-[11px] text-humo mt-0.5">
                          {typeof c.file_count === 'number' ? `En ${c.file_count} ${c.file_count === 1 ? 'archivo' : 'archivos'}` : ([c.dominant_gender, c.dominant_age].filter(Boolean).join(' · ') || 'sin demografía')}
                        </p>
                      </div>
                      <button
                        onClick={() => openPromote(c)}
                        className="inline-flex items-center justify-center gap-1.5 h-[34px] rounded-full bg-lavanda text-noche text-[13px] font-semibold hover:bg-lavanda-claro transition-transform active:scale-95"
                      >
                        <UserPlus className="w-[15px] h-[15px]" />
                        Nombrar
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Registradas */}
          <section className="mb-7">
            <div className="mb-3.5">
              <span className="font-mono text-[11px] tracking-wider uppercase text-humo">
                {personFilter === 'material' ? 'Con material en el archivo' : personFilter === 'vacias' ? 'Fichas sin una sola aparición' : 'Todas las fichas'}
              </span>
            </div>

            {/* Mantenimiento: el unico trabajo pendiente de verdad de esta pagina. */}
            {personFilter === 'vacias' && censo.vacias.length > 0 && (
              <div className="mb-4 rounded-2xl px-4 py-3 flex items-center flex-wrap gap-3" style={glassSoft}>
                <AlertTriangle className="w-4 h-4 text-melocoton shrink-0" />
                <p className="text-[13px] text-niebla flex-1 min-w-[260px] leading-relaxed">
                  Ninguna de estas personas sale en un solo archivo del catálogo. Suelen ser
                  restos de agrupaciones que se nombraron a medias. Borrarlas no toca ningún
                  archivo ni ninguna etiqueta.
                </p>
                <button
                  onClick={() => setSeleccionVacias(new Set(censo.vacias.map(v => v.person_id)))}
                  className="h-8 px-3 rounded-full text-[12px] font-medium text-niebla hover:text-marfil"
                  style={glassSoft}
                >
                  Marcar todas
                </button>
                {seleccionVacias.size > 0 && (
                  <>
                    <button
                      onClick={() => setSeleccionVacias(new Set())}
                      className="h-8 px-3 rounded-full text-[12px] font-medium text-humo hover:text-niebla"
                    >
                      Ninguna
                    </button>
                    <button
                      onClick={borrarFichasVacias}
                      disabled={borrandoLote}
                      className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full text-[12px] font-semibold bg-estado-error/90 text-noche hover:bg-estado-error disabled:opacity-60"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      {borrandoLote ? 'Borrando…' : `Borrar ${seleccionVacias.size}`}
                    </button>
                  </>
                )}
              </div>
            )}
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader variant="caras" cap="Cargando personas" sub="Leyendo el registry" />
              </div>
            ) : filteredPersons.length > 0 ? (
              <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(172px, 1fr))' }}>
                {filteredPersons.map(p => {
                  const appearances = filesPerPerson.get(p.person_id) || 0;
                  const last = personStats.last.get(p.person_id);
                  const vacia = appearances === 0;
                  const marcada = seleccionVacias.has(p.person_id);
                  return (
                    <div key={p.person_id} className="relative">
                      <button
                        onClick={() => setSelectedPerson(p)}
                        style={vacia ? glassSoft : glass}
                        className={`w-full rounded-xl px-4 pt-[22px] pb-[18px] flex flex-col items-center text-center transition-transform hover:-translate-y-0.5 ${marcada ? 'ring-2 ring-melocoton' : ''}`}
                      >
                        <div
                          className={`w-[84px] h-[84px] mb-3.5 rounded-full overflow-hidden flex items-center justify-center text-[28px] font-semibold text-white/90 select-none ${vacia ? 'opacity-40 grayscale' : ''}`}
                          style={{ background: gradFor(p.person_id), boxShadow: '0 6px 18px rgba(0,0,0,.42)' }}
                        >
                          {avatarSrc(p)
                            ? <Avatar url={avatarSrc(p)} name={p.display_name} bust={avatarBust} />
                            : firstInitial(p.display_name)}
                        </div>
                        <p className="text-[15px] font-semibold text-marfil truncate w-full">{p.display_name}</p>
                        {vacia ? (
                          <p className="mt-1.5 text-[11px] text-melocoton">no aparece en ningún archivo</p>
                        ) : (
                          <>
                            <p className="mt-1.5 font-mono text-[11px] text-humo">
                              {appearances} {appearances === 1 ? 'aparición' : 'apariciones'}
                            </p>
                            <p className="mt-0.5 text-[11px] text-lavanda-archivo">{relativeTime(last)}</p>
                            {/* La barra da la jerarquia sin leer: 545 y 14 no pueden
                                pesar lo mismo en una pagina que sirve para priorizar. */}
                            <div className="mt-3 w-full h-[3px] rounded-full bg-pizarra overflow-hidden">
                              <div
                                className="h-full rounded-full bg-lavanda/70"
                                style={{ width: `${Math.max(4, (appearances / Math.max(1, censo.tope)) * 100)}%` }}
                              />
                            </div>
                          </>
                        )}
                      </button>
                      {vacia && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSeleccionVacias(prev => {
                              const n = new Set(prev);
                              if (n.has(p.person_id)) n.delete(p.person_id); else n.add(p.person_id);
                              return n;
                            });
                          }}
                          title={marcada ? 'Quitar de la selección' : 'Marcar para borrar'}
                          className={`absolute top-2.5 right-2.5 w-6 h-6 rounded-md flex items-center justify-center transition-colors ${marcada ? 'bg-melocoton text-noche' : 'bg-noche/70 text-humo hover:text-marfil'}`}
                        >
                          <Check className="w-3.5 h-3.5" strokeWidth={3} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-[70px] text-center text-humo">
                <Users className="w-9 h-9 mx-auto text-lavanda-archivo mb-3.5" />
                <p className="text-sm">{persons.length === 0 ? 'Sin personas todavía. Pulsa "Añadir persona" para empezar.' : 'Ninguna persona coincide con este filtro.'}</p>
              </div>
            )}
          </section>
        </>
      )}

      {/* ===== Elegir foto de perfil ===== */}
      {avatarPicker && (() => {
        const caras = carasDe(avatarPicker.person_id);
        return (
          <div
            onClick={() => setAvatarPicker(null)}
            className="fixed inset-0 z-[70] flex items-center justify-center p-6"
            style={{ background: 'rgba(8,9,14,0.86)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
          >
            <div
              onClick={e => e.stopPropagation()}
              className="w-[min(900px,96vw)] max-h-[88vh] rounded-2xl overflow-hidden flex flex-col"
              style={glassStrong}
            >
              <div className="flex items-center gap-3 p-5 border-b border-borde-sutil">
                <div
                  className="w-12 h-12 shrink-0 rounded-xl overflow-hidden flex items-center justify-center text-lg font-semibold text-white/90"
                  style={{ background: gradFor(avatarPicker.person_id) }}
                >
                  {avatarSrc(avatarPicker)
                    ? <Avatar url={avatarSrc(avatarPicker)} name={avatarPicker.display_name} bust={avatarBust} />
                    : firstInitial(avatarPicker.display_name)}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold text-marfil truncate">Foto de perfil de {avatarPicker.display_name}</h3>
                  <p className="text-[12px] text-humo">
                    {caras.length > 0
                      ? 'Pulsa una cara y se recorta del archivo original.'
                      : 'No hay caras suyas en el catálogo. Sube una foto de referencia.'}
                  </p>
                </div>
                <button onClick={() => fileInputRef.current?.click()} style={glassSoft} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium text-niebla hover:text-marfil">
                  <ImagePlus className="w-4 h-4" />
                  Subir foto
                </button>
                <button onClick={() => setAvatarPicker(null)} className="flex-none w-8 h-8 rounded-lg bg-pizarra text-niebla hover:text-marfil flex items-center justify-center">
                  <X className="w-[15px] h-[15px]" />
                </button>
              </div>

              <div className="p-5 overflow-y-auto">
                {photos.length > 0 && (
                  <div className="mb-5">
                    <p className="mb-2.5 font-mono text-[10px] tracking-wider uppercase text-humo">Fotos de referencia</p>
                    <div className="flex gap-2.5 flex-wrap">
                      {photos.map(photo => {
                        const esAvatar = avatarPicker.avatar_path?.endsWith(photo.filename);
                        return (
                          <button
                            key={photo.filename}
                            onClick={() => handleSetAvatar(avatarPicker.person_id, photo.filename)}
                            className={`relative w-[88px] h-[88px] rounded-xl overflow-hidden bg-pizarra transition-all ${esAvatar ? 'ring-2 ring-lavanda' : 'hover:ring-2 hover:ring-lavanda/60'}`}
                            title={esAvatar ? 'Es la foto actual' : 'Usar esta foto'}
                          >
                            <img src={photoSrc(photo)} alt="" className="w-full h-full object-cover" />
                            {esAvatar && (
                              <span className="absolute top-1 left-1 w-5 h-5 rounded-full bg-lavanda flex items-center justify-center">
                                <Check className="w-3 h-3 text-noche" strokeWidth={3} />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {caras.length > 0 && (
                  <>
                    <p className="mb-2.5 font-mono text-[10px] tracking-wider uppercase text-humo">
                      Sus caras en el archivo — las más nítidas primero
                    </p>
                    <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))' }}>
                      {caras.map((c, i) => {
                        const clave = c.file.id + ':' + c.faceIndex;
                        const guardando = guardandoAvatar === clave;
                        return (
                          <button
                            key={clave + ':' + i}
                            onClick={() => handleAvatarDesdeCara(avatarPicker.person_id, c.file, c.faceIndex, clave)}
                            disabled={!!guardandoAvatar}
                            title={`${c.file.name} — usar esta cara`}
                            className="relative aspect-square rounded-xl overflow-hidden bg-pizarra hover:ring-2 hover:ring-lavanda transition-all disabled:opacity-60"
                          >
                            <RecorteCara
                              src={c.file.thumbnail || c.file.url}
                              bbox={c.bbox}
                              ancho={c.ancho}
                              alto={c.alto}
                            />
                            {guardando && (
                              <span className="absolute inset-0 bg-noche/70 flex items-center justify-center">
                                <Loader2 className="w-5 h-5 text-lavanda animate-spin" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-4 text-[11px] text-humo leading-relaxed">
                      El recorte se hace sobre el archivo original, no sobre la miniatura:
                      lo que ves aquí es una vista previa.
                    </p>
                  </>
                )}

                {caras.length === 0 && photos.length === 0 && (
                  <div className="py-12 text-center text-humo">
                    <Camera className="w-8 h-8 mx-auto text-lavanda-archivo mb-3" />
                    <p className="text-sm">Sin caras ni fotos todavía.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ===== Modal de detalle de persona ===== */}
      {selectedPerson && (() => {
        const p = selectedPerson;
        const appearances = mediaFiles ? mediaFiles.filter(f => f.faces?.some(face => face.person_id === p.person_id)) : [];
        const sessions = personStats.sessions.get(p.person_id) || 0;
        const last = personStats.last.get(p.person_id);
        const training = trainingIds.has(p.person_id);
        const grad = gradFor(p.person_id);
        return (
          <div
            onClick={() => setSelectedPerson(null)}
            className="fixed inset-0 z-[60] flex items-center justify-center p-6"
            style={{ background: 'rgba(8,9,14,0.82)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
          >
            <div
              onClick={e => e.stopPropagation()}
              className="w-[min(880px,96vw)] max-h-[88vh] rounded-2xl overflow-hidden flex flex-col"
              style={glassStrong}
            >
              {/* Cabecera. Antes el 42% del ancho era un degradado de color con
                  un avatar en medio, y el material de la persona se apretaba en
                  la otra mitad. El retrato ahora ocupa lo que vale. */}
              <div className="flex items-start gap-4 p-5 border-b border-borde-sutil">
                {/* El retrato es el boton para cambiarlo: hasta ahora solo se
                    podia elegir entre fotos subidas a mano, y casi nadie tiene. */}
                <button
                  onClick={() => setAvatarPicker(p)}
                  title="Elegir foto de perfil"
                  className="group/foto relative w-[88px] h-[88px] shrink-0 rounded-2xl overflow-hidden flex items-center justify-center text-[34px] font-semibold text-white/90 select-none"
                  style={{ background: grad, boxShadow: '0 8px 24px rgba(0,0,0,.45)' }}
                >
                  {avatarSrc(p)
                    ? <Avatar url={avatarSrc(p)} name={p.display_name} bust={avatarBust} />
                    : firstInitial(p.display_name)}
                  <span className="absolute inset-0 bg-noche/65 opacity-0 group-hover/foto:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1">
                    <Camera className="w-5 h-5 text-marfil" />
                    <span className="text-[10px] font-medium text-marfil">Cambiar</span>
                  </span>
                </button>

                <div className="min-w-0 flex-1">
                  <DisplayNameEditor key={p.person_id} initial={p.display_name} onSave={(name) => handleUpdateDisplayName(p, name)} />
                  <p className="mt-1 font-mono text-[11px] text-humo truncate">{p.person_id}</p>
                  <div className="mt-3 flex items-center flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-niebla">
                    <span><b className="text-lavanda text-[15px] tabular-nums">{appearances.length}</b> apariciones</span>
                    <span><b className="text-marfil text-[15px] tabular-nums">{sessions}</b> {sessions === 1 ? 'sesión' : 'sesiones'}</span>
                    <span>última vez <b className="text-marfil">{relativeTime(last)}</b></span>
                  </div>
                </div>

                <button onClick={() => setSelectedPerson(null)} className="flex-none w-8 h-8 rounded-lg bg-pizarra text-niebla hover:text-marfil flex items-center justify-center">
                  <X className="w-[15px] h-[15px]" />
                </button>
              </div>

              {/* Acciones, a la vista. Antes vivian al fondo del panel, en
                  botones de 38 px que habia que buscar con scroll. */}
              <div className="flex items-center flex-wrap gap-2 px-5 py-3 border-b border-borde-sutil">
                {onVerLineaDeVida && appearances.length > 0 && (
                  <button
                    onClick={() => { onVerLineaDeVida(p.person_id); setSelectedPerson(null); }}
                    className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-lavanda text-noche text-[13px] font-semibold hover:bg-lavanda-claro transition-colors"
                    title="Todos sus años, de la primera vez a la última"
                  >
                    <Sparkles className="w-4 h-4" />
                    Línea de vida
                  </button>
                )}
                {onFilterByPerson && appearances.length > 0 && (
                  <button
                    onClick={() => { onFilterByPerson(p.person_id); setSelectedPerson(null); }}
                    style={glassSoft}
                    className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium text-niebla hover:text-marfil transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Ver en la galería
                  </button>
                )}
                {faceStatus?.ready && photos.length > 0 && (
                  <button
                    onClick={() => handleRetrain(p.person_id)}
                    disabled={training}
                    style={glassSoft}
                    className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium text-niebla hover:text-marfil disabled:opacity-60"
                  >
                    <Brain className={`w-4 h-4 ${training ? 'animate-pulse text-lavanda' : ''}`} />
                    Re-entrenar
                  </button>
                )}
                <span className="flex-1" />
                {persons.length > 1 && (
                  <button
                    onClick={() => { setMergePersonOpen(true); setMergeLoserId(null); setMergeQuery(''); }}
                    style={glassSoft}
                    className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[13px] font-medium text-niebla hover:text-marfil"
                    title="Fusionar otra persona en esta"
                  >
                    <GitMerge className="w-[15px] h-[15px]" />
                    Fusionar
                  </button>
                )}
                <button
                  onClick={() => handleDelete(p)}
                  title="Olvidarla, u ocultar o borrar sus archivos"
                  style={glassSoft}
                  className="inline-flex items-center justify-center w-9 h-9 rounded-full text-estado-error hover:bg-estado-error/10"
                >
                  <Trash2 className="w-[15px] h-[15px]" />
                </button>
              </div>

              {/* Cuerpo */}
              <div className="p-5 flex flex-col gap-5 overflow-y-auto">
                {training && (
                  <div className="flex items-center gap-2 p-2.5 rounded-xl text-sm" style={{ background: 'rgba(200,182,255,0.1)', border: '1px solid rgba(200,182,255,0.3)' }}>
                    <Brain className="w-4 h-4 text-lavanda animate-pulse" />
                    <span className="text-marfil">Entrenando embeddings faciales…</span>
                  </div>
                )}

                <div>
                  <p className="mb-1.5 font-mono text-[10px] tracking-wider uppercase text-humo">Aliases</p>
                  <AliasesEditor initialAliases={p.aliases} onSave={(aliases) => handleUpdateAliases(p, aliases)} />
                </div>

                <div>
                  <p className="mb-1.5 font-mono text-[10px] tracking-wider uppercase text-humo">Grupos</p>
                  <div className="flex flex-wrap gap-1.5">
                    {grupos.map(g => {
                      const dentro = g.miembros.includes(p.person_id);
                      return (
                        <button
                          key={g.id}
                          onClick={() => alternarEnGrupo(g, p.person_id)}
                          title={dentro ? `Sacar de «${g.nombre}»` : `Meter en «${g.nombre}»`}
                          className={`inline-flex items-center gap-1 h-7 px-3 rounded-full text-[12px] font-medium transition-colors ${
                            dentro ? 'bg-lavanda text-noche' : 'text-humo hover:text-marfil'
                          }`}
                          style={dentro ? undefined : glassSoft}
                        >
                          {dentro ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                          {g.nombre}
                        </button>
                      );
                    })}
                    <button
                      onClick={() => { setGruposIniciales([p.person_id]); setEditandoGrupo('nuevo'); }}
                      className="inline-flex items-center gap-1 h-7 px-3 rounded-full text-[12px] text-lavanda hover:text-lavanda-claro"
                    >
                      <Users className="w-3 h-3" />
                      Nuevo grupo con {p.display_name.split(' ')[0]}
                    </button>
                  </div>
                </div>

                {appearances.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2.5">
                      <p className="font-mono text-[10px] tracking-wider uppercase text-humo">Apariciones recientes</p>
                      <span className="font-mono text-[10px] text-humo">
                        {Math.min(12, appearances.length)} de {appearances.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                      {appearances.slice(0, 12).map(file => (
                        <button
                          key={file.id}
                          onClick={() => { if (onSelectFile) onSelectFile(file); setSelectedPerson(null); }}
                          title={file.name}
                          className="relative aspect-square rounded-lg overflow-hidden bg-pizarra hover:ring-2 hover:ring-lavanda transition-all"
                        >
                          <img src={file.thumbnail || file.url} alt={file.name} className="w-full h-full object-cover" loading="lazy" onError={e => { (e.target as HTMLImageElement).style.opacity = '0.3'; }} />
                          {file.type === 'video' && <span className="absolute bottom-1 right-1 text-[9px] bg-noche/80 text-marfil px-1 rounded">VIDEO</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between mb-2.5">
                    <p className="font-mono text-[10px] tracking-wider uppercase text-humo">Caras de entrenamiento</p>
                    <button onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-lavanda hover:text-lavanda-claro">
                      <ImagePlus className="w-3.5 h-3.5" />
                      Subir
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={e => handleUploadPhoto(p.person_id, e.target.files)} />
                  </div>
                  {photos.length > 0 ? (
                  <div className="flex gap-2 flex-wrap">
                    {photos.map(photo => {
                      const isAvatar = p.avatar_path?.endsWith(photo.filename);
                      return (
                        <div key={photo.filename} className="relative group w-12 h-12 rounded-lg overflow-hidden bg-pizarra" style={{ border: '1px solid rgba(245,241,255,0.12)' }}>
                          <img src={photoSrc(photo)} alt={photo.filename} className="w-full h-full object-cover" />
                          {isAvatar && (
                            <div className="absolute top-0.5 left-0.5 bg-lavanda rounded-full p-0.5">
                              <Star className="w-2.5 h-2.5 text-noche fill-current" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-noche/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                            {!isAvatar && (
                              <button onClick={() => handleSetAvatar(p.person_id, photo.filename)} title="Marcar como avatar" className="p-1 bg-lavanda text-noche rounded-full">
                                <Star className="w-3 h-3" />
                              </button>
                            )}
                            <button onClick={() => handleDeletePhoto(p.person_id, photo.filename)} title="Eliminar foto" className="p-1 bg-estado-error/90 text-noche rounded-full">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  ) : appearances.length > 0 ? (
                    /* Ya se le reconoce en el archivo: el recuadro punteado de
                       "sube 5-10 fotos" pedia trabajo que no hace falta. */
                    <p className="text-[12px] text-humo leading-relaxed">
                      Sin fotos de referencia: se le reconoce por las caras que ya tiene
                      asignadas en el archivo. Sube alguna solo si falla en material nuevo.
                    </p>
                  ) : (
                    <div className="p-4 rounded-lg border-2 border-dashed border-pizarra text-center text-[11px] text-lavanda-archivo">
                      Sube 5-10 fotos con caras claras y distintos ángulos para que el
                      reconocimiento pueda empezar a encontrarla.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {editandoGrupo && (
        <GrupoEditor
          grupo={editandoGrupo === 'nuevo' ? null : editandoGrupo}
          persons={persons}
          apariciones={filesPerPerson}
          iniciales={gruposIniciales}
          onClose={() => setEditandoGrupo(null)}
        />
      )}
    </div>
  );
}

/**
 * Dimensiones reales del archivo, que es el espacio en el que vienen las bbox.
 */
function dimensionesDe(f: import('../types').MediaFile): { ancho: number; alto: number } | null {
  if (f.dimensions && f.dimensions.width && f.dimensions.height) {
    return { ancho: f.dimensions.width, alto: f.dimensions.height };
  }
  const r = (f as unknown as { resolution?: string }).resolution;
  const m = typeof r === 'string' ? r.match(/^(\d+)\s*x\s*(\d+)$/i) : null;
  if (!m) return null;
  const ancho = parseInt(m[1], 10);
  const alto = parseInt(m[2], 10);
  return ancho > 0 && alto > 0 ? { ancho, alto } : null;
}

/**
 * Recorte de una cara hecho con CSS sobre la miniatura. La bbox esta en
 * pixeles del fotograma original y la miniatura es ese mismo fotograma a otra
 * escala, asi que basta con trabajar en fracciones: ancho y alto se fijan por
 * separado pero salen del MISMO cuadrado en pixeles, de modo que la imagen no
 * se deforma.
 */
function RecorteCara({ src, bbox, ancho, alto }: {
  src?: string; bbox: number[]; ancho: number; alto: number;
}) {
  const [x1, y1, x2, y2] = bbox;
  // Margen alrededor de la cara: un retrato pegado a las cejas no es retrato.
  const lado = Math.max(x2 - x1, y2 - y1) * 1.7;
  const rx = Math.min(1, lado / ancho);
  const ry = Math.min(1, lado / alto);
  const cx = (x1 + x2) / 2 / ancho;
  const cy = (y1 + y2) / 2 / alto;
  const izq = Math.min(Math.max(cx - rx / 2, 0), 1 - rx);
  const arr = Math.min(Math.max(cy - ry / 2, 0), 1 - ry);
  if (!src) return <div className="absolute inset-0 bg-pizarra" />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      style={{
        position: 'absolute',
        maxWidth: 'none',
        width: `${100 / rx}%`,
        height: `${100 / ry}%`,
        left: `${(-izq * 100) / rx}%`,
        top: `${(-arr * 100) / ry}%`,
      }}
      onError={e => { (e.target as HTMLImageElement).style.opacity = '0.25'; }}
    />
  );
}

/**
 * Una cifra del panel de estado. Si lleva `onClick` se comporta como filtro:
 * el numero es el sitio natural para pulsar cuando quieres ver "esos".
 */
function Cifra({ valor, etiqueta, acento, aviso, onClick }: {
  valor: number; etiqueta: string; acento?: boolean; aviso?: boolean; onClick?: () => void;
}) {
  const color = aviso && valor > 0 ? 'text-melocoton' : acento ? 'text-lavanda' : 'text-marfil';
  const cuerpo = (
    <>
      <span className={`block text-[26px] font-bold leading-none tabular-nums ${color}`}>
        {valor.toLocaleString('es-ES')}
      </span>
      <span className="mt-1.5 block font-mono text-[10px] tracking-wider uppercase text-humo">{etiqueta}</span>
    </>
  );
  if (!onClick) return <div>{cuerpo}</div>;
  return (
    <button
      onClick={onClick}
      className="text-left rounded-lg -mx-2 px-2 py-1 hover:bg-pizarra/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda"
    >
      {cuerpo}
    </button>
  );
}

/**
 * Mini-componente para editar aliases en línea con guardado al pulsar Enter
 * o al desfocar. Mantiene su propio estado intermedio para no spamear API.
 */
function AliasesEditor({ initialAliases, onSave }: { initialAliases: string[]; onSave: (aliases: string[]) => void }) {
  const [value, setValue] = useState(initialAliases.join(', '));
  const initial = useRef(initialAliases.join(', '));

  useEffect(() => {
    const joined = initialAliases.join(', ');
    if (joined !== initial.current) {
      setValue(joined);
      initial.current = joined;
    }
  }, [initialAliases]);

  const save = () => {
    const aliases = value.split(',').map(a => a.trim()).filter(Boolean);
    if (aliases.join(',') !== initialAliases.join(',')) {
      onSave(aliases);
    }
  };

  return (
    <input
      type="text"
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
      // Un ejemplo con nombres reales del archivo se lee como un valor ya
      // escrito, no como un ejemplo. Mejor decir para que sirve el campo.
      placeholder="Otros nombres con los que la buscas…"
      className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda text-sm"
    />
  );
}

/**
 * Editor inline para el display_name. Se ve como un titulo h2 hasta que el
 * usuario pulsa el icono de lapiz; entonces se transforma en input. Enter
 * guarda, Esc cancela, blur tambien guarda.
 */
function DisplayNameEditor({ initial, onSave }: { initial: string; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);

  useEffect(() => { setValue(initial); }, [initial]);

  const commit = () => {
    const trimmed = value.trim();
    setEditing(false);
    if (trimmed && trimmed !== initial) onSave(trimmed);
    else setValue(initial);
  };

  const cancel = () => {
    setValue(initial);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        type="text"
        autoFocus
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        className="text-xl font-bold bg-pizarra text-marfil border border-lavanda rounded-xl px-2 py-1 focus:outline-none focus:ring-2 focus:ring-lavanda min-w-0 w-full max-w-xs"
      />
    );
  }

  return (
    <div className="flex items-center gap-2">
      <h2 className="text-xl font-bold text-marfil">{initial}</h2>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Editar nombre"
        className="p-1 rounded-md text-lavanda-archivo hover:text-marfil hover:bg-pizarra transition-colors"
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
