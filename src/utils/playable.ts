/**
 * Resolución de URL reproducible — Pensadero
 *
 * Muchos vídeos de cámara (.m2ts MPEG-TS+AC3, .mov H.264 10-bit 4:2:2 + PCM…)
 * no los reproduce ningún navegador. El backend genera, una sola vez, un
 * "proxy" MP4 web-compatible (ver backend/services/videoProxyService.js). Este
 * módulo consulta `/api/media/:id/playable` y, si el proxy se está generando,
 * hace polling hasta que esté listo.
 */

import { API_CONFIG } from '../config';

export interface PlayableInfo {
  status: 'native' | 'ready' | 'generating' | 'error';
  /** URL absoluta lista para usar en <video> (ya prefijada con el origen). */
  url?: string;
  kind?: 'native' | 'transcode';
  /**
   * Por qué no se pudo preparar, cuando `status` es 'error':
   *  - 'tope'    el disco llegó al tope de vídeos preparados y espera decisión
   *  - 'espacio' no queda sitio en ningún disco donde escribirlo
   */
  motivo?: 'tope' | 'espacio';
  /** Disco al que afecta el aviso ("F:\\"). Solo con motivo 'tope'. */
  raiz?: string;
  topeGB?: number;
  /**
   * Se está sirviendo el original (se puede ver ya) mientras por detrás se
   * prepara su versión ligera para la próxima vez. No hay nada que esperar.
   */
  preparando?: boolean;
  /** El disco está en su tope, así que no se preparará: se ve el original. */
  enSuTope?: boolean;
  /** true si el proxy se reescaló por debajo de la resolución original. */
  downscaled?: boolean;
  srcW?: number;
  srcH?: number;
  outW?: number;
  outH?: number;
  error?: string;
}

/** Hace absoluta una URL relativa devuelta por el backend (necesario en dev). */
function absolutize(url?: string): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_CONFIG.baseUrl}${url}`;
}

export async function fetchPlayable(fileId: string, forzar = false): Promise<PlayableInfo> {
  try {
    const res = await fetch(API_CONFIG.endpoints.playable(fileId) + (forzar ? '?forzar=1' : ''));
    if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };
    const json = await res.json();
    const data: PlayableInfo = (json && json.data) || { status: 'error', error: 'respuesta inválida' };
    data.url = absolutize(data.url);
    return data;
  } catch (err: any) {
    return { status: 'error', error: err?.message || 'error de red' };
  }
}

/**
 * Resuelve la URL reproducible de un vídeo, esperando (polling) si el proxy se
 * está generando. Llama `onUpdate` en cada cambio de estado para feedback de UI.
 */
export async function resolvePlayable(
  fileId: string,
  opts: {
    signal?: AbortSignal;
    onUpdate?: (info: PlayableInfo) => void;
    intervalMs?: number;
    maxWaitMs?: number;
    /**
     * El navegador no pudo abrir el original aunque parecia compatible: pedir
     * la version ligera. Es la red de seguridad de la clasificacion.
     */
    forzarProxy?: boolean;
  } = {}
): Promise<PlayableInfo> {
  const { signal, onUpdate, intervalMs = 2000, maxWaitMs = 30 * 60 * 1000, forzarProxy = false } = opts;
  const started = Date.now();

  let info = await fetchPlayable(fileId, forzarProxy);
  onUpdate?.(info);

  while (info.status === 'generating') {
    if (signal?.aborted) return info;
    if (Date.now() - started > maxWaitMs) {
      return { status: 'error', error: 'tiempo de espera agotado generando el vídeo' };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    if (signal?.aborted) return info;
    info = await fetchPlayable(fileId);
    onUpdate?.(info);
  }
  return info;
}
