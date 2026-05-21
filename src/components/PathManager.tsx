import React, { useState, useEffect, useRef } from 'react';
import { FolderOpen, RefreshCw, Unlink, Plus, Trash2, CheckCircle, AlertCircle, Clock, Sparkles, Zap, Square } from 'lucide-react';
import { api } from '../services/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { config } from '../config';
import ScanContextModal from './ScanContextModal';

interface ScanPath {
  id: string;
  path: string;
  isActive: boolean;
  lastScan: Date | null;
  fileCount: number;
  status: 'connected' | 'disconnected' | 'scanning' | 'error';
  errorMessage?: string;
}

interface AiScanState {
  jobId: string | null;
  total: number;
  done: number;
  errors: number;
  currentFile?: string;
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  errorMessage?: string;
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

  // Estado de escaneo visual con IA por ruta. Map: pathId → estado.
  const [aiScansByPath, setAiScansByPath] = useState<Map<string, AiScanState>>(new Map());
  // Map: jobId → pathId para resolver eventos WebSocket.
  // useRef para evitar stale closure cuando el WS evento llega antes de que
  // React aplique el setState (race condition entre POST /scan/start y el
  // evento scan_start emitido por el backend con setImmediate).
  const jobIdToPathIdRef = useRef<Map<string, string>>(new Map());

  // Estado de salud del VLM (Ollama + modelo). Se consulta al montar.
  const [vlmHealth, setVlmHealth] = useState<{ ollamaRunning: boolean; modelAvailable: boolean; model: string; error?: string } | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');

  // Modal de contexto previo al escaneo. Cuando se abre, contiene el id de
  // la ruta para la que estamos preparando el scan; al confirmar, lanza el
  // escaneo real.
  const [contextModalPathId, setContextModalPathId] = useState<string | null>(null);

  // Estado del bucle batch "Escanear todas las rutas". Solo uno activo a la vez.
  const [batchScan, setBatchScan] = useState<{ running: boolean; total: number; processed: number; force: boolean } | null>(null);

  // WebSocket para progreso en tiempo real
  const { isConnected, progressData } = useWebSocket(config.wsUrl);

  useEffect(() => {
    loadPaths();
    // Cargar health del VLM al entrar — diagnóstico al usuario si Ollama
    // o el modelo no están listos.
    api.scanHealth().then(r => {
      if (r.success && r.data) setVlmHealth(r.data);
    }).catch(() => setVlmHealth({ ollamaRunning: false, modelAvailable: false, model: 'qwen2.5vl:7b' }));
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

  // Escuchar progreso de sincronización Y de escaneo visual IA
  useEffect(() => {
    if (!progressData) return;

    if (progressData.type === 'sync_complete') {
      // Recargar las rutas para actualizar los contadores
      loadPaths();

      // Notificar al componente padre para refrescar los archivos
      if (onSyncComplete) {
        setTimeout(() => {
          onSyncComplete();
        }, 1000); // Pequeño delay para asegurar que el backend completó todo
      }
    }

    // Eventos del escaneo visual IA (visualScanService).
    // Resolver pathId desde el ref (sin closure stale) o, como fallback, desde
    // el unico path en estado running — util cuando el WS llega antes de que
    // jobIdToPathIdRef se actualice en el handler de startScan.
    const resolvePid = (jobId: string | undefined): string | undefined => {
      if (jobId) {
        const fromRef = jobIdToPathIdRef.current.get(jobId);
        if (fromRef) return fromRef;
      }
      // Fallback: si solo hay un path actualmente en running, asociar el evento a el
      let candidate: string | undefined;
      let count = 0;
      for (const [pid, st] of aiScansByPath.entries()) {
        if (st.status === 'running') { candidate = pid; count++; }
      }
      if (count === 1 && candidate && jobId) {
        // Aprovechar para repoblar el mapping para futuros eventos
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
            jobId: progressData.jobId,
            total: 0,
            done: 0,
            errors: 0,
            status: 'running',
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
          const cur = next.get(pid) || { jobId: progressData.jobId, total: 0, done: 0, errors: 0, status: 'running' as const };
          next.set(pid, {
            ...cur,
            jobId: progressData.jobId,
            total: progressData.total ?? cur.total,
            done: progressData.done ?? cur.done,
            errors: progressData.errors ?? cur.errors,
            currentFile: progressData.file,
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
              status: 'done',
              currentFile: undefined,
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
  }, [progressData, onSyncComplete, aiScansByPath]);

  const loadPaths = async () => {
    try {
      setIsLoading(true);
      const response = await api.getScanPaths();
      if (response.success && response.data) {
        setPaths(response.data.map((path: any) => ({
          ...path,
          lastScan: path.lastScan ? new Date(path.lastScan) : null
        })));
      }
    } catch (error) {
      console.error('Error cargando rutas:', error);
      // Si no existe el endpoint, usar ruta por defecto
      setPaths([{
        id: 'default',
        path: 'D:\\Biblioteca_Prueba_MarinaFinder',
        isActive: true,
        lastScan: new Date(),
        fileCount: 0,
        status: 'connected'
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddPath = async () => {
    if (!newPath.trim()) return;

    try {
      const response = await api.addScanPath(newPath);
      if (response.success && response.data) {
        setPaths([...paths, {
          ...response.data,
          lastScan: response.data.lastScan ? new Date(response.data.lastScan) : null
        }]);
        setNewPath('');
        setShowAddPath(false);
      }
    } catch (error) {
      console.error('Error añadiendo ruta:', error);
      alert('Error al añadir la ruta. Verifica que existe y tienes permisos.');
    }
  };

  const handleSyncPath = async (pathId: string) => {
    setScanningPaths(prev => new Set([...prev, pathId]));
    
    try {
      // Actualizar estado local inmediatamente
      setPaths(prev => prev.map(p => 
        p.id === pathId ? { ...p, status: 'scanning' } : p
      ));

      const response = await api.syncPath(pathId);
      if (response.success) {
        console.log(`✅ Sincronización exitosa: ${response.fileCount} archivos`);
        
        // Actualizar con los datos del servidor
        setPaths(prev => prev.map(p => 
          p.id === pathId 
            ? { 
                ...p, 
                status: 'connected',
                lastScan: new Date(),
                fileCount: response.fileCount || p.fileCount,
                isActive: true,
                errorMessage: undefined
              } 
            : p
        ));
        
        // Mostrar notificación de éxito
        alert(`✅ Sincronización completada: ${response.fileCount} archivos encontrados`);
      }
    } catch (error) {
      console.error('Error sincronizando ruta:', error);
      setPaths(prev => prev.map(p => 
        p.id === pathId 
          ? { ...p, status: 'error', errorMessage: 'Error al sincronizar. Verifica que la ruta existe.' } 
          : p
      ));
      alert('❌ Error al sincronizar la ruta. Verifica que existe y tienes permisos.');
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
      const response = await api.togglePath(pathId, !currentStatus);
      if (response.success) {
        setPaths(prev => prev.map(p => 
          p.id === pathId 
            ? { 
                ...p, 
                isActive: !currentStatus,
                status: !currentStatus ? 'connected' : 'disconnected'
              } 
            : p
        ));
      }
    } catch (error) {
      console.error('Error cambiando estado de ruta:', error);
    }
  };

  /**
   * Lanza un escaneo visual con IA sobre la carpeta de la ruta. El backend
   * recorre todas las imágenes, las describe con qwen2.5vl, y guarda los
   * resultados en `_pensadero.json` por carpeta.
   */
  const handleAiScan = async (pathId: string, force: boolean = false) => {
    const path = paths.find(p => p.id === pathId);
    if (!path) return;

    // Limpiar estado previo de esta ruta
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
        // Registrar el mapeo en el ref (sincronicamente, sin esperar al
        // proximo render). Asi los eventos WS que ya hayan llegado al
        // listener tras el ultimo render encuentran el path correcto.
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
          jobId: null,
          total: 0,
          done: 0,
          errors: 0,
          status: 'error',
          errorMessage: err.message || 'Error desconocido',
        });
        return next;
      });
    }
  };

  /**
   * Escaneo masivo: dispara la IA sobre TODAS las rutas activas en serie.
   * Devuelve los jobIds en el orden de las rutas activas para pre-poblar
   * el mapping jobId↔pathId y que el progreso por ruta se renderize
   * correctamente.
   */
  const handleScanAll = async (force: boolean) => {
    if (batchScan?.running) return;
    const activeCount = paths.filter(p => p.isActive).length;
    if (activeCount === 0) {
      alert('No hay rutas activas para escanear');
      return;
    }
    if (force) {
      if (!confirm(`¿Re-escanear con IA las ${activeCount} rutas activas (incluso ya catalogadas)? Puede tardar bastante.`)) return;
    }
    try {
      const r: any = await api.startScanAll(force);
      if (!r.success) throw new Error(r.error || 'Error iniciando escaneo masivo');
      const jobIds: string[] = Array.isArray(r.jobIds) ? r.jobIds : [];
      const activePaths = paths.filter(p => p.isActive);
      // Pre-poblar el ref antes de que lleguen eventos WS (mismo patron que handleAiScan)
      for (let i = 0; i < jobIds.length && i < activePaths.length; i++) {
        jobIdToPathIdRef.current.set(jobIds[i], activePaths[i].id);
      }
      setBatchScan({ running: true, total: r.count || activePaths.length, processed: 0, force });
    } catch (err: any) {
      alert('Error: ' + (err.message || 'desconocido'));
    }
  };

  const handleCancelAll = async () => {
    if (!batchScan?.running) return;
    if (!confirm('¿Detener el escaneo masivo? Se cancelará la ruta actual y no se procesarán las restantes.')) return;
    try {
      await api.cancelScanAll();
    } catch {
      // El estado se reseteara con batch_scan_done
    }
  };

  /**
   * Cancela el escaneo IA de UNA ruta concreta. El backend hace break del
   * bucle en cuanto procesa el archivo actual y escribe a disco los
   * _pensadero.json con todo lo procesado hasta el cancel.
   */
  const handleCancelScan = async (pathId: string) => {
    const scan = aiScansByPath.get(pathId);
    if (!scan || !scan.jobId || scan.status !== 'running') return;
    if (!confirm('¿Detener el escaneo de esta ruta? Lo procesado hasta ahora se guardara en disco.')) return;
    try {
      await api.cancelScan(scan.jobId);
    } catch (err: any) {
      alert('Error cancelando: ' + (err.message || 'desconocido'));
    }
  };

  const handleRemovePath = async (pathId: string) => {
    if (!confirm('¿Estás seguro de que quieres eliminar esta ruta?')) return;

    try {
      const response = await api.removeScanPath(pathId);
      if (response.success) {
        setPaths(prev => prev.filter(p => p.id !== pathId));
      }
    } catch (error) {
      console.error('Error eliminando ruta:', error);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'connected':
        return <CheckCircle className="w-5 h-5 text-green-600" />;
      case 'disconnected':
        return <AlertCircle className="w-5 h-5 text-gray-400" />;
      case 'scanning':
        return <RefreshCw className="w-5 h-5 text-blue-600 animate-spin" />;
      case 'error':
        return <AlertCircle className="w-5 h-5 text-red-600" />;
      default:
        return <Clock className="w-5 h-5 text-gray-400" />;
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'connected':
        return 'Conectado';
      case 'disconnected':
        return 'Desconectado';
      case 'scanning':
        return 'Escaneando...';
      case 'error':
        return 'Error';
      default:
        return 'Desconocido';
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-8 h-8 text-bruma animate-spin" />
        <span className="ml-3 text-lavanda-archivo">Cargando rutas...</span>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-marfil mb-2">Administrar Rutas de Escaneo</h1>
        <p className="text-lavanda-archivo">
          Gestiona las carpetas que el sistema escanea en busca de archivos multimedia
        </p>
      </div>

      {/* Banner de estado del VLM. Solo se muestra si hay problemas que
          impiden el escaneo con IA — invisible cuando todo está OK. */}
      {vlmHealth && (!vlmHealth.ollamaRunning || !vlmHealth.modelAvailable) && (
        <div className="mb-6 p-4 bg-pizarra border border-lavanda-archivo rounded-2xl">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-bruma flex-shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <p className="font-medium text-marfil mb-1">Escaneo con IA no disponible</p>
              {!vlmHealth.ollamaRunning && (
                <p className="text-lavanda-archivo">
                  Ollama no responde en localhost:11434. Comprueba que está arrancado
                  (instálalo desde <span className="font-mono text-bruma">https://ollama.com</span> si todavía no).
                </p>
              )}
              {vlmHealth.ollamaRunning && !vlmHealth.modelAvailable && (
                <p className="text-lavanda-archivo">
                  El modelo <span className="font-mono text-bruma">{vlmHealth.model}</span> no está descargado.
                  Ábrete una terminal y ejecuta: <span className="font-mono text-bruma">ollama pull {vlmHealth.model}</span>
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Selector de modelo VLM — visible solo cuando Ollama está disponible.
          Solo se listan modelos con capacidad de vision (filtrado en backend). */}
      {vlmHealth?.ollamaRunning && availableModels.length > 0 && (
        <div className="mb-6 flex items-center gap-3 flex-wrap">
          <span className="text-sm text-lavanda-archivo" title="Modelo de IA que mira cada foto y la describe durante el escaneo">
            Modelo que describe las fotos:
          </span>
          <select
            value={selectedModel}
            onChange={async (e) => {
              const model = e.target.value;
              setSelectedModel(model);
              await api.setScanModel(model).catch(() => {});
            }}
            className="bg-grafito border border-pizarra rounded-lg px-3 py-1.5 text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
          >
            {availableModels.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      )}

      {/* Acciones globales: añadir ruta + escaneos masivos */}
      <div className="mb-6">
        {!showAddPath ? (
          <div className="flex items-center flex-wrap gap-2">
            <button
              onClick={() => setShowAddPath(true)}
              className="flex items-center gap-2 btn-primary"
            >
              <Plus className="w-4 h-4" />
              Añadir Nueva Ruta
            </button>

            {/* Escanear todas (solo nuevas) */}
            <button
              onClick={() => handleScanAll(false)}
              disabled={
                !!batchScan?.running ||
                paths.filter(p => p.isActive).length === 0 ||
                (vlmHealth ? (!vlmHealth.ollamaRunning || !vlmHealth.modelAvailable) : false)
              }
              className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-pizarra text-lavanda hover:bg-lavanda hover:bg-opacity-20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              title="Escanear con IA todas las rutas activas (solo archivos nuevos)"
            >
              <Sparkles className="w-4 h-4" />
              Escanear todas
            </button>

            {/* Re-escanear forzado todas */}
            <button
              onClick={() => handleScanAll(true)}
              disabled={
                !!batchScan?.running ||
                paths.filter(p => p.isActive).length === 0 ||
                (vlmHealth ? (!vlmHealth.ollamaRunning || !vlmHealth.modelAvailable) : false)
              }
              className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-pizarra text-melocoton hover:bg-melocoton hover:bg-opacity-20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              title="Re-escanear FORZADO todas las rutas activas (incluye archivos ya catalogados)"
            >
              <Zap className="w-4 h-4" />
              Re-escanear todas
            </button>

            {/* Indicador + cancelar cuando hay batch activo */}
            {batchScan?.running && (
              <div className="flex items-center gap-2 ml-2 px-3 py-2 rounded-full bg-tinta border border-pizarra">
                <RefreshCw className="w-4 h-4 text-bruma animate-spin" />
                <span className="text-sm text-lavanda-archivo">
                  Escaneando ruta <span className="text-marfil font-medium">{Math.min(batchScan.processed + 1, batchScan.total)}</span>/<span className="text-marfil font-medium">{batchScan.total}</span>
                  {batchScan.force && <span className="ml-1 text-melocoton text-xs">(forzado)</span>}
                </span>
                <button
                  onClick={handleCancelAll}
                  className="ml-1 text-xs px-2 py-0.5 rounded-full bg-pizarra text-lavanda-archivo hover:bg-lavanda hover:bg-opacity-20"
                  title="Cancelar escaneo masivo"
                >
                  Detener
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-tinta rounded-3xl border border-pizarra p-4">
            <div className="flex items-center gap-3">
              <FolderOpen className="w-5 h-5 text-lavanda-archivo" />
              <input
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="Ej: D:\Mis Documentos\Fotos"
                className="flex-1 px-3 py-2 border border-pizarra rounded-full focus:outline-none focus:ring-2 focus:ring-lavanda"
                autoFocus
              />
              <button
                onClick={handleAddPath}
                className="btn-primary"
              >
                Añadir
              </button>
              <button
                onClick={() => {
                  setShowAddPath(false);
                  setNewPath('');
                }}
                className="btn-secondary"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lista de rutas */}
      <div className="space-y-4">
        {paths.length === 0 ? (
          <div className="bg-tinta rounded-3xl border border-pizarra p-8 text-center">
            <FolderOpen className="w-12 h-12 text-lavanda-archivo mx-auto mb-3" />
            <p className="text-lavanda-archivo">No hay rutas configuradas</p>
            <p className="text-sm text-lavanda-archivo mt-1">Añade una ruta para comenzar a escanear archivos</p>
          </div>
        ) : (
          paths.map((path) => (
            <div
              key={path.id}
              className={`bg-tinta rounded-3xl border ${
                path.isActive ? 'border-pizarra' : 'border-pizarra opacity-75'
              } p-6 transition-all`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-3">
                    {getStatusIcon(path.status)}
                    <h3 className="font-semibold text-lg text-marfil">{path.path}</h3>
                    <span className={`px-2 py-1 text-xs rounded-full ${
                      path.isActive 
                        ? 'bg-lavanda-claro text-marfil' 
                        : 'bg-pizarra text-lavanda-archivo'
                    }`}>
                      {getStatusText(path.status)}
                    </span>
                  </div>

                  <div className="flex items-center gap-6 text-sm text-lavanda-archivo">
                    <div className="flex items-center gap-1">
                      <span>Archivos:</span>
                      <span className="font-medium">{path.fileCount}</span>
                    </div>
                    {path.lastScan && (
                      <div className="flex items-center gap-1">
                        <span>Última sincronización:</span>
                        <span className="font-medium">
                          {path.lastScan.toLocaleDateString()} {path.lastScan.toLocaleTimeString()}
                        </span>
                      </div>
                    )}
                  </div>

                  {path.errorMessage && (
                    <div className="mt-2 text-sm text-marfil bg-lavanda-claro px-3 py-2 rounded-2xl">
                      {path.errorMessage}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 ml-4">
                  <button
                    onClick={() => handleSyncPath(path.id)}
                    disabled={scanningPaths.has(path.id) || !path.isActive}
                    className={`p-2 rounded-lg transition-colors ${
                      scanningPaths.has(path.id) || !path.isActive
                        ? 'bg-pizarra text-lavanda-archivo cursor-not-allowed'
                        : 'bg-grafito text-bruma hover:bg-lavanda-claro'
                    }`}
                    title="Sincronizar"
                  >
                    <RefreshCw className={`w-4 h-4 ${scanningPaths.has(path.id) ? 'animate-spin' : ''}`} />
                  </button>

                  {/* Escanear con IA — abre el modal de contexto previo al scan */}
                  <button
                    onClick={() => setContextModalPathId(path.id)}
                    disabled={
                      !path.isActive ||
                      aiScansByPath.get(path.id)?.status === 'running' ||
                      !vlmHealth?.ollamaRunning ||
                      !vlmHealth?.modelAvailable
                    }
                    className={`p-2 rounded-lg transition-colors ${
                      aiScansByPath.get(path.id)?.status === 'running'
                        ? 'bg-lavanda text-white cursor-wait'
                        : !path.isActive || !vlmHealth?.ollamaRunning || !vlmHealth?.modelAvailable
                          ? 'bg-pizarra text-lavanda-archivo cursor-not-allowed'
                          : 'bg-grafito text-lavanda hover:bg-lavanda hover:text-white'
                    }`}
                    title={
                      !vlmHealth?.ollamaRunning ? 'Ollama no disponible' :
                      !vlmHealth?.modelAvailable ? `Falta modelo: ollama pull ${vlmHealth.model}` :
                      `Escanear con IA (describir cada imagen con ${selectedModel || vlmHealth?.model || 'VLM'})`
                    }
                  >
                    <Sparkles className={`w-4 h-4 ${aiScansByPath.get(path.id)?.status === 'running' ? 'animate-pulse' : ''}`} />
                  </button>

                  {/* Re-escanear FORZADO — re-procesa todas las imágenes aunque
                      ya estén catalogadas. Útil al cambiar el prompt del VLM. */}
                  <button
                    onClick={() => {
                      if (!confirm(`¿Re-escanear con IA TODAS las imágenes de "${path.path}", incluso las ya catalogadas? Puede tardar varios minutos.`)) return;
                      handleAiScan(path.id, true);
                    }}
                    disabled={
                      !path.isActive ||
                      aiScansByPath.get(path.id)?.status === 'running' ||
                      !vlmHealth?.ollamaRunning ||
                      !vlmHealth?.modelAvailable
                    }
                    className={`p-2 rounded-lg transition-colors ${
                      aiScansByPath.get(path.id)?.status === 'running'
                        ? 'bg-lavanda text-white cursor-wait'
                        : !path.isActive || !vlmHealth?.ollamaRunning || !vlmHealth?.modelAvailable
                          ? 'bg-pizarra text-lavanda-archivo cursor-not-allowed'
                          : 'bg-grafito text-bruma hover:bg-bruma hover:text-noche'
                    }`}
                    title={
                      !vlmHealth?.ollamaRunning ? 'Ollama no disponible' :
                      !vlmHealth?.modelAvailable ? `Falta modelo: ollama pull ${vlmHealth.model}` :
                      'Re-escanear FORZADO (incluye las ya catalogadas, fuerza re-procesado con el prompt actual)'
                    }
                  >
                    <Zap className={`w-4 h-4 ${aiScansByPath.get(path.id)?.status === 'running' ? 'animate-pulse' : ''}`} />
                  </button>

                  <button
                    onClick={() => handleTogglePath(path.id, path.isActive)}
                    className={`p-2 rounded-lg transition-colors ${
                      path.isActive
                        ? 'bg-lavanda-claro text-marfil hover:bg-opacity-90'
                        : 'bg-grafito text-bruma hover:bg-lavanda-claro'
                    }`}
                    title={path.isActive ? 'Desvincular' : 'Vincular'}
                  >
                    {path.isActive ? <Unlink className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
                  </button>

                  {path.id !== 'default' && (
                    <button
                      onClick={() => handleRemovePath(path.id)}
                      className="p-2 rounded-lg bg-pizarra text-marfil hover:bg-lavanda-claro transition-colors"
                      title="Eliminar"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Barra de progreso de escaneo IA */}
              {(() => {
                const scan = aiScansByPath.get(path.id);
                if (!scan || scan.status === 'idle') return null;
                const pct = scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : 0;
                return (
                  <div className="mt-4 p-3 bg-pizarra rounded-2xl">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Sparkles className={`w-4 h-4 text-lavanda ${scan.status === 'running' ? 'animate-pulse' : ''}`} />
                        <span className="text-sm font-medium text-marfil">
                          {scan.status === 'running' && 'Escaneando con IA...'}
                          {scan.status === 'done' && '✓ Escaneo completado'}
                          {scan.status === 'error' && '✗ Error al iniciar escaneo'}
                          {scan.status === 'cancelled' && 'Escaneo cancelado'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-lavanda-archivo">
                          {scan.total > 0 ? `${scan.done}/${scan.total}` : 'preparando...'}
                          {scan.errors > 0 && ` · ${scan.errors} errores`}
                        </span>
                        {scan.status === 'running' && scan.jobId && (
                          <button
                            onClick={() => handleCancelScan(path.id)}
                            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-melocoton/20 text-melocoton hover:bg-melocoton hover:text-noche transition-colors"
                            title="Detener este escaneo (guarda lo procesado hasta ahora en disco)"
                          >
                            <Square className="w-3 h-3" fill="currentColor" />
                            Detener
                          </button>
                        )}
                      </div>
                    </div>
                    {scan.total > 0 && (
                      <div className="w-full bg-grafito rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-gradient-to-r from-lavanda to-lavanda-claro h-full transition-all duration-300"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                    {scan.currentFile && scan.status === 'running' && (
                      <p className="text-xs text-lavanda-archivo mt-2 truncate">
                        Procesando: {scan.currentFile}
                      </p>
                    )}
                    {scan.errorMessage && (
                      <p className="text-xs text-red-400 mt-2">{scan.errorMessage}</p>
                    )}
                  </div>
                );
              })()}
            </div>
          ))
        )}
      </div>

      {/* Información adicional */}
      <div className="mt-8 card-primary">
        <h4 className="font-semibold text-marfil mb-2">Información</h4>
        <ul className="text-sm text-lavanda-archivo space-y-1">
          <li>• Las rutas activas se escanean automáticamente al iniciar la aplicación</li>
          <li>• Puedes desvincular temporalmente una ruta sin eliminarla</li>
          <li>• La sincronización manual actualiza los archivos de la ruta seleccionada</li>
          <li>• Solo se escanean archivos de imagen y video soportados</li>
        </ul>
      </div>

      {/* Modal de contexto previo al escaneo con IA */}
      {contextModalPathId && (() => {
        const target = paths.find(p => p.id === contextModalPathId);
        if (!target) return null;
        return (
          <ScanContextModal
            isOpen={true}
            rootPath={target.path}
            onClose={() => setContextModalPathId(null)}
            onConfirm={() => handleAiScan(contextModalPathId, false)}
          />
        );
      })()}
    </div>
  );
}