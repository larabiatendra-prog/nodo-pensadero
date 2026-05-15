import React, { useState, useEffect } from 'react';
import { FolderOpen, RefreshCw, Unlink, Plus, Trash2, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import { api } from '../services/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { config } from '../config';

interface ScanPath {
  id: string;
  path: string;
  isActive: boolean;
  lastScan: Date | null;
  fileCount: number;
  status: 'connected' | 'disconnected' | 'scanning' | 'error';
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
  
  // WebSocket para progreso en tiempo real
  const { isConnected, progressData } = useWebSocket(config.wsUrl);

  useEffect(() => {
    loadPaths();
  }, []);
  
  // Escuchar progreso de sincronización
  useEffect(() => {
    if (progressData) {
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
    }
  }, [progressData, onSyncComplete]);

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

      {/* Botón para añadir nueva ruta */}
      <div className="mb-6">
        {!showAddPath ? (
          <button
            onClick={() => setShowAddPath(true)}
            className="flex items-center gap-2 btn-primary"
          >
            <Plus className="w-4 h-4" />
            Añadir Nueva Ruta
          </button>
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
    </div>
  );
}