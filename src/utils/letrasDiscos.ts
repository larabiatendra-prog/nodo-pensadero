/**
 * Que letra fija darle a cada disco — Pensadero
 *
 * Windows reparte las letras segun el orden en que se conectan los discos, y a
 * veces se las cruza (dos discos con la misma carpeta, cada uno en la letra
 * del otro). Pensadero no puede arreglarlo por su cuenta: la letra es un
 * ajuste de Windows. Lo que si puede es decir, con los discos de verdad, que
 * letra poner a cada uno. Aqui se decide; el paso a paso esta en
 * components/TutorialLetraFija.tsx.
 *
 * Puro y sin React, para poder probarlo (tests/letrasDiscos.test.ts).
 */

export interface RutaConDisco {
  id: string;
  path: string;
  isActive?: boolean;
  sugerencia?: {
    ruta: string;
    ocupadaPor?: { id: string; nombre: string; mismoDisco?: boolean; suDisco?: string | null } | null;
  } | null;
  disco?: { etiqueta: string | null; capacidad: number | null } | null;
}

export interface DiscoAFijar {
  /** Donde esta ahora, tal como sale en Administracion de discos: "G:". */
  letraAhora: string;
  /** La que se le propone, sin dos puntos, como sale en el desplegable: "W". */
  letraNueva: string;
  etiqueta: string | null;
  capacidad: number | null;
  /** Bibliotecas que viven en ese disco. */
  bibliotecas: string[];
}

// Del final del abecedario: Windows da a lo que se conecta la primera libre
// empezando por arriba (D:, E:...), asi que estas no se las quita un pendrive.
// Z: y las de antes de la M se evitan: Z: la suelen coger las unidades de red.
const CANDIDATAS = ['W', 'X', 'Y', 'V', 'U', 'T', 'S', 'R'];

/** "G:" de "G:\\(1) WORKS", o '' si la ruta no empieza por una letra. */
export function letraDe(ruta: string | null | undefined): string {
  const m = /^([a-z]):/i.exec(String(ruta || ''));
  return m ? `${m[1].toUpperCase()}:` : '';
}

/** Una letra que ya es de las altas: no hace falta cambiarla. */
const esAlta = (letra: string) => letra >= 'M:' && letra !== 'Z:';

/**
 * Plan de letras para todos los discos que estan en otra letra que la de su
 * biblioteca. Uno por disco (dos bibliotecas del mismo disco comparten letra
 * nueva), en el orden de la lista, y el mismo para todas las tarjetas: si no,
 * cada tarjeta propondria W: para su disco.
 * @returns letraAhora -> disco
 */
export function planLetras(rutas: RutaConDisco[]): Map<string, DiscoAFijar> {
  const ocupadas = new Set<string>();
  for (const p of rutas) {
    ocupadas.add(letraDe(p.path));
    ocupadas.add(letraDe(p.sugerencia?.ruta));
    ocupadas.add(letraDe(p.sugerencia?.ocupadaPor?.suDisco));
  }
  const plan = new Map<string, DiscoAFijar>();
  const libres = CANDIDATAS.filter(l => !ocupadas.has(`${l}:`));
  for (const p of rutas) {
    if (p.isActive === false || !p.sugerencia) continue;
    const ahora = letraDe(p.sugerencia.ruta);
    if (!ahora || esAlta(ahora)) continue;
    const ya = plan.get(ahora);
    if (ya) { ya.bibliotecas.push(p.id); continue; }
    const nueva = libres.shift();
    if (!nueva) break;
    plan.set(ahora, {
      letraAhora: ahora,
      letraNueva: nueva,
      etiqueta: p.disco?.etiqueta ?? null,
      capacidad: p.disco?.capacidad ?? null,
      bibliotecas: [p.id],
    });
  }
  return plan;
}

/**
 * Los discos que salen en el tutorial de la tarjeta `id`: el suyo y, si las
 * letras se han cruzado, el de la otra biblioteca (en cualquier sentido).
 * Vacio si no hay nada que cambiar (p. ej. el disco ya esta en W:).
 */
export function discosDeLaTarjeta(rutas: RutaConDisco[], id: string): DiscoAFijar[] {
  const p = rutas.find(q => q.id === id);
  if (!p || !p.sugerencia) return [];
  const relacionadas = new Set([id]);
  if (p.sugerencia.ocupadaPor) relacionadas.add(p.sugerencia.ocupadaPor.id);
  for (const q of rutas) {
    if (q.sugerencia?.ocupadaPor?.id === id) relacionadas.add(q.id);
  }
  // El de esta tarjeta primero: es por el que se empieza.
  return [...planLetras(rutas).values()]
    .filter(d => d.bibliotecas.some(b => relacionadas.has(b)))
    .sort((a, b) => Number(b.bibliotecas.includes(id)) - Number(a.bibliotecas.includes(id)));
}
