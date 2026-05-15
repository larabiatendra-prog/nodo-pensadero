import { useMemo } from 'react';
import { MediaFile } from '../types';
import { getSessionKey, parseSmartLabel } from '../utils/filenameParser';

export const MIN_GROUP_SIZE = 5;
export const EXPANDED_PREVIEW = 12;

export type SessionItem =
  | { type: 'file'; file: MediaFile }
  | { type: 'session-card'; key: string; files: MediaFile[]; label: { line1: string; line2: string } }
  | { type: 'session-header'; key: string; files: MediaFile[]; label: { line1: string; line2: string } }
  | { type: 'session-show-more'; key: string; remaining: number };

/** Agrupa los archivos preservando el orden de primera aparición de cada clave */
function buildOrderedGroups(allFiles: MediaFile[]): { key: string | null; files: MediaFile[] }[] {
  const groupMap = new Map<string | null, MediaFile[]>();
  const order: (string | null)[] = [];

  for (const file of allFiles) {
    const key = getSessionKey(file.name);
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
      order.push(key);
    }
    groupMap.get(key)!.push(file);
  }

  return order.map(key => ({ key, files: groupMap.get(key)! }));
}

/**
 * Calcula el total de "slots visuales" que existen dado el estado actual.
 * Función pura O(N) usada en el scroll handler.
 */
export function computeTotalSlots(
  allFiles: MediaFile[],
  expandedGroups: Set<string>,
  showAllGroups: Set<string>
): number {
  const groups = buildOrderedGroups(allFiles);
  let total = 0;

  for (const { key, files } of groups) {
    const isGroup = key !== null && files.length >= MIN_GROUP_SIZE;

    if (!isGroup) {
      total += files.length;
    } else if (!expandedGroups.has(key!)) {
      total += 1; // tarjeta colapsada = 1 slot
    } else {
      const showAll = showAllGroups.has(key!);
      const fileCount = showAll ? files.length : Math.min(files.length, EXPANDED_PREVIEW);
      total += fileCount;
      if (!showAll && files.length > EXPANDED_PREVIEW) total += 1; // show-more card
      // session-header no cuenta como slot
    }
  }

  return total;
}

/**
 * Hook principal: devuelve el array flat de items a renderizar,
 * limitado a `visibleSlotCount` slots.
 */
export function useSessionGroups(
  allFiles: MediaFile[],
  groupingEnabled: boolean,
  expandedGroups: Set<string>,
  showAllGroups: Set<string>,
  visibleSlotCount: number
): SessionItem[] {
  return useMemo(() => {
    if (!groupingEnabled) {
      return allFiles.slice(0, visibleSlotCount).map(file => ({ type: 'file' as const, file }));
    }

    const groups = buildOrderedGroups(allFiles);
    const items: SessionItem[] = [];
    let slotsUsed = 0;

    for (const { key, files } of groups) {
      if (slotsUsed >= visibleSlotCount) break;

      const isGroup = key !== null && files.length >= MIN_GROUP_SIZE;

      if (!isGroup) {
        // Archivos sueltos — 1 slot cada uno
        for (const file of files) {
          if (slotsUsed >= visibleSlotCount) break;
          items.push({ type: 'file', file });
          slotsUsed++;
        }
      } else if (!expandedGroups.has(key!)) {
        // Grupo colapsado — 1 slot (tarjeta mosaico)
        const label = parseSmartLabel(files[0].name);
        items.push({ type: 'session-card', key: key!, files, label });
        slotsUsed++;
      } else {
        // Grupo expandido — header (0 slots) + archivos + show-more opcional
        const label = parseSmartLabel(files[0].name);
        items.push({ type: 'session-header', key: key!, files, label });

        const showAll = showAllGroups.has(key!);
        const filesToShow = showAll ? files : files.slice(0, EXPANDED_PREVIEW);

        for (const file of filesToShow) {
          if (slotsUsed >= visibleSlotCount) break;
          items.push({ type: 'file', file });
          slotsUsed++;
        }

        if (!showAll && files.length > EXPANDED_PREVIEW && slotsUsed < visibleSlotCount) {
          items.push({ type: 'session-show-more', key: key!, remaining: files.length - EXPANDED_PREVIEW });
          slotsUsed++;
        }
      }
    }

    return items;
  }, [allFiles, groupingEnabled, expandedGroups, showAllGroups, visibleSlotCount]);
}
