import React from 'react';
import { CheckSquare, Square } from 'lucide-react';

interface SelectionModeButtonProps {
  isSelectionMode: boolean;
  selectedCount: number;
  onToggle: () => void;
}

export function SelectionModeButton({
  isSelectionMode,
  selectedCount,
  onToggle
}: SelectionModeButtonProps) {
  return (
    <button
      onClick={onToggle}
      className={`
        w-14 h-14 rounded-full shadow-lg hover:shadow-xl
        transition-all duration-300 hover:scale-110
        flex items-center justify-center
        ${isSelectionMode
          ? 'bg-lavanda text-white ring-4 ring-lavanda/30'
          : 'bg-tinta text-lavanda-archivo hover:bg-pizarra'
        }
      `}
      aria-label={isSelectionMode ? 'Desactivar modo selección' : 'Activar modo selección'}
      title={isSelectionMode ? 'Desactivar selección múltiple' : 'Activar selección múltiple'}
    >
      {/* Icono */}
      {isSelectionMode ? (
        <CheckSquare className="w-6 h-6" />
      ) : (
        <Square className="w-6 h-6" />
      )}

      {/* Contador de archivos seleccionados */}
      {selectedCount > 0 && (
        <div className="absolute -top-2 -right-2 w-6 h-6 bg-bruma text-white rounded-full flex items-center justify-center text-xs font-bold shadow-md animate-in zoom-in-50 duration-200">
          {selectedCount}
        </div>
      )}
    </button>
  );
}
