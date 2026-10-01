// Lo que hay en una biblioteca y Pensadero aun no sabe leer (RAW...). Lo
// cuenta la sincronizacion (backend/utils/formatos.js, NO_LEIDOS) y Rutas lo
// dice: antes una carpeta con 32 RAW daba "0 archivos" y "Todo lo conectado
// esta escaneado", y no habia forma de saber por que.

export interface SinSoporte {
  familia: string;
  n: number;
  exts: string[];
}

const miles = (x: number) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Cuantos archivos no se saben leer en total. */
export function totalSinSoporte(lista: SinSoporte[] | null | undefined): number {
  return (lista || []).reduce((s, x) => s + (x.n || 0), 0);
}

/**
 * "32 archivos que Pensadero aún no sabe leer: RAW de cámara (CR3, NEF, ARW,
 * RAF…). No salen en la galería." Hasta cuatro extensiones por familia.
 */
export function textoSinSoporte(lista: SinSoporte[] | null | undefined): string {
  const total = totalSinSoporte(lista);
  if (total === 0) return '';
  const partes = (lista || []).filter(x => x.n > 0).map(x => {
    const exts = x.exts.map(e => e.replace(/^\./, '').toUpperCase());
    return `${x.familia} (${exts.slice(0, 4).join(', ')}${exts.length > 4 ? '…' : ''})`;
  });
  const quien = total === 1 ? 'archivo que Pensadero aún no sabe leer' : 'archivos que Pensadero aún no sabe leer';
  return `${miles(total)} ${quien}: ${partes.join(' y ')}. No ${total === 1 ? 'sale' : 'salen'} en la galería.`;
}
