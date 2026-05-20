import React, { useRef, useState } from 'react';
import { Heart, Image as ImageIcon, X } from 'lucide-react';
import DateRangeFilter from './DateRangeFilter';
import ColorWheelFilter from './ColorWheelFilter';
import { api } from '../services/api';

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
  // Busqueda por imagen via CLIP
  onImageSearchChange?: (fileIds: Set<string> | null, preview: string | null) => void;
  imageSearchPreview?: string | null;
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
  onImageSearchChange,
  imageSearchPreview,
}: QuickFiltersProps) {
  const imgInputRef = useRef<HTMLInputElement>(null);
  const [imgSearching, setImgSearching] = useState(false);

  async function handleImageSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset
    if (!file || !onImageSearchChange) return;
    setImgSearching(true);
    try {
      const r = await api.searchByImage(file);
      if (r.success && Array.isArray(r.data)) {
        const ids = new Set(r.data.map(x => x.fileId));
        // Crear data URL para preview
        const reader = new FileReader();
        reader.onload = (evt) => {
          const dataUrl = evt.target?.result as string;
          onImageSearchChange(ids, dataUrl);
        };
        reader.readAsDataURL(file);
      } else {
        onImageSearchChange(new Set(), null);
      }
    } catch (err: any) {
      console.warn('Image search error:', err);
      alert('Error en búsqueda por imagen: ' + (err.message || 'desconocido'));
      onImageSearchChange(null, null);
    } finally {
      setImgSearching(false);
    }
  }

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

        {/* Buscar por imagen (CLIP) */}
        {onImageSearchChange && (
          <>
            <input
              ref={imgInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelected}
            />
            <button
              onClick={() => {
                if (imageSearchPreview) {
                  // Si ya hay busqueda activa, click la limpia
                  onImageSearchChange(null, null);
                } else {
                  imgInputRef.current?.click();
                }
              }}
              disabled={imgSearching}
              className={`flex items-center gap-2 px-3 md:px-4 py-1.5 md:py-2 rounded-full text-sm font-medium transition-all duration-200 ${
                imgSearching
                  ? 'bg-lavanda/20 text-lavanda cursor-wait'
                  : imageSearchPreview
                    ? 'bg-lavanda text-white shadow-md'
                    : 'bg-pizarra text-lavanda-archivo hover:bg-lavanda hover:bg-opacity-20'
              }`}
              title={imageSearchPreview ? 'Limpiar búsqueda por imagen' : 'Buscar archivos similares a una imagen'}
            >
              {imageSearchPreview ? (
                <img src={imageSearchPreview} alt="" className="w-4 h-4 rounded object-cover border border-white/40" />
              ) : (
                <ImageIcon className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">
                {imgSearching ? 'Buscando...' : imageSearchPreview ? 'Similares activos' : 'Por imagen'}
              </span>
              {imageSearchPreview && <X className="w-3 h-3" />}
            </button>
          </>
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
