import { useMemo } from 'react';
import { MediaFile } from '../types';
import { etiquetaDeCarpeta, etiquetaDeSesionSuelta, getFileSessionKey, getSessionKey, getSessionLabelSource, nombreDeBiblioteca, parseSmartLabel } from '../utils/filenameParser';

type Etiqueta = { line1: string; line2: string };

/**
 * Etiqueta de una sesion: fecha + origen si es un dia suelto; la del nombre
 * puesto o del patron del archivo, como siempre; y si sale de la carpeta, el
 * evento y de que va (`etiquetaDeCarpeta`), no la carpeta de la camara.
 */
function etiquetaDe(key: string, files: MediaFile[]): Etiqueta {
  const f = files[0];
  if (key.includes('#')) return etiquetaDeSesionSuelta(key, f);
  if ((f.displayName && f.displayName.trim()) || getSessionKey(f.name)) return parseSmartLabel(getSessionLabelSource(f));
  return etiquetaDeCarpeta(f);
}

/**
 * Etiquetas de todas las sesiones, con desempate: dos sesiones distintas que se
 * llaman igual (un servidor y su backup con las mismas carpetas, "01_BRUTOS"
 * dos veces) llevan detras el nombre de su biblioteca.
 */
function etiquetasDe(groups: { key: string | null; files: MediaFile[] }[]): Map<string, Etiqueta> {
  const out = new Map<string, Etiqueta>();
  const usos = new Map<string, number>();
  for (const { key, files } of groups) {
    if (key === null || files.length < MIN_GROUP_SIZE) continue;
    const e = etiquetaDe(key, files);
    out.set(key, e);
    const firma = `${e.line1}|${e.line2}`;
    usos.set(firma, (usos.get(firma) || 0) + 1);
  }
  for (const { key, files } of groups) {
    const e = key !== null ? out.get(key) : undefined;
    if (!e || (usos.get(`${e.line1}|${e.line2}`) || 0) < 2) continue;
    const biblioteca = nombreDeBiblioteca(files[0]).replace(/_/g, ' ').trim();
    if (!biblioteca) continue;
    out.set(key!, e.line2 ? { ...e, line2: `${e.line2} · ${biblioteca}` } : { ...e, line1: `${e.line1} · ${biblioteca}` });
  }
  return out;
}

export const MIN_GROUP_SIZE = 5;
export const EXPANDED_PREVIEW = 12;

export type SessionItem =
  // `dimmed`: el archivo/tarjeta queda atenuado porque hay otra sesion abierta
  // y este item esta fuera de ella (refuerzo visual del foco en la sesion abierta).
  | { type: 'file'; file: MediaFile; dimmed?: boolean }
  | { type: 'session-card'; key: string; files: MediaFile[]; label: { line1: string; line2: string }; dimmed?: boolean }
  | { type: 'session-header'; key: string; files: MediaFile[]; label: { line1: string; line2: string } }
  // Tarjetas lavanda que marcan inicio (izquierda del primer archivo) y fin
  // (derecha del ultimo) de una sesion abierta. Al pulsarlas se colapsa.
  | { type: 'session-start'; key: string; firstFile: MediaFile; label: { line1: string; line2: string } }
  | { type: 'session-end'; key: string; firstFile: MediaFile; label: { line1: string; line2: string } }
  | { type: 'session-show-more'; key: string; remaining: number };

/** Agrupa los archivos preservando el orden de primera aparición de cada clave */
function buildOrderedGroups(allFiles: MediaFile[]): { key: string | null; files: MediaFile[] }[] {
  const groupMap = new Map<string | null, MediaFile[]>();
  const order: (string | null)[] = [];

  for (const file of allFiles) {
    const key = getFileSessionKey(file);
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
      const truncated = !showAll && files.length > EXPANDED_PREVIEW;
      const fileCount = showAll ? files.length : Math.min(files.length, EXPANDED_PREVIEW);
      total += 1; // tarjeta de inicio (lavanda)
      total += fileCount;
      if (truncated) total += 1; // show-more card
      else total += 1; // tarjeta de fin (lavanda)
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
    const etiquetas = etiquetasDe(groups);
    const items: SessionItem[] = [];
    let slotsUsed = 0;

    // Hay alguna sesion realmente abierta? Si la hay, el resto de items (archivos
    // sueltos y tarjetas colapsadas) se atenuan para enfocar la sesion abierta.
    const anyExpanded = groups.some(
      g => g.key !== null && g.files.length >= MIN_GROUP_SIZE && expandedGroups.has(g.key)
    );

    for (const { key, files } of groups) {
      if (slotsUsed >= visibleSlotCount) break;

      const isGroup = key !== null && files.length >= MIN_GROUP_SIZE;

      if (!isGroup) {
        // Archivos sueltos — 1 slot cada uno
        for (const file of files) {
          if (slotsUsed >= visibleSlotCount) break;
          items.push({ type: 'file', file, dimmed: anyExpanded });
          slotsUsed++;
        }
      } else if (!expandedGroups.has(key!)) {
        // Grupo colapsado — 1 slot (tarjeta mosaico)
        const label = etiquetas.get(key!) || etiquetaDe(key!, files);
        items.push({ type: 'session-card', key: key!, files, label, dimmed: anyExpanded });
        slotsUsed++;
      } else {
        // Grupo expandido: tarjeta de inicio + archivos + (show-more | tarjeta de fin)
        const label = etiquetas.get(key!) || etiquetaDe(key!, files);
        items.push({ type: 'session-start', key: key!, firstFile: files[0], label });
        slotsUsed++;
        if (slotsUsed >= visibleSlotCount) break;

        const showAll = showAllGroups.has(key!);
        const filesToShow = showAll ? files : files.slice(0, EXPANDED_PREVIEW);

        for (const file of filesToShow) {
          if (slotsUsed >= visibleSlotCount) break;
          items.push({ type: 'file', file });
          slotsUsed++;
        }

        const truncated = !showAll && files.length > EXPANDED_PREVIEW;
        if (truncated && slotsUsed < visibleSlotCount) {
          items.push({ type: 'session-show-more', key: key!, remaining: files.length - EXPANDED_PREVIEW });
          slotsUsed++;
        } else if (!truncated && slotsUsed < visibleSlotCount) {
          // Tarjeta de fin: misma relacion de aspecto que el ultimo archivo.
          items.push({ type: 'session-end', key: key!, firstFile: files[files.length - 1], label });
          slotsUsed++;
        }
      }
    }

    return items;
  }, [allFiles, groupingEnabled, expandedGroups, showAllGroups, visibleSlotCount]);
}
