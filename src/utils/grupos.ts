/**
 * Grupos de personas: cuando un archivo "es de la Familia" — Pensadero
 *
 * Un grupo se busca con una tolerancia, no necesariamente con un todos-o-nada:
 * en una comida familiar casi ninguna foto pilla a todos, y quien graba no
 * sale nunca. Una perilla, que se guarda con el grupo:
 *
 *   minimo  cuantos de ellos tienen que salir en el mismo archivo. De
 *           fabrica, todos: el usuario la baja el mismo desde el chip si
 *           quiere mas resultados, viendo cuantos da cada nivel.
 *
 * `modo` sigue en el tipo por compatibilidad con grupos antiguos que lo
 * guardaron en 'dia' (cuenta quien sale a lo largo del dia, no solo en el
 * mismo archivo), pero ya no se ofrece cambiarlo desde la UI: confundia mas
 * de lo que ayudaba.
 *
 * Todo es local y en memoria: sin llamadas al servidor.
 */

import type { GrupoPersonas, MediaFile } from '../types';
import { normalizeText } from './smartTags';

/** Lo que el grupo pide por defecto si nadie lo ha tocado: todos los miembros. */
export function minimoPorDefecto(miembros: number): number {
  return Math.max(1, miembros);
}

/** Cuantos tienen que salir, siempre entre 1 y el tamano del grupo. */
export function minimoDe(grupo: Pick<GrupoPersonas, 'miembros' | 'minimo'>): number {
  const total = grupo.miembros.length;
  if (total === 0) return 1;
  const pedido = grupo.minimo ?? minimoPorDefecto(total);
  return Math.min(total, Math.max(1, pedido));
}

/** El dia del archivo, el mismo que usa la galeria para agrupar. */
export function claveDeDia(f: MediaFile): string {
  if (f.fechaDia) return String(f.fechaDia);
  const d = f.extractedDate || f.createdAt;
  if (d instanceof Date && !isNaN(d.getTime())) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }
  return 'sin-dia';
}

function personasDe(f: MediaFile): Set<string> {
  const ids = new Set<string>();
  for (const cara of f.faces ?? []) if (cara?.person_id) ids.add(cara.person_id);
  return ids;
}

/** Quien sale cada dia, sumando todos los archivos de ese dia. */
export type PresenciaPorDia = Map<string, Set<string>>;

export function presenciaPorDia(files: MediaFile[]): PresenciaPorDia {
  const mapa: PresenciaPorDia = new Map();
  for (const f of files) {
    if (!f.faces || f.faces.length === 0) continue;
    const dia = claveDeDia(f);
    let quien = mapa.get(dia);
    if (!quien) { quien = new Set(); mapa.set(dia, quien); }
    for (const cara of f.faces) if (cara?.person_id) quien.add(cara.person_id);
  }
  return mapa;
}

/**
 * Cuantos del grupo cuentan para este archivo. 0 si no sale ninguno EN el
 * archivo: el modo 'dia' amplia a quien se cuenta, no a que archivos se ven
 * (un paisaje de ese dia no es "de la Familia").
 */
export function aciertos(
  f: MediaFile,
  miembros: string[],
  modo: GrupoPersonas['modo'],
  presencia: PresenciaPorDia,
): number {
  const aqui = personasDe(f);
  let enArchivo = 0;
  for (const m of miembros) if (aqui.has(m)) enArchivo++;
  if (enArchivo === 0 || modo === 'archivo') return enArchivo;
  const eseDia = presencia.get(claveDeDia(f));
  if (!eseDia) return enArchivo;
  let n = 0;
  for (const m of miembros) if (eseDia.has(m)) n++;
  return n;
}

/** Lo que se aplica al filtrar: el grupo con su minimo ya resuelto. */
export interface FiltroGrupo {
  id: string;
  miembros: string[];
  minimo: number;
  modo: GrupoPersonas['modo'];
}

export function filtroDe(grupo: GrupoPersonas): FiltroGrupo {
  return { id: grupo.id, miembros: grupo.miembros, minimo: minimoDe(grupo), modo: grupo.modo };
}

export function cumple(f: MediaFile, filtro: FiltroGrupo, presencia: PresenciaPorDia): boolean {
  if (filtro.miembros.length === 0) return false;
  return aciertos(f, filtro.miembros, filtro.modo, presencia) >= filtro.minimo;
}

/**
 * Cuantos archivos saldrian con cada minimo posible, en los dos modos:
 * `porModo.dia[k]` = archivos con al menos k+1 del grupo. Es lo que ensena el
 * selector del grupo para que la tolerancia se vea en resultados, no en %.
 */
export function niveles(files: MediaFile[], miembros: string[], presencia: PresenciaPorDia) {
  const total = miembros.length;
  const cuenta = (modo: GrupoPersonas['modo']) => {
    const exactos = new Array(total + 1).fill(0);
    for (const f of files) exactos[aciertos(f, miembros, modo, presencia)]++;
    // Acumulado de mayor a menor: "al menos k".
    const alMenos = new Array(total).fill(0);
    let suma = 0;
    for (let k = total; k >= 1; k--) {
      suma += exactos[k];
      alMenos[k - 1] = suma;
    }
    return alMenos;
  };
  return { dia: cuenta('dia'), archivo: cuenta('archivo') };
}

/** "Familia" -> "familia", sin tildes: para casar lo escrito tras la @. */
export const normalizarNombre = (texto: string) => normalizeText(texto).trim();
