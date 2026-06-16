import React, { useMemo } from 'react';
import { Download, Heart, Plus, X, Sparkles, FolderOpen } from 'lucide-react';
import { MediaFile, VideoItem } from '../types';
import { formatDate } from '../utils/dateUtils';
import { normalizePath } from '../utils/formatData';
import VideoThumbnail from './VideoThumbnail';

/**
 * Tarjeta de archivo individual del grid (Home/galería).
 *
 * Extraída de MediaGrid.renderFileCard y envuelta en React.memo para que un
 * cambio de estado en App (nota, favorito de otro archivo, modal, filtros)
 * NO repinte todas las tarjetas: solo se re-renderiza la que cambió.
 *
 * Recibe SOLO props escalares (isSelected/isScanning/isDownloading/note) en vez
 * del Set/Record completo, de modo que el comparador es una comparación barata
 * de primitivas + identidad de `file`. Los callbacks se comparan por referencia
 * (deben venir estables vía useCallback en App); si alguno cambia, la tarjeta
 * se re-renderiza — así nunca queda un closure obsoleto.
 */

// Helpers puros (sin closure sobre props/estado): a nivel de módulo para
// identidad estable. Exportados porque MediaGrid los reutiliza en la vista lista.
export const formatFileSize = (bytes: number) => {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;
};

export const formatDuration = (seconds?: number) => {
  if (!seconds) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const convertToVideoItem = (file: MediaFile): VideoItem => ({
  id: file.id,
  name: file.name,
  url: file.url,
  thumbnail: file.thumbnail,
  duration: file.duration,
  width: file.dimensions?.width,
  height: file.dimensions?.height,
});

export interface MediaCardProps {
  file: MediaFile;
  isSecondary?: boolean;     // tramo "menos probables" (búsqueda natural) → atenuado
  isSelected: boolean;       // = selectedFiles.has(file.id), derivado en MediaGrid
  isScanning: boolean;       // = scanningFiles.has(file.id)
  isDownloading: boolean;    // = downloadingFiles.has(file.id)
  note?: string;             // = fileNotes?.[file.id]
  isSelectionMode: boolean;
  updatingFavs: boolean;
  onFileClick: (file: MediaFile, event?: React.MouseEvent) => void;
  onToggleFavorite: (fileId: string) => void;
  onDownload: (file: MediaFile) => void;
  onScanFile?: (file: MediaFile) => void;
  onAddToCollection?: (fileId: string) => void;
  onRemoveFromCollection?: (fileId: string) => void;
  onOpenPath?: (fileId: string) => void; // Abrir carpeta contenedora con el archivo seleccionado
}

function MediaCardBase({
  file,
  isSecondary = false,
  isSelected,
  isScanning,
  isDownloading,
  note,
  isSelectionMode,
  updatingFavs,
  onFileClick,
  onToggleFavorite,
  onDownload,
  onScanFile,
  onAddToCollection,
  onRemoveFromCollection,
  onOpenPath,
}: MediaCardProps) {
  // El VideoItem solo se recalcula si cambian sus campos; así VideoThumbnail
  // (memoizado) no se repinta en cada render del grid.
  const videoItem = useMemo(
    () => convertToVideoItem(file),
    [file.id, file.name, file.url, file.thumbnail, file.duration, file.dimensions?.width, file.dimensions?.height]
  );

  return (
    <div
      data-file-id={file.id}
      className={`bg-tinta rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 overflow-hidden group cursor-pointer relative mb-3 md:mb-6 ${
        isSecondary ? 'opacity-60 hover:opacity-100' : ''
      } ${isSelected ? 'ring-4 ring-lavanda ring-opacity-50 bg-grafito' : ''}`}
      onClick={(e) => onFileClick(file, e)}
    >
      <div className="relative bg-slate-900 overflow-hidden"
        style={{
          aspectRatio: file.dimensions
            ? `${file.dimensions.width}/${file.dimensions.height}`
            : '16/9'
        }}>
        {file.type === 'video' ? (
          <VideoThumbnail video={videoItem} className="w-full h-full" />
        ) : (
          <img
            src={file.thumbnail}
            alt={file.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => {
              e.currentTarget.src = `data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="%23ef4444"/><text x="150" y="110" font-family="Arial" font-size="12" fill="white" text-anchor="middle">Sin miniatura</text></svg>`;
            }}
          />
        )}
        <div className="absolute inset-0 bg-noche bg-opacity-0 group-hover:bg-opacity-40 transition-all duration-300" />
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-all duration-300 p-3 md:p-4 flex flex-col justify-end text-white">
          {file.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-3">
              {file.tags.slice(0, 3).map((tag) => (
                <span key={tag} className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-lavanda-claro text-marfil font-medium">{tag}</span>
              ))}
              {file.tags.length > 3 && <span className="text-xs text-lavanda-archivo font-medium">+{file.tags.length - 3}</span>}
            </div>
          )}
          <div className="mb-3">
            {/* Nota humana del archivo (si existe). El nombre del archivo no se
                muestra: no aporta informacion al usuario. */}
            {note && (
              <p className="font-medium text-lavanda-claro italic mb-2 line-clamp-3 text-shadow" title={note}>
                “{note}”
              </p>
            )}
            <div className="flex items-center justify-between text-xs sm:text-sm text-white/90">
              <span>{formatFileSize(file.size)}</span>
              <span>{formatDate(file.createdAt)}</span>
            </div>
          </div>
          <div className="flex justify-end space-x-2">
            {onAddToCollection && (
              <button onClick={(e) => { e.stopPropagation(); onAddToCollection(normalizePath(file.fullPath!)); }} className="p-2.5 sm:p-2 rounded-lg backdrop-blur-sm transition-colors bg-lavanda/20 text-white hover:bg-lavanda/30" title="Añadir a colección"><Plus className="w-4 h-4" /></button>
            )}
            {onRemoveFromCollection && (
              <button onClick={(e) => { e.stopPropagation(); onRemoveFromCollection(normalizePath(file.fullPath!)); }} className="p-2.5 sm:p-2 rounded-lg backdrop-blur-sm transition-colors bg-red-500/20 text-white hover:bg-red-500/30" title="Eliminar de colección"><X className="w-4 h-4" /></button>
            )}
            {onScanFile && file.type !== 'audio' && (
              <button
                onClick={(e) => { e.stopPropagation(); onScanFile(file); }}
                disabled={isScanning}
                className={`p-2.5 sm:p-2 rounded-lg backdrop-blur-sm transition-colors ${isScanning ? 'bg-lavanda/30 text-white cursor-wait' : 'bg-lavanda/20 text-white hover:bg-lavanda/30'}`}
                title={isScanning ? 'Escaneando...' : (file.visual_description ? 'Re-escanear visualmente (IA)' : 'Escanear visualmente (IA)')}
              >
                {isScanning ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Sparkles className="w-4 h-4" />}
              </button>
            )}
            {onOpenPath && (
              <button onClick={(e) => { e.stopPropagation(); onOpenPath(file.id); }} className="p-2.5 sm:p-2 rounded-lg backdrop-blur-sm transition-colors bg-bruma/20 text-white hover:bg-bruma/30" title="Ir a ruta (abrir carpeta)"><FolderOpen className="w-4 h-4" /></button>
            )}
            <button onClick={(e) => { e.stopPropagation(); onDownload(file); }} disabled={isDownloading} className={`p-2.5 sm:p-2 rounded-lg backdrop-blur-sm transition-colors ${isDownloading ? 'bg-bruma/30 text-white cursor-not-allowed' : 'bg-bruma/20 text-white hover:bg-bruma/30'}`} title="Descargar">
              {isDownloading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Download className="w-4 h-4" />}
            </button>
          </div>
        </div>
        {file.duration && (
          <div className="absolute bottom-2 right-2 bg-noche/75 text-white text-xs px-2 py-1 rounded backdrop-blur-sm">{formatDuration(file.duration)}</div>
        )}
        <button disabled={updatingFavs} onClick={(e) => { e.stopPropagation(); onToggleFavorite(file.id); }} className={`absolute top-2 right-2 p-2 rounded-full transition-all duration-200 backdrop-blur-sm ${file.isFavorite ? 'bg-lavanda/90 text-white' : 'bg-noche/30 text-white opacity-70 hover:opacity-100 hover:bg-noche/50'} ${updatingFavs ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
          {!updatingFavs ? <Heart className={`w-4 h-4 ${file.isFavorite ? 'fill-current' : ''}`} /> : <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
        </button>
        {isSelectionMode && (
          <div className="absolute top-2 left-2 z-10">
            <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-lavanda border-lavanda' : 'bg-tinta/90 border-white backdrop-blur-sm'}`}>
              {isSelected && <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </div>
          </div>
        )}
        <div className={`absolute ${isSelectionMode ? 'top-10' : 'top-2'} left-2 px-2 py-1 rounded-full text-xs font-medium ${file.type === 'export' ? 'bg-bruma text-white' : 'bg-lavanda-claro text-marfil'}`}>
          {file.type === 'export' ? 'EXPORT' : file.type.toUpperCase()}
        </div>
      </div>
    </div>
  );
}

/**
 * Comparador del memo. Devuelve true (saltar render) solo si TODO lo que afecta
 * a lo pintado es igual. `file` se compara primero por identidad (fast-path: se
 * conserva salvo en el archivo realmente tocado) y, como fallback autoritativo
 * para recargas/escaneos donde la identidad se pierde, por los campos que la
 * tarjeta usa. Los callbacks se comparan por referencia (estables vía useCallback).
 */
function areEqual(prev: MediaCardProps, next: MediaCardProps): boolean {
  if (
    prev.isSelected !== next.isSelected ||
    prev.isScanning !== next.isScanning ||
    prev.isDownloading !== next.isDownloading ||
    prev.isSelectionMode !== next.isSelectionMode ||
    prev.updatingFavs !== next.updatingFavs ||
    prev.isSecondary !== next.isSecondary ||
    prev.note !== next.note ||
    prev.onFileClick !== next.onFileClick ||
    prev.onToggleFavorite !== next.onToggleFavorite ||
    prev.onDownload !== next.onDownload ||
    prev.onScanFile !== next.onScanFile ||
    prev.onAddToCollection !== next.onAddToCollection ||
    prev.onRemoveFromCollection !== next.onRemoveFromCollection ||
    prev.onOpenPath !== next.onOpenPath
  ) {
    return false;
  }
  const a = prev.file;
  const b = next.file;
  if (a === b) return true; // fast-path: identidad preservada salvo el archivo tocado
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.isFavorite === b.isFavorite &&
    a.thumbnail === b.thumbnail &&
    a.url === b.url &&
    a.type === b.type &&
    a.size === b.size &&
    a.duration === b.duration &&
    a.visual_description === b.visual_description &&
    a.tags === b.tags &&
    a.dimensions?.width === b.dimensions?.width &&
    a.dimensions?.height === b.dimensions?.height &&
    a.createdAt === b.createdAt &&
    a.fullPath === b.fullPath
  );
}

const MediaCard = React.memo(MediaCardBase, areEqual);
export default MediaCard;
