import { useEffect, useRef, useState } from 'react';
import { GitCommitVertical, Users, X } from 'lucide-react';
import toast from 'react-hot-toast';
import config from '../config';
import type { GrupoPersonas, Person } from '../types';
import { GrupoAvatares } from './GrupoChip';
import { crearGrupo } from '../hooks/useGrupos';
import { minimoDe } from '../utils/grupos';

interface PersonBubblesProps {
  selectedPersonIds: string[];
  onSelectionChange: (personIds: string[]) => void;
  /** Grupos ("Familia"...): van delante de las caras y se activan igual. */
  grupos?: GrupoPersonas[];
  gruposActivos?: string[];
  onGruposChange?: (ids: string[]) => void;
  /** Abre la linea de vida de una persona (solo se ofrece con una sola activa). */
  onVerLineaDeVida?: (personId: string) => void;
  /** Cambia (incrementa) cuando el catalogo se recarga tras un sync o un
   * cambio de registry: repite la carga de /api/persons. Al abrir Pensadero
   * el agregado del backend puede seguir vacio (se calcula al terminar el
   * sync inicial); sin esto la barra se quedaba en "sin personas" hasta
   * refrescar la pagina a mano. */
  refreshKey?: number;
}

// Hash estable de un string a un entero no negativo (para derivar color)
function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

// Devuelve un color HSL en gama lavanda (hue 240-300, sat 40%, light 65%)
// derivado del person_id, para fallback consistente cuando no hay avatar.
function lavendaColor(personId: string): string {
  const hue = 240 + (hashString(personId) % 61); // 240..300
  return `hsl(${hue}, 40%, 65%)`;
}

function initialsFrom(displayName: string): string {
  const trimmed = (displayName || '').trim();
  if (!trimmed) return '??';
  return trimmed.slice(0, 2).toUpperCase();
}

function avatarFullUrl(relativePath: string): string {
  // avatar_url ya viene como /persons-avatars/... (relativo al backend)
  return `${config.apiUrl}${relativePath}`;
}

// Umbrales de visualizacion para que la barra no se sature cuando hay muchas
// personas entrenadas. Con > MAX se oculta totalmente y se invita a usar la
// busqueda @nombre. Entre MIN y MAX se muestran MIN colapsadas con un "+".
const MIN_BUBBLES = 10;
const MAX_BUBBLES = 28;

export default function PersonBubbles({ selectedPersonIds, onSelectionChange, grupos = [], gruposActivos = [], onGruposChange, onVerLineaDeVida, refreshKey }: PersonBubblesProps) {
  // "Guardar como grupo" con varias caras elegidas: el nombre se escribe aqui mismo.
  const [nombrando, setNombrando] = useState(false);
  const [nombreGrupo, setNombreGrupo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const nombreRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (nombrando) nombreRef.current?.focus(); }, [nombrando]);
  useEffect(() => { if (selectedPersonIds.length < 2) setNombrando(false); }, [selectedPersonIds.length]);

  const guardarGrupo = async () => {
    const nombre = nombreGrupo.trim();
    if (!nombre || guardando) return;
    setGuardando(true);
    try {
      const grupo = await crearGrupo(nombre, selectedPersonIds);
      toast.success(`Grupo «${grupo.nombre}» guardado. Búscalo con @${grupo.nombre.toLowerCase()}`);
      setNombrando(false);
      setNombreGrupo('');
    } catch (err) {
      toast.error((err as Error).message || 'No se ha podido guardar el grupo');
    } finally {
      setGuardando(false);
    }
  };

  const alternarGrupo = (id: string) => {
    if (!onGruposChange) return;
    onGruposChange(gruposActivos.includes(id) ? gruposActivos.filter(g => g !== id) : [...gruposActivos, id]);
  };
  const gruposVisibles = grupos.filter(g => g.miembros.length > 0);
  const [persons, setPersons] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Tracking de imágenes que han fallado al cargar para forzar fallback
  const [brokenAvatars, setBrokenAvatars] = useState<Set<string>>(new Set());
  // Expand/colapse cuando persons.length esta entre MIN y MAX
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetch(`${config.apiBaseUrl}/persons`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(json => {
        if (cancelled) return;
        if (json && json.success && Array.isArray(json.data)) {
          setPersons(json.data);
        } else {
          setPersons([]);
        }
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.warn('[PersonBubbles] Error al cargar /api/persons:', err);
        setError(true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // ESC limpia la selección
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || nombrando) return;
      if (selectedPersonIds.length > 0) onSelectionChange([]);
      if (gruposActivos.length > 0) onGruposChange?.([]);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedPersonIds, onSelectionChange, gruposActivos, onGruposChange, nombrando]);

  const togglePerson = (personId: string) => {
    if (selectedPersonIds.includes(personId)) {
      onSelectionChange(selectedPersonIds.filter(id => id !== personId));
    } else {
      onSelectionChange([...selectedPersonIds, personId]);
    }
  };

  if (error) {
    // Falla silenciosa: log ya emitido, no rompe UI
    return null;
  }

  if (loading) {
    return (
      <div className="flex flex-wrap gap-3">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="w-12 h-12 rounded-full bg-pizarra animate-pulse" />
        ))}
      </div>
    );
  }

  if (persons.length === 0) {
    return (
      <div className="text-humo italic text-xs">
        Sin personas detectadas todavia. Anade una en Personas con fotos de referencia,<br/>o usa "Descubrir caras" para identificar las que ya aparecen en la biblioteca.
      </div>
    );
  }

  // Logica de renderizado por umbrales:
  //  - <= MIN_BUBBLES: muestra todas
  //  - MIN < N <= MAX: top MIN colapsado, "+N" expande hasta MAX
  //  - > MAX: top MIN colapsado, "+ ver MAX" expande hasta MAX. El resto solo
  //    se filtra desde la barra @nombre (hint discreto al final).
  // En modo colapsado, las personas seleccionadas que caen fuera del top se
  // muestran igual para no perder visibilidad del filtro activo.
  const tooManyToShowAll = persons.length > MAX_BUBBLES;
  const visibleLimit = expanded ? MAX_BUBBLES : MIN_BUBBLES;
  let visiblePersons: Person[];
  if (persons.length <= MIN_BUBBLES) {
    visiblePersons = persons;
  } else {
    const topSlice = persons.slice(0, visibleLimit);
    const topIds = new Set(topSlice.map(p => p.person_id));
    const extraSelected = persons.filter(p => selectedPersonIds.includes(p.person_id) && !topIds.has(p.person_id));
    visiblePersons = [...topSlice, ...extraSelected];
  }
  const hiddenInBubblesCount = Math.max(0, Math.min(persons.length, MAX_BUBBLES) - visibleLimit);
  const hiddenBeyondMaxCount = tooManyToShowAll ? persons.length - MAX_BUBBLES : 0;

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {onGruposChange && gruposVisibles.map(grupo => {
        const activo = gruposActivos.includes(grupo.id);
        const total = grupo.miembros.length;
        const minimo = minimoDe(grupo);
        const nombres = grupo.miembros.map(id => persons.find(p => p.person_id === id)?.display_name || id).join(', ');
        return (
          <button
            key={`grupo-${grupo.id}`}
            onClick={() => alternarGrupo(grupo.id)}
            title={`${grupo.nombre}: ${nombres}`}
            className={`group inline-flex items-center gap-2 h-12 pl-1.5 pr-4 rounded-full transition-all duration-200 ${
              activo
                ? 'bg-lavanda text-noche ring-2 ring-lavanda ring-offset-2 ring-offset-noche'
                : 'bg-pizarra text-niebla hover:text-marfil hover:bg-grafito'
            }`}
          >
            <span className={activo ? '' : 'grayscale group-hover:grayscale-0 transition-[filter]'}>
              <GrupoAvatares grupo={grupo} persons={persons} tam={30} borde={activo ? 'border-lavanda' : 'border-pizarra'} />
            </span>
            <span className="text-left leading-tight">
              <span className="block text-[13px] font-semibold max-w-[120px] truncate">{grupo.nombre}</span>
              <span className={`block text-[10px] tabular-nums ${activo ? 'text-noche/60' : 'text-humo'}`}>
                {minimo === total ? `los ${total}` : `${minimo} de ${total}`}
              </span>
            </span>
          </button>
        );
      })}
      {onGruposChange && gruposVisibles.length > 0 && (
        <span aria-hidden className="w-px h-8 bg-borde-sutil mx-0.5" />
      )}
      {visiblePersons.map(person => {
        const isSelected = selectedPersonIds.includes(person.person_id);
        const showFallback = !person.avatar_url || brokenAvatars.has(person.person_id);
        const bgColor = lavendaColor(person.person_id);
        const initials = initialsFrom(person.display_name);
        const tooltip = `${person.display_name} · ${person.count} ${person.count === 1 ? 'archivo' : 'archivos'}`;

        return (
          <button
            key={person.person_id}
            onClick={() => togglePerson(person.person_id)}
            title={tooltip}
            className={`relative group peer rounded-full transition-all duration-200 ease-out hover:brightness-110 hover:scale-125 hover:z-10 peer-hover:scale-110 peer-hover:translate-x-2 has-[+button:hover]:scale-110 has-[+button:hover]:-translate-x-2 ${
              isSelected
                ? 'ring-2 ring-lavanda ring-offset-2 ring-offset-noche scale-105'
                : ''
            }`}
          >
            <div
              className={`relative w-12 h-12 rounded-full overflow-hidden transition-[filter] duration-200 ${
                isSelected ? '' : 'grayscale group-hover:grayscale-0'
              }`}
            >
              {showFallback ? (
                <div
                  className="w-full h-full flex items-center justify-center text-noche font-semibold text-sm"
                  style={{ backgroundColor: bgColor }}
                >
                  {initials}
                </div>
              ) : (
                <img
                  src={avatarFullUrl(person.avatar_url as string)}
                  alt={person.display_name}
                  className="w-full h-full object-cover"
                  onError={() => {
                    setBrokenAvatars(prev => {
                      const next = new Set(prev);
                      next.add(person.person_id);
                      return next;
                    });
                  }}
                />
              )}
            </div>
          </button>
        );
      })}
      {(hiddenInBubblesCount > 0 || expanded) && persons.length > MIN_BUBBLES && (
        <button
          onClick={() => setExpanded(v => !v)}
          title={expanded ? 'Ver menos personas' : `Ver ${hiddenInBubblesCount} ${hiddenInBubblesCount === 1 ? 'persona mas' : 'personas mas'}`}
          className="w-12 h-12 rounded-full bg-pizarra text-lavanda hover:bg-lavanda hover:text-white transition-colors flex items-center justify-center text-sm font-semibold"
        >
          {expanded ? '−' : `+${hiddenInBubblesCount}`}
        </button>
      )}
      {/* Con UNA sola persona activa la pregunta natural es "y esta quien es
          a lo largo del tiempo": la linea de vida. Con varias no significa
          nada, asi que no aparece. */}
      {onVerLineaDeVida && selectedPersonIds.length === 1 && (() => {
        const activa = persons.find(p => p.person_id === selectedPersonIds[0]);
        return (
          <button
            onClick={() => onVerLineaDeVida(selectedPersonIds[0])}
            title={activa ? `Ver la linea de vida de ${activa.display_name}` : 'Ver su linea de vida'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-pizarra text-lavanda hover:bg-lavanda hover:text-noche transition-colors"
          >
            <GitCommitVertical className="w-3.5 h-3.5" />
            Línea de vida
          </button>
        );
      })()}
      {/* Varias caras elegidas: se pueden guardar como grupo para no tener
          que volver a elegirlas una a una. */}
      {onGruposChange && selectedPersonIds.length >= 2 && !nombrando && (
        <button
          onClick={() => setNombrando(true)}
          title="Guardar a estas personas como un grupo (Familia, Rodaje…)"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-pizarra text-lavanda hover:bg-lavanda hover:text-noche transition-colors"
        >
          <Users className="w-3.5 h-3.5" />
          Guardar como grupo
        </button>
      )}
      {nombrando && (
        <form
          onSubmit={(e) => { e.preventDefault(); guardarGrupo(); }}
          className="flex items-center gap-1.5 pl-3 pr-1 h-9 rounded-full bg-pizarra border border-lavanda/50"
        >
          <Users className="w-3.5 h-3.5 text-lavanda flex-shrink-0" />
          <input
            ref={nombreRef}
            value={nombreGrupo}
            onChange={(e) => setNombreGrupo(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNombrando(false); } }}
            placeholder={`Nombre para estas ${selectedPersonIds.length}`}
            maxLength={40}
            className="w-44 bg-transparent outline-none text-sm text-marfil placeholder:text-humo"
          />
          <button
            type="submit"
            disabled={!nombreGrupo.trim() || guardando}
            className="h-7 px-3 rounded-full text-xs font-semibold bg-lavanda text-noche disabled:opacity-40"
          >
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
          <button
            type="button"
            onClick={() => setNombrando(false)}
            className="h-7 w-7 rounded-full flex items-center justify-center text-humo hover:text-marfil"
            title="Cancelar"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </form>
      )}
      {hiddenBeyondMaxCount > 0 && (
        <span className="text-xs text-humo italic ml-1">
          +{hiddenBeyondMaxCount} mas · busca con <span className="font-mono text-lavanda-archivo not-italic">@nombre</span>
        </span>
      )}
    </div>
  );
}
