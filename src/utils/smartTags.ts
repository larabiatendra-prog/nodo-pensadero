// Smart Tag Matching — lógica pura (sin React, sin red, sin IA).
//
// Convierte lo que el usuario teclea en la barra de búsqueda en una etiqueta
// existente (match exacto), o en sugerencias de etiquetas relacionadas vía un
// mapa local de sinónimos, antes de caer a búsqueda de texto libre.
//
// Todo aquí es determinista y testeable de forma aislada: recibe strings y
// arrays, devuelve strings y descriptores. La integración con la UI vive en
// SearchBar.tsx; estas funciones no tocan estado.

import { TAG_SYNONYM_GROUPS } from './tagSynonyms';

// Normaliza para comparar: minúsculas, sin tildes, sin espacios extra.
// "reunion", "Reunión" y "  reunión " colapsan al mismo valor.
export function normalizeText(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diacríticos
    .replace(/\s+/g, ' ')
    .trim();
}

// Devuelve la etiqueta REAL (con su grafía original) que coincide exactamente
// con la query tras normalizar, o null si ninguna coincide.
export function findExactTagMatch(
  query: string,
  availableTags: string[],
): string | null {
  const q = normalizeText(query);
  if (!q) return null;
  for (const tag of availableTags) {
    if (normalizeText(tag) === q) return tag;
  }
  return null;
}

// Busca en los grupos de sinónimos los que contienen la query y devuelve las
// etiquetas relacionadas que EXISTEN realmente en availableTags (con su grafía
// original). No sugiere términos que no sean etiquetas reales: un sinónimo solo
// vale si hay archivos etiquetados con él. Sin duplicados, preserva orden.
export function findSynonymSuggestions(
  query: string,
  availableTags: string[],
  synonymGroups: string[][] = TAG_SYNONYM_GROUPS,
): string[] {
  const q = normalizeText(query);
  if (!q) return [];

  // Índice normalizado -> grafía original de las etiquetas disponibles.
  const realByNorm = new Map<string, string>();
  for (const tag of availableTags) {
    const n = normalizeText(tag);
    if (!realByNorm.has(n)) realByNorm.set(n, tag);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of synonymGroups) {
    const normGroup = group.map(normalizeText);
    if (!normGroup.includes(q)) continue; // la query no pertenece a este grupo
    for (const term of normGroup) {
      if (term === q) continue; // no sugerirse a sí mismo
      const real = realByNorm.get(term);
      if (real && !seen.has(real)) {
        seen.add(real);
        out.push(real);
      }
    }
  }
  return out;
}

// Descriptor de la acción que la UI debe ejecutar al pulsar Enter.
export type EnterAction =
  | { kind: 'addTag'; tag: string }
  | { kind: 'showSuggestions'; suggestions: string[] }
  | { kind: 'freeSearch'; query: string };

export interface EnterState {
  availableTags: string[];
  synonymGroups?: string[][];
  // true si ya se mostraron sugerencias para esta query: el segundo Enter
  // debe ejecutar búsqueda libre con el texto original.
  suggestionsAlreadyShown: boolean;
}

// Decide qué hacer al pulsar Enter. Orden de prioridad:
//   1. Si ya se mostraron sugerencias -> búsqueda libre (segundo Enter).
//   2. Match exacto con etiqueta existente -> añadir como filtro.
//   3. Sinónimos que existan como etiqueta -> mostrar sugerencias.
//   4. Nada coincide -> búsqueda libre.
export function resolveEnterBehavior(
  query: string,
  state: EnterState,
): EnterAction {
  const q = (query ?? '').trim();
  const { availableTags, synonymGroups, suggestionsAlreadyShown } = state;

  if (suggestionsAlreadyShown) return { kind: 'freeSearch', query: q };
  if (!q) return { kind: 'freeSearch', query: q };

  const exact = findExactTagMatch(q, availableTags);
  if (exact) return { kind: 'addTag', tag: exact };

  const suggestions = findSynonymSuggestions(q, availableTags, synonymGroups);
  if (suggestions.length > 0) return { kind: 'showSuggestions', suggestions };

  return { kind: 'freeSearch', query: q };
}
