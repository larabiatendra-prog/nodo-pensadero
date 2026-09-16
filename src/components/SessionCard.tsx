import React from 'react';
import { Layers, ChevronUp, Pencil, Play, Lock } from 'lucide-react';
import { MediaFile } from '../types';

// ─── SessionCard (grupo colapsado) ──────────────────────────────────────────

interface SessionCardProps {
  sessionKey: string;
  files: MediaFile[];
  label: { line1: string; line2: string };
  onExpand: (key: string) => void;
  isSelectionMode?: boolean;
  onSelectAll?: (files: MediaFile[]) => void;
  /** Nota humana que resume esta sesion (vacia si no hay). */
  note?: string;
  /** Abre el editor de la nota de esta sesion. */
  onEditNote?: (key: string, label: { line1: string; line2: string }) => void;
  /** Atenuada porque hay otra sesion abierta y esta queda fuera del foco. */
  dimmed?: boolean;
  /** Reproduce la sesion entera en pantalla completa (modo presentacion). */
  onPlaySession?: (files: MediaFile[]) => void;
  /** Pone la sesion entera bajo candado. */
  onOcultar?: (fileIds: string[]) => void;
}

function SessionCardBase({ sessionKey, files, label, onExpand, isSelectionMode, onSelectAll, note, onEditNote, dimmed, onPlaySession, onOcultar }: SessionCardProps) {
  // Seleccionar 4 thumbnails representativas (0%, 25%, 50%, 100%)
  const count = files.length;
  const indices = [
    0,
    Math.floor(count * 0.25),
    Math.floor(count * 0.5),
    count - 1,
  ];
  const thumbFiles = indices.map(i => files[Math.min(i, count - 1)]);
  // El modo presentacion solo reproduce videos: sin ninguno no ofrecemos play.
  const tieneVideos = files.some(f => f.type === 'video');

  const handleClick = () => {
    if (isSelectionMode && onSelectAll) {
      onSelectAll(files);
    } else {
      onExpand(sessionKey);
    }
  };

  return (
    <div
      className={`relative bg-tinta rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 overflow-hidden cursor-pointer group mb-3 md:mb-6 ${
        dimmed ? 'opacity-50 hover:opacity-100' : ''
      }`}
      onClick={handleClick}
    >
      {/* Mosaico 2×2 */}
      <div className="grid grid-cols-2 gap-0 aspect-square">
        {thumbFiles.map((file, i) => (
          <div key={`${file.id}-${i}`} className="relative overflow-hidden bg-slate-300">
            <img
              src={file.thumbnail}
              alt=""
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          </div>
        ))}
      </div>

      {/* Overlay oscuro en hover */}
      <div className="absolute inset-0 bg-noche bg-opacity-0 group-hover:bg-opacity-30 transition-all duration-300" />

      {/* Badge con total de archivos */}
      <div className="absolute top-2 right-2 flex items-center gap-1 bg-noche/70 text-white text-xs font-semibold px-2 py-1 rounded-full backdrop-blur-sm">
        <Layers className="w-3 h-3" />
        <span>{count}</span>
      </div>

      {/* Lapiz para editar la nota de la sesion. Resaltado si ya hay nota. */}
      {onEditNote && (
        <button
          onClick={(e) => { e.stopPropagation(); onEditNote(sessionKey, label); }}
          title={note ? 'Editar nota de la sesion' : 'Anadir nota a la sesion'}
          className={`absolute top-2 left-2 z-10 p-1.5 rounded-full backdrop-blur-sm transition-colors ${
            note
              ? 'bg-lavanda/90 text-noche'
              : 'bg-noche/40 text-white/80 opacity-0 group-hover:opacity-100 hover:bg-noche/70'
          }`}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Candado de la sesion entera, junto al lapiz. */}
      {onOcultar && !isSelectionMode && (
        <button
          onClick={(e) => { e.stopPropagation(); onOcultar(files.map(f => f.id)); }}
          title={`Ocultar la sesion entera (${count} archivos) bajo candado`}
          aria-label="Ocultar la sesion bajo candado"
          className={`absolute top-2 ${onEditNote ? 'left-11' : 'left-2'} z-10 p-1.5 rounded-full backdrop-blur-sm bg-noche/40 text-white/80 opacity-0 group-hover:opacity-100 hover:bg-noche/70 transition-colors`}
        >
          <Lock className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Gradiente inferior + etiqueta + nota humana */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-3">
        <p className="text-white text-xs font-medium leading-tight truncate">{label.line1}</p>
        {label.line2 && (
          <p className="text-white/80 text-xs leading-tight truncate mt-0.5">{label.line2}</p>
        )}
        {note && (
          <p className="text-lavanda-claro text-xs italic leading-snug mt-1 line-clamp-2" title={note}>
            “{note}”
          </p>
        )}
      </div>

      {/* Play — reproduce la sesion entera en pantalla completa (modo
          presentacion). Solo en hover y solo si la sesion tiene videos.
          z-20 para quedar por encima del gradiente y del overlay de "Abrir". */}
      {onPlaySession && tieneVideos && !isSelectionMode && (
        <button
          onClick={(e) => { e.stopPropagation(); onPlaySession(files); }}
          title="Reproducir la sesion entera en pantalla completa"
          aria-label="Reproducir la sesion entera en pantalla completa"
          className="absolute bottom-2 right-2 z-20 w-9 h-9 rounded-full flex items-center justify-center bg-lavanda text-noche shadow-lg opacity-0 group-hover:opacity-100 hover:bg-lavanda-claro hover:scale-110 transition-all duration-200"
        >
          <Play className="w-4 h-4 fill-current" />
        </button>
      )}

      {/* Botón "Abrir" visible en hover */}
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <span className="bg-tinta/90 text-slate-900 text-sm font-semibold px-4 py-1.5 rounded-full shadow">
          {isSelectionMode ? 'Seleccionar todos' : 'Abrir sesión'}
        </span>
      </div>
    </div>
  );
}

// Memoizado: una tarjeta de sesion solo se repinta si cambia su contenido o su
// nota. Los callbacks (onExpand/onSelectAll/onEditNote) se asumen estables vía
// useCallback en App; se comparan por referencia para evitar closures obsoletos.
function sessionCardEqual(prev: SessionCardProps, next: SessionCardProps): boolean {
  return (
    prev.sessionKey === next.sessionKey &&
    prev.files === next.files &&
    prev.note === next.note &&
    prev.dimmed === next.dimmed &&
    prev.isSelectionMode === next.isSelectionMode &&
    prev.label.line1 === next.label.line1 &&
    prev.label.line2 === next.label.line2 &&
    prev.onExpand === next.onExpand &&
    prev.onSelectAll === next.onSelectAll &&
    prev.onEditNote === next.onEditNote &&
    prev.onPlaySession === next.onPlaySession &&
    prev.onOcultar === next.onOcultar
  );
}

export const SessionCard = React.memo(SessionCardBase, sessionCardEqual);

// ─── SessionHeader (cabecera del grupo expandido) ───────────────────────────

interface SessionHeaderProps {
  sessionKey: string;
  files: MediaFile[];
  label: { line1: string; line2: string };
  onCollapse: (key: string) => void;
}

export function SessionHeader({ sessionKey, files, label, onCollapse }: SessionHeaderProps) {
  return (
    <div className="col-span-full flex items-center justify-between bg-pizarra/60 rounded-xl px-4 py-3 mb-1 mt-2">
      <div className="flex items-center gap-3 min-w-0">
        <Layers className="w-4 h-4 text-lavanda-archivo flex-shrink-0" />
        <div className="min-w-0">
          <span className="font-semibold text-marfil text-sm truncate block">{label.line1}</span>
          {label.line2 && (
            <span className="text-lavanda-archivo text-xs truncate block">{label.line2}</span>
          )}
        </div>
        <span className="flex-shrink-0 text-xs text-lavanda-archivo bg-lavanda-claro px-2 py-0.5 rounded-full font-medium">
          {files.length} archivos
        </span>
      </div>
      <button
        onClick={() => onCollapse(sessionKey)}
        className="flex items-center gap-1.5 text-xs text-lavanda-archivo hover:text-marfil font-medium px-3 py-1.5 rounded-lg hover:bg-lavanda-claro transition-colors flex-shrink-0 ml-3"
      >
        <ChevronUp className="w-3.5 h-3.5" />
        Colapsar
      </button>
    </div>
  );
}

// ─── SessionBoundaryCard (marca inicio/fin de una sesion abierta) ────────────

interface SessionBoundaryCardProps {
  sessionKey: string;
  /** Archivo cuya relacion de aspecto adopta la tarjeta (primer/ultimo de la sesion). */
  refFile: MediaFile;
  label: { line1: string; line2: string };
  variant: 'start' | 'end';
  onCollapse: (key: string) => void;
}

export function SessionBoundaryCard({ sessionKey, refFile, label, variant, onCollapse }: SessionBoundaryCardProps) {
  const aspect = refFile.dimensions
    ? `${refFile.dimensions.width}/${refFile.dimensions.height}`
    : '16/9';
  return (
    <div
      onClick={() => onCollapse(sessionKey)}
      title="Colapsar sesión"
      className="relative bg-lavanda rounded-xl overflow-hidden cursor-pointer group mb-3 md:mb-6 flex items-center justify-center hover:bg-lavanda-claro transition-colors duration-200"
      style={{ aspectRatio: aspect }}
    >
      <div className="text-center px-3">
        <p className="text-white text-sm font-semibold leading-tight break-words">{label.line1}</p>
        {label.line2 && (
          <p className="text-white/80 text-xs mt-1 break-words">{label.line2}</p>
        )}
        <p className="text-white/70 text-[11px] mt-2 inline-flex items-center gap-1">
          <ChevronUp className="w-3 h-3" />
          {variant === 'start' ? 'Inicio' : 'Fin'} · colapsar
        </p>
      </div>
    </div>
  );
}

// ─── SessionShowMore (tarjeta +N más) ───────────────────────────────────────

interface SessionShowMoreProps {
  sessionKey: string;
  remaining: number;
  onShowAll: (key: string) => void;
}

export function SessionShowMore({ sessionKey, remaining, onShowAll }: SessionShowMoreProps) {
  return (
    <div
      className="relative bg-pizarra rounded-xl overflow-hidden cursor-pointer group mb-3 md:mb-6 aspect-square flex items-center justify-center hover:bg-lavanda-claro transition-colors duration-200"
      onClick={() => onShowAll(sessionKey)}
    >
      <div className="text-center">
        <p className="text-2xl font-bold text-lavanda-archivo">+{remaining}</p>
        <p className="text-xs text-lavanda-archivo/80 mt-1 font-medium">Ver más</p>
      </div>
    </div>
  );
}
