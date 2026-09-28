import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Film, Loader2, X, Zap } from 'lucide-react';
import { api, ProxiesEstado, ProxiesEstimacion, ProxiesLote } from '../services/api';
import { aproximado, completar, numero, tamaño, textoSinPrevisualizar } from '../utils/proxies';

/**
 * Aviso de vídeos sin versión ligera, abajo a la izquierda de la home.
 *
 * Son los que se abren con espera o a tirones: 4K de cámara, bitrates altos,
 * HEVC o ProRes que el navegador no abre. Con su versión ligera (el proxy) se
 * ven fluidos y al momento. El botón no empieza directamente: antes mide
 * cuánto tardaría en ESTE equipo (con la gráfica, veinte minutos; por el
 * procesador, una noche) y qué no cabría por el tope de cada disco, y se
 * decide con eso delante.
 *
 * Cerrarlo no lo silencia para siempre: vuelve si hay MÁS que al cerrarlo,
 * como el aviso de copias exactas.
 */

const CLAVE_CERRADO = 'pensadero.proxies.avisoCerradoCon';

type Fase = 'reposo' | 'estimando' | 'confirmar';

interface Props {
  /** Cambia cada vez que se recarga la lista de archivos: se vuelve a preguntar. */
  recarga: unknown;
  /** Ir a los ajustes de los vídeos preparados (Estadísticas). */
  onAjustes: () => void;
}

const enMarcha = (l: ProxiesLote | null | undefined): boolean => !!l && !l.terminado;

export default function AvisoProxies({ recarga, onAjustes }: Props) {
  const [estado, setEstado] = useState<ProxiesEstado | null>(null);
  const [fase, setFase] = useState<Fase>('reposo');
  const [estimacion, setEstimacion] = useState<ProxiesEstimacion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cerradoCon, setCerradoCon] = useState<number>(() => {
    try { return Number(localStorage.getItem(CLAVE_CERRADO)) || 0; } catch { return 0; }
  });
  // El lote que se ha seguido desde aquí: al terminar se enseña cómo acabó.
  const [seguido, setSeguido] = useState<number | null>(null);
  const [escondido, setEscondido] = useState(false);
  const [parando, setParando] = useState(false);
  const vivo = useRef(true);

  const pedir = useCallback(() => {
    api.getProxiesEstado()
      .then(r => { if (vivo.current && r.success && r.data) setEstado(completar(r.data)); })
      // Sin respuesta no hay aviso: no es algo que deba tapar la galería.
      .catch(() => { if (vivo.current) setEstado(null); });
  }, []);

  useEffect(() => { vivo.current = true; return () => { vivo.current = false; }; }, []);
  useEffect(pedir, [recarga, pedir]);

  // Con un lote en marcha (lanzado aquí o desde Estadísticas), se sigue.
  const lote = estado?.lote ?? null;
  const corriendo = enMarcha(lote);
  useEffect(() => {
    if (!corriendo) return;
    if (lote && seguido !== lote.desde) { setSeguido(lote.desde); setEscondido(false); }
    const t = setInterval(pedir, 3000);
    return () => clearInterval(t);
  }, [corriendo, lote, seguido, pedir]);

  const n = (estado?.fluidez || []).reduce((a, d) => a + d.n, 0);

  const estimar = async () => {
    setFase('estimando');
    setError(null);
    try {
      const r = await api.estimarProxies();
      if (!vivo.current) return;
      if (!r.success || !r.data) throw new Error(r.error || 'no se pudo calcular');
      setEstimacion(r.data);
      setFase('confirmar');
    } catch (e) {
      if (!vivo.current) return;
      setError(e instanceof Error ? e.message : 'no se pudo calcular');
      setFase('reposo');
    }
  };

  const empezar = async () => {
    setError(null);
    try {
      const r = await api.prepararProxies();
      if (r.success && r.data) {
        setEstado(completar(r.data.estado));
        if (r.data.estado.lote) setSeguido(r.data.estado.lote.desde);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'no se pudo empezar');
    }
    setFase('reposo');
    setEstimacion(null);
  };

  const parar = async () => {
    setParando(true);
    try {
      const r = await api.cancelarPreparacion();
      if (r.success && r.data) setEstado(completar(r.data.estado));
    } catch { /* el siguiente sondeo lo dira */ }
    setParando(false);
  };

  const cerrarReposo = () => {
    setCerradoCon(n);
    try { localStorage.setItem(CLAVE_CERRADO, String(n)); } catch { /* modo privado */ }
  };

  // ── Qué se enseña ─────────────────────────────────────────────────────────
  if (!estado || escondido) return null;

  if (corriendo && lote) {
    return <EnMarcha lote={lote} estimado={estimacion?.segundos ?? null} parando={parando} onParar={parar} onCerrar={() => setEscondido(true)} />;
  }

  if (lote && lote.terminado && seguido === lote.desde) {
    return <Resultado lote={lote} onAjustes={onAjustes} onCerrar={() => { setSeguido(null); pedir(); }} />;
  }

  if (fase === 'estimando') {
    return (
      <Tarjeta icono={<Loader2 className="w-4 h-4 animate-spin" />} titulo="Calculando el tiempo…">
        Se prepara un trozo de unos vídeos de muestra para medir lo que tarda este equipo. Son unos segundos.
      </Tarjeta>
    );
  }

  if (fase === 'confirmar' && estimacion) {
    return <Confirmar e={estimacion} onEmpezar={empezar} onAjustes={onAjustes} onCancelar={() => { setFase('reposo'); setEstimacion(null); }} />;
  }

  if (n === 0 || n <= cerradoCon) return null;
  return (
    <Tarjeta
      icono={<Film className="w-4 h-4" />}
      titulo={textoSinPrevisualizar(n)}
      onCerrar={cerrarReposo}
      tituloCerrar="Cerrar. Vuelve si aparecen más."
      acciones={
        <button
          onClick={estimar}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium bg-lavanda text-noche hover:bg-lavanda-claro transition-colors"
        >
          <Zap className="w-3.5 h-3.5" />
          Generar todos los proxies
        </button>
      }
    >
      Se abren con espera o van a tirones. Con su versión ligera se verán fluidos y al momento.
      {error && <span className="block mt-1 text-melocoton">No se ha podido: {error}</span>}
    </Tarjeta>
  );
}

/** Antes de empezar: cuánto tardaría, cuánto ocuparía y qué no cabría. */
function Confirmar({ e, onEmpezar, onAjustes, onCancelar }: {
  e: ProxiesEstimacion; onEmpezar: () => void; onAjustes: () => void; onCancelar: () => void;
}) {
  const topados = e.discos.filter(d => d.fuera > 0);
  const alSistema = e.discos.filter(d => (d.alSistema || 0) > 0);
  const titulo = e.n === 0
    ? 'No cabe ninguno'
    : e.segundos !== null ? `Tardaría ${aproximado(e.segundos)}` : 'No se ha podido medir el tiempo';
  return (
    <Tarjeta
      icono={<Zap className="w-4 h-4" />}
      titulo={titulo}
      onCerrar={onCancelar}
      tituloCerrar="Ahora no"
      acciones={
        <>
          {e.n > 0 ? (
            <button
              onClick={onEmpezar}
              className="flex-1 px-3 py-2 rounded-full text-xs font-medium bg-lavanda text-noche hover:bg-lavanda-claro transition-colors"
            >
              Empezar
            </button>
          ) : (
            <button
              onClick={onAjustes}
              className="flex-1 px-3 py-2 rounded-full text-xs font-medium bg-lavanda text-noche hover:bg-lavanda-claro transition-colors"
            >
              Ver el tope
            </button>
          )}
          <button
            onClick={onCancelar}
            className="flex-1 px-3 py-2 rounded-full text-xs font-medium bg-pizarra text-niebla hover:text-marfil transition-colors"
          >
            Ahora no
          </button>
        </>
      }
    >
      {e.n > 0 && (
        <>
          {numero(e.n)} {e.n === 1 ? 'vídeo' : 'vídeos'} · unos {tamaño(e.bytes)} en disco
          {e.encoder && <> · {e.encoder === 'grafica' ? 'con la gráfica' : 'por el procesador'}</>}.
        </>
      )}
      {alSistema.map(d => (
        <span key={`s-${d.raiz}`} className="block mt-1">
          {' '}A {d.raiz} le queda poco sitio: {numero(d.alSistema || 0)} se guardarán en {e.raizSistema || 'el disco del sistema'}, en la carpeta de Pensadero.
        </span>
      ))}
      {topados.map(d => (
        <span key={d.raiz} className="block mt-1 text-melocoton">
          {' '}En {d.raiz} {numero(d.fuera)} se quedarían sin preparar:{' '}
          {d.limite === 'sitio'
            ? 'no queda sitio ni ahí ni en el disco del sistema.'
            : d.limite === 'tope-sistema'
              ? `${e.raizSistema || 'el disco del sistema'} llega a su tope de ${numero(d.topeGB)} GB.`
              : `llega a su tope de ${numero(d.topeGB)} GB.`}
        </span>
      ))}
      {e.sinMedir > 0 && (
        <span className="block mt-1"> {numero(e.sinMedir)} sin duración conocida: el tiempo es aproximado.</span>
      )}
      {e.n > 0 && <span className="block mt-1"> Se puede parar cuando quieras: lo hecho se queda.</span>}
    </Tarjeta>
  );
}

/** Mientras prepara: cuántos van, cuánto queda y el botón de parar. */
function EnMarcha({ lote, estimado, parando, onParar, onCerrar }: {
  lote: ProxiesLote; estimado: number | null; parando: boolean; onParar: () => void; onCerrar: () => void;
}) {
  const hecho = lote.total > 0 ? lote.procesados / lote.total : 0;
  // Al principio aún no hay ritmo: vale lo estimado menos lo que lleva.
  const restante = lote.restanteSeg ?? (estimado !== null ? Math.max(0, estimado - (Date.now() - lote.desde) / 1000) : null);
  return (
    <Tarjeta
      icono={<Loader2 className="w-4 h-4 animate-spin" />}
      titulo={`Generando proxies · ${numero(lote.procesados)} de ${numero(lote.total)}`}
      onCerrar={onCerrar}
      tituloCerrar="Esconder. Sigue preparando."
      acciones={
        <button
          onClick={onParar}
          disabled={parando}
          className="flex-1 px-3 py-2 rounded-full text-xs font-medium bg-pizarra text-niebla hover:text-marfil disabled:opacity-60 transition-colors"
        >
          Parar
        </button>
      }
    >
      <span className="block h-1.5 my-1.5 rounded-full bg-pizarra overflow-hidden">
        <span className="block h-full rounded-full bg-lavanda transition-all" style={{ width: `${hecho * 100}%` }} />
      </span>
      {restante !== null && <span className="block">Terminará en {aproximado(restante)}.</span>}
      <span className="block truncate">{lote.actual || 'en cola…'}</span>
    </Tarjeta>
  );
}

/** Cómo acabó. */
function Resultado({ lote, onAjustes, onCerrar }: { lote: ProxiesLote; onAjustes: () => void; onCerrar: () => void }) {
  const topes = lote.topes || [];
  const titulo = lote.cancelado ? 'Generación parada' : 'Proxies generados';
  return (
    <Tarjeta
      icono={<Zap className="w-4 h-4" />}
      titulo={titulo}
      onCerrar={onCerrar}
      tituloCerrar="Cerrar"
      acciones={topes.length > 0 ? (
        <button
          onClick={onAjustes}
          className="flex-1 px-3 py-2 rounded-full text-xs font-medium bg-pizarra text-niebla hover:text-marfil transition-colors"
        >
          Ver el tope
        </button>
      ) : undefined}
    >
      {numero(lote.hechos)} {lote.hechos === 1 ? 'listo' : 'listos'} ({tamaño(lote.bytes)})
      {lote.fallos > 0 && <> · {numero(lote.fallos)} no se pudieron</>}.
      {lote.cancelado && <span className="block mt-1">Lo hecho se queda hecho.</span>}
      {topes.length > 0 && (
        <span className="block mt-1 text-melocoton">
          {numero(lote.sinSitio || 0)} sin preparar: {topes.map(t => t.raiz).join(', ')}{' '}
          {topes.length === 1 ? 'llegó' : 'llegaron'} a su tope o se quedó sin sitio.
        </span>
      )}
    </Tarjeta>
  );
}

/** La tarjeta de abajo a la izquierda, igual que la de copias exactas. */
function Tarjeta({ icono, titulo, children, acciones, onCerrar, tituloCerrar }: {
  icono: ReactNode;
  titulo: string;
  children?: ReactNode;
  acciones?: ReactNode;
  onCerrar?: () => void;
  tituloCerrar?: string;
}) {
  return (
    <div role="status" className="rounded-2xl bg-tinta/95 backdrop-blur-sm border border-borde-sutil shadow-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 w-8 h-8 rounded-full bg-pizarra text-lavanda flex items-center justify-center shrink-0">
          {icono}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-marfil">{titulo}</p>
          {children && <div className="mt-0.5 text-xs text-humo leading-relaxed">{children}</div>}
        </div>
        {onCerrar && (
          <button
            onClick={onCerrar}
            aria-label={tituloCerrar || 'Cerrar el aviso'}
            title={tituloCerrar}
            className="-mt-1 -mr-1 p-1 rounded-full text-humo hover:text-marfil hover:bg-pizarra transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {acciones && <div className="mt-3 flex gap-2">{acciones}</div>}
    </div>
  );
}
