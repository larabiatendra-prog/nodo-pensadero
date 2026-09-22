import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Check, Loader2, RotateCw, Sparkles, Star, StickyNote, Library,
  FileText, Users, ShieldCheck, ExternalLink, Layers, Undo2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../services/api';
import type { CopiaGrupo, CopiaMiembro, CopiasPar, CopiasResumen } from '../types';
import { formatFileSize } from './MediaCard';
import PestanasGemelas, { type ApartadoGemelas } from './PestanasGemelas';
import { limpiarCopiasConDeshacer, textoDuplicados } from '../utils/copias';

/**
 * Copias exactas: el mismo archivo, byte a byte, en mas de un sitio.
 *
 * A diferencia de las parecidas aqui no hay nada que mirar: las miniaturas son
 * identicas. Lo que se decide es DONDE se queda cada archivo, asi que cada
 * copia es una fila con su disco y su carpeta, y lo que la distingue (si tiene
 * algo tuyo, cuanto escaneo lleva, si su disco es de copia de seguridad).
 *
 * Un clic en una fila la deja como la que se ve; el resto deja de salir en la
 * galeria. Nada se borra y todo se puede devolver a "por decidir".
 */

interface Props {
  onBack: () => void;
  onAbrir: (fileId: string) => void;
  onCambiarApartado: (a: ApartadoGemelas) => void;
}

const POR_PAGINA = 60;

const ETIQUETA_ESTADO: Record<CopiaGrupo['estado'], { texto: string; clase: string }> = {
  pendiente: { texto: 'por decidir', clase: 'bg-melocoton/15 text-melocoton' },
  decidido: { texto: 'decidido', clase: 'bg-salvia/15 text-salvia' },
  suplente: { texto: 'la elegida no está conectada', clase: 'bg-pizarra text-niebla' },
  'copia-seguridad': { texto: 'resuelto: disco de copia de seguridad', clase: 'bg-pizarra text-lavanda' },
};

function Huellas({ m }: { m: CopiaMiembro }) {
  const marcas: Array<{ si?: boolean; icono: JSX.Element; texto: string }> = [
    { si: m.humano.favorito, icono: <Star className="w-3 h-3" />, texto: 'favorito' },
    { si: m.humano.nota, icono: <StickyNote className="w-3 h-3" />, texto: 'tiene nota' },
    { si: m.humano.coleccion, icono: <Library className="w-3 h-3" />, texto: 'en una colección' },
    { si: m.trabajo.descripcion, icono: <FileText className="w-3 h-3" />, texto: 'descrito' },
    { si: m.trabajo.caras, icono: <Users className="w-3 h-3" />, texto: 'con caras' },
  ];
  const activas = marcas.filter(x => x.si);
  if (activas.length === 0) return <span className="text-[11px] text-humo">sin escanear</span>;
  return (
    <span className="flex items-center gap-1.5">
      {activas.map(x => (
        <span key={x.texto} title={x.texto} className="text-niebla">{x.icono}</span>
      ))}
    </span>
  );
}

export default function CopiasExactas({ onBack, onAbrir, onCambiarApartado }: Props) {
  const [resumen, setResumen] = useState<CopiasResumen | null>(null);
  const [grupos, setGrupos] = useState<CopiaGrupo[]>([]);
  const [total, setTotal] = useState(0);
  const [pares, setPares] = useState<CopiasPar[]>([]);
  const [solo, setSolo] = useState<'pendientes' | 'todas'>('pendientes');
  const [limite, setLimite] = useState(POR_PAGINA);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null); // huella en curso
  const [limpiando, setLimpiando] = useState(false);
  const sondeo = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      const r = await api.getCopias({ solo, desde: 0, limite });
      if (!r.success || !r.data) throw new Error('no se pudo leer');
      setResumen(r.data.resumen);
      setGrupos(r.data.grupos);
      setTotal(r.data.total);
      setPares(r.data.pares || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'error de red');
    } finally {
      setCargando(false);
    }
  }, [solo, limite]);

  useEffect(() => { cargar(); }, [cargar]);

  // Mientras se leen archivos para comparar, la lista crece sola.
  useEffect(() => {
    if (sondeo.current) clearTimeout(sondeo.current);
    if (resumen?.calculando) sondeo.current = setTimeout(cargar, 2500);
    return () => { if (sondeo.current) clearTimeout(sondeo.current); };
  }, [resumen, cargar]);

  const hacer = async (huella: string, accion: () => Promise<unknown>, aviso?: string) => {
    setOcupado(huella);
    try {
      await accion();
      if (aviso) toast.success(aviso);
      await cargar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar');
    } finally {
      setOcupado(null);
    }
  };

  const quedarse = (g: CopiaGrupo, ids: string[]) => hacer(g.huella, () => api.decidirCopia(g.huella, ids));
  const devolver = (g: CopiaGrupo) => hacer(g.huella, () => api.olvidarCopias([g.huella]), 'Vuelve a estar por decidir.');

  const marcarCopiaSeguridad = async (lib: { id: string; nombre: string }) => {
    try {
      await api.setCopiaSeguridadRuta(lib.id, true);
      toast.success(`${lib.nombre} es ahora copia de seguridad. Se puede cambiar en Rutas.`);
      await cargar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo marcar');
    }
  };

  const limpiar = async () => {
    setLimpiando(true);
    await limpiarCopiasConDeshacer(cargar);
    setLimpiando(false);
  };

  // Si casi todo lo pendiente esta entre dos discos, decidir de uno en uno no
  // tiene sentido: es un disco y su backup.
  const parDominante = resumen && resumen.pendientes >= 10 && pares[0]
    && pares[0].grupos >= resumen.pendientes * 0.8 ? pares[0] : null;

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Volver</span>
      </button>

      <PestanasGemelas activo="copias" onCambiar={onCambiarApartado} pendientesCopias={resumen?.pendientes} />

      <div className="flex flex-wrap items-start gap-x-10 gap-y-4 pb-4 mb-5 border-b border-pizarra">
        <div className="min-w-[280px] flex-1">
          <h1 className="text-2xl font-bold text-marfil mb-1">Tomas gemelas</h1>
          <p className="text-sm text-niebla max-w-2xl leading-relaxed">
            El mismo archivo, byte a byte, en más de un sitio: un disco y su copia de seguridad, una
            carpeta duplicada. Elige dónde se queda cada uno y las demás copias dejan de salir en la
            galería. <span className="text-humo">No se borra nada.</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 ml-auto">
          {resumen && (
            <span className="text-xs text-humo">
              <span className="text-niebla">{resumen.pendientes} por decidir</span>
              {' · '}{resumen.escondidas} escondidas
              {resumen.porCopiaSeguridad > 0 && ` (${resumen.porCopiaSeguridad} por copia de seguridad)`}
            </span>
          )}
          <button
            onClick={() => { setSolo(s => (s === 'pendientes' ? 'todas' : 'pendientes')); setLimite(POR_PAGINA); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-pizarra text-niebla hover:text-marfil transition-colors"
          >
            <Layers className="w-3.5 h-3.5" />
            {solo === 'pendientes' ? 'viendo: por decidir' : 'viendo: todas'}
          </button>
          <button
            onClick={async () => {
              try { await api.buscarCopias(); await cargar(); } catch (err) {
                toast.error(err instanceof Error ? err.message : 'No se pudo buscar');
              }
            }}
            title="Volver a buscar copias sin esperar a la próxima sincronización"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-pizarra text-niebla hover:text-marfil transition-colors"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Buscar otra vez
          </button>
          {resumen && resumen.sobrantes > 0 && (
            <button
              onClick={limpiar}
              disabled={limpiando}
              title="Se queda una copia de cada archivo: la que tenga algo tuyo, la que no esté en un disco de copia de seguridad, la más escaneada…"
              className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-60 transition-colors"
            >
              {limpiando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              Limpiar automáticamente ({resumen.sobrantes})
            </button>
          )}
        </div>
      </div>

      {resumen?.calculando && (
        <p className="flex items-center gap-2 text-sm text-niebla mb-4">
          <Loader2 className="w-4 h-4 animate-spin text-lavanda" />
          Comparando archivos… {resumen.leidos.toLocaleString('es-ES')} de {resumen.porLeer.toLocaleString('es-ES')}.
          Cada archivo se lee una sola vez.
        </p>
      )}

      {parDominante && (
        <div className="rounded-2xl bg-grafito/50 border border-borde-sutil p-4 mb-5 flex flex-wrap items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-lavanda shrink-0" />
          <p className="text-sm text-niebla flex-1 min-w-[240px]">
            {parDominante.grupos === resumen?.pendientes ? 'Todas' : 'Casi todas'} están entre{' '}
            <span className="text-marfil">{parDominante.a.nombre}</span> y{' '}
            <span className="text-marfil">{parDominante.b.nombre}</span>. Si uno es la copia de
            seguridad del otro, márcalo y se resuelven solas, también las que aparezcan más adelante.
          </p>
          <div className="flex flex-wrap gap-2">
            {[parDominante.b, parDominante.a].map(lib => (
              <button
                key={lib.id}
                onClick={() => marcarCopiaSeguridad(lib)}
                className="px-3 py-1.5 rounded-full text-xs bg-pizarra text-lavanda hover:text-marfil transition-colors"
              >
                {lib.nombre} es la copia
              </button>
            ))}
          </div>
        </div>
      )}

      {cargando && (
        <div className="flex items-center gap-2 text-niebla py-16">
          <Loader2 className="w-5 h-5 animate-spin text-lavanda" />
          Buscando copias…
        </div>
      )}

      {error && !cargando && <p className="text-estado-error py-8">No se pudieron leer las copias: {error}</p>}

      {!cargando && !error && grupos.length === 0 && (
        <p className="text-niebla py-8">
          {solo === 'pendientes' && resumen && resumen.grupos > 0
            ? 'Nada por decidir: cada archivo se ve una sola vez.'
            : resumen?.calculando ? 'Todavía no ha salido ninguna.' : 'No hay copias exactas en lo que está conectado.'}
        </p>
      )}

      <div className="flex flex-col gap-3">
        {grupos.map(g => {
          const propia = g.miembros.find(m => m.id === g.propuesta.id) || g.miembros[0];
          const etiqueta = ETIQUETA_ESTADO[g.estado];
          const trabajando = ocupado === g.huella;
          return (
            <article key={g.huella} className="rounded-2xl bg-grafito/40 p-3 md:p-4">
              <div className="flex gap-4">
                <div className="hidden sm:block self-start w-[140px] shrink-0 aspect-video rounded-lg overflow-hidden bg-grafito">
                  <img
                    src={propia.thumbnail}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1">
                    <h2 className="text-[15px] font-medium text-marfil truncate" title={propia.name}>{propia.name}</h2>
                    <span className="text-xs font-mono text-humo">{formatFileSize(g.tamano)} · {g.miembros.length} copias</span>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] ${etiqueta.clase}`}>
                      {etiqueta.texto}{g.estado === 'decidido' && g.origen === 'auto' ? ' automáticamente' : ''}
                    </span>
                  </div>
                  {g.estado === 'pendiente' && (
                    <p className="text-xs text-humo mb-2">
                      {/* Lo que distingue a la propuesta: su disco, o su carpeta si todas estan en el mismo. */}
                      Propuesta: la de{' '}
                      <span className="text-niebla">
                        {new Set(g.miembros.map(m => m.biblioteca.id)).size > 1
                          ? (propia.biblioteca.nombre || 'otro disco')
                          : (propia.carpeta === '.' ? 'la raíz del disco' : propia.carpeta)}
                      </span>
                      {' · '}{g.propuesta.motivo}
                    </p>
                  )}

                  <ul className="flex flex-col gap-1 mt-2" aria-label="Copias">
                    {g.miembros.map(m => {
                      // Por decidir se ven todas, pero marcarlas todas pareceria
                      // una eleccion: ahi se destaca la propuesta, sin marca.
                      const elegida = g.estado !== 'pendiente' && m.visible;
                      const propuesta = g.estado === 'pendiente' && m.id === g.propuesta.id;
                      return (
                      <li key={m.id} className="flex items-center gap-2">
                        <button
                          onClick={() => quedarse(g, [m.id])}
                          disabled={trabajando}
                          title={elegida ? 'Esta es la que se ve' : 'Quedarme con esta: las demás dejan de salir'}
                          className={`group flex-1 min-w-0 flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${
                            elegida ? 'bg-pizarra' : propuesta ? 'bg-pizarra/50 hover:bg-pizarra' : 'hover:bg-pizarra/60'
                          }`}
                        >
                          <span className={`w-5 h-5 rounded-full shrink-0 flex items-center justify-center ${
                            elegida ? 'bg-lavanda text-noche'
                              : propuesta ? 'border-2 border-lavanda group-hover:bg-lavanda/20'
                              : 'border border-humo/60 group-hover:border-lavanda'
                          }`}>
                            {elegida && <Check className="w-3 h-3" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className={`text-sm truncate ${m.visible ? 'text-marfil' : 'text-niebla'}`}>
                                {m.biblioteca.nombre || 'Biblioteca sin nombre'}
                              </span>
                              {m.biblioteca.copiaSeguridad && (
                                <span className="px-1.5 py-px rounded-full text-[10px] bg-grafito text-lavanda shrink-0">copia de seguridad</span>
                              )}
                              {propuesta && (
                                <span className="px-1.5 py-px rounded-full text-[10px] bg-lavanda/15 text-lavanda shrink-0">propuesta</span>
                              )}
                              {m.name !== propia.name && (
                                <span className="text-[11px] text-humo truncate">como «{m.name}»</span>
                              )}
                            </span>
                            <span className="block text-[12px] text-niebla truncate" title={m.fullPath}>
                              {m.carpeta === '.' ? 'raíz del disco' : m.carpeta}
                            </span>
                          </span>
                          <Huellas m={m} />
                        </button>
                        <button
                          onClick={() => onAbrir(m.id)}
                          title="Abrir esta copia"
                          className="p-2 rounded-full text-humo hover:text-marfil hover:bg-pizarra transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                      </li>
                      );
                    })}
                  </ul>

                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    {g.estado === 'pendiente' && (
                      <button
                        onClick={() => quedarse(g, [g.propuesta.id])}
                        disabled={trabajando}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-60 transition-colors"
                      >
                        {trabajando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                        Aceptar la propuesta
                      </button>
                    )}
                    {!(g.estado === 'decidido' && g.miembros.every(m => m.preferida)) && (
                      <button
                        onClick={() => quedarse(g, g.miembros.map(m => m.id))}
                        disabled={trabajando}
                        title="Que se vean todas: por ejemplo, un archivo que pertenece a varios proyectos"
                        className="px-3 py-1.5 rounded-full text-xs bg-pizarra text-niebla hover:text-marfil disabled:opacity-60 transition-colors"
                      >
                        Quedarme con todas
                      </button>
                    )}
                    {(g.estado === 'decidido' || g.estado === 'suplente') && (
                      <button
                        onClick={() => devolver(g)}
                        disabled={trabajando}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-humo hover:text-niebla disabled:opacity-60 transition-colors"
                      >
                        <Undo2 className="w-3.5 h-3.5" />
                        Volver a por decidir
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {grupos.length < total && (
        <div className="flex justify-center mt-5">
          <button
            onClick={() => setLimite(l => l + POR_PAGINA)}
            className="px-4 py-2 rounded-full text-sm bg-pizarra text-niebla hover:text-marfil transition-colors"
          >
            Ver {Math.min(POR_PAGINA, total - grupos.length)} más de {total.toLocaleString('es-ES')}
          </button>
        </div>
      )}

      {resumen && resumen.sobrantes > 0 && grupos.length > 0 && (
        <p className="mt-6 text-xs text-humo">{textoDuplicados(resumen.sobrantes)} por decidir en total.</p>
      )}
    </div>
  );
}
