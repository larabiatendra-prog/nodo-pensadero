import { useSyncExternalStore } from 'react';

/**
 * La cesta «Para Premiere»: lo que se va añadiendo desde cualquier sitio
 * (selección, búsqueda, colección, ficha) hasta que se envía de una vez.
 * Guarda el orden en que se añade, que es el de la secuencia.
 *
 * Vive en el navegador (localStorage): es una comodidad de quien está
 * trabajando, no un dato del archivo. Si no se puede guardar, dura lo que la
 * pestaña.
 */

export interface Cesta {
  ids: string[];
  /** Nombre para Premiere; lo pone la primera cosa que se añade. */
  nombre: string;
  /** Cuántos entraron en la última vez que se añadió (para el «+N»). */
  ultimoAnadido: { n: number; cuando: number } | null;
}

const CLAVE = 'pensadero.cestaPremiere';
const VACIA: Cesta = { ids: [], nombre: '', ultimoAnadido: null };

function leer(): Cesta {
  try {
    const c = JSON.parse(localStorage.getItem(CLAVE) || 'null');
    if (c && Array.isArray(c.ids)) {
      return { ids: c.ids.filter((x: unknown) => typeof x === 'string'), nombre: String(c.nombre || ''), ultimoAnadido: null };
    }
  } catch { /* sin cesta guardada */ }
  return VACIA;
}

let estado: Cesta = leer();
const oyentes = new Set<() => void>();

function poner(nueva: Cesta) {
  estado = nueva;
  try { localStorage.setItem(CLAVE, JSON.stringify({ ids: nueva.ids, nombre: nueva.nombre })); } catch { /* sin almacenamiento */ }
  oyentes.forEach(f => f());
}

export const cestaPremiere = {
  get: () => estado,
  /** Añade sin repetir. Devuelve cuántos son nuevos y cuántos ya estaban. */
  anadir(ids: string[], nombre?: string) {
    const ya = new Set(estado.ids);
    const nuevos = ids.filter((id, i) => !ya.has(id) && ids.indexOf(id) === i);
    if (nuevos.length > 0) {
      poner({
        ids: [...estado.ids, ...nuevos],
        nombre: estado.ids.length === 0 && nombre ? nombre : estado.nombre,
        ultimoAnadido: { n: nuevos.length, cuando: Date.now() },
      });
    }
    return { nuevos: nuevos.length, yaEstaban: ids.length - nuevos.length };
  },
  quitar(ids: string[]) {
    const fuera = new Set(ids);
    const quedan = estado.ids.filter(id => !fuera.has(id));
    poner({ ...estado, ids: quedan, nombre: quedan.length ? estado.nombre : '', ultimoAnadido: null });
  },
  renombrar(nombre: string) {
    poner({ ...estado, nombre });
  },
  vaciar() {
    poner(VACIA);
  },
  /** Para «Deshacer» después de vaciar. */
  restaurar(c: Cesta) {
    poner({ ...c, ultimoAnadido: null });
  },
};

function suscribir(f: () => void) {
  oyentes.add(f);
  // Otra pestaña de Pensadero cambió la cesta.
  const otraPestana = (e: StorageEvent) => {
    if (e.key === CLAVE) { estado = leer(); f(); }
  };
  window.addEventListener('storage', otraPestana);
  return () => { oyentes.delete(f); window.removeEventListener('storage', otraPestana); };
}

export function useCestaPremiere(): Cesta {
  return useSyncExternalStore(suscribir, () => estado);
}
