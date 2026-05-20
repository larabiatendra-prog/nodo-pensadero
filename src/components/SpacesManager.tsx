import React, { useEffect, useRef, useState } from 'react';
import { MapPin, Plus, Trash2, Upload, Star, RefreshCw, X, ArrowLeft, ImagePlus, Brain, AlertTriangle, Sparkles } from 'lucide-react';
import { api } from '../services/api';
import { API_CONFIG, config } from '../config';
import { useWebSocket } from '../hooks/useWebSocket';

/**
 * SpacesManager — gestion de espacios fisicos con place recognition CLIP.
 *
 * Patron analogo a PersonsManager. Diferencias:
 *  - El "modelo de reconocimiento" es CLIP / M-CLIP (place rec por similitud
 *    visual), no InsightFace
 *  - El "avatar" se llama "cover" (foto representativa del lugar)
 *  - Tras subir/borrar foto de referencia, se recalcula el CENTROIDE CLIP
 *    automaticamente en background
 *  - Threshold de match mas conservador (~0.6) configurable via env
 */

interface Space {
  space_id: string;
  display_name: string;
  aliases: string[];
  cover_image_path: string | null;
  cover_url: string | null;
  ref_photo_count: number;
  trained: boolean;
  trained_at: string | null;
}

interface SpacePhoto {
  filename: string;
  url: string;
}

interface SpacesManagerProps {
  onBack?: () => void;
  mediaFiles?: import('../types').MediaFile[];
  onSelectFile?: (file: import('../types').MediaFile) => void;
  onFilterBySpace?: (spaceId: string) => void;
}

export default function SpacesManager({ onBack, mediaFiles, onSelectFile, onFilterBySpace }: SpacesManagerProps) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSpace, setSelectedSpace] = useState<Space | null>(null);
  const [photos, setPhotos] = useState<SpacePhoto[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [clipStatus, setClipStatus] = useState<{ ready: boolean; unavailable: boolean; lastError: string | null; embeddingDim: number; trainedSpaces: number } | null>(null);
  const [trainingIds, setTrainingIds] = useState<Set<string>>(new Set());

  // Threshold global de matching (cosine similarity). Default 0.7, ajustable.
  const [threshold, setThreshold] = useState<number>(0.7);
  const [defaultThreshold, setDefaultThreshold] = useState<number>(0.7);
  const [savingThreshold, setSavingThreshold] = useState(false);

  // Re-identificacion de la biblioteca
  type ReidStatus = 'idle' | 'running' | 'done' | 'error';
  const [reidJob, setReidJob] = useState<{
    status: ReidStatus;
    total: number;
    done: number;
    changed: number;
    skippedNoEmbedding: number;
    catalogsWritten: number;
    errorMessage?: string;
  }>({ status: 'idle', total: 0, done: 0, changed: 0, skippedNoEmbedding: 0, catalogsWritten: 0 });

  const { progressData } = useWebSocket(config.wsUrl);

  // Listener WS para eventos reidentify_space_*
  useEffect(() => {
    if (!progressData) return;
    const d: any = progressData;
    if (!d.type || !String(d.type).startsWith('reidentify_space_')) return;
    if (d.type === 'reidentify_space_start') {
      setReidJob(prev => ({ ...prev, status: 'running' }));
    } else if (d.type === 'reidentify_space_progress') {
      setReidJob(prev => ({
        ...prev,
        status: 'running',
        total: d.total ?? prev.total,
        done: d.done ?? prev.done,
        changed: d.changed ?? prev.changed,
        skippedNoEmbedding: d.skippedNoEmbedding ?? prev.skippedNoEmbedding,
      }));
    } else if (d.type === 'reidentify_space_done') {
      setReidJob({
        status: 'done',
        total: d.total ?? 0,
        done: d.done ?? 0,
        changed: d.changed ?? 0,
        skippedNoEmbedding: d.skippedNoEmbedding ?? 0,
        catalogsWritten: d.catalogsWritten ?? 0,
      });
    } else if (d.type === 'reidentify_space_error') {
      setReidJob(prev => ({ ...prev, status: 'error', errorMessage: d.error || 'Error' }));
    }
  }, [progressData]);

  async function handleReidentify() {
    setError(null);
    setReidJob({ status: 'running', total: 0, done: 0, changed: 0, skippedNoEmbedding: 0, catalogsWritten: 0 });
    try {
      const r: any = await api.reidentifySpaces();
      if (!r.success) throw new Error(r.error || 'Error iniciando re-identificacion');
    } catch (err: any) {
      setReidJob({ status: 'error', total: 0, done: 0, changed: 0, skippedNoEmbedding: 0, catalogsWritten: 0, errorMessage: err.message || 'Error' });
    }
  }

  const [newSpaceId, setNewSpaceId] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newAliases, setNewAliases] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadSpaces();
    loadClipStatus();
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const r = await api.getSpacesSettings();
      if (r.success && r.data) {
        setThreshold(r.data.match_threshold);
        setDefaultThreshold(r.data.default_threshold);
      }
    } catch {}
  }

  async function saveThreshold(value: number) {
    setSavingThreshold(true);
    try {
      const r = await api.setSpacesThreshold(value);
      if (r.success && r.data) setThreshold(r.data.match_threshold);
    } catch (err: any) {
      setError(err.message || 'Error guardando threshold');
    } finally {
      setSavingThreshold(false);
    }
  }

  // Polling automatico mientras el daemon CLIP no esta listo
  useEffect(() => {
    if (clipStatus?.ready) return;
    const interval = setInterval(() => { loadClipStatus(); }, 3000);
    return () => clearInterval(interval);
  }, [clipStatus?.ready]);

  async function loadClipStatus() {
    try {
      const r = await api.clipServiceStatus();
      if (r.success && r.data) setClipStatus(r.data);
    } catch {
      setClipStatus({ ready: false, unavailable: true, lastError: 'No se pudo consultar', embeddingDim: 512, trainedSpaces: 0 });
    }
  }

  useEffect(() => {
    if (selectedSpace) {
      loadPhotos(selectedSpace.space_id);
    } else {
      setPhotos([]);
    }
  }, [selectedSpace]);

  async function loadSpaces() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listSpacesRegistry();
      if (res.success && Array.isArray(res.data)) {
        setSpaces(res.data as Space[]);
      } else {
        setSpaces([]);
      }
    } catch (err: any) {
      setError(err.message || 'Error cargando espacios');
    } finally {
      setLoading(false);
    }
  }

  async function loadPhotos(spaceId: string) {
    try {
      const res = await api.listSpacePhotos(spaceId);
      if (res.success && Array.isArray(res.data)) setPhotos(res.data);
      else setPhotos([]);
    } catch {
      setPhotos([]);
    }
  }

  async function handleCreate() {
    setError(null);
    const id = newSpaceId.trim();
    const display = newDisplayName.trim();
    if (!id) { setError('space_id es requerido'); return; }
    if (!/^[a-zA-Z0-9_\-]+$/.test(id)) { setError('space_id sólo letras, números, _ y -'); return; }
    const aliases = newAliases.split(',').map(a => a.trim()).filter(Boolean);
    try {
      const res = await api.upsertSpace({ space_id: id, display_name: display || id, aliases });
      if (!res.success) throw new Error((res as any).error || 'Error creando espacio');
      setShowCreate(false);
      setNewSpaceId('');
      setNewDisplayName('');
      setNewAliases('');
      await loadSpaces();
    } catch (err: any) {
      setError(err.message || 'Error creando espacio');
    }
  }

  async function handleUpdateAliases(space: Space, aliases: string[]) {
    try {
      await api.upsertSpace({ space_id: space.space_id, aliases });
      await loadSpaces();
      if (selectedSpace?.space_id === space.space_id) {
        const updated = (await api.listSpacesRegistry()).data?.find((s: any) => s.space_id === space.space_id);
        if (updated) setSelectedSpace(updated as Space);
      }
    } catch (err: any) {
      setError(err.message || 'Error actualizando');
    }
  }

  async function handleDelete(space: Space) {
    if (!confirm(`¿Eliminar el espacio "${space.display_name}" y todas sus fotos? Esta acción no se puede deshacer.`)) return;
    try {
      await api.deleteSpace(space.space_id);
      if (selectedSpace?.space_id === space.space_id) setSelectedSpace(null);
      await loadSpaces();
    } catch (err: any) {
      setError(err.message || 'Error eliminando');
    }
  }

  async function handleUploadPhoto(spaceId: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    if (clipStatus?.ready) setTrainingIds(prev => new Set(prev).add(spaceId));
    try {
      for (const f of Array.from(files)) {
        await api.uploadSpacePhoto(spaceId, f);
      }
      await loadPhotos(spaceId);
      await loadSpaces();
      // El backend dispara train en background; refrescar status tras unos segundos
      setTimeout(() => {
        loadClipStatus();
        loadSpaces();
        setTrainingIds(prev => { const n = new Set(prev); n.delete(spaceId); return n; });
      }, 3000);
    } catch (err: any) {
      setError(err.message || 'Error subiendo foto');
      setTrainingIds(prev => { const n = new Set(prev); n.delete(spaceId); return n; });
    }
  }

  async function handleRetrain(spaceId: string) {
    setError(null);
    setTrainingIds(prev => new Set(prev).add(spaceId));
    try {
      const r = await api.trainSpace(spaceId);
      if (!r.success) throw new Error((r as any).error || 'Error entrenando');
      await loadClipStatus();
      await loadSpaces();
    } catch (err: any) {
      setError(err.message || 'Error entrenando');
    } finally {
      setTrainingIds(prev => { const n = new Set(prev); n.delete(spaceId); return n; });
    }
  }

  async function handleDeletePhoto(spaceId: string, filename: string) {
    if (!confirm('¿Eliminar esta foto de referencia?')) return;
    try {
      await api.deleteSpacePhoto(spaceId, filename);
      await loadPhotos(spaceId);
      await loadSpaces();
    } catch (err: any) {
      setError(err.message || 'Error eliminando foto');
    }
  }

  async function handleSetCover(spaceId: string, filename: string) {
    try {
      await api.setSpaceCover(spaceId, filename);
      await loadSpaces();
    } catch (err: any) {
      setError(err.message || 'Error');
    }
  }

  function coverSrc(space: Space): string | null {
    if (!space.cover_url) return null;
    if (space.cover_url.startsWith('http')) return space.cover_url;
    return `${API_CONFIG.apiUrl.replace(/\/api$/, '')}${space.cover_url}`;
  }

  function photoSrc(photo: SpacePhoto): string {
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
          <h1 className="text-2xl font-bold text-marfil mb-2 flex items-center gap-3">
            <MapPin className="w-7 h-7 text-lavanda" />
            Espacios
          </h1>
          <p className="text-lavanda-archivo">
            Lugares físicos de tu archivo (Auditorio EDEM, Marina de Empresas...). Sube fotos de referencia y CLIP aprenderá a reconocerlos automáticamente en futuras fotos.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {clipStatus?.ready && clipStatus.trainedSpaces > 0 && (
            <button
              onClick={handleReidentify}
              disabled={reidJob.status === 'running'}
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${
                reidJob.status === 'running'
                  ? 'bg-lavanda/20 text-lavanda cursor-wait'
                  : 'bg-pizarra text-lavanda hover:bg-lavanda hover:text-white'
              }`}
              title="Recalcular matches en fotos ya escaneadas con el threshold y centroides actuales (sin re-correr CLIP)"
            >
              <Sparkles className={`w-4 h-4 ${reidJob.status === 'running' ? 'animate-pulse' : ''}`} />
              Re-identificar biblioteca
            </button>
          )}
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-lavanda text-white rounded-full hover:bg-lavanda-claro transition-colors font-medium"
          >
            <Plus className="w-4 h-4" />
            Añadir espacio
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-pizarra border border-red-400/30 rounded-2xl text-sm text-red-300 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-200"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Estado del CLIP service */}
      {clipStatus && (
        <div className={`mb-6 p-4 rounded-2xl border flex items-start gap-3 ${
          clipStatus.ready ? 'bg-pizarra border-pizarra' : 'bg-pizarra border-bruma/40'
        }`}>
          {clipStatus.ready ? (
            <Brain className="w-5 h-5 text-lavanda flex-shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-bruma flex-shrink-0 mt-0.5" />
          )}
          <div className="flex-1 text-sm">
            {clipStatus.ready ? (
              <>
                <p className="font-medium text-marfil mb-0.5">
                  Reconocimiento de espacios activo (M-CLIP)
                  {clipStatus.trainedSpaces > 0 && (
                    <span className="ml-2 text-xs text-lavanda-archivo">· {clipStatus.trainedSpaces} {clipStatus.trainedSpaces === 1 ? 'espacio entrenado' : 'espacios entrenados'}</span>
                  )}
                </p>
                <p className="text-xs text-lavanda-archivo">
                  Al subir fotos, el sistema calcula automáticamente el centroide CLIP. En futuros escaneos, las fotos del archivo se compararán contra estos centroides.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-marfil mb-0.5">Reconocimiento de espacios cargando...</p>
                <p className="text-xs text-lavanda-archivo">
                  {clipStatus.lastError || 'El daemon CLIP se carga la primera vez que se necesita (puede tardar 15-30s). Puedes seguir registrando espacios; el reconocimiento automático se activará cuando esté listo.'}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Banner de progreso de re-identificacion */}
      {reidJob.status !== 'idle' && (
        <div className="mb-6 p-4 bg-pizarra border border-lavanda/30 rounded-2xl">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Sparkles className={`w-4 h-4 text-lavanda ${reidJob.status === 'running' ? 'animate-pulse' : ''}`} />
              <span className="text-sm font-medium text-marfil">
                {reidJob.status === 'running' && 'Re-identificando biblioteca...'}
                {reidJob.status === 'done' && 'Re-identificacion completada'}
                {reidJob.status === 'error' && 'Error en re-identificacion'}
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
          {reidJob.status === 'done' && (
            <div className="text-xs text-lavanda-archivo space-y-0.5">
              <p>{reidJob.changed} {reidJob.changed === 1 ? 'foto actualizada' : 'fotos actualizadas'}.</p>
              <p>{reidJob.catalogsWritten} {reidJob.catalogsWritten === 1 ? 'carpeta reescrita' : 'carpetas reescritas'}.</p>
              {reidJob.skippedNoEmbedding > 0 && (
                <p className="text-bruma">
                  {reidJob.skippedNoEmbedding} {reidJob.skippedNoEmbedding === 1 ? 'entrada sin embedding CLIP' : 'entradas sin embedding CLIP'} (necesitan re-scan con Zap).
                </p>
              )}
            </div>
          )}
          {reidJob.status === 'error' && reidJob.errorMessage && (
            <p className="text-xs text-red-400">{reidJob.errorMessage}</p>
          )}
          {(reidJob.status === 'done' || reidJob.status === 'error') && (
            <button
              onClick={() => setReidJob({ status: 'idle', total: 0, done: 0, changed: 0, skippedNoEmbedding: 0, catalogsWritten: 0 })}
              className="mt-2 text-xs text-lavanda-archivo hover:text-marfil"
            >
              Cerrar
            </button>
          )}
        </div>
      )}

      {/* Slider de threshold global */}
      {clipStatus?.ready && (
        <div className="mb-6 p-4 bg-pizarra/40 border border-pizarra rounded-2xl">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-medium text-marfil">Umbral de coincidencia</p>
              <p className="text-xs text-lavanda-archivo">
                Cuanto más alto, más estricto. Una foto se etiqueta con un espacio solo si la similitud CLIP supera este valor.
              </p>
            </div>
            <span className="text-sm font-mono text-marfil bg-pizarra px-3 py-1 rounded-full">
              {threshold.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0.4}
            max={0.95}
            step={0.01}
            value={threshold}
            onChange={e => setThreshold(parseFloat(e.target.value))}
            onMouseUp={() => saveThreshold(threshold)}
            onTouchEnd={() => saveThreshold(threshold)}
            disabled={savingThreshold}
            className="w-full accent-lavanda"
          />
          <div className="flex justify-between text-[10px] text-bruma mt-0.5">
            <span>0.40 (laxo)</span>
            <span>default {defaultThreshold.toFixed(2)}</span>
            <span>0.95 (estricto)</span>
          </div>
        </div>
      )}

      {/* Modal: crear espacio */}
      {showCreate && (
        <div className="fixed inset-0 bg-noche/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-tinta rounded-3xl border border-pizarra p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-marfil">Nuevo espacio</h2>
              <button onClick={() => { setShowCreate(false); setError(null); }} className="text-lavanda-archivo hover:text-marfil">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">ID interno <span className="text-bruma">*</span></label>
                <input
                  type="text"
                  value={newSpaceId}
                  onChange={e => setNewSpaceId(e.target.value)}
                  placeholder="auditorio_edem, marina_empresas..."
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Nombre a mostrar</label>
                <input
                  type="text"
                  value={newDisplayName}
                  onChange={e => setNewDisplayName(e.target.value)}
                  placeholder="Auditorio EDEM"
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Aliases (separados por coma)</label>
                <input
                  type="text"
                  value={newAliases}
                  onChange={e => setNewAliases(e.target.value)}
                  placeholder="EDEM, Auditorio principal"
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => { setShowCreate(false); setError(null); }} className="px-4 py-2 text-lavanda-archivo hover:text-marfil">Cancelar</button>
              <button onClick={handleCreate} className="px-4 py-2 bg-lavanda text-white rounded-full hover:bg-lavanda-claro font-medium">Crear</button>
            </div>
          </div>
        </div>
      )}

      {/* Layout principal */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Lista de espacios */}
        <div className="lg:col-span-1">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-lavanda-archivo">
              <RefreshCw className="w-6 h-6 animate-spin mr-2" />
              Cargando...
            </div>
          ) : spaces.length === 0 ? (
            <div className="bg-tinta rounded-3xl border border-pizarra p-8 text-center">
              <MapPin className="w-12 h-12 text-lavanda-archivo mx-auto mb-3" />
              <p className="text-marfil font-medium mb-1">Sin espacios todavia</p>
              <p className="text-sm text-lavanda-archivo">Pulsa "Añadir espacio" para registrar el primero.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {spaces.map(space => (
                <button
                  key={space.space_id}
                  onClick={() => setSelectedSpace(space)}
                  className={`w-full text-left p-3 rounded-2xl border transition-colors flex items-center gap-3 ${
                    selectedSpace?.space_id === space.space_id ? 'bg-lavanda/10 border-lavanda' : 'bg-tinta border-pizarra hover:border-lavanda-archivo'
                  }`}
                >
                  <div className="w-10 h-10 rounded-xl bg-pizarra overflow-hidden flex-shrink-0 flex items-center justify-center">
                    {coverSrc(space) ? (
                      <img src={coverSrc(space)!} alt={space.display_name} className="w-full h-full object-cover" />
                    ) : (
                      <MapPin className="w-5 h-5 text-lavanda-archivo" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-marfil font-medium truncate">{space.display_name}</p>
                    <p className="text-xs text-lavanda-archivo truncate font-mono">
                      {space.ref_photo_count} {space.ref_photo_count === 1 ? 'foto' : 'fotos'}
                      {space.trained && <span className="ml-2 text-lavanda">· entrenado</span>}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Detalle */}
        <div className="lg:col-span-2">
          {selectedSpace ? (
            <div className="bg-tinta rounded-3xl border border-pizarra p-6">
              <div className="flex items-start justify-between mb-6">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-xl bg-pizarra overflow-hidden flex items-center justify-center">
                    {coverSrc(selectedSpace) ? (
                      <img src={coverSrc(selectedSpace)!} alt={selectedSpace.display_name} className="w-full h-full object-cover" />
                    ) : (
                      <MapPin className="w-7 h-7 text-lavanda-archivo" />
                    )}
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-marfil">{selectedSpace.display_name}</h2>
                    <p className="text-sm text-lavanda-archivo font-mono">{selectedSpace.space_id}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {clipStatus?.ready && photos.length > 0 && (
                    <button
                      onClick={() => handleRetrain(selectedSpace.space_id)}
                      disabled={trainingIds.has(selectedSpace.space_id)}
                      className={`p-2 rounded-lg transition-colors ${
                        trainingIds.has(selectedSpace.space_id) ? 'bg-lavanda/20 text-lavanda cursor-wait' : 'bg-pizarra text-lavanda hover:bg-lavanda hover:text-white'
                      }`}
                      title="Recalcular centroide CLIP desde las fotos actuales"
                    >
                      <Brain className={`w-4 h-4 ${trainingIds.has(selectedSpace.space_id) ? 'animate-pulse' : ''}`} />
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(selectedSpace)}
                    className="p-2 rounded-lg bg-pizarra text-red-300 hover:bg-red-500/20 transition-colors"
                    title="Eliminar espacio"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {trainingIds.has(selectedSpace.space_id) && (
                <div className="mb-4 p-2.5 bg-lavanda/10 border border-lavanda/30 rounded-2xl flex items-center gap-2 text-sm">
                  <Brain className="w-4 h-4 text-lavanda animate-pulse" />
                  <span className="text-marfil">Calculando centroide CLIP...</span>
                </div>
              )}

              {/* Aliases editables */}
              <div className="mb-6">
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Aliases (separados por coma)</label>
                <AliasesEditor
                  initialAliases={selectedSpace.aliases}
                  onSave={(aliases) => handleUpdateAliases(selectedSpace, aliases)}
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
                    onChange={(e) => handleUploadPhoto(selectedSpace.space_id, e.target.files)}
                  />
                </div>
                {photos.length === 0 ? (
                  <div className="p-6 border-2 border-dashed border-pizarra rounded-2xl text-center">
                    <Upload className="w-8 h-8 text-lavanda-archivo mx-auto mb-2" />
                    <p className="text-sm text-lavanda-archivo">
                      Sube 5-10 fotos del espacio desde distintos ángulos. M-CLIP calculará un centroide que servirá para detectarlo automáticamente.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                    {photos.map(photo => {
                      const isCover = selectedSpace.cover_image_path?.endsWith(photo.filename);
                      return (
                        <div key={photo.filename} className="relative group rounded-2xl overflow-hidden bg-pizarra aspect-square">
                          <img src={photoSrc(photo)} alt={photo.filename} className="w-full h-full object-cover" />
                          {isCover && (
                            <div className="absolute top-2 left-2 bg-lavanda text-white text-xs px-2 py-0.5 rounded-full flex items-center gap-1">
                              <Star className="w-3 h-3 fill-current" />
                              Cover
                            </div>
                          )}
                          <div className="absolute inset-0 bg-noche/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                            {!isCover && (
                              <button
                                onClick={() => handleSetCover(selectedSpace.space_id, photo.filename)}
                                className="p-2 bg-lavanda text-white rounded-full hover:bg-lavanda-claro"
                                title="Marcar como cover"
                              >
                                <Star className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => handleDeletePhoto(selectedSpace.space_id, photo.filename)}
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

              {/* Apariciones en la biblioteca */}
              {(() => {
                if (!mediaFiles || mediaFiles.length === 0) return null;
                const appearances = mediaFiles.filter(f =>
                  (f as any).spaces?.some?.((sp: any) => sp.space_id === selectedSpace.space_id)
                );
                if (appearances.length === 0) {
                  return (
                    <div className="mt-6 p-4 bg-pizarra/40 border border-pizarra rounded-2xl text-center">
                      <p className="text-sm text-lavanda-archivo">
                        Aun no hay apariciones de {selectedSpace.display_name} en la biblioteca.
                      </p>
                      <p className="text-xs text-bruma mt-1">
                        Tras escanear con IA, las fotos que CLIP identifique como este espacio apareceran aqui.
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
                      {onFilterBySpace && (
                        <button
                          onClick={() => onFilterBySpace(selectedSpace.space_id)}
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
                          <img src={file.thumbnail || file.url} alt={file.name} className="w-full h-full object-cover" loading="lazy" />
                          {file.type === 'video' && (
                            <span className="absolute bottom-1 right-1 text-[10px] bg-noche/80 text-marfil px-1.5 py-0.5 rounded">VIDEO</span>
                          )}
                        </button>
                      ))}
                      {remaining > 0 && onFilterBySpace && (
                        <button
                          onClick={() => onFilterBySpace(selectedSpace.space_id)}
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
            <div className="bg-tinta rounded-3xl border border-pizarra p-12 text-center">
              <MapPin className="w-12 h-12 text-lavanda-archivo mx-auto mb-3" />
              <p className="text-marfil font-medium mb-1">Selecciona un espacio</p>
              <p className="text-sm text-lavanda-archivo">O añade uno nuevo con el botón de arriba.</p>
            </div>
          )}
        </div>
      </div>

      {/* Nota */}
      <div className="mt-8 p-4 bg-pizarra/50 border border-pizarra rounded-2xl">
        <h4 className="text-sm font-medium text-marfil mb-1">Cómo funciona el reconocimiento de espacios</h4>
        <p className="text-xs text-lavanda-archivo">
          Subes 5-10 fotos del lugar (Auditorio EDEM, Marina de Empresas, tu salón...) desde ángulos distintos. M-CLIP calcula un
          <span className="font-mono text-bruma"> embedding visual</span> de cada una y promedia un centroide para el espacio.
          Al escanear con IA tus carpetas, cada foto se compara contra todos los centroides; si supera el umbral, se asocia al
          <span className="font-mono text-bruma"> space_id</span> correspondiente. Esto alimenta búsquedas tipo "fotos en EDEM" y Smart Folders.
        </p>
      </div>
    </div>
  );
}

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
    if (aliases.join(',') !== initialAliases.join(',')) onSave(aliases);
  };
  return (
    <input
      type="text"
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
      placeholder="EDEM, Auditorio principal"
      className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda text-sm"
    />
  );
}
