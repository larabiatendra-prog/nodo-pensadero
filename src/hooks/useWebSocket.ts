import { useEffect, useRef, useState } from 'react';

export interface ProgressData {
  type: 'sync_start' | 'sync_progress' | 'scan_progress' | 'sync_complete' | 'sync_error';
  percentage: number;
  status: string;
  current?: number;
  total?: number;
  action?: 'new' | 'cached' | 'modified';
  stats?: {
    nuevos?: number;
    cache?: number;
    modificados?: number;
    total?: number;
  };
  error?: string;
}

export function useWebSocket(url: string) {
  const [isConnected, setIsConnected] = useState(false);
  const [progressData, setProgressData] = useState<ProgressData | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isUnmountedRef = useRef(false);

  useEffect(() => {
    isUnmountedRef.current = false;
    
    const connect = () => {
      // No intentar conectar si el componente fue desmontado
      if (isUnmountedRef.current) return;
      
      try {
        // Cerrar conexión existente si hay una
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.close();
        }
        
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isUnmountedRef.current) {
            console.log('📡 Conectado al WebSocket para recibir progreso');
            setIsConnected(true);
          }
        };

        ws.onmessage = (event) => {
          if (!isUnmountedRef.current) {
            try {
              const data = JSON.parse(event.data) as ProgressData;
              console.log('📡 Progreso recibido:', data);
              setProgressData(data);
            } catch (error) {
              console.error('❌ Error parseando mensaje WebSocket:', error);
            }
          }
        };

        ws.onclose = (event) => {
          if (!isUnmountedRef.current) {
            // Solo mostrar mensaje si fue un cierre no esperado
            if (!event.wasClean) {
              console.log('📡 WebSocket desconectado, intentando reconectar...');
            }
            setIsConnected(false);
            wsRef.current = null;
            
            // Intentar reconectar después de 5 segundos solo si no fue desmontado
            if (!isUnmountedRef.current) {
              reconnectTimeoutRef.current = setTimeout(connect, 5000);
            }
          }
        };

        ws.onerror = () => {
          // No mostrar error en consola, el onclose se encargará de la reconexión
          if (!isUnmountedRef.current) {
            setIsConnected(false);
          }
        };

      } catch (error) {
        // Solo mostrar error si es crítico
        console.warn('⚠️ WebSocket no disponible, reintentando...');
        setIsConnected(false);
        
        // Intentar reconectar después de 5 segundos
        if (!isUnmountedRef.current) {
          reconnectTimeoutRef.current = setTimeout(connect, 5000);
        }
      }
    };

    // Intentar conectar inicialmente
    connect();

    // Cleanup al desmontar
    return () => {
      isUnmountedRef.current = true;
      
      // Cancelar timeout de reconexión
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      
      // Cerrar WebSocket si existe
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [url]);

  const clearProgress = () => {
    setProgressData(null);
  };

  return {
    isConnected,
    progressData,
    clearProgress
  };
}