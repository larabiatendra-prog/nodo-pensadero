import React from 'react';
import { Heart } from 'lucide-react';
import DateRangeFilter from './DateRangeFilter';
import ColorWheelFilter from './ColorWheelFilter';

interface QuickFiltersProps {
  selectedTypes: string[];
  onTypeSelection: (type: string) => void;
  showFavoritesOnly?: boolean;
  onFavoritesToggle?: () => void;
  groupingEnabled?: boolean;
  onGroupingChange?: (enabled: boolean) => void;
  groupingDisabled?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  onDateRangeChange?: (from: Date | undefined, to: Date | undefined) => void;
  onColorFilterChange?: (fileIds: Set<string> | null, hex: string | null) => void;
  colorFilterHex?: string | null;
}

export default function QuickFilters({
  selectedTypes,
  onTypeSelection,
  showFavoritesOnly = false,
  onFavoritesToggle,
  groupingEnabled = true,
  onGroupingChange,
  groupingDisabled = false,
  dateFrom,
  dateTo,
  onDateRangeChange,
  onColorFilterChange,
  colorFilterHex,
}: QuickFiltersProps) {
  return (
    <div className="flex items-center flex-wrap gap-1.5 md:gap-2">

        {['image', 'video', 'audio', 'export'].map((type) => {
          const isSelected = selectedTypes.includes(type);
          return (
            <button
              key={type}
              onClick={() => onTypeSelection(type)}
              className={`px-3 md:px-4 py-1.5 md:py-2 rounded-full text-sm font-medium transition-all duration-200 ${
                isSelected
                  ? 'bg-lavanda-claro text-marfil shadow-md'
                  : 'bg-pizarra text-lavanda-archivo hover:bg-lavanda-claro hover:bg-opacity-30'
              }`}
            >
              {type === 'image' ? 'Fotos' :
               type === 'video' ? 'Videos' :
               type === 'audio' ? 'Audio' :
               type === 'export' ? 'Exports' : type}
            </button>
          );
        })}

        {/* Separator */}
        {onFavoritesToggle && (
          <div className="h-6 w-px bg-slate-300 mx-2 hidden sm:block" />
        )}

        {/* Favorites Filter Button */}
        {onFavoritesToggle && (
          <button
            onClick={onFavoritesToggle}
            className={`flex items-center space-x-2 px-3 md:px-4 py-1.5 md:py-2 rounded-full text-sm font-medium transition-all duration-200 ${
              showFavoritesOnly
                ? 'bg-lavanda text-white shadow-md'
                : 'bg-pizarra text-lavanda-archivo hover:bg-lavanda hover:bg-opacity-20'
            }`}
            title={showFavoritesOnly ? 'Mostrar todos los archivos' : 'Mostrar solo favoritos'}
          >
            <Heart
              className={`w-4 h-4 ${showFavoritesOnly ? 'fill-noche text-noche' : 'text-lavanda'}`}
            />
            <span className="hidden sm:inline">Favoritos</span>
          </button>
        )}

        {/* Separator before grouping toggle */}
        {onGroupingChange && (
          <div className="h-6 w-px bg-slate-300 mx-2 hidden sm:block" />
        )}

        {/* Grouping Toggle */}
        {onGroupingChange && (
          <button
            data-testid="filter-grouping"
            onClick={() => !groupingDisabled && onGroupingChange(!groupingEnabled)}
            disabled={groupingDisabled}
            className={`flex items-center gap-2 px-3 md:px-4 py-1.5 md:py-2 rounded-full text-sm font-medium transition-all duration-200 ${
              groupingDisabled
                ? 'opacity-40 cursor-not-allowed bg-pizarra text-lavanda-archivo'
                : groupingEnabled
                  ? 'bg-lavanda-claro text-marfil shadow-md'
                  : 'bg-pizarra text-lavanda-archivo hover:bg-lavanda-claro hover:bg-opacity-30'
            }`}
            title={groupingDisabled ? 'Solo disponible en vista cuadrícula' : groupingEnabled ? 'Desactivar agrupación por sesiones' : 'Agrupar por sesiones'}
          >
            {/* Toggle switch pill */}
            <div
              className={`relative w-8 h-4 rounded-full transition-colors duration-200 flex-shrink-0 ${
                groupingEnabled && !groupingDisabled ? 'bg-lavanda' : 'bg-slate-300'
              }`}
            >
              <div
                className={`absolute top-0.5 w-3 h-3 rounded-full bg-tinta shadow transition-transform duration-200 ${
                  groupingEnabled && !groupingDisabled ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </div>
            <span className="hidden sm:inline">Agrupar por sesiones</span>
          </button>
        )}

        {/* Date Range Filter */}
        {onDateRangeChange && (
          <>
            <div className="h-6 w-px bg-slate-300 mx-2 hidden sm:block" />
            <DateRangeFilter
              dateFrom={dateFrom}
              dateTo={dateTo}
              onDateRangeChange={onDateRangeChange}
            />
          </>
        )}

        {/* Color Wheel Filter - al lado de fechas */}
        {onColorFilterChange && (
          <ColorWheelFilter
            onColorFilterChange={onColorFilterChange}
            activeHex={colorFilterHex}
          />
        )}

        {/* Status indicators */}
        <div className="flex items-center gap-3 ml-2 md:ml-4">
          {selectedTypes.length > 1 && (
            <span className="text-xs text-marfil font-medium bg-lavanda-claro px-2 py-1 rounded-full">
              {selectedTypes.length} tipos seleccionados
            </span>
          )}
        </div>
    </div>
  );
}
