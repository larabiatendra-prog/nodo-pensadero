import React, { useEffect, useState } from 'react';
import config from '../config';
import type { Person } from '../types';

interface PersonBubblesProps {
  selectedPersonIds: string[];
  onSelectionChange: (personIds: string[]) => void;
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
const MAX_BUBBLES = 30;

export default function PersonBubbles({ selectedPersonIds, onSelectionChange }: PersonBubblesProps) {
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
  }, []);

  // ESC limpia la selección
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedPersonIds.length > 0) {
        onSelectionChange([]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedPersonIds, onSelectionChange]);

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
      {hiddenBeyondMaxCount > 0 && (
        <span className="text-xs text-humo italic ml-1">
          +{hiddenBeyondMaxCount} mas · busca con <span className="font-mono text-lavanda-archivo not-italic">@nombre</span>
        </span>
      )}
    </div>
  );
}
