import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, Loader2, Lock, Trash2, UserX, X } from 'lucide-react';
import { api, ArchivosPersona } from '../services/api';

/**
 * ¿Qué hacemos con esta persona? — sustituye al antiguo "¿Eliminar a X y
 * todas sus fotos?", que se podia leer como que borraba sus fotos del archivo
 * (solo borraba las de referencia).
 *
 * Tres cosas distintas, cada una con lo que implica dicho antes de hacerla:
 *  - Ocultar sus archivos: bajo el candado. Siguen en disco; vuelven con la clave.
 *  - Moverlos a la papelera: salen de sus carpetas; se restauran hasta que
 *    se vacie la papelera. Hay que escribir su nombre.
 *  - Olvidarla: se borra la ficha y deja de reconocerse. Sus archivos no se
 *    tocan. Opcionalmente, que no te la vuelva a proponer como desconocida.
 *
 * El orden importa: los archivos se encuentran POR la persona, asi que lo que
 * se vaya a hacer con ellos va antes de olvidarla. Por eso olvidar va al final.
 */

interface Props {
  persona: { person_id: string; display_name: string };
  onCerrar: () => void;
  /** La ficha ya no existe: quien abrio esto la quita de su lista. */
  onOlvidada: () => void;
}

type Alcance = 'todos' | 'sin_otros';

const numero = (n: number) => n.toLocaleString('es-ES');
const normal = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

function tamaño(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toLocaleString('es-ES', { maximumFractionDigits: i >= 3 ? 1 : 0 })} ${u[i]}`;
}

export default function PersonaAcciones({ persona, onCerrar, onOlvidada }: Props) {
  const navigate = useNavigate();
  const nombre = persona.display_name || persona.person_id;
  const [alcance, setAlcance] = useState<Alcance>('todos');
  const [vista, setVista] = useState<ArchivosPersona | null>(null);
  const [totalTodos, setTotalTodos] = useState<number | null>(null);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState<null | 'ocultar' | 'papelera' | 'olvidar'>(null);
  const [pidiendoNombre, setPidiendoNombre] = useState(false);
  const [escrito, setEscrito] = useState('');
  const [confirmarOlvido, setConfirmarOlvido] = useState(false);
  const [noProponer, setNoProponer] = useState(true);
  const [hecho, setHecho] = useState<{ texto: string; papelera?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async (a: Alcance) => {
    setCargando(true);
    try {
      const r = await api.getArchivosPersona(persona.person_id, a);
      if (r.success && r.data) {
        setVista(r.data);
        if (a === 'todos') setTotalTodos(r.data.total);
      }
    } catch (e: any) {
      setError(e?.message || 'No se pudo saber en qué archivos aparece');
    } finally {
      setCargando(false);
    }
  }, [persona.person_id]);

  useEffect(() => { cargar(alcance); }, [alcance, cargar]);

  // Escape cierra (si no hay nada a medias).
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape' && !ocupado) onCerrar(); };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [ocupado, onCerrar]);

  const hayArchivos = !!vista && vista.total > 0;
  const desconectados = (vista?.discos || []).filter(d => !d.conectado);
  const enDesconectados = desconectados.reduce((s, d) => s + d.n, 0);
  const movibles = (vista?.total || 0) - enDesconectados;
  const nombreBien = normal(escrito) === normal(nombre);

  async function ocultar() {
    setOcupado('ocultar'); setError(null);
    try {
      const r = await api.ocultarArchivosPersona(persona.person_id, alcance);
      const d = r.data!;
      setHecho({ texto: d.ocultados > 0
        ? `${numero(d.ocultados)} ${d.ocultados === 1 ? 'archivo oculto' : 'archivos ocultos'} bajo el candado${d.yaEstaban > 0 ? ` (${numero(d.yaEstaban)} ya lo estaban)` : ''}.`
        : 'Ya estaban todos ocultos.' });
      if (d.deshacer) {
        const token = d.deshacer;
        toast((t) => (
          <span className="flex items-center gap-3">
            <span>{numero(d.ocultados)} ocultos bajo el candado</span>
            <button
              className="text-lavanda font-medium"
              onClick={async () => {
                toast.dismiss(t.id);
                try { await api.deshacerOcultado(token); toast.success('Vuelven a estar a la vista'); cargar(alcance); }
                catch { toast.error('Ya no se puede deshacer: sácalos desde Material oculto'); }
              }}
            >
              Deshacer
            </button>
          </span>
        ), { duration: 20000 });
      }
      cargar(alcance);
    } catch (e: any) {
      setError(e?.message || 'No se pudieron ocultar');
    } finally {
      setOcupado(null);
    }
  }

  async function aPapelera() {
    if (!nombreBien) return;
    setOcupado('papelera'); setError(null);
    try {
      const r = await api.papeleraArchivosPersona(persona.person_id, alcance, escrito);
      const d = r.data!;
      setPidiendoNombre(false);
      setEscrito('');
      setHecho({
        texto: `${numero(d.movidos)} ${d.movidos === 1 ? 'archivo movido' : 'archivos movidos'} a la papelera (${tamaño(d.bytes)}).`
          + (d.fallidos.length ? ` ${numero(d.fallidos.length)} no se pudieron mover: ${d.fallidos[0].motivo}.` : ''),
        papelera: d.movidos > 0,
      });
      cargar(alcance);
    } catch (e: any) {
      setError(e?.message || 'No se pudieron mover a la papelera');
    } finally {
      setOcupado(null);
    }
  }

  async function olvidar() {
    setOcupado('olvidar'); setError(null);
    try {
      const r = await api.deletePerson(persona.person_id, noProponer);
      toast.success(noProponer && r.olvidada
        ? `${nombre} olvidada: no se te volverá a proponer`
        : `${nombre} olvidada`);
      onOlvidada();
    } catch (e: any) {
      setError(e?.message || 'No se pudo olvidar');
      setOcupado(null);
    }
  }

  const tarjeta = 'rounded-xl border border-borde-sutil bg-grafito/40 p-4';

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-noche/75 backdrop-blur-sm p-4"
      onClick={() => { if (!ocupado) onCerrar(); }}
      role="dialog"
      aria-label={`Qué hacer con ${nombre}`}
    >
      <div
        className="w-full max-w-[560px] max-h-[92vh] overflow-y-auto rounded-2xl border border-borde-sutil bg-tinta p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 mb-1">
          <h2 className="text-[19px] font-semibold text-marfil">¿Qué hacemos con {nombre}?</h2>
          <button onClick={onCerrar} disabled={!!ocupado} className="text-humo hover:text-marfil p-1 -m-1" title="Cerrar">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Lo que hay, antes de tocar nada */}
        <p className="text-[13px] text-niebla mb-4 min-h-[20px]">
          {cargando && !vista ? 'Buscando en qué archivos aparece…' : vista && totalTodos !== null && (
            totalTodos === 0
              ? 'No aparece en ningún archivo del catálogo.'
              : <>Aparece en <span className="text-marfil font-medium">{numero(totalTodos)}</span> {totalTodos === 1 ? 'archivo' : 'archivos'}.</>
          )}
        </p>

        {hecho && (
          <div className="mb-4 rounded-lg bg-salvia/10 border border-salvia/30 px-3.5 py-2.5 text-[12px] text-salvia flex items-center justify-between gap-3 flex-wrap">
            <span>{hecho.texto}</span>
            {hecho.papelera && (
              <button onClick={() => { onCerrar(); navigate('/papelera'); }} className="underline underline-offset-2 hover:text-marfil">
                Ver la papelera
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg bg-estado-error/10 border border-estado-error/30 px-3.5 py-2.5 text-[12px] text-estado-error">
            {error}
          </div>
        )}

        {/* ── Sus archivos ─────────────────────────────────────────────── */}
        {totalTodos !== null && totalTodos > 0 && (
          <section className="mb-5">
            <p className="font-mono text-[10px] tracking-wider uppercase text-humo mb-2.5">Sus archivos</p>

            <div className="inline-flex items-center gap-1 rounded-full bg-grafito/70 p-1 mb-3 flex-wrap">
              {([['todos', `Todos (${numero(totalTodos)})`], ['sin_otros', `Solo donde no sale nadie más (${numero(vista?.soloElla ?? 0)})`]] as const).map(([id, txt]) => (
                <button
                  key={id}
                  onClick={() => { setAlcance(id); setPidiendoNombre(false); setEscrito(''); }}
                  disabled={!!ocupado}
                  className={`h-8 px-3.5 rounded-full text-[12px] font-medium transition-colors ${
                    alcance === id ? 'bg-lavanda text-noche' : 'text-niebla hover:text-marfil'
                  }`}
                >
                  {txt}
                </button>
              ))}
            </div>

            {vista && (
              <div className="text-[12px] text-humo leading-relaxed mb-3.5">
                <p>
                  {numero(vista.total)} {vista.total === 1 ? 'archivo' : 'archivos'} · {tamaño(vista.bytes)}
                  {vista.porTipo.video > 0 && ` · ${numero(vista.porTipo.video)} ${vista.porTipo.video === 1 ? 'vídeo' : 'vídeos'}`}
                  {vista.porTipo.image > 0 && ` · ${numero(vista.porTipo.image)} ${vista.porTipo.image === 1 ? 'foto' : 'fotos'}`}
                  {vista.ocultos > 0 && ` · ${numero(vista.ocultos)} ya ocultos`}
                </p>
                {vista.carpetas.length > 0 && (
                  <p className="truncate">en {vista.carpetas.map(c => `${c.nombre} (${numero(c.n)})`).join(', ')}</p>
                )}
                {alcance === 'todos' && vista.conOtros > 0 && (
                  <p className="mt-1.5 text-melocoton">
                    En {numero(vista.conOtros)} sale también
                    {' '}{vista.otros.map(o => o.nombre).slice(0, 4).join(', ')}{vista.otros.length > 4 ? ' y más' : ''}:
                    lo que hagas con ellos les afecta.
                  </p>
                )}
              </div>
            )}

            {hayArchivos ? (
              <div className="flex flex-col gap-2.5">
                {/* Ocultar */}
                <div className={tarjeta}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="flex items-center gap-2 text-[14px] text-marfil font-medium"><Lock className="w-4 h-4 text-lavanda" /> Ocultarlos</p>
                      <p className="mt-1 text-[12px] text-humo leading-snug">
                        Dejan de verse en la aplicación. Siguen en el disco, en su sitio. Vuelven con la clave del candado.
                      </p>
                    </div>
                    <button
                      onClick={ocultar}
                      disabled={!!ocupado || vista!.ocultos >= vista!.total}
                      className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full bg-grafito hover:bg-pizarra text-[12px] text-marfil transition-colors disabled:opacity-40"
                    >
                      {ocupado === 'ocultar' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      Ocultar {numero(vista!.total - vista!.ocultos)}
                    </button>
                  </div>
                </div>

                {/* Papelera */}
                <div className={`${tarjeta} ${pidiendoNombre ? 'border-estado-error/40' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="flex items-center gap-2 text-[14px] text-marfil font-medium"><Trash2 className="w-4 h-4 text-estado-error" /> Borrarlos del disco</p>
                      <p className="mt-1 text-[12px] text-humo leading-snug">
                        Salen de sus carpetas a la papelera de Pensadero. Se pueden restaurar hasta que vacíes la papelera;
                        vaciarla es lo que los borra de verdad.
                      </p>
                    </div>
                    {!pidiendoNombre && (
                      <button
                        onClick={() => setPidiendoNombre(true)}
                        disabled={!!ocupado || movibles <= 0}
                        className="shrink-0 h-8 px-3.5 rounded-full bg-grafito hover:bg-estado-error/15 text-[12px] text-estado-error transition-colors disabled:opacity-40"
                      >
                        Borrar {numero(movibles)}
                      </button>
                    )}
                  </div>

                  {enDesconectados > 0 && (
                    <p className="mt-2 text-[11px] text-melocoton">
                      {numero(enDesconectados)} {enDesconectados === 1 ? 'está' : 'están'} en {desconectados.map(d => d.raiz).join(', ')}, que no está conectado: esos no se moverán ahora.
                    </p>
                  )}

                  {pidiendoNombre && (
                    <div className="mt-3.5 pt-3.5 border-t border-borde-sutil">
                      <p className="flex items-start gap-2 text-[12px] text-niebla leading-snug mb-2.5">
                        <AlertTriangle className="w-4 h-4 text-estado-error shrink-0 mt-px" />
                        <span>
                          Se van a mover <span className="text-marfil">{numero(movibles)} archivos ({tamaño(vista!.bytes)})</span> a la papelera.
                          Para confirmarlo, escribe <span className="text-marfil font-medium">«{nombre}»</span>.
                        </span>
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          autoFocus
                          value={escrito}
                          onChange={(e) => setEscrito(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && nombreBien) aPapelera(); }}
                          placeholder={nombre}
                          className="flex-1 min-w-[180px] h-9 px-3 rounded-lg bg-noche border border-borde-sutil text-[13px] text-marfil focus:outline-none focus:border-estado-error/60"
                        />
                        <button
                          onClick={aPapelera}
                          disabled={!nombreBien || !!ocupado}
                          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-estado-error text-noche text-[12px] font-semibold transition-opacity disabled:opacity-30"
                        >
                          {ocupado === 'papelera' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          Mover a la papelera
                        </button>
                        <button onClick={() => { setPidiendoNombre(false); setEscrito(''); }} className="h-9 px-2 text-[12px] text-humo hover:text-niebla">
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : vista && !cargando && (
              <p className="text-[12px] text-humo">Con este criterio no hay archivos.</p>
            )}
          </section>
        )}

        {/* ── La persona ───────────────────────────────────────────────── */}
        <section>
          <p className="font-mono text-[10px] tracking-wider uppercase text-humo mb-2.5">La persona</p>
          <div className={`${tarjeta} ${confirmarOlvido ? 'border-melocoton/40' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-[14px] text-marfil font-medium"><UserX className="w-4 h-4 text-melocoton" /> Olvidar a {nombre}</p>
                <p className="mt-1 text-[12px] text-humo leading-snug">
                  Se borra su ficha y sus fotos de referencia, y deja de reconocerse en ningún archivo.
                  Los archivos no se tocan.
                </p>
              </div>
              {!confirmarOlvido && (
                <button
                  onClick={() => setConfirmarOlvido(true)}
                  disabled={!!ocupado}
                  className="shrink-0 h-8 px-3.5 rounded-full bg-grafito hover:bg-melocoton/15 text-[12px] text-melocoton transition-colors disabled:opacity-40"
                >
                  Olvidar
                </button>
              )}
            </div>

            {confirmarOlvido && (
              <div className="mt-3.5 pt-3.5 border-t border-borde-sutil">
                <label className="flex items-start gap-2.5 text-[12px] text-niebla leading-snug cursor-pointer mb-3">
                  <input type="checkbox" checked={noProponer} onChange={(e) => setNoProponer(e.target.checked)} className="mt-0.5 accent-lavanda" />
                  <span>
                    No volver a proponérmela entre las caras desconocidas.
                    <span className="block text-humo">Si no lo marcas, sus caras vuelven a salir como alguien sin nombre.</span>
                  </span>
                </label>
                {totalTodos !== null && totalTodos > 0 && (
                  <p className="text-[11px] text-melocoton mb-3 leading-snug">
                    Si vas a ocultar o borrar sus archivos, hazlo antes: después ya no se sabrá en cuáles aparece.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <button
                    onClick={olvidar}
                    disabled={!!ocupado}
                    className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-melocoton text-noche text-[12px] font-semibold disabled:opacity-40"
                  >
                    {ocupado === 'olvidar' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Olvidar a {nombre}
                  </button>
                  <button onClick={() => setConfirmarOlvido(false)} disabled={!!ocupado} className="h-9 px-2 text-[12px] text-humo hover:text-niebla">
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
