import { config } from '../config';

const API_BASE_URL = config.apiBaseUrl;

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  count?: number;
}

class ApiService {
  private async fetchWithErrorHandling<T>(url: string, options?: RequestInit): Promise<T> {
    try {
      console.log('🌐 Realizando petición a:', url);

      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      });

      if (!response.ok) {
        console.error(`❌ HTTP Error ${response.status}: ${response.statusText}`);

        // Intentar extraer mensaje de error del body
        let errorMessage = response.statusText;
        try {
          const errorData = await response.json();
          // Buscar mensaje en 'message' o 'error'
          if (errorData.message) {
            errorMessage = errorData.message;
          } else if (errorData.error) {
            errorMessage = errorData.error;
          }
        } catch (e) {
          // Si no hay JSON, usar statusText
        }

        const error: any = new Error(errorMessage);
        error.status = response.status;
        error.statusText = response.statusText;
        throw error;
      }

      const data = await response.json();
      console.log('✅ Respuesta recibida:', data);
      return data;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        console.error('🔌 Error de conexión: No se puede conectar al servidor. ¿Está el backend ejecutándose en puerto 5000?');
      } else {
        console.error('❌ API Error:', error);
      }
      throw error;
    }
  }

  // Archivos
  async getFiles() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/files`);
  }

  async syncFiles() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/sync`, {
      method: 'POST'
    });
  }

  async getFile(id: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/files/${id}`);
  }

  async searchFiles(params: {
    q?: string;
    type?: string;
    tags?: string;
    year?: string;
    month?: string;
    dateFrom?: string;
    dateTo?: string;
    exports?: boolean;
  }) {
    // Filter out undefined values and convert boolean to string
    const cleanParams = Object.fromEntries(
      Object.entries(params)
        .filter(([_, value]) => value !== undefined && value !== '')
        .map(([key, value]) => [key, String(value)])
    );
    const queryString = new URLSearchParams(cleanParams).toString();
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/search?${queryString}`);
  }

  async updateFile(id: string, updates: any) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/files/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  // Colecciones
  async getCollections() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/collections`);
  }

  async createCollection(name: string, description: string, coverImage?: string, coverType?: 'system' | 'custom', clientTempId?: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections`, {
      method: 'POST',
      body: JSON.stringify({ name, description, coverImage, coverType, clientTempId }),
    });
  }

  async addFileToCollection(collectionId: string, fileId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections/${collectionId}/files`, {
      method: 'POST',
      body: JSON.stringify({ fileId }),
    });
  }

  async addFilesToCollection(collectionId: string, fileIds: string[]) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections/${collectionId}/files/bulk`, {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
    });
  }

  async removeFileFromCollection(collectionId: string, fileId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections/${collectionId}/files/${fileId}`, {
      method: 'DELETE',
    });
  }

  // Descarga de archivos
  async downloadFile(fileId: string): Promise<Blob> {
    try {
      console.log('🌐 Descargando archivo con ID:', fileId);

      const response = await fetch(`${API_BASE_URL}/download/${fileId}`, {
        method: 'GET',
      });

      if (!response.ok) {
        console.error(`❌ HTTP Error ${response.status}: ${response.statusText}`);
        throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
      }

      const blob = await response.blob();
      console.log('✅ Archivo descargado como blob, tamaño:', blob.size);
      return blob;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        console.error('🔌 Error de conexión: No se puede conectar al servidor. ¿Está el backend ejecutándose en puerto 5000?');
      } else {
        console.error('❌ Download Error:', error);
      }
      throw error;
    }
  }

  // Descarga múltiple como ZIP
  async downloadMultipleFiles(fileIds: string[]): Promise<Blob> {
    try {
      console.log('🌐 Descargando múltiples archivos como ZIP:', fileIds);

      const response = await fetch(`${API_BASE_URL}/download/zip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fileIds }),
      });

      if (!response.ok) {
        console.error(`❌ HTTP Error ${response.status}: ${response.statusText}`);
        throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
      }

      const blob = await response.blob();
      console.log('✅ ZIP descargado como blob, tamaño:', blob.size);
      return blob;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        console.error('🔌 Error de conexión: No se puede conectar al servidor. ¿Está el backend ejecutándose en puerto 5000?');
      } else {
        console.error('❌ ZIP Download Error:', error);
      }
      throw error;
    }
  }


  // Sistema
  async getSystemInfo() {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/system/info`);
  }

  // Estadísticas
  async getStatistics() {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/statistics`);
  }

  // =====================
  // Gestión de Rutas de Escaneo
  // =====================

  // Obtener todas las rutas configuradas
  async getScanPaths() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/scan-paths`);
  }

  // Añadir nueva ruta de escaneo
  async addScanPath(path: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  // Sincronizar una ruta específica
  async syncPath(pathId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths/${pathId}/sync`, {
      method: 'POST',
    });
  }

  // Cambiar estado activo/inactivo de una ruta
  async togglePath(pathId: string, isActive: boolean) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths/${pathId}/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  }

  // Eliminar una ruta
  async removeScanPath(pathId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths/${pathId}`, {
      method: 'DELETE',
    });
  }

  // Tag Management
  async updateTagCache(tagMapping: Record<string, string>) {
    // Guardar mapeo de etiquetas en cache local
    const existingCache = localStorage.getItem('tagCache') || '{}';
    const cache = JSON.parse(existingCache);
    const updatedCache = { ...cache, ...tagMapping };
    localStorage.setItem('tagCache', JSON.stringify(updatedCache));

    // Intentar sincronizar con el backend si está disponible
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/tags/cache`, {
        method: 'POST',
        body: JSON.stringify({ mapping: tagMapping }),
      });
    } catch (error) {
      // Si el backend no está disponible, solo usar cache local
      console.log('Tag cache saved locally');
      return { success: true, data: updatedCache };
    }
  }

  async getTagHistory() {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/tags/history`);
    } catch (error) {
      // Si el backend no está disponible, usar historial local
      const localHistory = localStorage.getItem('tagHistory');
      return { success: true, data: localHistory ? JSON.parse(localHistory) : [] };
    }
  }

  async bulkUpdateTags(updates: { fileIds: string[], addTags?: string[], removeTags?: string[] }) {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/tags/bulk-update`, {
        method: 'POST',
        body: JSON.stringify(updates),
      });
    } catch (error) {
      console.error('Error updating tags:', error);
      return { success: false, message: 'Error updating tags' };
    }
  }

  async updateCollection(collectionId: string, updates: { name?: string; description?: string }): Promise<ApiResponse<any>> {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections/${collectionId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
    } catch (error) {
      console.error('Error updating collection:', error);
      return { success: false, message: 'Error updating collection' };
    }
  }

  async deleteCollection(collectionId: string): Promise<ApiResponse<void>> {
    return this.fetchWithErrorHandling<ApiResponse<void>>(`${API_BASE_URL}/collections/${collectionId}`, {
      method: 'DELETE',
    });
  }

  async reorderCollections(orderedIds: string[]): Promise<ApiResponse<any>> {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds }),
      });
    } catch (error) {
      console.error('Error reordering collections:', error);
      return { success: false, message: 'Error reordering collections' };
    }
  }

  // AI Search - Búsqueda con lenguaje natural
  async aiSearch(query: string): Promise<ApiResponse<any>> {
    try {
      console.log('🤖 AI Search request:', query);
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/ai/search`, {
        method: 'POST',
        body: JSON.stringify({ query }),
      });
    } catch (error) {
      console.error('❌ Error en AI Search:', error);
      throw error;
    }
  }

  // Health check del servicio de IA
  async aiHealthCheck(): Promise<ApiResponse<any>> {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/ai/health`);
    } catch (error) {
      console.error('❌ Error en AI Health Check:', error);
      throw error;
    }
  }

  // =====================
  // Image Similarity Search - Búsqueda por imagen
  // =====================

  /**
   * Busca imágenes similares a la imagen proporcionada
   * @param imageFile - Archivo de imagen a buscar
   * @param options - Opciones de búsqueda
   */
  async imageSearch(
    imageFile: File,
    options: { topN?: number; useBlur?: boolean; minScore?: number } = {}
  ): Promise<ApiResponse<ImageSearchResult[]>> {
    try {
      console.log('🔍 Image Search request:', imageFile.name);

      const formData = new FormData();
      formData.append('image', imageFile);

      // Construir query string con opciones
      const params = new URLSearchParams();
      if (options.topN !== undefined) params.set('topN', String(options.topN));
      if (options.useBlur !== undefined) params.set('useBlur', String(options.useBlur));
      if (options.minScore !== undefined) params.set('minScore', String(options.minScore));

      const queryString = params.toString();
      const url = `${API_BASE_URL}/image-search${queryString ? `?${queryString}` : ''}`;

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        // No incluir Content-Type header - el browser lo añade automáticamente con boundary
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(errorData.message || `HTTP error ${response.status}`);
      }

      const data = await response.json();
      console.log('✅ Image Search completado:', data.count, 'resultados');
      return data;
    } catch (error) {
      console.error('❌ Error en Image Search:', error);
      throw error;
    }
  }

  /**
   * Construye el índice de embeddings para búsqueda por imagen
   * Este proceso puede tardar varios minutos
   */
  async buildImageSearchIndex(): Promise<ApiResponse<ImageSearchIndexStats>> {
    try {
      console.log('🔄 Iniciando construcción de índice de embeddings...');
      return await this.fetchWithErrorHandling<ApiResponse<ImageSearchIndexStats>>(
        `${API_BASE_URL}/image-search/build-index`,
        { method: 'POST' }
      );
    } catch (error) {
      console.error('❌ Error construyendo índice:', error);
      throw error;
    }
  }

  /**
   * Obtiene estadísticas del índice de embeddings
   */
  async getImageSearchStats(): Promise<ApiResponse<ImageSearchIndexStats>> {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<ImageSearchIndexStats>>(
        `${API_BASE_URL}/image-search/stats`
      );
    } catch (error) {
      console.error('❌ Error obteniendo estadísticas:', error);
      throw error;
    }
  }

  /**
   * Limpia el índice de embeddings
   */
  async clearImageSearchIndex(): Promise<ApiResponse<void>> {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<void>>(
        `${API_BASE_URL}/image-search/index`,
        { method: 'DELETE' }
      );
    } catch (error) {
      console.error('❌ Error limpiando índice:', error);
      throw error;
    }
  }

  // =====================
  // Background Removal - Quitar fondo de imágenes (beta)
  // =====================

  /**
   * Obtiene el estado del servicio de eliminación de fondo
   * @returns Estado de disponibilidad del servicio
   */
  async getBackgroundRemovalStatus(): Promise<ApiResponse<BackgroundRemovalStatus>> {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<BackgroundRemovalStatus>>(
        `${API_BASE_URL}/remove-background/status`
      );
    } catch (error) {
      console.error('❌ Error obteniendo estado del servicio:', error);
      throw error;
    }
  }

  /**
   * Elimina el fondo de una imagen
   * @param fileId - ID del archivo de imagen
   * @returns Información del archivo original y el nuevo archivo generado
   */
  async removeBackground(fileId: string): Promise<ApiResponse<BackgroundRemovalResult>> {
    try {
      console.log('🎨 Remove Background request para archivo:', fileId);
      return await this.fetchWithErrorHandling<ApiResponse<BackgroundRemovalResult>>(
        `${API_BASE_URL}/files/${fileId}/remove-background`,
        { method: 'POST' }
      );
    } catch (error) {
      console.error('❌ Error eliminando fondo:', error);
      throw error;
    }
  }

  /**
   * Resetea el cache de disponibilidad del servicio de eliminación de fondo
   * Útil si el usuario instala rembg mientras el servidor está corriendo
   */
  async resetBackgroundRemovalCache(): Promise<ApiResponse<void>> {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<void>>(
        `${API_BASE_URL}/remove-background/reset-cache`,
        { method: 'POST' }
      );
    } catch (error) {
      console.error('❌ Error reseteando cache:', error);
      throw error;
    }
  }

  // ============================================
  // ESCANEO VISUAL CON VLM (NODO Visión B)
  // ============================================

  async scanHealth() {
    return this.fetchWithErrorHandling<ApiResponse<{ ollamaRunning: boolean; modelAvailable: boolean; model: string; error?: string }>>(`${API_BASE_URL}/scan/health`);
  }

  async startScan(path: string, force: boolean = false) {
    return this.fetchWithErrorHandling<ApiResponse<any> & { jobId?: string }>(`${API_BASE_URL}/scan/start`, {
      method: 'POST',
      body: JSON.stringify({ path, force }),
    });
  }

  async listScanJobs() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/scan/jobs`);
  }

  async scanStatus(jobId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan/status/${jobId}`);
  }

  async cancelScan(jobId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan/cancel/${jobId}`, {
      method: 'POST',
    });
  }

  async scanModels() {
    return this.fetchWithErrorHandling<ApiResponse<{ models: string[]; current: string }>>(`${API_BASE_URL}/scan/models`);
  }

  async setScanModel(model: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ model: string }>>(`${API_BASE_URL}/scan/model`, {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    });
  }

  /**
   * Lista las subcarpetas con material bajo `path`, junto con el estado del
   * `_contexto.md` de cada una. Alimenta el modal de contexto previo al scan.
   */
  async scanInventory(folderPath: string) {
    const qs = new URLSearchParams({ path: folderPath }).toString();
    return this.fetchWithErrorHandling<ApiResponse<{
      root: string;
      rootContext: { meta: Record<string, any>; body: string } | null;
      folders: Array<{
        dir: string;
        relPath: string;
        mediaCount: number;
        imageCount: number;
        videoCount: number;
        hasContext: boolean;
        context: { meta: Record<string, any>; body: string } | null;
      }>;
    }>>(`${API_BASE_URL}/scan/inventory?${qs}`);
  }

  /**
   * Guarda (o sobrescribe, o borra si todo viene vacío) el `_contexto.md`
   * de la carpeta indicada.
   */
  async saveScanContext(folderPath: string, context: Record<string, any> | null) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan/context`, {
      method: 'POST',
      body: JSON.stringify({ folderPath, context }),
    });
  }

  // ============================================
  // GESTIÓN DE PERSONAS (registry CRUD + fotos)
  // ============================================

  async listPersonsRegistry() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/persons/registry`);
  }

  async upsertPerson(person: { person_id: string; display_name?: string; aliases?: string[]; avatar_path?: string }) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/registry`, {
      method: 'POST',
      body: JSON.stringify(person),
    });
  }

  async deletePerson(personId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}`, {
      method: 'DELETE',
    });
  }

  async listPersonPhotos(personId: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ filename: string; url: string }[]>>(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/photos`);
  }

  /**
   * Sube una foto de referencia para una persona. El backend devuelve el
   * filename asignado y la URL pública.
   */
  async uploadPersonPhoto(personId: string, file: File) {
    const formData = new FormData();
    formData.append('photo', file);
    const response = await fetch(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/photos`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      try { const j = await response.json(); if (j.error) errMsg = j.error; } catch {}
      throw new Error(errMsg);
    }
    return response.json();
  }

  async deletePersonPhoto(personId: string, filename: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/photos/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
    });
  }

  async setPersonAvatar(personId: string, filename: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/avatar`, {
      method: 'POST',
      body: JSON.stringify({ filename }),
    });
  }

  async trainPerson(personId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/train`, {
      method: 'POST',
    });
  }

  async faceServiceStatus() {
    return this.fetchWithErrorHandling<ApiResponse<{ ready: boolean; unavailable: boolean; lastError: string | null; threshold: number; trainedPersons: number }>>(`${API_BASE_URL}/persons/face-service/status`);
  }

  async reidentifyAll() {
    return this.fetchWithErrorHandling<ApiResponse<any> & { jobId?: string }>(`${API_BASE_URL}/persons/reidentify`, {
      method: 'POST',
    });
  }

  async reidentifyStatus(jobId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/reidentify/status/${jobId}`);
  }

  async cancelReidentify(jobId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/reidentify/cancel/${jobId}`, {
      method: 'POST',
    });
  }

  // ============================================
  // BUSQUEDA POR COLOR — alimenta la rueda HSL del frontend
  // ============================================

  // ============================================
  // SINONIMOS — alias table para expandir queries
  // ============================================

  async getAllCorpusTags() {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ tag: string; count: number }>> & { count: number }>(
      `${API_BASE_URL}/tags/all`
    );
  }

  async getAliasGroups() {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ canonical: string; aliases: string[] }>>>(
      `${API_BASE_URL}/tags/aliases`
    );
  }

  async proposeAliases(tags?: string[]) {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ canonical: string; aliases: string[] }>> & { count: number }>(
      `${API_BASE_URL}/tags/aliases/propose`,
      {
        method: 'POST',
        body: JSON.stringify(tags ? { tags } : {}),
      }
    );
  }

  async saveAliasGroups(groups: Array<{ canonical: string; aliases: string[] }>) {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ canonical: string; aliases: string[] }>>>(
      `${API_BASE_URL}/tags/aliases/save`,
      {
        method: 'POST',
        body: JSON.stringify({ groups }),
      }
    );
  }

  async upsertAliasGroup(group: { canonical: string; aliases: string[] }) {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ canonical: string; aliases: string[] }>>>(
      `${API_BASE_URL}/tags/aliases/upsert`,
      {
        method: 'POST',
        body: JSON.stringify(group),
      }
    );
  }

  async deleteAliasGroup(canonical: string) {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ canonical: string; aliases: string[] }>>>(
      `${API_BASE_URL}/tags/aliases/${encodeURIComponent(canonical)}`,
      { method: 'DELETE' }
    );
  }

  // ============================================
  // SMART FOLDERS — preview de reglas
  // ============================================

  async previewCollectionRules(rules: any[], rule_combinator: 'AND' | 'OR' = 'AND') {
    return this.fetchWithErrorHandling<{ count: number; total: number; sample: string[] }>(
      `${API_BASE_URL}/collections/preview-rules`,
      {
        method: 'POST',
        body: JSON.stringify({ rules, rule_combinator }),
      }
    );
  }

  async searchByColor(hex: string, threshold: number = 30, max: number = 500) {
    const params = new URLSearchParams({
      hex,
      threshold: String(threshold),
      max: String(max),
    });
    return this.fetchWithErrorHandling<ApiResponse<Array<{
      fileId: string;
      name: string;
      distance: number;
      matchedHex: string;
      matchedName: string;
    }>> & { count: number; totalMatched: number; threshold: number; targetHex: string }>(
      `${API_BASE_URL}/search/by-color?${params.toString()}`
    );
  }

  // ============================================
  // CLUSTERING DE CARAS DESCONOCIDAS
  // ============================================

  async listFaceClusters() {
    return this.fetchWithErrorHandling<ApiResponse<{ clusters: any[]; computedAt: number; fromCache: boolean }> & { jobId?: string; status?: string }>(`${API_BASE_URL}/persons/clusters`);
  }

  async refreshFaceClusters() {
    return this.fetchWithErrorHandling<ApiResponse<any> & { jobId?: string }>(`${API_BASE_URL}/persons/clusters/refresh`, {
      method: 'POST',
    });
  }

  faceClusterSampleUrl(clusterId: string, index: number): string {
    return `${API_BASE_URL}/persons/clusters/${encodeURIComponent(clusterId)}/sample/${index}`;
  }

  async promoteFaceCluster(clusterId: string, payload: { person_id: string; display_name?: string; aliases?: string[] }) {
    return this.fetchWithErrorHandling<ApiResponse<{ person_id: string; display_name: string; face_count: number; avatar_path: string | null }>>(
      `${API_BASE_URL}/persons/clusters/${encodeURIComponent(clusterId)}/promote`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  }
}

// Tipos para Image Search
export interface ImageSearchResult {
  fileId: string;
  similarityScore: number;
  fileName: string;
  file: any; // MediaFile completo
}

export interface ImageSearchIndexStats {
  version: string;
  modelType: string;
  embeddingDim: number;
  totalEntries: number;
  lastFullBuild: string | null;
}

// Tipos para Background Removal
export interface BackgroundRemovalStatus {
  available: boolean;
  method: string;
  message: string;
}

export interface BackgroundRemovalResult {
  message: string;
  originalFile: {
    id: string;
    name: string;
    path: string;
  };
  newFile: {
    id: string;
    name: string;
    path: string;
    size: number;
  };
}

export const api = new ApiService();

/**
 * =====================================================================
 * FAVORITOS Y COLECCIONES — Backend Node local (single-user, sin auth)
 * =====================================================================
 *
 * Estas funciones reemplazan el antiguo cliente Supabase. Llaman al
 * backend Node a través de los endpoints REST locales.
 *
 * Endpoints asumidos (deben existir en el backend; si faltan, hay que
 * implementarlos en favoritesManager.js / collectionsManager.js):
 *
 *   FAVORITOS
 *     GET    /api/favorites                       → array de favoritos
 *     POST   /api/favorites/toggle  body {fileId} → toggle de un fileId
 *
 *   COLECCIONES
 *     GET    /api/collections                              → array
 *     POST   /api/collections        body {name, coverImage?, files?}  → created
 *     PATCH  /api/collections/:id    body {name?, coverImage?}         → updated
 *     DELETE /api/collections/:id                                       → ok
 *     POST   /api/collections/:id/files     body {fileIds}              → add
 *     DELETE /api/collections/:id/files     body {fileIds}              → remove
 *
 * NOTA: las firmas exportadas se conservan para no romper a los
 * consumidores (App.tsx). Los parámetros `user_id` que existían se
 * ignoran — single-user.
 */

import { normalizePath } from '../utils/formatData';

const FAVORITES_BASE = `${API_BASE_URL}/favorites`;
const COLLECTIONS_BASE = `${API_BASE_URL}/collections`;

// Helper interno para llamadas JSON al backend con manejo uniforme.
async function backendFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const errorData = await response.json();
      message = errorData.message || errorData.error || message;
    } catch {
      // sin body JSON
    }
    const err: any = new Error(message);
    err.status = response.status;
    throw err;
  }
  // Algunos endpoints DELETE pueden devolver vacío
  const text = await response.text();
  return (text ? JSON.parse(text) : ({} as T)) as T;
}

/**
 * Obtiene los favoritos del usuario.
 * En single-user no hay user_id real: el parámetro se ignora.
 * Devuelve la misma forma que antes: { success, data: any[] | null }.
 *
 * El backend puede devolver bien un array de strings (paths/ids) o un
 * array de objetos con `photo_url`. Normalizamos la salida a objetos
 * con `photo_url` para mantener compatibilidad con App.tsx.
 */
export const getFavouritesByUser = async (_user_id?: string) => {
  try {
    const data = await backendFetch<any>(FAVORITES_BASE);

    // Acepta varias formas de respuesta del backend
    let raw: any[] = [];
    if (Array.isArray(data)) {
      raw = data;
    } else if (Array.isArray(data?.data)) {
      raw = data.data;
    } else if (Array.isArray(data?.favorites)) {
      raw = data.favorites;
    }

    const normalized = raw.map((item: any) => {
      if (typeof item === 'string') {
        return { photo_url: item, access_url: item };
      }
      return {
        ...item,
        photo_url: item.photo_url ?? item.fileId ?? item.path ?? '',
        access_url: item.access_url ?? item.path ?? item.photo_url ?? '',
      };
    });

    return { success: true, data: normalized };
  } catch (error) {
    console.error('Error obteniendo los favoritos del backend:', error);
    return { success: false, data: null };
  }
};

/**
 * Toggle de favorito. Antes alternaba en Supabase usando el path como
 * identificador; ahora delega al backend con el mismo identificador
 * (path normalizado), que es lo que el frontend ya tenía como `fullPath`.
 *
 * Mantiene la firma original; `user_id` se ignora.
 * Devuelve la lista actualizada de favoritos (mismos campos que antes).
 */
export const handleSupabaseFavourite = async (
  file: string,
  _user_id: string,
  userFavs: any[]
) => {
  try {
    const normalized = normalizePath(file);

    await backendFetch(`${FAVORITES_BASE}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ fileId: normalized }),
    });

    // Actualización local optimista a partir de la lista previa
    const newFavs = [...userFavs];
    const idx = newFavs.findIndex(
      (f) => normalizePath(f.photo_url) === normalized
    );
    if (idx !== -1) {
      newFavs.splice(idx, 1);
    } else {
      newFavs.push({ photo_url: normalized, access_url: file });
    }

    return newFavs;
  } catch (error) {
    console.error('Error al actualizar favorito en backend:', error);
    return userFavs;
  }
};

/**
 * Crea una colección en el backend.
 * Mantiene la firma original con (newCollection, user_id) — user_id se ignora.
 */
export const createCollection = async (newCollection: any, _user_id?: string) => {
  try {
    const body: any = {
      name: newCollection.name,
      coverImage: newCollection.coverImage,
      coverType: newCollection.coverType,
    };
    if (Array.isArray(newCollection.mediaFiles) && newCollection.mediaFiles.length > 0) {
      body.files = newCollection.mediaFiles;
    }
    // Smart Folder: incluir type/rules/rule_combinator si vienen
    if (newCollection.type === 'smart' && Array.isArray(newCollection.rules)) {
      body.type = 'smart';
      body.rules = newCollection.rules;
      body.rule_combinator = newCollection.rule_combinator || 'AND';
    }

    const data = await backendFetch<any>(COLLECTIONS_BASE, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return { success: true, data: data?.data ?? data };
  } catch (error) {
    console.error('Error en createCollection:', error);
    return { success: false, data: null };
  }
};

/**
 * Lista todas las colecciones (single-user).
 * Mantiene la firma original; user_id se ignora.
 * Cada colección incluye `mediaFiles` como array de identificadores.
 */
export const getCollectionsByUser = async (_user_id?: string) => {
  try {
    const data = await backendFetch<any>(COLLECTIONS_BASE);

    let raw: any[] = [];
    if (Array.isArray(data)) {
      raw = data;
    } else if (Array.isArray(data?.data)) {
      raw = data.data;
    } else if (Array.isArray(data?.collections)) {
      raw = data.collections;
    }

    // Normalizamos: si el backend devuelve `collections_content`, lo
    // aplanamos a `mediaFiles` como hacía el cliente Supabase.
    const collections = raw.map((c: any) => {
      let mediaFiles = c.mediaFiles ?? c.files ?? [];
      if (!mediaFiles.length && Array.isArray(c.collections_content)) {
        mediaFiles = c.collections_content.map((cc: any) => cc.mediaFile);
      }
      return { ...c, mediaFiles };
    });

    return { success: true, data: collections };
  } catch (error) {
    console.error('Error obteniendo colecciones del backend:', error);
    return { success: false, data: null };
  }
};

/**
 * Añade archivos a una colección. Acepta lista de IDs (o paths normalizados).
 */
export const addFilesToCollection = async (collectionId: string, fileIds: string[]) => {
  try {
    const data = await backendFetch<any>(
      `${COLLECTIONS_BASE}/${collectionId}/files`,
      {
        method: 'POST',
        body: JSON.stringify({ fileIds }),
      }
    );
    return { success: true, data: data?.data ?? data };
  } catch (error) {
    console.error('Error al añadir archivos a la colección:', error);
    return { success: false, data: null };
  }
};

/**
 * Actualiza la imagen de portada de una colección.
 */
export const updateCoverCollection = async (collectionId: string, coverImage: string) => {
  try {
    const data = await backendFetch<any>(`${COLLECTIONS_BASE}/${collectionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ coverImage }),
    });
    return { success: true, data: data?.data ?? data };
  } catch (error) {
    console.error('Error al actualizar la portada de la colección:', error);
    return { success: false, data: null };
  }
};

/**
 * Renombra una colección.
 */
export const updateNameCollection = async (collectionId: string, name: string) => {
  try {
    const data = await backendFetch<any>(`${COLLECTIONS_BASE}/${collectionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    return { success: true, data: data?.data ?? data };
  } catch (error) {
    console.error('Error al actualizar el nombre de la colección:', error);
    return { success: false, data: null };
  }
};

/**
 * Elimina un archivo concreto de una colección.
 * Acepta el mismo `mediaFile` (path o id) que se almacenó al añadirlo.
 */
export const deleteFromCollection = async (collectionId: string, mediaFile: string) => {
  const normalizedPath = normalizePath(mediaFile);
  try {
    await backendFetch(`${COLLECTIONS_BASE}/${collectionId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ fileIds: [normalizedPath] }),
    });
    return { success: true };
  } catch (error) {
    console.error('Error al eliminar el archivo de la colección:', error);
    return { success: false };
  }
};

/**
 * Elimina por completo una colección (y todo su contenido).
 */
export const deleteCollection = async (collectionId: string) => {
  try {
    await backendFetch(`${COLLECTIONS_BASE}/${collectionId}`, {
      method: 'DELETE',
    });
    return { success: true };
  } catch (error) {
    console.error('Error al eliminar la colección:', error);
    return { success: false };
  }
};