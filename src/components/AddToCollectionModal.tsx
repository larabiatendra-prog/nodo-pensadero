import React, { useState } from 'react';
import { X, FolderPlus, Check } from 'lucide-react';
import { Collection } from '../types';

interface AddToCollectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  collections: Collection[];
  onAddToCollection: (collectionId: string) => void;
  onCreateNewCollection?: () => void; // Callback to open create collection modal
  fileId?: string; // Single file ID (optional for backward compatibility)
  fileIds?: string[]; // Multiple file IDs for bulk operations
}

export function AddToCollectionModal({
  isOpen,
  onClose,
  collections,
  onAddToCollection,
  onCreateNewCollection,
  fileId,
  fileIds
}: AddToCollectionModalProps) {
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>('');

  if (!isOpen) return null;

  // Determine which files we're working with
  const targetFileIds = fileIds || (fileId ? [fileId] : []);
  const isBulkOperation = targetFileIds.length > 1;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedCollectionId) {
      onAddToCollection(selectedCollectionId);
      setSelectedCollectionId('');
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-noche bg-opacity-70 flex items-center justify-center p-4 z-50">
      <div className="bg-tinta text-marfil rounded-3xl max-w-md w-full border border-borde-sutil">
        <div className="flex items-center justify-between p-6 border-b border-pizarra">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <FolderPlus className="w-5 h-5 text-lavanda" />
            {isBulkOperation ? `Añadir ${targetFileIds.length} archivos a Colección` : 'Añadir a Colección'}
          </h2>
          <button
            onClick={onClose}
            className="text-lavanda-archivo hover:text-marfil"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="p-6">
          {collections.length > 0 ? (
            <>
              <p className="text-sm text-lavanda-archivo mb-4">
                {isBulkOperation
                  ? `Selecciona la colección donde quieres añadir estos ${targetFileIds.length} archivos:`
                  : 'Selecciona la colección donde quieres añadir este archivo:'
                }
              </p>
              
              <div className="space-y-2 max-h-64 overflow-y-auto mb-6">
                {collections.map((collection) => {
                  // For bulk operations, check if ANY of the files are already in the collection
                  const isInCollection = isBulkOperation
                    ? targetFileIds.some(id => collection.mediaFiles.includes(id))
                    : collection.mediaFiles.includes(fileId || '');
                  const isSelected = selectedCollectionId === collection.id;
                  
                  return (
                    <label
                      key={collection.id}
                      className={`flex items-center p-3 rounded-lg border cursor-pointer transition-colors ${
                        isInCollection 
                          ? 'bg-pizarra border-pizarra cursor-not-allowed opacity-60' 
                          : isSelected 
                            ? 'bg-lavanda-claro border-lavanda' 
                            : 'border-pizarra hover:bg-grafito'
                      }`}
                    >
                      <input
                        type="radio"
                        name="collection"
                        value={collection.id}
                        checked={isSelected}
                        onChange={() => setSelectedCollectionId(collection.id)}
                        disabled={isInCollection}
                        className="mr-3"
                      />
                      <div className="flex-1">
                        <h4 className="font-medium text-marfil">{collection.name}</h4>
                        {collection.description && (
                          <p className="text-sm text-lavanda-archivo mt-1">{collection.description}</p>
                        )}
                        <p className="text-xs text-lavanda-archivo mt-1">
                          {collection.mediaFiles.length} archivo{collection.mediaFiles.length !== 1 ? 's' : ''}
                        </p>
                        {isInCollection && isBulkOperation && (
                          <p className="text-xs text-bruma mt-1">
                            Algunos archivos ya están en esta colección
                          </p>
                        )}
                      </div>
                      {isInCollection && (
                        <Check className="w-5 h-5 text-bruma ml-2" />
                      )}
                    </label>
                  );
                })}
              </div>
              
              <div className="flex gap-3 justify-between">
                {/* Create new collection button on the left */}
                {onCreateNewCollection && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onCreateNewCollection();
                    }}
                    className="btn-secondary flex items-center gap-2"
                  >
                    <FolderPlus className="w-4 h-4" />
                    Crear Nueva Colección
                  </button>
                )}

                {/* Main action buttons on the right */}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={onClose}
                    className="btn-secondary"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={!selectedCollectionId}
                    className="btn-primary"
                  >
                    {isBulkOperation ? `Añadir ${targetFileIds.length} archivos` : 'Añadir a Colección'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-8">
              <p className="text-lavanda-archivo mb-4">No hay colecciones disponibles</p>
              <p className="text-sm text-lavanda-archivo mb-6">Crea una colección primero para poder añadir archivos</p>

              {/* Action buttons when no collections exist */}
              <div className="flex gap-3 justify-center">
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-secondary"
                >
                  Cancelar
                </button>
                {onCreateNewCollection && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onCreateNewCollection();
                    }}
                    className="btn-primary flex items-center gap-2"
                  >
                    <FolderPlus className="w-4 h-4" />
                    Crear Nueva Colección
                  </button>
                )}
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}