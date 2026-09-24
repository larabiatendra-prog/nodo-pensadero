import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, MomentosEstado, MomentosTrabajo } from '../services/api';

/**
 * Momentos de los vídeos — panel de Estadísticas.
 *
 * Para la búsqueda visual (arrastrar una imagen), cada vídeo tenía UNA huella:
 * la de su fotograma del medio. Con una imagen de otro instante del clip no
 * siempre salía. Los "momentos" son huellas de varios instantes del vídeo.
 * Los escaneos nuevos ya los guardan; aquí se calculan los de lo escaneado
 * antes. Es un trabajo largo que se lanza a mano, se puede parar y seguir otro
 * día, y espera si hay un escaneo en marcha.
 */

const numero = (n: number) => n.toLocaleString('es-ES');
function tiempo(seg: number): string {
  if (seg < 90) return `${Math.max(1, Math.round(seg))} s`;
  const m = Math.round(seg / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  const resto = m % 60;
  return resto > 0 ? `${h} h ${resto} min` : `${h} h`;
}

export default function MomentosPanel() {
  const [estado, setEstado] = useState<MomentosEstado | null>(null);
  const [ocupado, setOcupado] = useState<'empezar' | 'parar' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await api.getMomentosEstado();
      if (r.success && r.data) setEstado(r.data);
    } catch { /* servidor anterior sin esta ruta: el panel no se enseña */ }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Con el trabajo en marcha el panel se refresca solo: es su barra de progreso.
  const enMarcha = !!estado?.trabajo && !estado.trabajo.terminado;
  useEffect(() => {
    if (!enMarcha) return;
    const t = setInterval(() => { cargar(); }, 2000);
    return () => clearInterval(t);
  }, [enMarcha, cargar]);

  const empezar = async () => {
    setOcupado('empezar');
    setError(null);
    try {
      const r = await api.empezarMomentos();
      if (r.success && r.data) setEstado(r.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se ha podido empezar');
    } finally {
      setOcupado(null);
    }
  };

  const parar = async () => {
    setOcupado('parar');
    try {
      const r = await api.pararMomentos();
      if (r.success && r.data) setEstado(r.data);
    } catch { /* se queda como estaba; el siguiente refresco lo dira */ }
    finally { setOcupado(null); }
  };

  // Sin nada escaneado con búsqueda visual no hay nada que completar.
  if (!estado || estado.videosConHuella === 0) return null;
  const { trabajo } = estado;

  return (
    <section className="mt-12 pt-8 border-t border-borde-sutil">
      <div className="flex items-baseline justify-between gap-4 mb-5 flex-wrap">
        <h2 className="text-[15px] font-semibold text-marfil">Momentos de los vídeos</h2>
        <span className="text-[11px] text-humo">
          para encontrar un vídeo arrastrando una imagen de cualquier instante, no solo del medio
        </span>
      </div>

      <div className="flex gap-10 flex-wrap mb-6">
        <Cifra valor={numero(estado.completos)} pie={`de ${numero(estado.videosConHuella)} vídeos con sus momentos`} destacada={estado.pendientes === 0} />
        {estado.pendientes > 0 && <Cifra valor={numero(estado.pendientes)} pie="vídeos por completar" />}
      </div>

      {trabajo && !trabajo.terminado ? (
        <EnMarcha trabajo={trabajo} parando={ocupado === 'parar'} onParar={parar} />
      ) : (
        <>
          {trabajo && trabajo.terminado && (trabajo.hechos > 0 || trabajo.fallidos > 0) && <Resultado trabajo={trabajo} />}
          {estado.pendientes > 0 ? (
            <div className="p-4 rounded-lg bg-grafito/40 border border-borde-sutil">
              <p className="text-[13px] text-marfil leading-snug">
                {numero(estado.pendientes)} {estado.pendientes === 1 ? 'vídeo tiene' : 'vídeos tienen'} una sola huella o les faltan momentos.
                Calcularlos llevaría unos <span className="text-lavanda-claro">{tiempo(estado.estimacionSeg)}</span>.
              </p>
              <p className="mt-1.5 text-[11px] text-humo leading-snug">
                Solo lee los vídeos (de los discos conectados) y apunta las huellas en el catálogo de cada carpeta.
                Puedes pararlo cuando quieras y seguir otro día: lo hecho se queda hecho.
                {estado.escaneoEnMarcha ? ' Ahora hay un escaneo en marcha: empezará cuando termine.' : ' Si empieza un escaneo, espera a que acabe.'}
              </p>
              <button
                onClick={empezar}
                disabled={ocupado !== null}
                className="mt-3 h-8 px-4 rounded-full bg-lavanda text-noche text-[12px] font-medium hover:bg-lavanda-claro transition-colors disabled:opacity-60 inline-flex items-center gap-2"
              >
                {ocupado === 'empezar' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Calcular los momentos
              </button>
              {error && <p className="mt-2 text-[12px] text-melocoton">{error}</p>}
            </div>
          ) : (
            <p className="text-[12px] text-humo">Todos los vídeos escaneados de los discos conectados tienen ya sus momentos.</p>
          )}
        </>
      )}
    </section>
  );
}

/** El trabajo en marcha: cuántos van, cuánto queda y el botón de parar. */
function EnMarcha({ trabajo, parando, onParar }: { trabajo: MomentosTrabajo; parando: boolean; onParar: () => void }) {
  const hechos = trabajo.hechos + trabajo.fallidos;
  const fraccion = trabajo.total > 0 ? hechos / trabajo.total : 0;
  return (
    <div className="p-4 rounded-lg bg-grafito/60 border border-lavanda/25">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
        <p className="text-[13px] text-marfil">
          {trabajo.esperandoEscaneo ? 'Esperando a que termine el escaneo…' : 'Calculando los momentos…'}
        </p>
        <p className="font-mono text-[11px] text-humo tabular-nums">
          {numero(hechos)} de {numero(trabajo.total)}
          {trabajo.restanteSeg !== null && hechos > 0 && ` · quedan ~${tiempo(trabajo.restanteSeg)}`}
        </p>
      </div>
      <div className="h-1.5 rounded-full bg-pizarra overflow-hidden">
        <div className="h-full rounded-full bg-lavanda transition-all" style={{ width: `${fraccion * 100}%` }} />
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <p className="text-[11px] text-humo truncate">{trabajo.actual || 'empezando…'}</p>
        <button
          onClick={onParar}
          disabled={parando}
          className="h-7 px-3 rounded-full bg-grafito hover:bg-pizarra text-[11px] text-niebla hover:text-marfil transition-colors disabled:opacity-50 shrink-0"
        >
          Parar
        </button>
      </div>
      <p className="mt-2 text-[11px] text-humo leading-snug">
        Puedes seguir usando la app mientras tanto. La búsqueda visual ya usa los momentos que van saliendo.
      </p>
    </div>
  );
}

/** Cómo acabó el último cálculo. */
function Resultado({ trabajo }: { trabajo: MomentosTrabajo }) {
  const texto = trabajo.motivo === 'fallos'
    ? `Se paró tras muchos fallos seguidos (¿se desconectó un disco?). ${numero(trabajo.hechos)} vídeos completados; lo que falta sigue pendiente.`
    : trabajo.motivo === 'error'
      ? `Se cortó por un error. ${numero(trabajo.hechos)} vídeos completados; lo que falta sigue pendiente.`
      : trabajo.cancelado
        ? `Parado. ${numero(trabajo.hechos)} vídeos completados (${numero(trabajo.momentos)} momentos); lo hecho se queda hecho.`
        : `Último cálculo: ${numero(trabajo.hechos)} vídeos completados, ${numero(trabajo.momentos)} momentos nuevos${trabajo.fallidos > 0 ? ` · ${numero(trabajo.fallidos)} no se pudieron leer` : ''}.`;
  const aviso = trabajo.motivo !== null || trabajo.fallidos > 0;
  return <p className={`mb-4 text-[12px] leading-snug ${aviso ? 'text-melocoton' : 'text-humo'}`}>{texto}</p>;
}

/** Una cifra de cabecera con su pie. */
function Cifra({ valor, pie, destacada }: { valor: string; pie: string; destacada?: boolean }) {
  return (
    <div>
      <p className={`text-[26px] leading-none font-bold tabular-nums ${destacada ? 'text-lavanda' : 'text-marfil'}`}>{valor}</p>
      <p className="mt-1.5 text-[11px] text-humo">{pie}</p>
    </div>
  );
}
