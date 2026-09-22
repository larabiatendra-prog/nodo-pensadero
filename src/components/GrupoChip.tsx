/**
 * Un grupo activo en la barra de busqueda — Pensadero
 *
 * El chip dice como se esta buscando ("Familia · 3 de 4") y, al pulsarlo,
 * abre las dos perillas del grupo con lo que saldria en cada caso:
 *
 *   ¿Cuantos tienen que salir?   1 · 2 · 3 · 4, cada uno con sus resultados
 *   ¿Donde?                      ese dia  /  en la misma toma
 *
 * La tolerancia se ve en archivos y no en un porcentaje abstracto. Lo que se
 * elige se guarda con el grupo: la proxima @familia sale igual.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Users, X } from 'lucide-react';
import toast from 'react-hot-toast';
import config from '../config';
import type { GrupoPersonas, Person } from '../types';
import { actualizarGrupo } from '../hooks/useGrupos';
import { minimoDe } from '../utils/grupos';

export interface NivelesGrupo {
  dia: number[];
  archivo: number[];
  minimo: number;
}

/** Lo que hace falta de una persona para pintar su cara. */
export type CaraPersona = Pick<Person, 'person_id' | 'display_name' | 'avatar_url'>;

/** Caras del grupo superpuestas. `tam` en px. */
export function GrupoAvatares({ grupo, persons, tam = 20, max = 3, borde = 'border-lavanda' }: {
  grupo: GrupoPersonas;
  persons: CaraPersona[];
  tam?: number;
  max?: number;
  borde?: string;
}) {
  const miembros = grupo.miembros
    .map((id): CaraPersona => persons.find(p => p.person_id === id) || { person_id: id, display_name: id, avatar_url: null })
    // Primero quien tiene cara: un circulo de iniciales dice menos.
    .sort((a, b) => Number(!!b.avatar_url) - Number(!!a.avatar_url))
    .slice(0, max);
  return (
    <span className="inline-flex items-center flex-shrink-0">
      {miembros.map((p, i) => (
        <span
          key={p.person_id}
          className={`rounded-full overflow-hidden bg-pizarra border-2 ${borde} flex items-center justify-center`}
          style={{ width: tam, height: tam, marginLeft: i ? -tam * 0.38 : 0, zIndex: max - i }}
          title={p.display_name}
        >
          {p.avatar_url ? (
            <img
              src={`${config.apiUrl}${p.avatar_url}`}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <span className="text-[9px] font-semibold text-lavanda-archivo">{p.display_name.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
      ))}
    </span>
  );
}

function cifra(n: number): string {
  return n.toLocaleString('es-ES');
}

export default function GrupoChip({ grupo, persons, contar, onRemove }: {
  grupo: GrupoPersonas;
  persons: Person[];
  contar?: (id: string) => NivelesGrupo | null;
  onRemove: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [niveles, setNiveles] = useState<NivelesGrupo | null>(null);
  const cajaRef = useRef<HTMLSpanElement>(null);
  const total = grupo.miembros.length;
  const minimo = minimoDe(grupo);

  // Recontar al abrir y cada vez que cambia el grupo (tolerancia, miembros).
  useEffect(() => {
    if (!abierto || !contar) return;
    setNiveles(contar(grupo.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto, grupo]);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (cajaRef.current && !cajaRef.current.contains(e.target as Node)) setAbierto(false);
    };
    // Esc cierra el selector y nada mas. Sin cortarlo aqui llegaba tambien al
    // Esc de la app (limpia todos los filtros) y al de las burbujas, y se
    // perdia justo el filtro que se estaba ajustando. En la ventana y en fase
    // de captura: es lo primero que se entera, antes que ellos.
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    window.addEventListener('keydown', tecla, true);
    return () => {
      document.removeEventListener('mousedown', fuera);
      window.removeEventListener('keydown', tecla, true);
    };
  }, [abierto]);

  const cambiar = (parcial: { minimo?: number; modo?: GrupoPersonas['modo'] }) => {
    actualizarGrupo(grupo.id, parcial).catch((err: Error) => toast.error(err.message || 'No se ha podido guardar'));
  };

  const porNivel = niveles ? niveles[grupo.modo] : null;
  const nombres = grupo.miembros
    .map(id => persons.find(p => p.person_id === id)?.display_name || id)
    .join(', ');

  return (
    <span ref={cajaRef} className="relative inline-flex">
      <span
        className="inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full text-sm bg-lavanda text-noche font-medium select-none cursor-pointer hover:bg-lavanda-claro transition-colors"
        onClick={() => setAbierto(a => !a)}
        title={`${grupo.nombre}: ${nombres}`}
      >
        <GrupoAvatares grupo={grupo} persons={persons} tam={22} />
        <span className="truncate max-w-[140px]">{grupo.nombre}</span>
        <span className="text-noche/60 text-xs tabular-nums whitespace-nowrap">
          {total === 0 ? 'sin nadie' : minimo === total ? (total === 1 ? '1' : 'todos') : `${minimo} de ${total}`}
          {grupo.modo === 'dia' ? ' · ese día' : ''}
        </span>
        <ChevronDown className={`w-3 h-3 transition-transform ${abierto ? 'rotate-180' : ''}`} />
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 hover:text-estado-error transition-colors"
          title="Quitar el grupo de la búsqueda"
        >
          <X className="w-3 h-3" />
        </button>
      </span>

      {abierto && total > 0 && (
        <div className="absolute left-0 top-full mt-2 z-30 w-[320px] max-w-[calc(100vw-2rem)] rounded-2xl border border-borde-sutil bg-tinta shadow-xl p-4 text-left">
          <div className="flex items-center gap-2.5 mb-3">
            <GrupoAvatares grupo={grupo} persons={persons} tam={28} max={5} borde="border-tinta" />
            <div className="min-w-0">
              <p className="text-marfil font-semibold text-sm truncate">{grupo.nombre}</p>
              <p className="text-humo text-xs truncate" title={nombres}>{nombres}</p>
            </div>
          </div>

          <p className="font-mono text-[10px] tracking-wider uppercase text-humo mb-2">¿Cuántos tienen que salir?</p>
          {total <= 8 ? (
            <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}>
              {Array.from({ length: total }, (_, i) => i + 1).map(k => {
                const activo = k === minimo;
                const n = porNivel ? porNivel[k - 1] : null;
                return (
                  <button
                    key={k}
                    onClick={() => cambiar({ minimo: k })}
                    className={`rounded-xl py-1.5 flex flex-col items-center transition-colors ${
                      activo ? 'bg-lavanda text-noche' : 'bg-pizarra text-niebla hover:text-marfil'
                    } ${n === 0 && !activo ? 'opacity-50' : ''}`}
                    title={k === 1 ? 'Basta con que salga uno' : k === total ? 'Tienen que salir todos' : `Al menos ${k} de ${total}`}
                  >
                    <span className="text-sm font-semibold tabular-nums">{k}</span>
                    <span className={`text-[10px] tabular-nums ${activo ? 'text-noche/70' : 'text-humo'}`}>
                      {n === null ? '·' : cifra(n)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div>
              <input
                type="range"
                min={1}
                max={total}
                step={1}
                value={minimo}
                onChange={(e) => cambiar({ minimo: parseInt(e.target.value, 10) })}
                className="w-full accent-lavanda cursor-pointer"
                aria-label="Cuántos tienen que salir"
              />
              <p className="text-xs text-niebla tabular-nums">
                Al menos {minimo} de {total}
                {porNivel ? ` · ${cifra(porNivel[minimo - 1])} archivos` : ''}
              </p>
            </div>
          )}
          <div className="flex justify-between text-[10px] text-humo mt-1 px-0.5">
            <span>cualquiera</span>
            <span>todos</span>
          </div>

          <p className="font-mono text-[10px] tracking-wider uppercase text-humo mt-4 mb-2">¿Juntos dónde?</p>
          <div className="grid grid-cols-2 gap-1.5">
            {([['archivo', 'En el mismo archivo'], ['dia', 'El mismo día']] as const).map(([modo, etiqueta]) => {
              const activo = grupo.modo === modo;
              const n = niveles ? niveles[modo][minimo - 1] : null;
              return (
                <button
                  key={modo}
                  onClick={() => cambiar({ modo })}
                  className={`rounded-xl px-2 py-1.5 text-xs font-medium transition-colors ${
                    activo ? 'bg-lavanda text-noche' : 'bg-pizarra text-niebla hover:text-marfil'
                  }`}
                >
                  {etiqueta}
                  {n !== null && <span className={`ml-1 tabular-nums ${activo ? 'text-noche/60' : 'text-humo'}`}>{cifra(n)}</span>}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-humo leading-relaxed mt-2">
            {grupo.modo === 'dia'
              ? `Vale con que salgan ${minimo === total ? 'todos' : `${minimo}`} a lo largo del día, cada uno en su foto o vídeo. Por eso verás archivos en los que sale uno solo: son de un día en el que coincidieron.`
              : `Solo fotos y vídeos en los que salen ${minimo === total ? 'todos' : `al menos ${minimo}`} a la vez.`}
          </p>
          <p className="text-[10px] text-humo/80 mt-3 flex items-center gap-1">
            <Users className="w-3 h-3" />
            Se recuerda para la próxima vez. El grupo se edita en Personas.
          </p>
        </div>
      )}
    </span>
  );
}
