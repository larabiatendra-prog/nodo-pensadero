/**
 * Safe Fetch Utility — Pensadero
 *
 * Proporciona funciones de fetch con:
 * - Timeout automático via AbortController
 * - Reintentos configurables
 * - Manejo de errores consistente
 * - Logging en desarrollo
 */

import { API_CONFIG } from '../config';

// ============================================
// TIPOS
// ============================================

export interface SafeFetchOptions extends RequestInit {
  /** Timeout en milisegundos (default: 15000) */
  timeout?: number;
  /** Número máximo de reintentos (default: 0) */
  retries?: number;
  /** Delay entre reintentos en ms (default: 1000) */
  retryDelay?: number;
  /** Factor de backoff exponencial (default: 2) */
  backoff?: number;
  /** Callback llamado en cada reintento */
  onRetry?: (attempt: number, error: Error) => void;
}

export interface SafeFetchResult<T> {
  data: T | null;
  error: Error | null;
  status: number | null;
  ok: boolean;
}

// ============================================
// ERRORES PERSONALIZADOS
// ============================================

export class FetchTimeoutError extends Error {
  constructor(url: string, timeout: number) {
    super(`Request to ${url} timed out after ${timeout}ms`);
    this.name = 'FetchTimeoutError';
  }
}

export class FetchNetworkError extends Error {
  constructor(url: string, originalError: Error) {
    super(`Network error fetching ${url}: ${originalError.message}`);
    this.name = 'FetchNetworkError';
  }
}

// ============================================
// UTILIDAD PRINCIPAL
// ============================================

/**
 * Fetch con timeout y manejo de errores
 *
 * @example
 * const result = await safeFetch<User[]>('/api/users');
 * if (result.ok) {
 *   console.log(result.data);
 * } else {
 *   console.error(result.error);
 * }
 */
export async function safeFetch<T = unknown>(
  url: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult<T>> {
  const {
    timeout = API_CONFIG.timeouts.default,
    retries = 0,
    retryDelay = API_CONFIG.retries.delay,
    backoff = API_CONFIG.retries.backoff,
    onRetry,
    ...fetchOptions
  } = options;

  let lastError: Error | null = null;
  let attempt = 0;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Intentar parsear JSON, si falla devolver texto
      let data: T | null = null;
      const contentType = response.headers.get('content-type');

      if (contentType?.includes('application/json')) {
        try {
          data = await response.json();
        } catch {
          data = null;
        }
      }

      return {
        data,
        error: null,
        status: response.status,
        ok: response.ok,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          lastError = new FetchTimeoutError(url, timeout);
        } else {
          lastError = new FetchNetworkError(url, error);
        }
      } else {
        lastError = new Error('Unknown fetch error');
      }

      // Log en desarrollo
      if (import.meta.env.DEV) {
        console.warn(
          `⚠️ Fetch attempt ${attempt + 1}/${retries + 1} failed:`,
          lastError.message
        );
      }

      // Si hay reintentos disponibles
      if (attempt < retries) {
        const delay = retryDelay * Math.pow(backoff, attempt);
        onRetry?.(attempt + 1, lastError);
        await sleep(delay);
      }
    }

    attempt++;
  }

  return {
    data: null,
    error: lastError,
    status: null,
    ok: false,
  };
}

/**
 * Versión simplificada que lanza error en caso de fallo
 * Útil cuando se prefiere try/catch tradicional
 */
export async function fetchWithTimeout<T = unknown>(
  url: string,
  options: SafeFetchOptions = {}
): Promise<T> {
  const result = await safeFetch<T>(url, options);

  if (!result.ok) {
    throw result.error || new Error(`Request failed with status ${result.status}`);
  }

  return result.data as T;
}

/**
 * Fetch para JSON con método POST
 */
export async function safeFetchPost<T = unknown, B = unknown>(
  url: string,
  body: B,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult<T>> {
  return safeFetch<T>(url, {
    ...options,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Fetch múltiples URLs en paralelo con timeout individual
 * Similar a Promise.allSettled pero con timeout
 */
export async function safeFetchAll<T = unknown>(
  urls: string[],
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult<T>[]> {
  return Promise.all(urls.map(url => safeFetch<T>(url, options)));
}

// ============================================
// HOOK PARA REACT
// ============================================

import { useState, useCallback, useRef, useEffect } from 'react';

export interface UseSafeFetchState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  status: number | null;
}

export interface UseSafeFetchReturn<T> extends UseSafeFetchState<T> {
  execute: (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult<T>>;
  reset: () => void;
}

/**
 * Hook de React para fetch seguro
 *
 * @example
 * const { data, loading, error, execute } = useSafeFetch<User[]>();
 *
 * useEffect(() => {
 *   execute('/api/users');
 * }, []);
 */
export function useSafeFetch<T = unknown>(): UseSafeFetchReturn<T> {
  const [state, setState] = useState<UseSafeFetchState<T>>({
    data: null,
    error: null,
    loading: false,
    status: null,
  });

  // Ref para controlar si el componente está montado
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(
    async (url: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult<T>> => {
      if (!mountedRef.current) {
        return { data: null, error: null, status: null, ok: false };
      }

      setState(prev => ({ ...prev, loading: true, error: null }));

      const result = await safeFetch<T>(url, options);

      if (mountedRef.current) {
        setState({
          data: result.data,
          error: result.error,
          loading: false,
          status: result.status,
        });
      }

      return result;
    },
    []
  );

  const reset = useCallback(() => {
    setState({
      data: null,
      error: null,
      loading: false,
      status: null,
    });
  }, []);

  return {
    ...state,
    execute,
    reset,
  };
}

// ============================================
// UTILIDADES AUXILIARES
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Verifica si el servidor está disponible
 */
export async function checkServerHealth(
  baseUrl: string = API_CONFIG.baseUrl
): Promise<boolean> {
  const result = await safeFetch(`${baseUrl}/api/statistics`, {
    timeout: API_CONFIG.timeouts.short,
  });
  return result.ok;
}
