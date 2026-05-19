/**
 * Configuración centralizada de la aplicación — Pensadero
 *
 * IMPORTANTE: Todos los componentes deben usar estas constantes
 * en lugar de URLs hardcodeadas.
 *
 * Variables de entorno (definir en .env):
 * - VITE_API_URL: URL base del servidor API (ej: http://192.168.1.100:5000)
 * - VITE_WS_URL: URL del WebSocket (ej: ws://192.168.1.100:5000)
 */

// ============================================
// CONFIGURACIÓN BASE
// ============================================

// Obtener URLs base desde variables de entorno o usar valores por defecto
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
// IMPORTANTE: incluir /ws en el path — el backend monta el WebSocketServer
// en `{ server, path: '/ws' }` y rechaza upgrades sin ese path con HTTP 400.
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:5000/ws';

// ============================================
// API_CONFIG - Objeto central de configuración
// ============================================

export const API_CONFIG = {
  // URLs base
  baseUrl: API_URL,
  wsUrl: WS_URL,
  apiUrl: `${API_URL}/api`,

  // Endpoints específicos (para autocompletado y consistencia)
  endpoints: {
    // Archivos y media
    files: `${API_URL}/api/files`,
    sync: `${API_URL}/api/sync`,
    stream: (id: string) => `${API_URL}/api/stream/${id}`,
    download: (id: string) => `${API_URL}/api/download/${id}`,
    thumbnails: `${API_URL}/thumbnails`,

    // Colecciones y favoritos
    collections: `${API_URL}/api/collections`,
    favorites: `${API_URL}/api/favorites`,

    // Búsqueda y AI
    search: `${API_URL}/api/search`,
    aiSearch: `${API_URL}/api/ai/search`,
    imageSearch: `${API_URL}/api/image-search`,

    // Sistema
    scanPaths: `${API_URL}/api/scan-paths`,
    statistics: `${API_URL}/api/statistics`,
    colors: `${API_URL}/api/colors`,
  },

  // Timeouts por defecto (en ms)
  timeouts: {
    default: 15000,    // 15 segundos
    short: 5000,       // 5 segundos (health checks)
    long: 60000,       // 60 segundos (operaciones pesadas)
    upload: 120000,    // 2 minutos (uploads)
  },

  // Configuración de reintentos
  retries: {
    max: 3,
    delay: 1000,
    backoff: 2,
  },
} as const;

// ============================================
// INTERFACE Y TIPOS
// ============================================

export interface AppConfig {
  apiUrl: string;
  wsUrl: string;
  apiBaseUrl: string;
  isDevelopment: boolean;
  isProduction: boolean;
}

// ============================================
// CONFIG LEGACY (compatibilidad hacia atrás)
// ============================================

export const config: AppConfig = {
  apiUrl: API_URL,
  wsUrl: WS_URL,
  apiBaseUrl: `${API_URL}/api`,
  isDevelopment: import.meta.env.DEV,
  isProduction: import.meta.env.PROD,
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Construye una URL de API completa
 */
export const buildApiUrl = (endpoint: string): string => {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return `${config.apiBaseUrl}/${cleanEndpoint}`;
};

/**
 * Construye una URL de media
 */
export const buildMediaUrl = (path: string): string => {
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return `${config.apiUrl}/${cleanPath}`;
};

/**
 * Construye una URL de WebSocket
 */
export const buildWsUrl = (path?: string): string => {
  if (!path) return config.wsUrl;
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return `${config.wsUrl}/${cleanPath}`;
};

/**
 * Construye una URL de thumbnail
 */
export const buildThumbnailUrl = (thumbnailName: string): string => {
  return `${API_CONFIG.endpoints.thumbnails}/${thumbnailName}`;
};

/**
 * Construye una URL de streaming
 */
export const buildStreamUrl = (fileId: string): string => {
  return API_CONFIG.endpoints.stream(fileId);
};

// ============================================
// EXPORTACIONES DIRECTAS (compatibilidad)
// ============================================

export const API_BASE_URL = config.apiBaseUrl;
export const WS_BASE_URL = WS_URL;

// ============================================
// LOG EN DESARROLLO
// ============================================

if (config.isDevelopment) {
  console.log('Pensadero — App Configuration:', {
    apiUrl: config.apiUrl,
    wsUrl: config.wsUrl,
    environment: 'development',
  });
}

export default config;
