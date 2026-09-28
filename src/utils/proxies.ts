// Textos de los videos preparados (proxies): los comparten el panel de
// Estadisticas y el aviso de la home.

import type { ProxiesEstado } from '../services/api';

export const numero = (n: number) => n.toLocaleString('es-ES');

/** "3,03 GB": con coma decimal, que es como se escribe aqui. */
export function tamaño(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toLocaleString('es-ES', { maximumFractionDigits: i >= 3 ? 2 : 0 })} ${u[i]}`;
}

/** Duracion exacta y corta: "45 s", "12 min", "3 h 20 min". */
export function tiempo(seg: number): string {
  if (seg < 90) return `${Math.max(1, Math.round(seg))} s`;
  const m = Math.round(seg / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  const resto = m % 60;
  return resto > 0 ? `${h} h ${resto} min` : `${h} h`;
}

/**
 * Una estimacion dicha como estimacion: redondeada a lo que se puede
 * prometer. "menos de un minuto", "unos 25 minutos", "una hora y 20 minutos",
 * "unas 3 h 20 min", "unos 2 días y 4 h". Pasar de 3 h 17 min a 3 h 20 min no
 * engaña a nadie y se lee mejor.
 */
export function aproximado(seg: number): string {
  if (seg < 60) return 'menos de un minuto';
  const min = seg / 60;
  // Hasta 15 min, al minuto; hasta la hora, de 5 en 5; luego de 10 en 10 (de 30 pasadas las 10 h).
  const tramo = min < 15 ? 1 : min < 60 ? 5 : min < 600 ? 10 : 30;
  const total = Math.round(min / tramo) * tramo;
  if (total < 60) return total === 1 ? 'un minuto' : `unos ${total} minutos`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 1) return m > 0 ? `una hora y ${m} minutos` : 'una hora';
  if (h < 48) return m > 0 ? `unas ${h} h ${m} min` : `unas ${h} h`;
  const dias = Math.floor(h / 24);
  const hRest = h % 24;
  return hRest > 0 ? `unos ${dias} días y ${hRest} h` : `unos ${dias} días`;
}

/** "Tienes 1 archivo sin previsualizar" / "Tienes 1.234 archivos sin previsualizar". */
export function textoSinPrevisualizar(n: number): string {
  return `Tienes ${numero(n)} ${n === 1 ? 'archivo' : 'archivos'} sin previsualizar`;
}

/**
 * Deja el estado completo aunque el backend sea de una version anterior (justo
 * despues de actualizar, con el servidor viejo aun en marcha): mejor un panel
 * a cero que una pagina de estadisticas rota.
 */
export function completar(d: ProxiesEstado): ProxiesEstado {
  // El payload puede venir incompleto aunque el tipo diga que no: por eso Partial.
  const p = (d || {}) as Partial<ProxiesEstado>;
  return {
    ...d,
    discos: p.discos || [],
    fluidez: p.fluidez || [],
    lote: p.lote || null,
    totales: {
      listos: 0, bytes: 0, pendientes: 0, errores: 0, nativos: 0, forzados: 0, antiguos: 0,
      ...((p.totales || {}) as Partial<ProxiesEstado['totales']>),
    },
    ajustes: {
      topeGB: 40, porDisco: {}, alLlegar: 'preguntar',
      ...((p.ajustes || {}) as Partial<ProxiesEstado['ajustes']>),
    },
    minLibreGB: typeof p.minLibreGB === 'number' ? p.minLibreGB : 30,
  };
}
