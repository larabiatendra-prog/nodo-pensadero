import React from 'react';
import { Layers, ChevronUp } from 'lucide-react';
import { MediaFile } from '../types';

// ─── SessionCard (grupo colapsado) ──────────────────────────────────────────

interface SessionCardProps {
  sessionKey: string;
  files: MediaFile[];
  label: { line1: string; line2: string };
  onExpand: (key: string) => void;
  isSelectionMode?: boolean;
  onSelectAll?: (files: MediaFile[]) => void;
}

export function SessionCard({ sessionKey, files, label, onExpand, isSelectionMode, onSelectAll }: SessionCardProps) {
  // Seleccionar 4 thumbnails representativas (0%, 25%, 50%, 100%)
  const count = files.length;
  const indices = [
    0,
    Math.floor(count * 0.25),
    Math.floor(count * 0.5),
    count - 1,
  ];
  const thumbFiles = indices.map(i => files[Math.min(i, count - 1)]);

  const handleClick = () => {
    if (isSelectionMode && onSelectAll) {
      onSelectAll(files);
    } else {
      onExpand(sessionKey);
    }
  };

  return (
    <div
      className="relative bg-tinta rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 overflow-hidden cursor-pointer group mb-3 md:mb-6"
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

      {/* Gradiente inferior + etiqueta */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3">
        <p className="text-white text-xs font-medium leading-tight truncate">{label.line1}</p>
        {label.line2 && (
          <p className="text-white/80 text-xs leading-tight truncate mt-0.5">{label.line2}</p>
        )}
      </div>

      {/* Botón "Abrir" visible en hover */}
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <span className="bg-tinta/90 text-slate-900 text-sm font-semibold px-4 py-1.5 rounded-full shadow">
          {isSelectionMode ? 'Seleccionar todos' : 'Abrir sesión'}
        </span>
      </div>
    </div>
  );
}

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
