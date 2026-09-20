import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, HardDrive, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, LotePapelera } from '../services/api';

/**
 * Papelera — lo que ha salido del archivo y todavia se puede recuperar.
 *
 * Cada lote es una accion (p. ej. "Persona: Fulana"): sus archivos siguen en
 * el mismo disco, apartados en una carpeta que la aplicacion no enseña.
 * Restaurar los devuelve a su sitio; vaciar los borra de verdad, y para eso
 * hay que escribir «vaciar». Es el unico sitio de Pensadero que borra archivos.
 */

interface Props {
  onBack: () => void;
}

const numero = (n: number) => n.toLocaleString('es-ES');

function tamaño(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toLocaleString('es-ES', { maximumFractionDigits: i >= 3 ? 1 : 0 })} ${u[i]}`;
}

function fecha(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export default function PapeleraView({ onBack }: Props) {
  const [lotes, setLotes] = useState<LotePapelera[] | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [vaciando, setVaciando] = useState<string | null>(null);
  const [escrito, setEscrito] = useState('');

  const cargar = useCallback(async () => {
    try {
      const r = await api.getPapelera();
      setLotes(r.data || []);
    } catch {
      setLotes([]);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function restaurar(l: LotePapelera) {
    setOcupado(`restaurar:${l.id}`);
    try {
      const r = await api.restaurarLote(l.id);
      const d = r.data!;
      if (d.pendientes === 0) toast.success(`${numero(d.restaurados)} ${d.restaurados === 1 ? 'archivo ha vuelto' : 'archivos han vuelto'} a su sitio`);
      else if (d.conflictos.length) toast.error(`${numero(d.restaurados)} restaurados; ${numero(d.conflictos.length)} no, porque ya hay otro archivo en su lugar`);
      else toast(`${numero(d.restaurados)} restaurados; ${numero(d.pendientes)} esperan a que conectes su disco`);
      await cargar();
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo restaurar');
    } finally {
      setOcupado(null);
    }
  }

  async function vaciar(l: LotePapelera) {
    setOcupado(`vaciar:${l.id}`);
    try {
      const r = await api.vaciarLote(l.id, escrito);
      const d = r.data!;
      toast.success(`${numero(d.borrados)} ${d.borrados === 1 ? 'archivo borrado' : 'archivos borrados'} · ${tamaño(d.bytes)} liberados`
        + (d.quedan > 0 ? ` · ${numero(d.quedan)} esperan a que conectes su disco` : ''));
      setVaciando(null);
      setEscrito('');
      await cargar();
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo vaciar');
    } finally {
      setOcupado(null);
    }
  }

  const total = (lotes || []).reduce((s, l) => s + l.bytes, 0);

  return (
    <div className="max-w-[860px]">
      <button
        onClick={onBack}
        className="flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Volver</span>
      </button>

      <h1 className="text-[1.7rem] font-bold text-marfil leading-none">Papelera</h1>
      <p className="mt-2 text-sm text-niebla max-w-[620px]">
        Lo que has sacado del archivo. Sigue en su mismo disco, apartado: puedes devolverlo a su sitio
        o vaciarlo, que es lo que lo borra de verdad.
      </p>

      {lotes === null ? (
        <p className="mt-10 text-sm text-humo flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Mirando la papelera…</p>
      ) : lotes.length === 0 ? (
        <p className="mt-10 text-sm text-humo">La papelera está vacía.</p>
      ) : (
        <>
          <p className="mt-6 mb-4 font-mono text-[11px] text-humo">
            {numero(lotes.length)} {lotes.length === 1 ? 'lote' : 'lotes'} · {tamaño(total)} ocupados
          </p>
          <div className="flex flex-col gap-3">
            {lotes.map(l => (
              <div key={l.id} className={`rounded-xl border bg-grafito/40 p-4 ${vaciando === l.id ? 'border-estado-error/40' : 'border-borde-sutil'}`}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-[14px] text-marfil font-medium">{l.motivo}</p>
                    <p className="mt-0.5 text-[12px] text-humo">
                      {fecha(l.fecha)} · {numero(l.presentes)} {l.presentes === 1 ? 'archivo' : 'archivos'} · {tamaño(l.bytes)}
                    </p>
                    {l.muestra.length > 0 && (
                      <p className="mt-1.5 text-[11px] text-humo truncate font-mono">
                        {l.muestra.join(' · ')}{l.archivos > l.muestra.length ? ' …' : ''}
                      </p>
                    )}
                    {!l.conectado && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-melocoton">
                        <HardDrive className="w-3.5 h-3.5" /> Parte está en un disco que no está conectado.
                      </p>
                    )}
                  </div>
                  {vaciando !== l.id && (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => restaurar(l)}
                        disabled={!!ocupado}
                        className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full bg-grafito hover:bg-pizarra text-[12px] text-marfil transition-colors disabled:opacity-40"
                      >
                        {ocupado === `restaurar:${l.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                        Restaurar
                      </button>
                      <button
                        onClick={() => { setVaciando(l.id); setEscrito(''); }}
                        disabled={!!ocupado}
                        className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full bg-grafito hover:bg-estado-error/15 text-[12px] text-estado-error transition-colors disabled:opacity-40"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Vaciar
                      </button>
                    </div>
                  )}
                </div>

                {vaciando === l.id && (
                  <div className="mt-3.5 pt-3.5 border-t border-borde-sutil">
                    <p className="text-[12px] text-niebla mb-2.5">
                      Esto borra <span className="text-marfil">{numero(l.presentes)} archivos ({tamaño(l.bytes)})</span> para siempre.
                      No hay vuelta atrás. Escribe <span className="text-marfil font-medium">«vaciar»</span> para confirmarlo.
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        autoFocus
                        value={escrito}
                        onChange={(e) => setEscrito(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && escrito.trim().toLowerCase() === 'vaciar') vaciar(l); }}
                        placeholder="vaciar"
                        className="w-44 h-9 px-3 rounded-lg bg-noche border border-borde-sutil text-[13px] text-marfil focus:outline-none focus:border-estado-error/60"
                      />
                      <button
                        onClick={() => vaciar(l)}
                        disabled={escrito.trim().toLowerCase() !== 'vaciar' || !!ocupado}
                        className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-estado-error text-noche text-[12px] font-semibold disabled:opacity-30"
                      >
                        {ocupado === `vaciar:${l.id}` && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Borrar para siempre
                      </button>
                      <button onClick={() => { setVaciando(null); setEscrito(''); }} className="h-9 px-2 text-[12px] text-humo hover:text-niebla">
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
