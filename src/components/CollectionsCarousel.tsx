import React, { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FolderOpen, Edit2, Trash2, Download, Plus, Image, Loader } from 'lucide-react';
import { Collection, MediaFile } from '../types';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../services/api';
import { normalizePath } from '../utils/formatData';

// Componente individual sortable para cada colección
interface SortableCollectionItemProps {
  collection: Collection;
  mediaFiles: MediaFile[];
  onCollectionSelect: (id: string) => void;
  onEditCollection: (id: string) => void;
  onDeleteCollection: (id: string) => void;
  onDownloadCollection: (id: string, e?: React.MouseEvent) => void;
  onEditCover?: (id: string) => void;
  isDownloading?: boolean;
}

function SortableCollectionItem({
  collection,
  mediaFiles,
  onCollectionSelect,
  onEditCollection,
  onDeleteCollection,
  onDownloadCollection,
  onEditCover,
  isDownloading = false
}: SortableCollectionItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: collection.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.8 : 1,
    zIndex: isDragging ? 1000 : 1,
  };

  const handleActionClick = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
  };

  const collectionFiles = mediaFiles.length > 0 && collection.mediaFiles ? mediaFiles.filter(file =>
    collection.mediaFiles.includes(normalizePath(file.fullPath!))
  ) : [];

  // Determine cover image to use
  let coverImage = collection.coverImage ? mediaFiles.find(f => normalizePath(f.fullPath!) === normalizePath(collection.coverImage!))?.thumbnail : null;

  // Fallback to first file thumbnail if no custom cover
  const previewImage = coverImage || collectionFiles[0]?.thumbnail || null;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onCollectionSelect(collection.id)}
      className={`group relative flex-shrink-0 w-64 sm:w-80 rounded-xl overflow-hidden cursor-pointer bg-slate-200 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 ${isDragging ? 'shadow-2xl scale-105' : ''
        }`}
      style={{ scrollSnapAlign: 'start', aspectRatio: '16/9', ...style }}
    >
      {/* Background Image */}
      {previewImage ? (
        <img
          src={previewImage}
          alt={collection.name}
          className="w-full h-full object-cover"
          onError={(e) => {
            e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="256" height="144" viewBox="0 0 256 144"><rect width="256" height="144" fill="%23e2e8f0"/><g transform="translate(128,72)"><rect x="-20" y="-15" width="40" height="30" fill="%2394a3b8" rx="2"/><rect x="-15" y="-8" width="30" height="20" fill="%23cbd5e1" rx="1"/></g></svg>';
          }}
        />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
          <FolderOpen className="w-12 h-12 text-slate-400" />
        </div>
      )}

      {/* Gradient Overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

      {/* Drag Indicator */}
      {isDragging && (
        <div className="absolute top-2 left-2 bg-tinta/20 backdrop-blur-sm rounded-full p-1">
          <div className="w-2 h-2 bg-tinta rounded-full animate-pulse" />
        </div>
      )}

      {/* Collection Name - Only visible on hover */}
      <div className="absolute bottom-0 left-0 right-0 p-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <h3 className="font-bold text-white text-sm mb-1">
          {collection.name}
        </h3>
        <p className="text-white/80 text-xs">
          {collectionFiles.length} archivo{collectionFiles.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Action buttons - Only visible on hover */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <button
          onClick={(e) => handleActionClick(e, () => onDownloadCollection(collection.id, e))}
          className={`w-7 h-7 bg-tinta/20 backdrop-blur-sm hover:bg-tinta/30 rounded-full flex items-center justify-center transition-all duration-300 ${isDownloading ? 'cursor-wait bg-lavanda/40 scale-110' : ''
            }`}
          title={isDownloading ? 'Descargando...' : 'Descargar colección'}
          disabled={isDownloading}
        >
          {isDownloading ? (
            <Loader className="w-3.5 h-3.5 text-white animate-spin" />
          ) : (
            <Download className="w-3.5 h-3.5 text-white transition-transform duration-200 group-hover:scale-110" />
          )}
        </button>

        {onEditCover && (
          <button
            onClick={(e) => handleActionClick(e, () => onEditCover(collection.id))}
            className="w-7 h-7 bg-tinta/20 backdrop-blur-sm hover:bg-tinta/30 rounded-full flex items-center justify-center transition-colors"
            title="Cambiar portada"
          >
            <Image className="w-3.5 h-3.5 text-white" />
          </button>
        )}

        <button
          onClick={(e) => handleActionClick(e, () => onEditCollection(collection.id))}
          className="w-7 h-7 bg-tinta/20 backdrop-blur-sm hover:bg-tinta/30 rounded-full flex items-center justify-center transition-colors"
          title="Editar colección"
        >
          <Edit2 className="w-3.5 h-3.5 text-white" />
        </button>

        <button
          onClick={(e) => handleActionClick(e, () => onDeleteCollection(collection.id))}
          className="w-7 h-7 bg-red-500/80 backdrop-blur-sm hover:bg-red-600/80 rounded-full flex items-center justify-center transition-colors"
          title="Eliminar colección"
        >
          <Trash2 className="w-3.5 h-3.5 text-white" />
        </button>
      </div>

      {/* File Count Badge */}
      {
        collectionFiles.length > 0 && <div className="absolute top-2 left-2 bg-noche/50 backdrop-blur-sm text-white text-xs px-2 py-1 rounded-full">
          {collection.mediaFiles.length} archivo{collection.mediaFiles.length !== 1 ? 's' : ''}
        </div>
      }

    </div>
  );
}

interface CollectionsCarouselProps {
  collections: Collection[];
  onCollectionSelect: (id: string) => void;
  onCreateCollection: () => void;
  onEditCollection: (id: string) => void;
  onDeleteCollection: (id: string) => void;
  onDownloadCollection: (id: string, e?: React.MouseEvent) => void;
  onEditCover?: (id: string) => void;
  mediaFiles: MediaFile[];
  onCollectionsReorder?: (reorderedCollections: Collection[]) => void;
  downloadingCollectionId?: string | null;
}

export function CollectionsCarousel({
  collections,
  onCollectionSelect,
  onCreateCollection,
  onEditCollection,
  onDeleteCollection,
  onDownloadCollection,
  onEditCover,
  mediaFiles,
  onCollectionsReorder,
  downloadingCollectionId
}: CollectionsCarouselProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState(collections);

  // Configurar sensores para drag & drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Manejar el final del drag
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (active.id !== over?.id) {
      const oldIndex = items.findIndex((item) => item.id === active.id);
      const newIndex = items.findIndex((item) => item.id === over?.id);

      const newItems = arrayMove(items, oldIndex, newIndex);
      setItems(newItems);

      // Llamar al callback padre si existe
      if (onCollectionsReorder) {
        onCollectionsReorder(newItems);
      }

      // Enviar al servidor
      try {
        const orderedIds = newItems.map(item => item.id);
        await api.reorderCollections(orderedIds);
        console.log('🔄 Colecciones reordenadas exitosamente');
      } catch (error) {
        console.error('❌ Error reordenando colecciones:', error);
        // Revertir cambios en caso de error
        setItems(collections);
      }
    }
  };

  // Actualizar items cuando cambian las collections
  React.useEffect(() => {
    setItems(collections);
  }, [collections]);

  if (collections.length === 0) {
    return null;
  }

  const scrollLeft = () => {
    if (scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const scrollAmount = container.clientWidth * 0.8;
      container.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
    }
  };

  const scrollRight = () => {
    if (scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const scrollAmount = container.clientWidth * 0.8;
      container.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  return (
    <div className="mb-4 md:mb-8">
      <div className="relative">
        {/* Left Arrow */}
        <button
          onClick={scrollLeft}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 bg-tinta shadow-lg rounded-full flex items-center justify-center hover:bg-slate-50 transition-colors"
          aria-label="Desplazar izquierda"
        >
          <ChevronLeft className="w-5 h-5 text-slate-600" />
        </button>

        {/* Drag & Drop Context */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={items.map(item => item.id)}
            strategy={horizontalListSortingStrategy}
          >
            {/* Carousel Container */}
            <div
              ref={scrollContainerRef}
              className="flex gap-3 md:gap-4 overflow-x-hidden scroll-smooth px-8 md:px-12 py-4"
              style={{ scrollSnapType: 'x mandatory' }}
            >
              {items.map((collection) => (
                <SortableCollectionItem
                  key={collection.id}
                  collection={collection}
                  mediaFiles={mediaFiles}
                  onCollectionSelect={onCollectionSelect}
                  onEditCollection={onEditCollection}
                  onDeleteCollection={onDeleteCollection}
                  onDownloadCollection={onDownloadCollection}
                  onEditCover={onEditCover}
                  isDownloading={downloadingCollectionId === collection.id}
                />
              ))}

              {/* Nueva Colección Card */}
              <div
                onClick={onCreateCollection}
                className="group relative flex-shrink-0 w-64 sm:w-80 rounded-xl overflow-hidden cursor-pointer bg-slate-100 border-2 border-dashed border-slate-300 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 hover:border-lavanda hover:bg-lavanda/5"
                style={{ scrollSnapAlign: 'start', aspectRatio: '16/9' }}
              >
                <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 group-hover:text-lavanda transition-colors">
                  <Plus className="w-12 h-12 mb-3" />
                  <span className="text-lg font-medium">Nueva Colección</span>
                  <span className="text-sm text-slate-500 group-hover:text-lavanda/70">Haz clic para crear</span>
                </div>
              </div>
            </div>
          </SortableContext>
        </DndContext>

        {/* Right Arrow */}
        <button
          onClick={scrollRight}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 bg-tinta shadow-lg rounded-full flex items-center justify-center hover:bg-slate-50 transition-colors"
          aria-label="Desplazar derecha"
        >
          <ChevronRight className="w-5 h-5 text-slate-600" />
        </button>
      </div>
    </div>
  );
}