import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Lock, Unlock, Eye, X, Check, KeyRound, HardDrive } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../services/api';
import type { MediaFile } from '../types';
import { resolvePlayable } from '../utils/playable';

/**
 * Material oculto — la caja del candado.
 *
 * Cerrada, solo dice cuanto hay dentro y pide la clave. Abierta, enseña lo
 * oculto y deja devolverlo a la vista, de uno en uno o todo junto.
 *
 * La llave vive solo en el estado de este componente: al salir de la vista se
 * cierra sola y se tira (ni localStorage ni URL). Volver a entrar pide la
 * clave otra vez, que es exactamente lo que se espera de un candado.
 */

interface Props {
  onBack: () => void;
}

interface Ausente { clave: string; nombre: string; desde: string }

export default function OcultosView({ onBack }: Props) {
  const [total, setTotal] = useState<number | null>(null);
  const [llave, setLlave] = useState<string | null>(null);
  const [clave, setClave] = useState('');
  const [error, setError] = useState('');
  const [comprobando, setComprobando] = useState(false);
  const [sacudir, setSacudir] = useState(false);

  const [files, setFiles] = useState<MediaFile[]>([]);
  const [ausentes, setAusentes] = useState<Ausente[]>([]);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [viendo, setViendo] = useState<MediaFile | null>(null);
  const [cambiandoClave, setCambiandoClave] = useState(false);

  const llaveRef = useRef<string | null>(null);
  llaveRef.current = llave;

  useEffect(() => {
    api.getOcultosEstado().then(r => setTotal(r.data?.total ?? 0)).catch(() => setTotal(0));
    // Al salir de la vista, el candado se cierra en el servidor tambien.
    return () => {
      if (llaveRef.current) api.cerrarOcultos(llaveRef.current).catch(() => {});
    };
  }, []);

  const cargar = async (l: string) => {
    try {
      const r = await api.listarOcultos(l);
      setFiles(r.data?.files || []);
      setAusentes(r.data?.ausentes || []);
      setTotal(r.data?.total ?? 0);
    } catch (e: any) {
      if (e?.status === 401) {
        // La llave caduco (media hora sin usarla): vuelta a pedir la clave.
        setLlave(null);
        setError('El candado se ha vuelto a cerrar');
      } else {
        toast.error(e?.message || 'No se pudo abrir');
      }
    }
  };

  const abrir = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!clave || comprobando) return;
    setComprobando(true);
    setError('');
    try {
      const r = await api.abrirOcultos(clave);
      const l = r.data?.llave;
      if (!l) throw new Error('Clave incorrecta');
      setLlave(l);
      setClave('');
      await cargar(l);
    } catch (err: any) {
      setError(err?.message || 'Clave incorrecta');
      setSacudir(true);
      setTimeout(() => setSacudir(false), 450);
      setClave('');
    } finally {
      setComprobando(false);
    }
  };

  const cerrar = () => {
    if (llave) api.cerrarOcultos(llave).catch(() => {});
    setLlave(null);
    setFiles([]);
    setAusentes([]);
    setMarcados(new Set());
    setViendo(null);
  };

  const mostrar = async (ids: string[]) => {
    if (!llave || ids.length === 0) return;
    try {
      const r = await api.mostrarOcultos(llave, ids);
      const n = r.data?.mostrados ?? 0;
      toast.success(n === 1 ? 'Vuelve a estar a la vista' : `${n} archivos vuelven a estar a la vista`);
      setMarcados(new Set());
      setViendo(null);
      await cargar(llave);
    } catch (e: any) {
      if (e?.status === 401) { setLlave(null); setError('El candado se ha vuelto a cerrar'); return; }
      toast.error(e?.message || 'No se pudo sacar del candado');
    }
  };

  const alternar = (id: string) => {
    setMarcados(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── Cerrada ─────────────────────────────────────────────────────────────
  if (!llave) {
    return (
      <div className="min-h-[70vh] flex flex-col">
        <button
          onClick={onBack}
          className="self-start flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Volver</span>
        </button>

        <div className="flex-1 flex items-center justify-center px-4">
          <form onSubmit={abrir} className="w-full max-w-xs flex flex-col items-center text-center">
            <div className="relative mb-6">
              <div className="absolute inset-0 rounded-full bg-lavanda/20 blur-2xl" aria-hidden="true" />
              <div className="relative w-20 h-20 rounded-full bg-grafito border border-lavanda/25 flex items-center justify-center">
                <Lock className="w-8 h-8 text-lavanda" />
              </div>
            </div>
            <h1 className="text-2xl font-semibold text-marfil">Material oculto</h1>
            <p className="mt-2 text-sm text-niebla">
              {total === null ? ' '
                : total === 0 ? 'No hay nada bajo candado'
                : total === 1 ? 'Hay 1 archivo bajo candado'
                : `Hay ${total.toLocaleString('es-ES')} archivos bajo candado`}
            </p>

            <input
              type="password"
              autoFocus
              autoComplete="off"
              value={clave}
              onChange={(e) => { setClave(e.target.value); setError(''); }}
              // Enter explicito: el envio implicito del formulario no siempre
              // llega (teclados virtuales, algunos lectores de pantalla).
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); abrir(); } }}
              placeholder="Clave"
              aria-label="Clave del candado"
              className={`mt-8 w-full text-center tracking-[0.5em] text-xl px-4 py-3 rounded-2xl bg-tinta border text-marfil placeholder:text-humo placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-lavanda transition-colors ${
                error ? 'border-estado-error/60' : 'border-pizarra'
              }`}
              style={sacudir ? { animation: 'sacudir 0.4s ease-in-out' } : undefined}
            />
            <p className="h-5 mt-2 text-xs text-estado-error" role="alert">{error}</p>

            <button
              type="submit"
              disabled={!clave || comprobando}
              className="mt-2 w-full btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {comprobando ? 'Comprobando…' : 'Abrir'}
            </button>
          </form>
        </div>
        <style>{`@keyframes sacudir{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}`}</style>
      </div>
    );
  }

  // ── Abierta ─────────────────────────────────────────────────────────────
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <button
          onClick={onBack}
          className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Volver</span>
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCambiandoClave(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-niebla hover:text-marfil hover:bg-grafito transition-colors"
          >
            <KeyRound className="w-3.5 h-3.5" />
            Cambiar clave
          </button>
          <button
            onClick={cerrar}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-grafito text-lavanda hover:bg-pizarra transition-colors"
          >
            <Lock className="w-3.5 h-3.5" />
            Cerrar candado
          </button>
        </div>
      </div>

      <header className="mb-6">
        <div className="flex items-center gap-3">
          <Unlock className="w-6 h-6 text-lavanda" />
          <h1 className="text-2xl font-semibold text-marfil">Material oculto</h1>
        </div>
        <p className="mt-1 text-sm text-niebla">
          No sale en la galería, ni en búsquedas, recuerdos, colecciones o estadísticas. Los archivos siguen en su disco.
        </p>
      </header>

      {cambiandoClave && <CambiarClave onHecho={() => setCambiandoClave(false)} />}

      {/* Barra de accion: aparece solo cuando hay algo marcado. */}
      <div className="sticky z-20 mb-4 flex items-center justify-between gap-3 flex-wrap" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
        <p className="text-sm text-humo">
          {files.length === 0 && ausentes.length === 0
            ? 'Nada bajo candado'
            : marcados.size > 0
              ? `${marcados.size} marcados`
              : `${files.length.toLocaleString('es-ES')} ${files.length === 1 ? 'archivo' : 'archivos'}`}
        </p>
        <div className="flex items-center gap-2">
          {marcados.size > 0 && (
            <>
              <button onClick={() => setMarcados(new Set())} className="px-3 py-1.5 rounded-full text-xs text-niebla hover:text-marfil">
                Desmarcar
              </button>
              <button onClick={() => mostrar(Array.from(marcados))} className="flex items-center gap-1.5 btn-primary text-sm">
                <Eye className="w-4 h-4" />
                Mostrar {marcados.size}
              </button>
            </>
          )}
          {marcados.size === 0 && files.length > 1 && (
            <button
              onClick={() => { if (confirm(`¿Devolver a la vista los ${files.length} archivos?`)) mostrar(files.map(f => f.id)); }}
              className="px-3 py-1.5 rounded-full text-xs text-niebla hover:text-marfil hover:bg-grafito transition-colors"
            >
              Mostrar todo
            </button>
          )}
        </div>
      </div>

      {files.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 md:gap-3">
          {files.map(f => {
            const marcado = marcados.has(f.id);
            return (
              <div key={f.id} className={`group relative aspect-square rounded-xl overflow-hidden bg-grafito ${marcado ? 'ring-2 ring-lavanda' : ''}`}>
                <button onClick={() => setViendo(f)} className="absolute inset-0" title={f.displayName || f.name}>
                  <img
                    src={f.thumbnail}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                </button>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-noche/90 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                <button
                  onClick={() => alternar(f.id)}
                  aria-pressed={marcado}
                  aria-label={marcado ? 'Desmarcar' : 'Marcar'}
                  className={`absolute top-2 left-2 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                    marcado ? 'bg-lavanda border-lavanda text-noche' : 'bg-noche/50 border-white/70 text-transparent opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  onClick={() => mostrar([f.id])}
                  className="absolute bottom-2 left-2 right-2 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-lavanda text-noche text-xs font-medium opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                >
                  <Eye className="w-3.5 h-3.5" />
                  Mostrar
                </button>
              </div>
            );
          })}
        </div>
      )}

      {ausentes.length > 0 && (
        <section className="mt-8">
          <h2 className="flex items-center gap-2 text-sm font-medium text-niebla">
            <HardDrive className="w-4 h-4" />
            {ausentes.length === 1 ? '1 archivo' : `${ausentes.length} archivos`} en discos no conectados
          </h2>
          <p className="text-xs text-humo mt-1">Siguen ocultos. Puedes liberarlos ya, sin esperar a que vuelva el disco.</p>
          <ul className="mt-3 divide-y divide-borde-sutil">
            {ausentes.slice(0, 200).map(a => (
              <li key={a.clave} className="flex items-center justify-between gap-3 py-2">
                <span className="text-sm text-niebla truncate" title={a.clave}>{a.nombre || a.clave}</span>
                <button onClick={() => mostrar([a.clave])} className="text-xs text-lavanda hover:text-lavanda-claro shrink-0">
                  Liberar
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {viendo && <Visor file={viendo} onClose={() => setViendo(null)} onMostrar={() => mostrar([viendo.id])} />}
    </div>
  );
}

function Visor({ file, onClose, onMostrar }: { file: MediaFile; onClose: () => void; onMostrar: () => void }) {
  const [src, setSrc] = useState<string | undefined>(file.type === 'video' ? undefined : file.url);
  useEffect(() => {
    if (file.type !== 'video') return;
    const ctl = new AbortController();
    resolvePlayable(file.id, { signal: ctl.signal }).then(info => setSrc(info.url || file.url));
    return () => ctl.abort();
  }, [file]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const nombre = useMemo(() => file.displayName || file.name, [file]);

  return (
    <div className="fixed inset-0 z-[80] bg-noche/95 backdrop-blur-sm flex flex-col" role="dialog" aria-label={nombre}>
      <div className="flex items-center justify-between gap-3 p-4">
        <p className="text-sm text-niebla truncate">{nombre}</p>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onMostrar} className="flex items-center gap-1.5 btn-primary text-sm">
            <Eye className="w-4 h-4" />
            Mostrar
          </button>
          <button onClick={onClose} aria-label="Cerrar" className="p-2 rounded-full text-niebla hover:text-marfil hover:bg-grafito">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center px-4 pb-4" onClick={onClose}>
        {file.type === 'video' ? (
          src
            ? <video src={src} controls autoPlay className="max-w-full max-h-full rounded-xl" onClick={(e) => e.stopPropagation()} />
            : <p className="text-sm text-humo">Preparando el vídeo…</p>
        ) : file.type === 'audio' ? (
          <audio src={src} controls autoPlay onClick={(e) => e.stopPropagation()} />
        ) : (
          <img src={src} alt="" className="max-w-full max-h-full object-contain rounded-xl" onClick={(e) => e.stopPropagation()} />
        )}
      </div>
    </div>
  );
}

function CambiarClave({ onHecho }: { onHecho: () => void }) {
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [repetida, setRepetida] = useState('');
  const [error, setError] = useState('');

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nueva !== repetida) { setError('Las dos claves nuevas no coinciden'); return; }
    try {
      await api.cambiarClaveOcultos(actual, nueva);
      toast.success('Clave cambiada');
      onHecho();
    } catch (err: any) {
      setError(err?.message || 'No se pudo cambiar');
    }
  };

  const campo = 'px-3 py-2 rounded-xl bg-tinta border border-pizarra text-marfil text-sm focus:outline-none focus:ring-2 focus:ring-lavanda';
  return (
    <form onSubmit={guardar} className="mb-6 p-4 rounded-2xl bg-grafito/60 border border-borde-sutil flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-humo">
        Clave actual
        <input type="password" value={actual} onChange={e => { setActual(e.target.value); setError(''); }} className={campo} autoFocus />
      </label>
      <label className="flex flex-col gap-1 text-xs text-humo">
        Nueva
        <input type="password" value={nueva} onChange={e => { setNueva(e.target.value); setError(''); }} className={campo} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-humo">
        Repítela
        <input type="password" value={repetida} onChange={e => { setRepetida(e.target.value); setError(''); }} className={campo} />
      </label>
      <button type="submit" disabled={!actual || nueva.length < 4} className="btn-primary text-sm disabled:opacity-40">Guardar</button>
      {error && <p className="w-full text-xs text-estado-error">{error}</p>}
    </form>
  );
}
