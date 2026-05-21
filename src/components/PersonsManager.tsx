import React, { useEffect, useMemo, useRef, useState } from 'react';
import { User, Plus, Trash2, Upload, Star, RefreshCw, X, ArrowLeft, ImagePlus, Brain, AlertTriangle, CheckCircle, Sparkles, Search, Users, ExternalLink, Pencil } from 'lucide-react';
import { api } from '../services/api';
import { API_CONFIG, config } from '../config';
import { useWebSocket } from '../hooks/useWebSocket';
import { slugifyPersonId } from '../utils/persons';

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
export default function PersonsManager({ onBack, mediaFiles, onSelectFile, onFilterByPerson }: PersonsManagerProps) {
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
  const [reidJob, setReidJob] = useState<{
    jobId: string | null;
    status: ReidStatus;
    total: number;
    done: number;
    changed: number;
    skippedNoDetections: number;
    catalogsWritten: number;
    errorMessage?: string;
  }>({ jobId: null, status: 'idle', total: 0, done: 0, changed: 0, skippedNoDetections: 0, catalogsWritten: 0 });

  const { progressData } = useWebSocket(config.wsUrl);

  // Vista actual: gestion de personas vs. descubrimiento de caras desconocidas
  const [view, setView] = useState<'persons' | 'clusters'>('persons');
  interface FaceCluster {
    cluster_id: string;
    face_count: number;
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

  // Top personas por numero de apariciones (para el panel de resumen)
  const topPersonsByCount = useMemo(() => {
    return [...persons]
      .map(p => ({ person: p, count: filesPerPerson.get(p.person_id) || 0 }))
      .sort((a, b) => b.count - a.count)
      .filter(x => x.count > 0)
      .slice(0, 6);
  }, [persons, filesPerPerson]);

  useEffect(() => {
    loadPersons();
    loadFaceStatus();
  }, []);

  // Polling automatico mientras el daemon no esta listo. Cada llamada a
  // loadFaceStatus dispara init() en background en el backend, asi que basta
  // con consultar el status periodicamente. Se detiene en cuanto ready=true.
  useEffect(() => {
    if (faceStatus?.ready) return;
    const interval = setInterval(() => { loadFaceStatus(); }, 3000);
    return () => clearInterval(interval);
  }, [faceStatus?.ready]);

  // Escuchar eventos de re-identificacion para actualizar la barra de progreso
  useEffect(() => {
    if (!progressData) return;
    const d: any = progressData;
    if (!d.type || !String(d.type).startsWith('reidentify_')) return;
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
      }));
    } else if (d.type === 'reidentify_done') {
      setReidJob(prev => ({
        ...prev,
        status: 'done',
        total: d.total ?? prev.total,
        done: d.done ?? prev.done,
        changed: d.changed ?? prev.changed,
        skippedNoDetections: d.skippedNoDetections ?? prev.skippedNoDetections,
        catalogsWritten: d.catalogsWritten ?? prev.catalogsWritten,
      }));
      // Refrescar status (el trainedPersons no cambia pero por consistencia)
      loadFaceStatus();
    } else if (d.type === 'reidentify_error') {
      setReidJob(prev => ({ ...prev, status: 'error', errorMessage: d.error || 'Error desconocido' }));
    }
  }, [progressData, reidJob.jobId]);

  async function handleReidentify() {
    setError(null);
    setReidJob({ jobId: null, status: 'running', total: 0, done: 0, changed: 0, skippedNoDetections: 0, catalogsWritten: 0 });
    try {
      const r: any = await api.reidentifyAll();
      if (!r.success) throw new Error(r.error || 'Error iniciando re-identificacion');
      if (r.jobId) setReidJob(prev => ({ ...prev, jobId: r.jobId }));
    } catch (err: any) {
      setReidJob({ jobId: null, status: 'error', total: 0, done: 0, changed: 0, skippedNoDetections: 0, catalogsWritten: 0, errorMessage: err.message || 'Error' });
    }
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

  async function handlePromote() {
    if (!promotingCluster) return;
    const display = promoteForm.display_name.trim();
    if (!display) {
      setError('Escribe un nombre para la persona');
      return;
    }
    const id = slugifyPersonId(display);
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
        display_name: display,
        aliases,
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

  async function loadPersons() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPersonsRegistry();
      if (res.success && Array.isArray(res.data)) {
        setPersons(res.data);
      } else {
        setPersons([]);
      }
    } catch (err: any) {
      setError(err.message || 'Error cargando personas');
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
      await loadPersons();
      if (selectedPerson?.person_id === person.person_id) {
        const updated = (await api.listPersonsRegistry()).data?.find((p: Person) => p.person_id === person.person_id);
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

  async function handleDelete(person: Person) {
    if (!confirm(`¿Eliminar a ${person.display_name} y todas sus fotos? Esta acción no se puede deshacer.`)) return;
    try {
      await api.deletePerson(person.person_id);
      if (selectedPerson?.person_id === person.person_id) setSelectedPerson(null);
      await loadPersons();
    } catch (err: any) {
      setError(err.message || 'Error eliminando');
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

  async function handleSetAvatar(personId: string, filename: string) {
    try {
      await api.setPersonAvatar(personId, filename);
      await loadPersons();
    } catch (err: any) {
      setError(err.message || 'Error');
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
    <div>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          {onBack && (
            <button
              onClick={onBack}
              className="flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Volver</span>
            </button>
          )}
          <h1 className="text-2xl font-bold text-marfil mb-2">Personas</h1>
          <p className="text-lavanda-archivo">
            Gente que aparece en tu archivo. Sube fotos de referencia para que el sistema aprenda a reconocerlas (próximamente con detección automática).
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {faceStatus?.ready && (
            <button
              onClick={() => {
                const next = view === 'persons' ? 'clusters' : 'persons';
                setView(next);
                if (next === 'clusters' && !clusters) loadClusters();
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${
                view === 'clusters'
                  ? 'bg-lavanda text-white'
                  : 'bg-pizarra text-lavanda hover:bg-lavanda hover:text-white'
              }`}
              title={view === 'clusters' ? 'Volver a la lista de personas' : 'Descubrir caras frecuentes no identificadas'}
            >
              {view === 'clusters' ? <Users className="w-4 h-4" /> : <Search className="w-4 h-4" />}
              {view === 'clusters' ? 'Ver personas' : 'Descubrir caras'}
            </button>
          )}
          {view === 'persons' && faceStatus?.ready && faceStatus.trainedPersons > 0 && (
            <button
              onClick={handleReidentify}
              disabled={reidJob.status === 'running'}
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${
                reidJob.status === 'running'
                  ? 'bg-lavanda/20 text-lavanda cursor-wait'
                  : 'bg-pizarra text-lavanda hover:bg-lavanda hover:text-white'
              }`}
              title="Recalcular matches en fotos ya escaneadas tras añadir o entrenar personas"
            >
              <Sparkles className={`w-4 h-4 ${reidJob.status === 'running' ? 'animate-pulse' : ''}`} />
              Re-identificar biblioteca
            </button>
          )}
          {view === 'persons' && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 bg-lavanda text-white rounded-full hover:bg-lavanda-claro transition-colors font-medium"
            >
              <Plus className="w-4 h-4" />
              Añadir persona
            </button>
          )}
          {view === 'clusters' && clusters && clusters.length >= 2 && (
            <button
              onClick={toggleSelectMode}
              disabled={merging}
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${
                selectMode
                  ? 'bg-melocoton text-noche hover:bg-melocoton/90'
                  : 'bg-pizarra text-lavanda hover:bg-lavanda hover:text-white'
              }`}
              title={selectMode ? 'Salir del modo seleccion' : 'Seleccionar varios clusters para fusionarlos'}
            >
              <Users className="w-4 h-4" />
              {selectMode ? 'Cancelar' : 'Fusionar similares'}
            </button>
          )}
          {view === 'clusters' && (
            <button
              onClick={handleRefreshClusters}
              disabled={clusterJob.status === 'running' || selectMode}
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${
                clusterJob.status === 'running' || selectMode
                  ? 'bg-lavanda/20 text-lavanda cursor-not-allowed'
                  : 'bg-pizarra text-lavanda hover:bg-lavanda hover:text-white'
              }`}
              title="Recalcular clusters desde cero (descarta cache)"
            >
              <RefreshCw className={`w-4 h-4 ${clusterJob.status === 'running' ? 'animate-spin' : ''}`} />
              Re-clusterizar
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-pizarra border border-red-400/30 rounded-2xl text-sm text-red-300 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-200"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Estado del reconocimiento facial — siempre visible para que el usuario sepa si funciona */}
      {faceStatus && (
        <div className={`mb-6 p-4 rounded-2xl border flex items-start gap-3 ${
          faceStatus.ready
            ? 'bg-pizarra border-pizarra'
            : 'bg-pizarra border-bruma/40'
        }`}>
          {faceStatus.ready ? (
            <Brain className="w-5 h-5 text-lavanda flex-shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-bruma flex-shrink-0 mt-0.5" />
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
            ) : (
              <>
                <p className="font-medium text-marfil mb-0.5">Reconocimiento facial no disponible</p>
                <p className="text-xs text-lavanda-archivo">
                  {faceStatus.lastError || 'Servicio Python (InsightFace) no responde. Puedes seguir registrando personas; el reconocimiento automático en los escaneos se activará cuando arregles el servicio.'}
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
            <span className="text-xs text-lavanda-archivo">
              {reidJob.total > 0 ? `${reidJob.done}/${reidJob.total}` : 'preparando...'}
            </span>
          </div>
          {reidJob.total > 0 && reidJob.status === 'running' && (
            <div className="w-full bg-grafito rounded-full h-2 overflow-hidden mb-2">
              <div
                className="bg-gradient-to-r from-lavanda to-lavanda-claro h-full transition-all duration-300"
                style={{ width: `${Math.round((reidJob.done / reidJob.total) * 100)}%` }}
              />
            </div>
          )}
          {(reidJob.status === 'done' || reidJob.status === 'cancelled') && (
            <div className="text-xs text-lavanda-archivo space-y-0.5">
              <p>{reidJob.changed} {reidJob.changed === 1 ? 'foto actualizada' : 'fotos actualizadas'} con nuevos matches.</p>
              <p>{reidJob.catalogsWritten} {reidJob.catalogsWritten === 1 ? 'carpeta reescrita' : 'carpetas reescritas'}.</p>
              {reidJob.skippedNoDetections > 0 && (
                <p className="text-bruma">
                  {reidJob.skippedNoDetections} {reidJob.skippedNoDetections === 1 ? 'entrada antigua' : 'entradas antiguas'} sin embeddings persistidos — necesitan re-escaneo (Rutas → escanear con IA) para entrar en la re-identificacion.
                </p>
              )}
            </div>
          )}
          {reidJob.status === 'error' && reidJob.errorMessage && (
            <p className="text-xs text-red-400">{reidJob.errorMessage}</p>
          )}
          {(reidJob.status === 'done' || reidJob.status === 'error' || reidJob.status === 'cancelled') && (
            <button
              onClick={() => setReidJob({ jobId: null, status: 'idle', total: 0, done: 0, changed: 0, skippedNoDetections: 0, catalogsWritten: 0 })}
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
                      {c.face_count} {c.face_count === 1 ? 'aparicion' : 'apariciones'}
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
              <p className="text-marfil font-medium text-sm">{promotingCluster.face_count} apariciones en tu archivo</p>
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
                {promoteForm.display_name.trim() && (
                  <p className="text-xs text-bruma mt-1">
                    ID interno: <span className="font-mono text-lavanda-archivo">{slugifyPersonId(promoteForm.display_name) || '(invalido)'}</span>
                  </p>
                )}
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
                const validName = !!slugifyPersonId(promoteForm.display_name);
                const disabled = promoting || !validName || allExcluded;
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
                    {promoting ? 'Creando...' : allExcluded ? 'Incluye al menos una muestra' : 'Crear persona'}
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Layout principal: lista + detalle (vista de personas) */}
      {view === 'persons' && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Lista de personas */}
        <div className="lg:col-span-1">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-lavanda-archivo">
              <RefreshCw className="w-6 h-6 animate-spin mr-2" />
              Cargando...
            </div>
          ) : persons.length === 0 ? (
            <div className="bg-tinta rounded-3xl border border-pizarra p-8 text-center">
              <User className="w-12 h-12 text-lavanda-archivo mx-auto mb-3" />
              <p className="text-marfil font-medium mb-1">Sin personas todavía</p>
              <p className="text-sm text-lavanda-archivo">Pulsa "Añadir persona" para empezar tu registry.</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {persons.map(person => {
                const selected = selectedPerson?.person_id === person.person_id;
                return (
                  <button
                    key={person.person_id}
                    onClick={() => setSelectedPerson(person)}
                    title={person.display_name}
                    className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-pizarra/50 transition-colors"
                  >
                    <div className={`w-16 h-16 rounded-full overflow-hidden flex items-center justify-center transition-all ${
                      selected
                        ? 'ring-2 ring-lavanda ring-offset-2 ring-offset-noche bg-pizarra'
                        : 'bg-pizarra hover:ring-2 hover:ring-lavanda-archivo hover:ring-offset-2 hover:ring-offset-noche'
                    }`}>
                      {avatarSrc(person) ? (
                        <img src={avatarSrc(person)!} alt={person.display_name} className="w-full h-full object-cover" />
                      ) : (
                        <User className="w-7 h-7 text-lavanda-archivo" />
                      )}
                    </div>
                    <p className={`text-xs font-medium truncate w-full text-center ${
                      selected ? 'text-lavanda' : 'text-marfil'
                    }`}>
                      {person.display_name}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Detalle de persona seleccionada */}
        <div className="lg:col-span-2">
          {selectedPerson ? (
            <div className="bg-tinta rounded-3xl border border-pizarra p-6">
              <div className="flex items-start justify-between mb-6">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-pizarra overflow-hidden flex items-center justify-center">
                    {avatarSrc(selectedPerson) ? (
                      <img src={avatarSrc(selectedPerson)!} alt={selectedPerson.display_name} className="w-full h-full object-cover" />
                    ) : (
                      <User className="w-7 h-7 text-lavanda-archivo" />
                    )}
                  </div>
                  <div>
                    <DisplayNameEditor
                      key={selectedPerson.person_id}
                      initial={selectedPerson.display_name}
                      onSave={(name) => handleUpdateDisplayName(selectedPerson, name)}
                    />
                    <p className="text-sm text-lavanda-archivo font-mono">{selectedPerson.person_id}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {faceStatus?.ready && photos.length > 0 && (
                    <button
                      onClick={() => handleRetrain(selectedPerson.person_id)}
                      disabled={trainingIds.has(selectedPerson.person_id)}
                      className={`p-2 rounded-lg transition-colors ${
                        trainingIds.has(selectedPerson.person_id)
                          ? 'bg-lavanda/20 text-lavanda cursor-wait'
                          : 'bg-pizarra text-lavanda hover:bg-lavanda hover:text-white'
                      }`}
                      title="Re-entrenar embeddings desde las fotos actuales"
                    >
                      <Brain className={`w-4 h-4 ${trainingIds.has(selectedPerson.person_id) ? 'animate-pulse' : ''}`} />
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(selectedPerson)}
                    className="p-2 rounded-lg bg-pizarra text-red-300 hover:bg-red-500/20 transition-colors"
                    title="Eliminar persona"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Indicador de estado de entrenamiento */}
              {trainingIds.has(selectedPerson.person_id) && (
                <div className="mb-4 p-2.5 bg-lavanda/10 border border-lavanda/30 rounded-2xl flex items-center gap-2 text-sm">
                  <Brain className="w-4 h-4 text-lavanda animate-pulse" />
                  <span className="text-marfil">Entrenando embeddings faciales...</span>
                </div>
              )}

              {/* Aliases editables */}
              <div className="mb-6">
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Aliases (separados por coma)</label>
                <AliasesEditor
                  initialAliases={selectedPerson.aliases}
                  onSave={(aliases) => handleUpdateAliases(selectedPerson, aliases)}
                />
              </div>

              {/* Fotos de referencia */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-marfil">Fotos de referencia</h3>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-lavanda text-white rounded-full hover:bg-lavanda-claro"
                  >
                    <ImagePlus className="w-3.5 h-3.5" />
                    Subir foto
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => handleUploadPhoto(selectedPerson.person_id, e.target.files)}
                  />
                </div>
                {photos.length === 0 ? (
                  <div className="p-6 border-2 border-dashed border-pizarra rounded-2xl text-center">
                    <Upload className="w-8 h-8 text-lavanda-archivo mx-auto mb-2" />
                    <p className="text-sm text-lavanda-archivo">
                      Sube fotos donde aparezca esta persona. Recomendado: 5-10 fotos con caras claras, distintos ángulos e iluminación.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                    {photos.map(photo => {
                      const isAvatar = selectedPerson.avatar_path?.endsWith(photo.filename);
                      return (
                        <div key={photo.filename} className="relative group rounded-2xl overflow-hidden bg-pizarra aspect-square">
                          <img src={photoSrc(photo)} alt={photo.filename} className="w-full h-full object-cover" />
                          {isAvatar && (
                            <div className="absolute top-2 left-2 bg-lavanda text-white text-xs px-2 py-0.5 rounded-full flex items-center gap-1">
                              <Star className="w-3 h-3 fill-current" />
                              Avatar
                            </div>
                          )}
                          <div className="absolute inset-0 bg-noche/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                            {!isAvatar && (
                              <button
                                onClick={() => handleSetAvatar(selectedPerson.person_id, photo.filename)}
                                className="p-2 bg-lavanda text-white rounded-full hover:bg-lavanda-claro"
                                title="Marcar como avatar"
                              >
                                <Star className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => handleDeletePhoto(selectedPerson.person_id, photo.filename)}
                              className="p-2 bg-red-500/80 text-white rounded-full hover:bg-red-500"
                              title="Eliminar foto"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Apariciones en la biblioteca real */}
              {(() => {
                if (!mediaFiles || mediaFiles.length === 0) return null;
                const appearances = mediaFiles.filter(f =>
                  f.faces?.some(face => face.person_id === selectedPerson.person_id)
                );
                if (appearances.length === 0) {
                  return (
                    <div className="mt-6 p-4 bg-pizarra/40 border border-pizarra rounded-2xl text-center">
                      <p className="text-sm text-lavanda-archivo">
                        Aun no hay apariciones de {selectedPerson.display_name} en la biblioteca.
                      </p>
                      <p className="text-xs text-bruma mt-1">
                        Tras escanear con IA o re-identificar la biblioteca, las fotos donde aparezca apareceran aqui.
                      </p>
                    </div>
                  );
                }
                const previewLimit = 24;
                const preview = appearances.slice(0, previewLimit);
                const remaining = appearances.length - preview.length;
                return (
                  <div className="mt-6">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-marfil">
                        Apariciones en la biblioteca <span className="text-lavanda-archivo font-normal">· {appearances.length}</span>
                      </h3>
                      {onFilterByPerson && (
                        <button
                          onClick={() => onFilterByPerson(selectedPerson.person_id)}
                          className="text-xs text-lavanda hover:text-lavanda-claro font-medium"
                        >
                          Ver todas en la galeria →
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                      {preview.map(file => (
                        <button
                          key={file.id}
                          onClick={() => onSelectFile && onSelectFile(file)}
                          className="relative aspect-square bg-pizarra rounded-xl overflow-hidden group/thumb hover:ring-2 hover:ring-lavanda transition-all"
                          title={file.name}
                        >
                          <img
                            src={file.thumbnail || file.url}
                            alt={file.name}
                            className="w-full h-full object-cover"
                            loading="lazy"
                            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                          />
                          {file.type === 'video' && (
                            <span className="absolute bottom-1 right-1 text-[10px] bg-noche/80 text-marfil px-1.5 py-0.5 rounded">VIDEO</span>
                          )}
                        </button>
                      ))}
                      {remaining > 0 && onFilterByPerson && (
                        <button
                          onClick={() => onFilterByPerson(selectedPerson.person_id)}
                          className="aspect-square bg-pizarra/60 border-2 border-dashed border-pizarra rounded-xl flex items-center justify-center hover:border-lavanda hover:text-lavanda transition-colors text-lavanda-archivo"
                        >
                          <span className="text-sm font-medium">+{remaining}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : (
            (() => {
              const totalPersons = persons.length;
              const withAppearances = persons.filter(p => (filesPerPerson.get(p.person_id) || 0) > 0).length;
              const withoutAvatar = persons.filter(p => !p.avatar_url).length;

              return (
                <div className="bg-tinta rounded-3xl border border-pizarra p-6">
                  {/* Header con stats */}
                  <div className="mb-6">
                    <h2 className="text-xl font-bold text-marfil mb-2">Resumen</h2>
                    <div className="flex flex-wrap gap-4 text-sm">
                      <span className="text-lavanda-archivo">
                        <span className="text-marfil font-semibold">{totalPersons}</span> {totalPersons === 1 ? 'persona' : 'personas'} en total
                      </span>
                      {withAppearances > 0 && (
                        <span className="text-lavanda-archivo">
                          <span className="text-marfil font-semibold">{withAppearances}</span> con apariciones
                        </span>
                      )}
                      {withoutAvatar > 0 && (
                        <span className="text-lavanda-archivo">
                          <span className="text-marfil font-semibold">{withoutAvatar}</span> sin avatar
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Top personas por apariciones */}
                  {topPersonsByCount.length > 0 ? (
                    <div className="mb-6">
                      <h3 className="text-sm font-semibold text-marfil mb-3">Mas apariciones en tu archivo</h3>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {topPersonsByCount.map(({ person, count }) => (
                          <button
                            key={person.person_id}
                            onClick={() => setSelectedPerson(person)}
                            className="group bg-pizarra rounded-2xl p-3 border border-pizarra hover:border-lavanda transition-colors text-left"
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-12 h-12 rounded-full bg-grafito overflow-hidden flex-shrink-0 flex items-center justify-center">
                                {avatarSrc(person) ? (
                                  <img src={avatarSrc(person)!} alt={person.display_name} className="w-full h-full object-cover" />
                                ) : (
                                  <User className="w-5 h-5 text-lavanda-archivo" />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-marfil font-medium text-sm truncate">{person.display_name}</p>
                                <p className="text-xs text-lavanda-archivo">
                                  {count} {count === 1 ? 'aparicion' : 'apariciones'}
                                </p>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="mb-6 p-4 bg-pizarra/40 border border-pizarra rounded-2xl">
                      <p className="text-sm text-marfil font-medium mb-1">Aun no hay apariciones detectadas</p>
                      <p className="text-xs text-lavanda-archivo">
                        Tras escanear con IA o re-identificar la biblioteca, las personas con caras emparejadas apareceran aqui.
                      </p>
                    </div>
                  )}

                  {/* Atajos */}
                  <div className="pt-4 border-t border-pizarra">
                    <p className="text-xs text-lavanda-archivo mb-3">Atajos</p>
                    <div className="flex flex-wrap gap-2">
                      {faceStatus?.ready && (
                        <button
                          onClick={() => {
                            setView('clusters');
                            if (!clusters) loadClusters();
                          }}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm bg-pizarra text-lavanda hover:bg-lavanda hover:text-white transition-colors"
                        >
                          <Search className="w-3.5 h-3.5" />
                          Descubrir caras desconocidas
                        </button>
                      )}
                      <button
                        onClick={() => setShowCreate(true)}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm bg-pizarra text-lavanda hover:bg-lavanda hover:text-white transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Añadir persona manualmente
                      </button>
                    </div>
                    <p className="text-xs text-bruma mt-4">
                      Selecciona una persona en la lista de la izquierda para ver sus fotos y apariciones.
                    </p>
                  </div>
                </div>
              );
            })()
          )}
        </div>
      </div>
      )}

      {/* Nota informativa */}
      <div className="mt-8 p-4 bg-pizarra/50 border border-pizarra rounded-2xl">
        <h4 className="text-sm font-medium text-marfil mb-1">Cómo funciona el reconocimiento</h4>
        <p className="text-xs text-lavanda-archivo">
          Al subir fotos de referencia (5-10 con caras claras y distintos ángulos funciona mejor), Pensadero calcula un
          <span className="font-mono text-bruma"> embedding facial</span> con InsightFace y lo guarda junto a las fotos.
          Cuando escanees nuevas carpetas, las caras detectadas se comparan contra el registry y, si la similitud supera el umbral,
          se asocian al <span className="font-mono text-bruma">person_id</span> correspondiente. Esto alimenta las búsquedas tipo
          "fotos de Ester en el cumpleaños".
        </p>
      </div>
    </div>
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
      placeholder="Ester, Esti, mi prima"
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
