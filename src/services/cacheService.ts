/**
 * Servicio unificado de caché con resolución de conflictos
 * Single Source of Truth para todos los datos offline/online
 */

import { MediaFile, Collection } from '../types';
import { config } from '../config';

// Tipos para el sistema de caché
export interface CacheItem<T> {
  id: string;
  data: T;
  metadata: {
    lastModified: string; // ISO 8601 timestamp
    source: 'local' | 'server';
    syncStatus: 'synced' | 'pending' | 'conflict';
    version?: number;
  };
}

export interface CacheConfig {
  ttl: number; // Time to live en días
  syncInterval?: number; // Intervalo de sincronización en ms
  conflictResolution: 'latest' | 'local' | 'server' | 'merge';
}

// Configuraciones por defecto para cada tipo de dato
const DEFAULT_CONFIGS: Record<string, CacheConfig> = {
  favorites: {
    ttl: 30,
    syncInterval: 30000, // 30 segundos
    conflictResolution: 'latest'
  },
  collections: {
    ttl: 90,
    syncInterval: 60000, // 1 minuto
    conflictResolution: 'merge'
  },
  mediaFiles: {
    ttl: 7,
    syncInterval: 300000, // 5 minutos
    conflictResolution: 'server'
  }
};

class CacheService {
  private cachePrefix = 'marinafinder_cache_';
  private syncQueue: Map<string, any> = new Map();
  private syncTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Obtener datos del caché con timestamp
   */
  get<T>(key: string): CacheItem<T>[] | null {
    try {
      const stored = localStorage.getItem(this.cachePrefix + key);
      if (!stored) return null;
      
      const items = JSON.parse(stored) as CacheItem<T>[];
      
      // Filtrar items expirados
      const config = DEFAULT_CONFIGS[key] || { ttl: 30 };
      const now = new Date();
      const validItems = items.filter(item => {
        const itemDate = new Date(item.metadata.lastModified);
        const daysDiff = (now.getTime() - itemDate.getTime()) / (1000 * 60 * 60 * 24);
        return daysDiff <= config.ttl;
      });

      return validItems.length > 0 ? validItems : null;
    } catch (error) {
      console.error(`❌ Error reading cache for ${key}:`, error);
      return null;
    }
  }

  /**
   * Guardar datos en caché con metadata
   */
  set<T>(key: string, items: T[], source: 'local' | 'server' = 'local'): void {
    try {
      const cacheItems: CacheItem<T>[] = items.map((item: any) => ({
        id: item.id || this.generateId(),
        data: item,
        metadata: {
          lastModified: new Date().toISOString(),
          source,
          syncStatus: source === 'local' ? 'pending' : 'synced',
          version: 1
        }
      }));

      localStorage.setItem(
        this.cachePrefix + key,
        JSON.stringify(cacheItems)
      );

      console.log(`💾 Cached ${items.length} items in ${key}`);
      
      // Agregar a cola de sincronización si es local
      if (source === 'local') {
        this.addToSyncQueue(key, cacheItems);
      }
    } catch (error) {
      console.error(`❌ Error saving to cache ${key}:`, error);
    }
  }

  /**
   * Actualizar un item específico
   */
  updateItem<T>(key: string, itemId: string, data: Partial<T>, source: 'local' | 'server' = 'local'): void {
    const items = this.get<T>(key) || [];
    const index = items.findIndex(item => item.id === itemId);
    
    if (index !== -1) {
      items[index] = {
        ...items[index],
        data: { ...items[index].data, ...data },
        metadata: {
          ...items[index].metadata,
          lastModified: new Date().toISOString(),
          source,
          syncStatus: source === 'local' ? 'pending' : 'synced',
          version: (items[index].metadata.version || 0) + 1
        }
      };
    } else {
      // Crear nuevo item si no existe
      items.push({
        id: itemId,
        data: data as T,
        metadata: {
          lastModified: new Date().toISOString(),
          source,
          syncStatus: source === 'local' ? 'pending' : 'synced',
          version: 1
        }
      });
    }

    // Guardar actualización
    localStorage.setItem(this.cachePrefix + key, JSON.stringify(items));
    
    if (source === 'local') {
      this.addToSyncQueue(key, items.filter(item => item.id === itemId));
    }
  }

  /**
   * Eliminar un item específico
   */
  removeItem(key: string, itemId: string): void {
    const items = this.get(key) || [];
    const filtered = items.filter(item => item.id !== itemId);
    
    if (filtered.length !== items.length) {
      localStorage.setItem(this.cachePrefix + key, JSON.stringify(filtered));
      console.log(`🗑️ Removed item ${itemId} from ${key} cache`);
    }
  }

  /**
   * Merge inteligente de datos locales y servidor
   */
  merge<T>(key: string, localData: CacheItem<T>[], serverData: T[]): T[] {
    const config = DEFAULT_CONFIGS[key] || { conflictResolution: 'latest' };
    const merged = new Map<string, CacheItem<T>>(); // FIXED: Guardar CacheItem completo, no solo data

    // Convertir datos del servidor a CacheItems
    const serverItems: CacheItem<T>[] = serverData.map((item: any) => ({
      id: item.id,
      data: item,
      metadata: {
        lastModified: item.updatedAt || item.createdAt || new Date().toISOString(),
        source: 'server' as const,
        syncStatus: 'synced' as const,
        version: item.version || 1
      }
    }));

    // Aplicar estrategia de resolución
    switch (config.conflictResolution) {
      case 'latest':
        // El más reciente gana - FIXED: Comparar metadata.lastModified correctamente
        [...localData, ...serverItems].forEach(item => {
          const existing = merged.get(item.id);
          if (!existing || new Date(item.metadata.lastModified) > new Date(existing.metadata.lastModified)) {
            merged.set(item.id, item); // FIXED: Guardar item completo con metadata
          }
        });
        break;
        
      case 'local':
        // Local siempre gana
        serverItems.forEach(item => merged.set(item.id, item)); // FIXED: Guardar item completo
        localData.forEach(item => merged.set(item.id, item));    // FIXED: Guardar item completo
        break;

      case 'server':
        // Servidor siempre gana
        localData.forEach(item => merged.set(item.id, item));    // FIXED: Guardar item completo
        serverItems.forEach(item => merged.set(item.id, item));  // FIXED: Guardar item completo
        break;
        
      case 'merge':
        // Merge inteligente: servidor es fuente de verdad para colecciones
        // 1. Servidor siempre tiene prioridad
        serverItems.forEach(item => merged.set(item.id, item));

        // 2. Solo mantener items locales que:
        //    - Tienen ID temporal (temp_*) Y están pendientes de sincronizar
        //    - O existen en servidor (para merge de propiedades)
        localData.forEach(item => {
          const existing = merged.get(item.id);
          if (existing) {
            // Si existe en servidor, usar la versión del servidor (más actualizada)
            // pero mantener propiedades locales importantes como mediaFiles si el servidor no las tiene
            const serverData = existing.data as any;
            const localDataItem = item.data as any;

            // Crear un nuevo CacheItem combinado
            merged.set(item.id, {
              id: item.id,
              data: {
                ...serverData,
                // Si el servidor no tiene mediaFiles pero el local sí, usar los locales
                mediaFiles: serverData.mediaFiles && serverData.mediaFiles.length > 0
                  ? serverData.mediaFiles
                  : localDataItem.mediaFiles || []
              },
              metadata: existing.metadata // Usar metadata del servidor
            });
          } else {
            // FIXED: Solo rescatar items temporales pendientes de sincronizar
            // Si tiene ID de servidor (col_*) pero no está en servidor → fue eliminado, NO rescatar
            const isTemporary = item.id?.startsWith('temp_');
            const isPending = item.metadata?.syncStatus === 'pending';

            if (isTemporary && isPending) {
              // Item temporal nunca sincronizado - mantener para reintentar
              merged.set(item.id, item);
              console.log(`🔄 Manteniendo colección temporal pendiente: ${item.id}`);
            } else {
              // Item con ID de servidor que no existe en servidor = eliminado
              // NO rescatar - esto previene que colecciones eliminadas reaparezcan
              console.log(`🗑️ No rescatando colección eliminada del servidor: ${item.id}`);
            }
          }
        });
        break;
    }

    // FIXED: Extraer solo la data de los CacheItems al retornar
    const result = Array.from(merged.values()).map(item => item.data);
    console.log(`🔄 Merged ${key}: ${localData.length} local + ${serverData.length} server = ${result.length} total`);
    
    // Detectar y reportar conflictos
    const conflicts = this.detectConflicts(localData, serverItems);
    if (conflicts.length > 0) {
      console.warn(`⚠️ Detected ${conflicts.length} conflicts in ${key}:`, conflicts);
    }

    return result;
  }

  /**
   * Detectar conflictos entre datos locales y servidor
   */
  private detectConflicts<T>(localData: CacheItem<T>[], serverData: CacheItem<T>[]): string[] {
    const conflicts: string[] = [];
    const serverMap = new Map(serverData.map(item => [item.id, item]));

    localData.forEach(localItem => {
      const serverItem = serverMap.get(localItem.id);
      if (serverItem && localItem.metadata.syncStatus === 'pending') {
        // Hay cambios locales pendientes y el servidor tiene una versión diferente
        const localDate = new Date(localItem.metadata.lastModified);
        const serverDate = new Date(serverItem.metadata.lastModified);
        
        // Si las fechas son muy cercanas (< 5 segundos), probablemente es un conflicto real
        if (Math.abs(localDate.getTime() - serverDate.getTime()) < 5000) {
          conflicts.push(localItem.id);
        }
      }
    });

    return conflicts;
  }

  /**
   * Agregar items a la cola de sincronización
   */
  private addToSyncQueue(key: string, items: CacheItem<any>[]): void {
    const pending = items.filter(item => item.metadata.syncStatus === 'pending');
    if (pending.length > 0) {
      this.syncQueue.set(key, pending);
      console.log(`📤 Added ${pending.length} items to sync queue for ${key}`);
      
      // Programar sincronización automática
      this.scheduleSyncForKey(key);
    }
  }

  /**
   * Programar sincronización automática
   */
  private scheduleSyncForKey(key: string): void {
    // Cancelar timer existente
    const existingTimer = this.syncTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const config = DEFAULT_CONFIGS[key];
    if (config?.syncInterval) {
      const timer = setTimeout(() => {
        this.syncPendingItems(key);
      }, config.syncInterval);
      
      this.syncTimers.set(key, timer);
    }
  }

  /**
   * Sincronizar items pendientes con el servidor - IMPLEMENTACIÓN REAL
   */
  async syncPendingItems(key: string): Promise<void> {
    const pending = this.syncQueue.get(key);
    if (!pending || pending.length === 0) return;

    console.log(`🔄 Syncing ${pending.length} pending items for ${key}...`);

    // FIXED: Implementación real de sincronización con reintentos
    const items = this.get(key) || [];
    let syncedCount = 0;
    let failedCount = 0;
    const maxRetries = 3;

    for (const pendingItem of pending) {
      const item = items.find(i => i.id === pendingItem.id);
      if (!item || item.metadata.syncStatus !== 'pending') continue;

      let retries = 0;
      let synced = false;

      while (retries < maxRetries && !synced) {
        try {
          // Sincronizar con servidor según el tipo de dato
          if (key === 'favorites') {
            const favoriteData = item.data as any;
            const response = await fetch(`${config.apiBaseUrl}/files/${favoriteData.fileId}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                isFavorite: favoriteData.isFavorite
              }),
            });

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();

            if (result.success) {
              // Marcar como sincronizado
              item.metadata.syncStatus = 'synced';
              item.metadata.source = 'server';
              item.metadata.lastModified = new Date().toISOString();
              synced = true;
              syncedCount++;
              console.log(`✅ Favorito sincronizado: ${favoriteData.fileId}`);
            } else {
              throw new Error(result.message || 'Sync failed');
            }
          } else if (key === 'collections') {
            // FIXED: Sincronización real para colecciones
            const collectionData = item.data as any;

            // Si el ID empieza con temp_, es una nueva colección
            if (item.id.startsWith('temp_')) {
              const response = await fetch(`${config.apiBaseUrl}/collections`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  name: collectionData.name,
                  description: collectionData.description,
                  coverImage: collectionData.coverImage,
                  coverType: collectionData.coverType,
                  clientTempId: item.id // Incluir el ID temporal para prevenir duplicados
                }),
              });

              if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
              }

              const result = await response.json();

              if (result.success && result.data) {
                // Swap temporal ID con server ID
                await this.swapCollectionId(item.id, result.data.id);
                synced = true;
                syncedCount++;
                console.log(`✅ Colección temporal ${item.id} sincronizada como ${result.data.id}`);
              } else {
                throw new Error(result.message || 'Sync failed');
              }
            } else {
              // Colección existente - actualizar
              const response = await fetch(`${config.apiBaseUrl}/collections/${item.id}`, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  name: collectionData.name,
                  description: collectionData.description,
                  coverImage: collectionData.coverImage,
                  coverType: collectionData.coverType,
                  mediaFiles: collectionData.mediaFiles
                }),
              });

              if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
              }

              const result = await response.json();

              if (result.success) {
                item.metadata.syncStatus = 'synced';
                item.metadata.source = 'server';
                item.metadata.lastModified = new Date().toISOString();
                synced = true;
                syncedCount++;
                console.log(`✅ Colección ${item.id} sincronizada`);
              } else {
                throw new Error(result.message || 'Sync failed');
              }
            }
          }
        } catch (error) {
          retries++;
          console.warn(`⚠️ Intento ${retries}/${maxRetries} fallido para ${item.id}:`, error);

          if (retries >= maxRetries) {
            // Marcar como conflicto después de todos los reintentos
            item.metadata.syncStatus = 'conflict';
            failedCount++;
            console.error(`❌ Error sincronizando ${item.id} después de ${maxRetries} intentos`);
          } else {
            // Esperar antes de reintentar (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retries - 1)));
          }
        }
      }
    }

    // Guardar items actualizados
    localStorage.setItem(this.cachePrefix + key, JSON.stringify(items));

    // Limpiar cola solo si todos se sincronizaron
    if (failedCount === 0) {
      this.syncQueue.delete(key);
      console.log(`✅ Sincronización completa: ${syncedCount}/${pending.length} items sincronizados`);
    } else {
      console.warn(`⚠️ Sincronización parcial: ${syncedCount} exitosos, ${failedCount} fallidos`);
      // Mantener items fallidos en la cola para reintentar después
      const remainingPending = items.filter(i => i.metadata.syncStatus === 'pending');
      if (remainingPending.length > 0) {
        this.syncQueue.set(key, remainingPending);
      } else {
        this.syncQueue.delete(key);
      }
    }
  }

  /**
   * Swap temporal collection ID con server ID después de sincronización exitosa
   */
  async swapCollectionId(tempId: string, serverId: string): Promise<void> {
    try {
      const items = this.get('collections') || [];
      const tempItem = items.find(i => i.id === tempId);

      if (!tempItem) {
        console.warn(`⚠️ No se encontró colección temporal ${tempId} para swap`);
        return;
      }

      // Crear nuevo item con server ID
      const serverItem: CacheItem<any> = {
        id: serverId,
        data: {
          ...tempItem.data,
          id: serverId // Actualizar ID en el data también
        },
        metadata: {
          lastModified: new Date().toISOString(),
          source: 'server',
          syncStatus: 'synced',
          version: 1
        }
      };

      // Eliminar temporal y añadir server version
      const updatedItems = items.filter(i => i.id !== tempId);
      updatedItems.push(serverItem);

      localStorage.setItem(this.cachePrefix + 'collections', JSON.stringify(updatedItems));

      console.log(`🔄 Colección temporal ${tempId} reemplazada por ${serverId}`);

      // Notificar al componente App para actualizar estado
      window.dispatchEvent(new CustomEvent('collection-id-swap', {
        detail: { tempId, serverId }
      }));
    } catch (error) {
      console.error(`❌ Error swapping collection ID ${tempId} -> ${serverId}:`, error);
    }
  }

  /**
   * Sincronizar colecciones pendientes con el servidor
   */
  async syncCollectionsToServer(): Promise<number> {
    const items = this.get('collections') || [];
    const pendingItems = items.filter(i =>
      i.metadata.syncStatus === 'pending' ||
      i.metadata.syncStatus === 'dirty'
    );

    if (pendingItems.length === 0) {
      console.log('✅ No hay colecciones pendientes de sincronización');
      return 0;
    }

    console.log(`🔄 Sincronizando ${pendingItems.length} colecciones pendientes...`);

    // Añadir a cola de sincronización
    this.syncQueue.set('collections', pendingItems);

    // Ejecutar sincronización
    await this.syncPendingItems('collections');

    // Retornar número de items sincronizados exitosamente
    const remainingPending = this.syncQueue.get('collections')?.length || 0;
    return pendingItems.length - remainingPending;
  }

  /**
   * Limpiar caché expirado
   */
  cleanup(): void {
    const keys = Object.keys(localStorage)
      .filter(key => key.startsWith(this.cachePrefix));
    
    let cleaned = 0;
    keys.forEach(key => {
      const realKey = key.replace(this.cachePrefix, '');
      const items = this.get(realKey);
      
      if (!items || items.length === 0) {
        localStorage.removeItem(key);
        cleaned++;
      }
    });
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned ${cleaned} expired cache entries`);
    }
  }

  /**
   * Obtener estadísticas del caché
   */
  getStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    const keys = Object.keys(localStorage)
      .filter(key => key.startsWith(this.cachePrefix));
    
    keys.forEach(key => {
      const realKey = key.replace(this.cachePrefix, '');
      const items = this.get(realKey);
      if (items) {
        stats[realKey] = {
          count: items.length,
          pending: items.filter(i => i.metadata.syncStatus === 'pending').length,
          conflicts: items.filter(i => i.metadata.syncStatus === 'conflict').length,
          size: new Blob([JSON.stringify(items)]).size
        };
      }
    });
    
    return stats;
  }

  /**
   * Generar ID único
   */
  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Limpiar todo el caché (usar con cuidado)
   */
  clearAll(): void {
    const keys = Object.keys(localStorage)
      .filter(key => key.startsWith(this.cachePrefix));
    
    keys.forEach(key => localStorage.removeItem(key));
    this.syncQueue.clear();
    this.syncTimers.forEach(timer => clearTimeout(timer));
    this.syncTimers.clear();
    
    console.log('🗑️ All cache cleared');
  }
}

// Exportar instancia única (Singleton)
export const cacheService = new CacheService();

// Limpiar caché expirado al cargar
cacheService.cleanup();