import React from 'react';
import { Play, Download, Heart, MoreHorizontal, Clock, Eye, Plus, X, FolderOpen } from 'lucide-react';
import { MediaFile, VideoItem } from '../types';
import { formatDate } from '../utils/dateUtils';
import Masonry from 'react-masonry-css';
import VideoThumbnail from './VideoThumbnail';
import { SessionItem } from '../hooks/useSessionGroups';
import { SessionCard, SessionHeader, SessionShowMore } from './SessionCard';
import { normalizePath } from '../utils/formatData';

interface MediaGridProps {
  files: MediaFile[];
  viewMode: 'grid' | 'list';
  // Session grouping props (optional — cuando no se pasan, comportamiento normal)
  sessionItems?: SessionItem[];
  onExpandGroup?: (key: string) => void;
  onCollapseGroup?: (key: string) => void;
  onShowMoreGroup?: (key: string) => void;
  onSelectSessionFiles?: (files: MediaFile[]) => void;
  onFileClick: (file: MediaFile, event?: React.MouseEvent) => void;
  onToggleFavorite: (fileId: string) => void;
  onDownload: (file: MediaFile) => void;
  onAddToCollection?: (fileId: string) => void; // New callback for adding to collection
  onRemoveFromCollection?: (fileId: string) => void; // New callback for removing from collection
  onOpenPath?: (fileId: string) => void; // New callback for opening file path (admin only)
  downloadingFiles?: Set<string>; // IDs of files currently being downloaded
  isSelectionMode?: boolean; // Whether selection mode is active
  selectedFiles?: Set<string>; // IDs of selected files
  isAdmin?: boolean; // Whether the current user is admin
  updatingFavs?: boolean
  // Búsqueda natural: índice (dentro del array `files`) a partir del cual los
  // resultados son "menos probables". Si está definido y > 0 y < files.length,
  // se inserta un separador visual entre los dos tramos y los items del segundo
  // tramo se renderizan con menor opacidad. Si no se pasa o es 0, se comporta
  // como una grid normal.
  secondaryStartIndex?: number;
}

export default function MediaGrid({
  files,
  viewMode,
  onFileClick,
  onToggleFavorite,
  onDownload,
  onAddToCollection,
  onRemoveFromCollection,
  onOpenPath,
  downloadingFiles = new Set(),
  isSelectionMode = false,
  selectedFiles = new Set(),
  sessionItems,
  onExpandGroup,
  onCollapseGroup,
  onShowMoreGroup,
  onSelectSessionFiles,
  isAdmin = false,
  updatingFavs = false,
  secondaryStartIndex
}: MediaGridProps) {
  // Determina si hay split en dos tramos (primary / secondary).
  const hasTwoTiers = typeof secondaryStartIndex === 'number'
    && secondaryStartIndex > 0
    && secondaryStartIndex < files.length;
  const primaryFiles = hasTwoTiers ? files.slice(0, secondaryStartIndex) : files;
  const secondaryFiles = hasTwoTiers ? files.slice(secondaryStartIndex) : [];
  const formatFileSize = (bytes: number) => {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;
  };

  const isStoriesFormat = (file: MediaFile) => {
    return file.dimensions && file.dimensions.height > file.dimensions.width;
  };

  const convertToVideoItem = (file: MediaFile): VideoItem => {
    return {
      id: file.id,
      name: file.name,
      url: file.url,
      thumbnail: file.thumbnail,
      duration: file.duration,
      width: file.dimensions?.width,
      height: file.dimensions?.height
    };
  };


  const formatDuration = (seconds?: number) => {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'video':
        return <Play className="w-6 h-6" />;
      case 'audio':
        return <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center text-xs text-white font-bold">♪</div>;
      case 'export':
        return <div className="w-6 h-6 bg-orange-500 rounded-full flex items-center justify-center text-xs text-white font-bold">📤</div>;
      default:
        return <Eye className="w-6 h-6" />;
    }
  };

  // Renderiza una tarjeta de archivo individual (reutilizada en modo normal y modo sesiones)
  // isSecondary: si es un resultado del tramo "menos probables", se atenúa con
  // opacity-60 y vuelve a opacity-100 al pasar el ratón.
  const renderFileCard = (file: MediaFile, isSecondary: boolean = false) => (
    <div
      key={file.id}
      data-file-id={file.id}
      className={`bg-tinta rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 overflow-hidden group cursor-pointer relative mb-3 md:mb-6 ${
        isSecondary ? 'opacity-60 hover:opacity-100' : ''
      } ${selectedFiles.has(file.id) ? 'ring-4 ring-lavanda ring-opacity-50 bg-grafito' : ''}`}
      onClick={(e) => onFileClick(file, e)}
    >
      <div className="relative bg-slate-900 overflow-hidden"
        style={{
          aspectRatio: file.dimensions
            ? `${file.dimensions.width}/${file.dimensions.height}`
            : '16/9'
        }}>
        {file.type === 'video' ? (
          <VideoThumbnail video={convertToVideoItem(file)} className="w-full h-full" />
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
            <h3 className="font-semibold text-white mb-2 line-clamp-2 text-shadow">{file.name}</h3>
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
            {/* {isAdmin && onOpenPath && (
              <button onClick={(e) => { e.stopPropagation(); onOpenPath(file.id); }} className="p-2.5 sm:p-2 rounded-lg backdrop-blur-sm transition-colors bg-green-500/20 text-white hover:bg-green-500/30" title="Abrir ruta"><FolderOpen className="w-4 h-4" /></button>
            )} */}
            <button onClick={(e) => { e.stopPropagation(); onDownload(file); }} disabled={downloadingFiles.has(file.id)} className={`p-2.5 sm:p-2 rounded-lg backdrop-blur-sm transition-colors ${downloadingFiles.has(file.id) ? 'bg-bruma/30 text-white cursor-not-allowed' : 'bg-bruma/20 text-white hover:bg-bruma/30'}`} title="Descargar">
              {downloadingFiles.has(file.id) ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Download className="w-4 h-4" />}
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
            <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${selectedFiles.has(file.id) ? 'bg-lavanda border-lavanda' : 'bg-tinta/90 border-white backdrop-blur-sm'}`}>
              {selectedFiles.has(file.id) && <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
            </div>
          </div>
        )}
        <div className={`absolute ${isSelectionMode ? 'top-10' : 'top-2'} left-2 px-2 py-1 rounded-full text-xs font-medium ${file.type === 'export' ? 'bg-bruma text-white' : 'bg-lavanda-claro text-marfil'}`}>
          {file.type === 'export' ? 'EXPORT' : file.type.toUpperCase()}
        </div>
      </div>
    </div>
  );

  // ── Modo sesiones: CSS grid con items mixtos ──────────────────────────────
  if (sessionItems && sessionItems.length > 0 && viewMode === 'grid') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-6 items-start">
        {sessionItems.map((item, idx) => {
          if (item.type === 'session-header') {
            return (
              <SessionHeader
                key={`header-${item.key}`}
                sessionKey={item.key}
                files={item.files}
                label={item.label}
                onCollapse={onCollapseGroup ?? (() => {})}
              />
            );
          }
          if (item.type === 'session-card') {
            return (
              <SessionCard
                key={`session-${item.key}`}
                sessionKey={item.key}
                files={item.files}
                label={item.label}
                onExpand={onExpandGroup ?? (() => {})}
                isSelectionMode={isSelectionMode}
                onSelectAll={onSelectSessionFiles}
              />
            );
          }
          if (item.type === 'session-show-more') {
            return (
              <SessionShowMore
                key={`more-${item.key}-${idx}`}
                sessionKey={item.key}
                remaining={item.remaining}
                onShowAll={onShowMoreGroup ?? (() => {})}
              />
            );
          }
          // type === 'file'
          return renderFileCard(item.file);
        })}
      </div>
    );
  }

  if (viewMode === 'list') {
    return (
      <div className="bg-tinta rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b">
              <tr>
                {isSelectionMode && (
                  <th className="w-12 py-3 px-4"></th>
                )}
                <th className="text-left py-3 px-3 md:px-4 font-medium text-slate-700">Archivo</th>
                <th className="hidden md:table-cell text-left py-3 px-3 md:px-4 font-medium text-slate-700">Tipo</th>
                <th className="hidden md:table-cell text-left py-3 px-3 md:px-4 font-medium text-slate-700">Tamaño</th>
                <th className="hidden md:table-cell text-left py-3 px-3 md:px-4 font-medium text-slate-700">Fecha</th>
                <th className="hidden sm:table-cell text-left py-3 px-3 md:px-4 font-medium text-slate-700">Etiquetas</th>
                <th className="text-right py-3 px-3 md:px-4 font-medium text-slate-700">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file, idx) => {
                const isSecondary = hasTwoTiers && idx >= (secondaryStartIndex as number);
                const isFirstSecondary = hasTwoTiers && idx === secondaryStartIndex;
                const totalCols = isSelectionMode ? 7 : 6;
                return (
                  <React.Fragment key={file.id}>
                    {isFirstSecondary && (
                      <tr className="bg-grafito">
                        <td colSpan={totalCols} className="py-3 px-4 text-center text-niebla text-xs uppercase tracking-widest font-medium border-t border-b border-pizarra">
                          Resultados menos probables · {files.length - (secondaryStartIndex as number)}
                        </td>
                      </tr>
                    )}
                <tr
                  className={`border-b hover:bg-pizarra transition-colors cursor-pointer ${isSecondary ? 'opacity-60 hover:opacity-100' : ''} ${selectedFiles.has(file.id) ? 'bg-grafito border-lavanda' : ''
                    }`}
                  onClick={(e) => onFileClick(file, e)}
                >
                  {isSelectionMode && (
                    <td className="py-4 px-4">
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${selectedFiles.has(file.id)
                          ? 'bg-lavanda border-lavanda'
                          : 'bg-tinta border-slate-300'
                        }`}>
                        {selectedFiles.has(file.id) && (
                          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                    </td>
                  )}
                  <td className="py-4 px-3 md:px-4">
                    <div className="flex items-center space-x-3">
                      <div className={`relative w-12 h-12 rounded-lg overflow-hidden bg-slate-900 flex-shrink-0 ${isStoriesFormat(file) ? 'flex items-center justify-center' : ''
                        }`}>
                        <img
                          src={file.thumbnail}
                          alt={file.name}
                          className={`${isStoriesFormat(file)
                              ? 'h-full w-auto object-contain'
                              : 'w-full h-full object-cover'
                            }`}
                          onError={(e) => {
                            e.currentTarget.src = `data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" fill="%236366f1"/><text x="24" y="24" font-family="Arial" font-size="16" fill="white" text-anchor="middle">📹</text></svg>`;
                          }}
                        />
                        <div className="absolute inset-0 flex items-center justify-center text-white bg-noche bg-opacity-40">
                          {getTypeIcon(file.type)}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900 truncate">{file.name}</p>
                        {file.duration && (
                          <p className="text-sm text-slate-500 flex items-center">
                            <Clock className="w-3 h-3 mr-1" />
                            {formatDuration(file.duration)}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="hidden md:table-cell py-4 px-3 md:px-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${file.type === 'export' ? 'bg-bruma text-white' : 'bg-lavanda-claro text-marfil'
                      }`}>
                      {file.type === 'export' ? 'Export' : file.type}
                    </span>
                  </td>
                  <td className="hidden md:table-cell py-4 px-3 md:px-4 text-sm text-slate-600">
                    {formatFileSize(file.size)}
                  </td>
                  <td className="hidden md:table-cell py-4 px-3 md:px-4 text-sm text-slate-600">
                    {formatDate(file.createdAt)}
                  </td>
                  <td className="hidden sm:table-cell py-4 px-3 md:px-4">
                    <div className="flex flex-wrap gap-1">
                      {file.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-lavanda-claro text-marfil font-medium"
                        >
                          {tag}
                        </span>
                      ))}
                      {file.tags.length > 3 && (
                        <span className="text-xs text-lavanda-archivo font-medium">+{file.tags.length - 3}</span>
                      )}
                    </div>
                  </td>
                  <td className="py-4 px-3 md:px-4">
                    <div className="flex items-center justify-end space-x-2">
                      <button
                        onClick={() => onToggleFavorite(file.id)}
                        className={`p-2 rounded-lg transition-colors ${file.isFavorite
                            ? 'text-lavanda hover:bg-lavanda hover:bg-opacity-10'
                            : 'text-slate-400 hover:bg-slate-100'
                          }`}
                        title="Favorito"
                      >
                        <Heart className={`w-4 h-4 ${file.isFavorite ? 'fill-current' : ''}`} />
                      </button>
                      {onAddToCollection && (
                        <button
                          onClick={() => onAddToCollection(normalizePath(file.fullPath!))}
                          className="p-2 rounded-lg text-slate-400 hover:bg-lavanda hover:bg-opacity-10 hover:text-lavanda transition-colors"
                          title="Añadir a colección"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      )}
                      {onRemoveFromCollection && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveFromCollection(normalizePath(file.fullPath!));
                          }}
                          className="p-2 rounded-lg text-slate-400 hover:bg-red-500 hover:bg-opacity-10 hover:text-red-500 transition-colors"
                          title="Eliminar de colección"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => onDownload(file)}
                        disabled={downloadingFiles.has(file.id)}
                        className={`p-2 rounded-lg transition-colors ${downloadingFiles.has(file.id)
                            ? 'text-bruma cursor-not-allowed'
                            : 'text-slate-400 hover:bg-bruma hover:bg-opacity-10 hover:text-bruma'
                          }`}
                        title="Descargar"
                      >
                        {downloadingFiles.has(file.id) ? (
                          <div className="w-4 h-4 border-2 border-bruma border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <Download className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onFileClick(file, e);
                        }}
                        className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                        title="Más opciones"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Configuración de breakpoints para Masonry
  const breakpointColumnsObj = {
    default: 4,
    1100: 3,
    700: 2,
    500: 1
  };

  // Caso normal (sin dos tramos): un solo Masonry con todos los archivos.
  if (!hasTwoTiers) {
    return (
      <Masonry
        breakpointCols={breakpointColumnsObj}
        className="flex w-auto"
        columnClassName="bg-clip-padding px-1.5 md:px-3"
      >
        {files.map((file) => renderFileCard(file))}
      </Masonry>
    );
  }

  // Caso dos tramos (búsqueda natural): primer Masonry con los resultados
  // claros, separador visual, segundo Masonry con los menos probables
  // (atenuados). Cada Masonry recalcula sus columnas de forma independiente.
  return (
    <>
      <Masonry
        breakpointCols={breakpointColumnsObj}
        className="flex w-auto"
        columnClassName="bg-clip-padding px-1.5 md:px-3"
      >
        {primaryFiles.map((file) => renderFileCard(file))}
      </Masonry>

      <div className="my-8 px-3 flex items-center gap-4">
        <div className="flex-1 h-px bg-pizarra" />
        <span className="text-niebla text-xs uppercase tracking-widest font-medium whitespace-nowrap">
          Resultados menos probables · {secondaryFiles.length}
        </span>
        <div className="flex-1 h-px bg-pizarra" />
      </div>

      <Masonry
        breakpointCols={breakpointColumnsObj}
        className="flex w-auto"
        columnClassName="bg-clip-padding px-1.5 md:px-3"
      >
        {secondaryFiles.map((file) => renderFileCard(file, true))}
      </Masonry>
    </>
  );
}
