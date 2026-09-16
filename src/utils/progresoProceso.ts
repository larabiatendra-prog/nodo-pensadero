/**
 * Pantalla de progreso de los procesos largos — Pensadero
 *
 * Traduce los frames del WebSocket (indexado de bibliotecas y escaneo con IA)
 * a lo que se pinta: que fase es, cuantos van de cuantos, cuanto lleva, cuanto
 * queda y en que archivo esta.
 *
 * Existe porque la pantalla antigua decia "IA · VISION LOCAL · Escaneando" con
 * una barra casi vacia tambien durante el INDEXADO, que no usa IA, y no daba
 * ni una cifra: no habia forma de saber si iba a tardar un minuto o una noche.
 */
import type { ProgressData } from '../hooks/useWebSocket';

export type TipoProceso = 'escaneo' | 'sync';

export interface Cifra {
  valor: number;
  etiqueta: string;
  tono?: 'aviso' | 'error';
}

export interface VistaProgreso {
  tipo: TipoProceso;
  fase: string;
  micro: string;
  cap: string;
  sub: string;
  /** 0-100, o undefined si la fase no tiene cuenta (contar, cargar modelos). */
  porcentaje?: number;
  hechos?: number;
  total?: number;
  /** Epoch ms del arranque del proceso, para el reloj de transcurrido. */
  inicio?: number;
  /** Tiempo restante estimado y cuando se midio; null = aun calculando. */
  restanteMs?: number | null;
  medidoEn?: number;
  ritmo?: string;
  archivo?: string;
  /** Que se esta haciendo con ESE archivo ("nuevo", "re-indexando"...). */
  accion?: string;
  cifras: Cifra[];
  aviso?: string;
  terminado?: boolean;
  duracionMs?: number;
}

/** Muestras (instante, hechos) para medir el ritmo real de los ultimos segundos. */
export interface Muestra { t: number; hechos: number }

const VENTANA_MS = 45_000;
const MINIMO_MS = 6_000;

/** Miles con punto siempre: toLocaleString('es-ES') deja "4422" sin agrupar. */
export const miles = (x: number) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const n = miles;

export function formatoDuracion(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  let h = Math.floor(m / 60);
  let mm = Math.round((s - h * 3600) / 60);
  if (mm === 60) { h++; mm = 0; }
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h`;
  return `${h} h ${String(mm).padStart(2, '0')} min`;
}

/**
 * Ritmo medido sobre los ultimos ~45 s. Una media desde el principio mentiria:
 * en el indexado los archivos en cache pasan a miles por segundo y los nuevos
 * tardan segundos cada uno (miniatura), asi que el ritmo cambia por tramos.
 */
function medirRitmo(muestras: Muestra[], ahora: number, hechos: number) {
  const ultima = muestras[muestras.length - 1];
  if (ultima && hechos < ultima.hechos) muestras.length = 0; // proceso nuevo
  muestras.push({ t: ahora, hechos });
  while (muestras.length > 2 && ahora - muestras[1].t > VENTANA_MS) muestras.shift();
  const primera = muestras[0];
  const dt = ahora - primera.t;
  if (dt < MINIMO_MS) return null;
  return (hechos - primera.hechos) / (dt / 1000); // archivos por segundo
}

function textoRitmo(porSegundo: number): string {
  if (porSegundo >= 1) return `${n(Math.round(porSegundo))} archivos/s`;
  if (porSegundo * 60 >= 1) return `${n(Math.round(porSegundo * 60))} archivos/min`;
  if (porSegundo > 0) return `${formatoDuracion(1000 / porSegundo)} por archivo`;
  return '';
}

const ACCION_INDEXADO: Record<string, string> = {
  nuevo: 'nuevo',
  modificado: 're-indexando',
  cache: 'sin cambios',
};

export interface ContextoLote { activo: boolean; indice: number; total: number }

/**
 * Lee un frame y devuelve la vista siguiente, o null si el frame no es de un
 * proceso que se pinte en esta pantalla.
 */
export function leerFrame(
  previa: VistaProgreso | null,
  d: ProgressData,
  muestras: Muestra[],
  lote: ContextoLote,
  ahora = Date.now(),
): VistaProgreso | null {
  const t = d.type;
  const esSync = t === 'sync_start' || t === 'sync_progress' || t === 'sync_complete' || t === 'sync_error';
  const esScan = t === 'scan_start' || t === 'scan_progress' || t === 'scan_error' || t === 'scan_done';
  if (!esSync && !esScan) return null;
  if (esScan && d.unArchivo) return null; // el escaneo desde la tarjeta tiene su toast

  const tipo: TipoProceso = esScan ? 'escaneo' : 'sync';
  const mismaTanda = previa && previa.tipo === tipo && !previa.terminado;
  const base: VistaProgreso = {
    tipo,
    fase: d.fase || previa?.fase || '',
    micro: '',
    cap: '',
    sub: '',
    cifras: [],
    inicio: d.inicio ?? (mismaTanda ? previa!.inicio : ahora),
    hechos: d.hechos ?? d.current ?? (mismaTanda ? previa!.hechos : undefined),
    total: d.total ?? (mismaTanda ? previa!.total : undefined),
  };
  if (!mismaTanda) muestras.length = 0;

  // ── cierres ────────────────────────────────────────────────────────────
  if (t === 'sync_complete') {
    const st = d.stats || {};
    const cifras: Cifra[] = [];
    if (st.nuevos) cifras.push({ valor: st.nuevos, etiqueta: 'nuevos' });
    if (st.modificados) cifras.push({ valor: st.modificados, etiqueta: 're-indexados' });
    return {
      ...base,
      terminado: true,
      fase: 'listo',
      micro: 'INDEXADO',
      cap: 'Archivo al día',
      sub: `${n(st.total ?? d.total ?? 0)} archivos en el catálogo`,
      cifras,
      duracionMs: d.duracionMs ?? (base.inicio ? ahora - base.inicio : undefined),
      porcentaje: 100,
    };
  }
  if (t === 'sync_error') {
    return { ...base, terminado: true, fase: 'error', micro: 'INDEXADO', cap: 'El indexado ha fallado', sub: d.error || d.status || '', aviso: d.error };
  }
  if (t === 'scan_done') {
    const cifras: Cifra[] = [];
    if (d.done) cifras.push({ valor: d.done, etiqueta: 'descritos' });
    if (d.errores || d.errors) cifras.push({ valor: (d.errores ?? d.errors)!, etiqueta: 'con error', tono: 'error' });
    const cap = d.estado === 'cancelled' ? 'Escaneo detenido'
      : d.estado === 'done_con_fallos' ? 'Escaneo sin guardar'
      : 'Escaneo completado';
    return {
      ...base,
      terminado: !lote.activo,
      fase: 'listo',
      micro: lote.activo ? `IA · VISIÓN LOCAL · RUTA ${lote.indice + 1} DE ${lote.total}` : 'IA · VISIÓN LOCAL',
      cap: lote.activo ? 'Ruta terminada' : cap,
      sub: d.total === 0 ? (d.status || 'No había nada pendiente') : (d.carpeta || ''),
      cifras,
      aviso: d.causaPrincipal?.reason || (d.degraded && d.degraded.length ? avisoDegradado(d.degraded) : undefined),
      duracionMs: d.duracionMs ?? d.elapsedMs,
      porcentaje: 100,
    };
  }

  // ── en curso ───────────────────────────────────────────────────────────
  const vista: VistaProgreso = { ...base, fase: d.fase || base.fase };

  if (esSync) {
    const bib = d.bibliotecasTotal && d.bibliotecasTotal > 1 && d.bibliotecaN
      ? ` · BIBLIOTECA ${d.bibliotecaN} DE ${d.bibliotecasTotal}` : '';
    vista.micro = 'INDEXADO' + bib;
    switch (vista.fase) {
      case 'contando':
        vista.cap = 'Contando archivos';
        vista.sub = d.biblioteca ? d.biblioteca : 'Recorriendo las bibliotecas';
        if (d.total) vista.cifras = [{ valor: d.total, etiqueta: 'encontrados' }];
        vista.hechos = undefined;
        break;
      case 'rematando':
        vista.cap = 'Ordenando el catálogo';
        vista.sub = 'Nombres de carpeta, favoritos, colecciones y personas';
        vista.porcentaje = 100;
        break;
      case 'miniaturas':
        vista.cap = 'Generando miniaturas';
        vista.sub = d.status || '';
        vista.archivo = d.archivo;
        break;
      default:
        vista.cap = 'Indexando el archivo';
        vista.sub = d.biblioteca || d.status || '';
        vista.archivo = d.archivo;
        vista.accion = d.accion ? ACCION_INDEXADO[d.accion] : undefined;
        if (d.nuevos) vista.cifras.push({ valor: d.nuevos, etiqueta: 'nuevos' });
        if (d.modificados) vista.cifras.push({ valor: d.modificados, etiqueta: 're-indexados' });
        if (d.enCache) vista.cifras.push({ valor: d.enCache, etiqueta: 'sin cambios' });
    }
  } else {
    const ruta = lote.activo && lote.total > 1 ? ` · RUTA ${lote.indice + 1} DE ${lote.total}` : '';
    vista.micro = 'IA · VISIÓN LOCAL' + ruta;
    const verbo = d.force ? 'Re-escaneando' : 'Escaneando';
    switch (vista.fase) {
      case 'preparando':
        vista.cap = 'Cargando modelos';
        vista.sub = 'Visión, caras y búsqueda visual';
        vista.hechos = undefined;
        vista.total = undefined;
        break;
      case 'buscando':
        vista.cap = 'Buscando qué describir';
        vista.sub = (d.carpeta || d.folder || '');
        vista.hechos = undefined;
        vista.total = undefined;
        if (d.degraded && d.degraded.length) vista.aviso = avisoDegradado(d.degraded);
        break;
      case 'guardando':
        vista.cap = 'Guardando descripciones';
        vista.sub = (d.carpeta || '');
        vista.porcentaje = 100;
        break;
      default:
        vista.cap = `${verbo} con IA`;
        vista.sub = (d.carpeta || '') || (previa?.sub ?? '');
        vista.archivo = d.archivo || d.file;
        vista.accion = vista.archivo ? 'describiendo' : undefined;
        if (d.yaHechos) vista.cifras.push({ valor: d.yaHechos, etiqueta: 'ya descritos antes' });
        if (d.errores || d.errors) vista.cifras.push({ valor: (d.errores ?? d.errors)!, etiqueta: 'con error', tono: 'error' });
        if (previa?.aviso && mismaTanda) vista.aviso = previa.aviso;
    }
  }

  // ── cuenta, ritmo y lo que queda ───────────────────────────────────────
  if (typeof vista.hechos === 'number' && vista.total) {
    vista.porcentaje ??= Math.min(100, Math.round((vista.hechos / vista.total) * 100));
    const porSegundo = medirRitmo(muestras, ahora, vista.hechos);
    const faltan = Math.max(0, vista.total - vista.hechos);
    if (esScan && typeof d.etaMs === 'number' && vista.hechos >= 3) {
      // El backend mide cada archivo del VLM uno a uno: es mejor dato que el nuestro.
      vista.restanteMs = d.etaMs;
      vista.ritmo = d.avgMsPerFile ? `${formatoDuracion(d.avgMsPerFile)} por archivo` : undefined;
    } else if (porSegundo && porSegundo > 0) {
      vista.restanteMs = (faltan / porSegundo) * 1000;
      vista.ritmo = textoRitmo(porSegundo);
    } else {
      vista.restanteMs = faltan === 0 ? 0 : null;
    }
    vista.medidoEn = ahora;
  }
  return vista;
}

function avisoDegradado(caidas: string[]): string {
  const nombres: Record<string, string> = { faces: 'caras', clip: 'búsqueda visual', motion: 'movimiento de cámara' };
  return `Va sin ${caidas.map(c => nombres[c] || c).join(', ')}: esos campos quedarán vacíos`;
}
