/**
 * Los grupos de personas, compartidos por toda la app — Pensadero
 *
 * Los usan a la vez la barra de busqueda (@familia), las burbujas de la home y
 * la pagina de Personas. Viven en un almacen de modulo: se piden una vez, y
 * cualquier cambio (crear, renombrar, mover la tolerancia) se ve al momento
 * en todos los sitios sin que cada uno vuelva a preguntar al servidor.
 *
 * Los cambios de tolerancia son optimistas: el filtro se mueve ya y el
 * servidor se entera despues. Si el servidor dice que no, se vuelve atras.
 */

import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { GrupoPersonas } from '../types';

let grupos: GrupoPersonas[] = [];
let cargado = false;
let enCurso: Promise<void> | null = null;
const oyentes = new Set<(g: GrupoPersonas[]) => void>();

function publicar(nuevos: GrupoPersonas[]) {
  grupos = nuevos;
  oyentes.forEach(fn => fn(grupos));
}

export function recargarGrupos(): Promise<void> {
  if (enCurso) return enCurso;
  enCurso = api.getGrupos()
    .then(r => {
      if (r.success && Array.isArray(r.data)) publicar(r.data);
      cargado = true;
    })
    .catch(() => {
      // Servidor sin la ruta (version vieja) o caido: sin grupos, sin ruido.
    })
    .finally(() => { enCurso = null; });
  return enCurso;
}

export function useGrupos(): GrupoPersonas[] {
  const [lista, setLista] = useState(grupos);
  useEffect(() => {
    oyentes.add(setLista);
    if (!cargado) recargarGrupos();
    else setLista(grupos);
    return () => { oyentes.delete(setLista); };
  }, []);
  return lista;
}

export async function crearGrupo(nombre: string, miembros: string[]): Promise<GrupoPersonas> {
  const r = await api.crearGrupo({ nombre, miembros });
  if (!r.success || !r.data) throw new Error(r.message || 'No se ha podido crear el grupo');
  publicar([...grupos, r.data]);
  return r.data;
}

export async function actualizarGrupo(
  id: string,
  parcial: Partial<Pick<GrupoPersonas, 'nombre' | 'miembros' | 'minimo' | 'modo'>>,
): Promise<GrupoPersonas> {
  const antes = grupos;
  publicar(grupos.map(g => (g.id === id ? { ...g, ...parcial } : g)));
  try {
    const r = await api.actualizarGrupo(id, parcial);
    if (!r.success || !r.data) throw new Error(r.message || 'No se ha podido guardar el grupo');
    publicar(grupos.map(g => (g.id === id ? r.data! : g)));
    return r.data;
  } catch (err) {
    publicar(antes);
    throw err;
  }
}

export async function borrarGrupo(id: string): Promise<void> {
  const antes = grupos;
  publicar(grupos.filter(g => g.id !== id));
  try {
    const r = await api.borrarGrupo(id);
    if (!r.success) throw new Error(r.message || 'No se ha podido borrar el grupo');
  } catch (err) {
    publicar(antes);
    throw err;
  }
}
