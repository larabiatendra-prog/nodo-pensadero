import React, { useMemo } from 'react';
import { Play, Download, Heart, MoreHorizontal, Clock, Eye, Plus, X } from 'lucide-react';
import { MediaFile } from '../types';
import { formatDate } from '../utils/dateUtils';
import Masonry from 'react-masonry-css';
import { SessionItem } from '../hooks/useSessionGroups';
import { SessionCard, SessionHeader, SessionShowMore, SessionBoundaryCard } from './SessionCard';
import { normalizePath } from '../utils/formatData';
import MediaCard, { formatFileSize, formatDuration } from './MediaCard';
import { noteFor } from '../utils/mediaNotes';

interface MediaGridProps {
  files: MediaFile[];
  viewMode: 'grid' | 'list';
  // Session grouping props (optional — cuando no se pasan, comportamiento normal)
  sessionItems?: SessionItem[];
  onExpandGroup?: (key: string) => void;
  onCollapseGroup?: (key: string) => void;
  // Click en el fondo de la grid (hueco entre tarjetas), fuera de cualquier
  // tarjeta: colapsa la sesion abierta.
  onCollapseAll?: () => void;
  onShowMoreGroup?: (key: string) => void;
  onSelectSessionFiles?: (files: MediaFile[]) => void;
  // Notas humanas por sesion: mapa session key -> nota, y callback de edicion.
  sessionNotes?: Record<string, string>;
  onEditSessionNote?: (key: string, label: { line1: string; line2: string }) => void;
  // Play de una sesion colapsada: reproduce sus videos en modo presentacion.
  onPlaySession?: (files: MediaFile[]) => void;
  // Notas humanas por archivo: mapa file.id -> nota. Se muestran en el hover
  // de la tarjeta en lugar del nombre del archivo.
  fileNotes?: Record<string, string>;
  onFileClick: (file: MediaFile, event?: React.MouseEvent) => void;
  onToggleFavorite: (fileId: string) => void;
  onDownload: (file: MediaFile) => void;
  onAddToCollection?: (fileId: string) => void; // New callback for adding to collection
  onRemoveFromCollection?: (fileId: string) => void; // New callback for removing from collection
  onOpenPath?: (fileId: string) => void; // New callback for opening file path (admin only)
  onScanFile?: (file: MediaFile) => void; // Escaneo visual de un solo archivo (boton de la tarjeta)
  onOcultar?: (fileIds: string[]) => void; // Candado: fuera de la aplicacion hasta dar la clave
  scanningFiles?: Set<string>; // IDs de archivos con escaneo visual en curso
  downloadingFiles?: Set<string>; // IDs of files currently being downloaded
  isSelectionMode?: boolean; // Whether selection mode is active
  selectedFiles?: Set<string>; // IDs of selected files
  isAdmin?: boolean; // Whether the current user is admin
  updatingFavs?: boolean
  // Búsqueda natural: índice (dentro del array `files`) a partir del cual los
  // resultados van en el segundo bloque: o casaron debilmente con la consulta,
  // o los encontro la via semantica (se parecen a lo pedido aunque el texto no
  // coincidiera). Si está definido y > 0 y < files.length,
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
  onScanFile,
  onOcultar,
  scanningFiles = new Set(),
  downloadingFiles = new Set(),
  isSelectionMode = false,
  selectedFiles = new Set(),
  sessionItems,
  onExpandGroup,
  onCollapseGroup,
  onCollapseAll,
  onShowMoreGroup,
  onSelectSessionFiles,
  sessionNotes,
  onEditSessionNote,
  onPlaySession,
  fileNotes,
  updatingFavs = false,
  secondaryStartIndex
}: MediaGridProps) {
  // Determina si hay split en dos tramos (primary / secondary). Memoizado para
  // no recrear los slices (y forzar relayout de Masonry) en cada render cuando
  // `files` no ha cambiado.
  const hasTwoTiers = useMemo(
    () => typeof secondaryStartIndex === 'number' && secondaryStartIndex > 0 && secondaryStartIndex < files.length,
    [secondaryStartIndex, files.length]
  );
  const primaryFiles = useMemo(
    () => (hasTwoTiers ? files.slice(0, secondaryStartIndex) : files),
    [files, hasTwoTiers, secondaryStartIndex]
  );
  const secondaryFiles = useMemo(
    () => (hasTwoTiers ? files.slice(secondaryStartIndex) : []),
    [files, hasTwoTiers, secondaryStartIndex]
  );

  const isStoriesFormat = (file: MediaFile) => {
    return file.dimensions && file.dimensions.height > file.dimensions.width;
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

  // Renderiza una tarjeta de archivo (modo normal y modo sesiones). Ahora es un
  // envoltorio fino sobre <MediaCard> (memoizado): deriva las props ESCALARES
  // por tarjeta (isSelected/isScanning/isDownloading/note) desde los Sets/Record
  // antes de renderizar, para que el comparador del memo sea barato y la tarjeta
  // no se repinte cuando cambia el estado de OTRA tarjeta.
  // isSecondary: tramo "menos probables" (búsqueda natural) → atenuado.
  const renderFileCard = (file: MediaFile, isSecondary: boolean = false) => (
    <MediaCard
      key={file.id}
      file={file}
      isSecondary={isSecondary}
      isSelected={selectedFiles.has(file.id)}
      isScanning={scanningFiles.has(file.id)}
      isDownloading={downloadingFiles.has(file.id)}
      note={noteFor(fileNotes, file)}
      isSelectionMode={isSelectionMode}
      updatingFavs={updatingFavs}
      onFileClick={onFileClick}
      onToggleFavorite={onToggleFavorite}
      onDownload={onDownload}
      onScanFile={onScanFile}
      onAddToCollection={onAddToCollection}
      onRemoveFromCollection={onRemoveFromCollection}
      onOpenPath={onOpenPath}
      onOcultar={onOcultar}
    />
  );

  // ── Modo sesiones: CSS grid con items mixtos ──────────────────────────────
  if (sessionItems && sessionItems.length > 0 && viewMode === 'grid') {
    // Una tarjeta atenuada (fuera de la sesion abierta) actua como "fondo":
    // pulsarla colapsa la sesion en vez de abrir su preview. Capture para
    // interceptar antes que el onClick propio de la tarjeta.
    const wrapDimmed = (node: React.ReactNode, key: string) => (
      <div
        key={key}
        onClickCapture={(e) => { e.stopPropagation(); e.preventDefault(); onCollapseAll?.(); }}
      >
        {node}
      </div>
    );
    return (
      <div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-6 items-start"
        // Solo el fondo de la grid (huecos) tiene como target el propio div;
        // los clicks en tarjetas llegan a sus hijos. Asi colapsamos al pulsar
        // fuera de cualquier tarjeta sin interceptar los clicks de las tarjetas.
        onClick={(e) => { if (e.target === e.currentTarget) onCollapseAll?.(); }}
      >
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
          if (item.type === 'session-start' || item.type === 'session-end') {
            return (
              <SessionBoundaryCard
                key={`${item.type}-${item.key}`}
                sessionKey={item.key}
                refFile={item.firstFile}
                label={item.label}
                variant={item.type === 'session-start' ? 'start' : 'end'}
                onCollapse={onCollapseGroup ?? (() => {})}
              />
            );
          }
          if (item.type === 'session-card') {
            const card = (
              <SessionCard
                key={`session-${item.key}`}
                sessionKey={item.key}
                files={item.files}
                label={item.label}
                onExpand={onExpandGroup ?? (() => {})}
                isSelectionMode={isSelectionMode}
                onSelectAll={onSelectSessionFiles}
                note={sessionNotes?.[item.key]}
                onEditNote={onEditSessionNote}
                onPlaySession={onPlaySession}
                onOcultar={onOcultar}
                dimmed={item.dimmed}
              />
            );
            return item.dimmed ? wrapDimmed(card, `dim-session-${item.key}`) : card;
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
          return item.dimmed
            ? wrapDimmed(renderFileCard(item.file, item.dimmed), `dim-file-${item.file.id}`)
            : renderFileCard(item.file, item.dimmed);
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
                          Además, te puede interesar · {files.length - (secondaryStartIndex as number)}
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
                        <p className="font-medium text-slate-900 truncate" title={file.name}>{file.displayName || file.name}</p>
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
          Además, te puede interesar · {secondaryFiles.length}
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
