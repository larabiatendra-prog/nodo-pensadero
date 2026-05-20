import React from 'react';
import { ArrowLeft, FolderOpen } from 'lucide-react';
import { Collection, MediaFile } from '../types';
import { CollectionsCarousel } from './CollectionsCarousel';

/**
 * Vista dedicada a la gestión de colecciones. Accesible desde el menu de
 * tres puntos del header global (entrada "Colecciones").
 *
 * Encapsula CollectionsCarousel con un header propio. En esta version
 * minima delega todos los handlers al App, asi se mantiene la
 * funcionalidad existente intacta y los datos persisten consistentemente.
 *
 * Al hacer click en una coleccion, navega a la home con esa coleccion
 * seleccionada (el App muestra el detalle alli). Al volver del detalle,
 * regresa a esta vista (no a Inicio).
 */

interface CollectionsViewProps {
  onBack?: () => void;
  collections: Collection[];
  mediaFiles: MediaFile[];
  onCollectionSelect: (id: string) => void;
  onCreateCollection: () => void;
  onEditCollection: (id: string) => void;
  onDeleteCollection: (id: string) => void;
  onDownloadCollection: (id: string, e?: React.MouseEvent) => void;
  onEditCover?: (id: string) => void;
  onCollectionsReorder?: (reordered: Collection[]) => void;
  downloadingCollectionId?: string | null;
}

export default function CollectionsView({
  onBack,
  collections,
  mediaFiles,
  onCollectionSelect,
  onCreateCollection,
  onEditCollection,
  onDeleteCollection,
  onDownloadCollection,
  onEditCover,
  onCollectionsReorder,
  downloadingCollectionId,
}: CollectionsViewProps) {
  const smartCount = collections.filter(c => c.type === 'smart').length;
  const staticCount = collections.length - smartCount;

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          {onBack && (
            <button
              onClick={onBack}
              className="flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Volver</span>
            </button>
          )}
          <h1 className="text-2xl font-bold text-marfil mb-2 flex items-center gap-3">
            <FolderOpen className="w-7 h-7 text-lavanda" />
            Colecciones
          </h1>
          <p className="text-lavanda-archivo">
            Agrupa archivos en colecciones manuales o crea Smart Folders con reglas que se actualizan solas. Click en cualquier colección para ver su contenido.
          </p>
        </div>
      </div>

      {/* Stats banner */}
      {collections.length > 0 && (
        <div className="mb-6 p-4 bg-pizarra rounded-2xl flex items-center gap-4 text-sm flex-wrap">
          <span className="text-marfil font-medium">{collections.length}</span>
          <span className="text-lavanda-archivo">en total</span>
          {staticCount > 0 && (
            <>
              <span className="text-bruma">·</span>
              <span className="text-marfil font-medium">{staticCount}</span>
              <span className="text-lavanda-archivo">{staticCount === 1 ? 'manual' : 'manuales'}</span>
            </>
          )}
          {smartCount > 0 && (
            <>
              <span className="text-bruma">·</span>
              <span className="text-marfil font-medium">{smartCount}</span>
              <span className="text-lavanda-archivo">{smartCount === 1 ? 'Smart Folder' : 'Smart Folders'}</span>
            </>
          )}
        </div>
      )}

      {/* Carrusel reutilizado */}
      <CollectionsCarousel
        collections={collections}
        mediaFiles={mediaFiles}
        onCollectionSelect={onCollectionSelect}
        onCreateCollection={onCreateCollection}
        onEditCollection={onEditCollection}
        onDeleteCollection={onDeleteCollection}
        onDownloadCollection={onDownloadCollection}
        onEditCover={onEditCover}
        onCollectionsReorder={onCollectionsReorder}
        downloadingCollectionId={downloadingCollectionId}
      />

      {/* Nota informativa */}
      <div className="mt-8 p-4 bg-pizarra/50 border border-pizarra rounded-2xl">
        <h4 className="text-sm font-medium text-marfil mb-1">Tipos de colección</h4>
        <ul className="text-xs text-lavanda-archivo space-y-1">
          <li><strong className="text-marfil">Manual:</strong> tú añades los archivos uno a uno. El contenido no cambia salvo que añadas o quites elementos a mano.</li>
          <li><strong className="text-marfil">Smart Folder:</strong> defines reglas (color, persona, mood, tipo de plano, fecha...) y los archivos que las cumplan aparecen automáticamente. Cuando se añaden archivos nuevos a la biblioteca, los que encajen entran solos.</li>
        </ul>
      </div>
    </div>
  );
}
