/**
 * Crear o cambiar un grupo de personas — Pensadero
 *
 * Un nombre y a quien meter. Nada mas: como se busca (cuantos tienen que
 * salir, en la toma o en el dia) se ajusta desde el propio chip de la barra,
 * viendo los resultados, que es donde tiene sentido decidirlo.
 */

import { useMemo, useState } from 'react';
import { Check, Search, Trash2, Users, X } from 'lucide-react';
import toast from 'react-hot-toast';
import config from '../config';
import type { GrupoPersonas } from '../types';
import type { CaraPersona } from './GrupoChip';
import { actualizarGrupo, borrarGrupo, crearGrupo } from '../hooks/useGrupos';
import { normalizarNombre } from '../utils/grupos';

export default function GrupoEditor({ grupo, persons, apariciones, iniciales = [], onClose }: {
  /** Sin grupo: se crea uno nuevo. */
  grupo?: GrupoPersonas | null;
  persons: CaraPersona[];
  /** Archivos en los que sale cada persona: ordena la lista y se ensena. */
  apariciones?: Map<string, number>;
  /** Personas ya marcadas al abrir (p. ej. desde la ficha de alguien). */
  iniciales?: string[];
  onClose: () => void;
}) {
  const [nombre, setNombre] = useState(grupo?.nombre ?? '');
  const [miembros, setMiembros] = useState<string[]>(grupo?.miembros ?? iniciales);
  const [busca, setBusca] = useState('');
  const [guardando, setGuardando] = useState(false);

  const cuantas = (id: string) => apariciones?.get(id) ?? 0;

  // Quien sale en el archivo, primero y por apariciones; las fichas vacias al
  // final (se pueden meter, pero rara vez es lo que se busca).
  const lista = useMemo(() => {
    const q = normalizarNombre(busca);
    return persons
      .filter(p => !q || normalizarNombre(p.display_name).includes(q))
      .sort((a, b) => cuantas(b.person_id) - cuantas(a.person_id) || a.display_name.localeCompare(b.display_name, 'es'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persons, busca, apariciones]);

  const alternar = (id: string) =>
    setMiembros(prev => (prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]));

  const valido = nombre.trim().length > 0 && miembros.length >= 2;

  const guardar = async () => {
    if (!valido || guardando) return;
    setGuardando(true);
    try {
      if (grupo) {
        await actualizarGrupo(grupo.id, { nombre: nombre.trim(), miembros });
        toast.success(`Grupo «${nombre.trim()}» guardado`);
      } else {
        const nuevo = await crearGrupo(nombre.trim(), miembros);
        toast.success(`Grupo «${nuevo.nombre}» creado. Búscalo con @${nuevo.nombre.toLowerCase()}`);
      }
      onClose();
    } catch (err) {
      toast.error((err as Error).message || 'No se ha podido guardar el grupo');
    } finally {
      setGuardando(false);
    }
  };

  const borrar = async () => {
    if (!grupo) return;
    const ok = window.confirm(`¿Borrar el grupo «${grupo.nombre}»?\n\nSolo se borra el grupo: las personas y sus archivos no se tocan.`);
    if (!ok) return;
    try {
      await borrarGrupo(grupo.id);
      toast.success(`Grupo «${grupo.nombre}» borrado`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message || 'No se ha podido borrar el grupo');
    }
  };

  const nombreDe = (id: string) => persons.find(p => p.person_id === id)?.display_name || id;
  const avatarDe = (id: string) => persons.find(p => p.person_id === id)?.avatar_url || null;

  return (
    <div
      className="fixed inset-0 bg-noche/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-tinta rounded-3xl border border-pizarra w-full max-w-lg max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-lg font-semibold text-marfil flex items-center gap-2">
            <Users className="w-5 h-5 text-lavanda" />
            {grupo ? `Grupo «${grupo.nombre}»` : 'Nuevo grupo'}
          </h2>
          <button onClick={onClose} className="text-humo hover:text-marfil" title="Cerrar">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 flex flex-col gap-4 overflow-y-auto">
          <div>
            <label className="block font-mono text-[10px] tracking-wider uppercase text-humo mb-1.5">Nombre</label>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') guardar(); }}
              maxLength={40}
              autoFocus
              placeholder="Familia, Rodaje, Los del pueblo…"
              className="w-full bg-pizarra rounded-xl px-3 py-2 text-marfil outline-none focus:ring-2 focus:ring-lavanda placeholder:text-humo"
            />
            {nombre.trim() && (
              <p className="mt-1 text-[11px] text-humo">
                En la barra de búsqueda: <span className="font-mono text-lavanda-archivo">@{nombre.trim().toLowerCase()}</span>
              </p>
            )}
          </div>

          <div>
            <p className="font-mono text-[10px] tracking-wider uppercase text-humo mb-1.5">
              Quién está <span className="normal-case tracking-normal">· {miembros.length} {miembros.length === 1 ? 'persona' : 'personas'}</span>
            </p>
            {miembros.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {miembros.map(id => (
                  <span key={id} className="inline-flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full bg-lavanda text-noche text-xs font-medium">
                    <span className="w-5 h-5 rounded-full overflow-hidden bg-pizarra flex items-center justify-center">
                      {avatarDe(id)
                        ? <img src={`${config.apiUrl}${avatarDe(id)}`} alt="" className="w-full h-full object-cover" />
                        : <span className="text-[9px] text-lavanda-archivo">{nombreDe(id).slice(0, 1).toUpperCase()}</span>}
                    </span>
                    {nombreDe(id)}
                    <button onClick={() => alternar(id)} className="hover:text-estado-error" title="Sacar del grupo">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-humo">Elige al menos dos personas de la lista.</p>
            )}
          </div>

          <div>
            <div className="flex items-center gap-2 bg-pizarra rounded-xl px-3 h-9 mb-2">
              <Search className="w-4 h-4 text-humo" />
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Busca una persona…"
                className="flex-1 bg-transparent outline-none text-sm text-marfil placeholder:text-humo"
              />
            </div>
            <div className="max-h-[36vh] overflow-y-auto rounded-xl border border-pizarra divide-y divide-pizarra">
              {lista.length === 0 && (
                <p className="px-3 py-3 text-sm text-humo">Nadie se llama así.</p>
              )}
              {lista.map(p => {
                const dentro = miembros.includes(p.person_id);
                const n = cuantas(p.person_id);
                return (
                  <button
                    key={p.person_id}
                    onClick={() => alternar(p.person_id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${dentro ? 'bg-lavanda/10' : 'hover:bg-pizarra/60'}`}
                  >
                    <span className="w-8 h-8 rounded-full overflow-hidden bg-pizarra flex items-center justify-center flex-shrink-0">
                      {p.avatar_url
                        ? <img src={`${config.apiUrl}${p.avatar_url}`} alt="" className="w-full h-full object-cover" loading="lazy" />
                        : <span className="text-xs text-lavanda-archivo">{p.display_name.slice(0, 1).toUpperCase()}</span>}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className={`block truncate text-sm ${dentro ? 'text-marfil font-medium' : 'text-niebla'}`}>{p.display_name}</span>
                      <span className="block text-[11px] text-humo">
                        {n > 0 ? `${n.toLocaleString('es-ES')} ${n === 1 ? 'archivo' : 'archivos'}` : 'sin apariciones'}
                      </span>
                    </span>
                    <span className={`w-5 h-5 rounded-md border flex items-center justify-center ${dentro ? 'bg-lavanda border-lavanda' : 'border-humo/60'}`}>
                      {dentro && <Check className="w-3.5 h-3.5 text-noche" />}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-humo leading-relaxed">
              Quien graba casi nunca sale. Si el grupo es tuyo, no hace falta que te incluyas.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 px-6 py-4 mt-2 border-t border-pizarra">
          {grupo && (
            <button
              onClick={borrar}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full text-[13px] text-estado-error hover:bg-estado-error/10"
            >
              <Trash2 className="w-4 h-4" />
              Borrar grupo
            </button>
          )}
          <span className="flex-1" />
          <button onClick={onClose} className="h-9 px-4 rounded-full text-[13px] text-niebla hover:text-marfil">
            Cancelar
          </button>
          <button
            onClick={guardar}
            disabled={!valido || guardando}
            className="h-9 px-5 rounded-full text-[13px] font-semibold bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-40"
          >
            {guardando ? 'Guardando…' : grupo ? 'Guardar' : 'Crear grupo'}
          </button>
        </div>
      </div>
    </div>
  );
}
