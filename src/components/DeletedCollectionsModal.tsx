import React from 'react';
import { X, RotateCcw, Trash2, FolderOpen, Calendar } from 'lucide-react';
import { Collection } from '../types';
import { formatDate } from '../utils/dateUtils';

interface DeletedCollectionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  deletedCollections: (Collection & { deletedAt: Date })[];
  onRestore: (collectionId: string) => void;
}

export function DeletedCollectionsModal({
  isOpen,
  onClose,
  deletedCollections,
  onRestore
}: DeletedCollectionsModalProps) {
  if (!isOpen) return null;

  const calculateTimeLeft = (deletedAt: Date) => {
    const oneWeekFromDeletion = new Date(deletedAt);
    oneWeekFromDeletion.setDate(oneWeekFromDeletion.getDate() + 7);
    
    const now = new Date();
    const timeLeft = oneWeekFromDeletion.getTime() - now.getTime();
    const daysLeft = Math.ceil(timeLeft / (1000 * 60 * 60 * 24));
    
    if (daysLeft <= 0) return 'Expirado';
    if (daysLeft === 1) return '1 día restante';
    return `${daysLeft} días restantes`;
  };

  const handleRestore = (collectionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onRestore(collectionId);
  };

  return (
    <div className="fixed inset-0 bg-noche bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-tinta rounded-2xl max-w-4xl w-full max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-200">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Historial de Colecciones</h2>
            <p className="text-slate-600 text-sm mt-1">
              Colecciones eliminadas • Se eliminan permanentemente después de 7 días
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {deletedCollections.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 bg-lavanda-claro rounded-full flex items-center justify-center mx-auto mb-4">
                <FolderOpen className="w-8 h-8 text-slate-400" />
              </div>
              <h3 className="text-lg font-medium text-slate-900 mb-2">No hay colecciones en el historial</h3>
              <p className="text-slate-600">Las colecciones eliminadas aparecerán aquí</p>
            </div>
          ) : (
            <div className="space-y-4">
              {deletedCollections
                .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime()) // Most recently deleted first
                .map((collection) => {
                  const timeLeft = calculateTimeLeft(collection.deletedAt);
                  const isExpired = timeLeft === 'Expirado';
                  
                  return (
                    <div
                      key={collection.id}
                      className={`p-4 rounded-xl border transition-all duration-200 ${
                        isExpired 
                          ? 'bg-red-50 border-red-200' 
                          : 'bg-tinta border-slate-200 hover:shadow-md'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-3 mb-2">
                            <FolderOpen className={`w-5 h-5 ${isExpired ? 'text-red-400' : 'text-slate-400'}`} />
                            <h3 className={`font-semibold ${isExpired ? 'text-red-700' : 'text-slate-900'}`}>
                              {collection.name}
                            </h3>
                            <span className={`text-xs px-2 py-1 rounded-full ${
                              isExpired 
                                ? 'bg-red-200 text-red-700' 
                                : timeLeft.includes('1 día') || timeLeft.includes('2 día')
                                  ? 'bg-yellow-200 text-yellow-700'
                                  : 'bg-slate-200 text-slate-600'
                            }`}>
                              {timeLeft}
                            </span>
                          </div>
                          
                          {collection.description && (
                            <p className={`text-sm mb-3 ${isExpired ? 'text-red-600' : 'text-slate-600'}`}>
                              {collection.description}
                            </p>
                          )}
                          
                          <div className={`flex items-center space-x-4 text-xs ${isExpired ? 'text-red-500' : 'text-slate-500'}`}>
                            <span className="flex items-center">
                              <FolderOpen className="w-3 h-3 mr-1" />
                              {collection.mediaFiles.length} archivo{collection.mediaFiles.length !== 1 ? 's' : ''}
                            </span>
                            <span className="flex items-center">
                              <Calendar className="w-3 h-3 mr-1" />
                              Eliminado {formatDate(collection.deletedAt)}
                            </span>
                          </div>
                        </div>
                        
                        <div className="flex items-center space-x-2 ml-4">
                          {!isExpired && (
                            <button
                              onClick={(e) => handleRestore(collection.id, e)}
                              className="flex items-center space-x-1 px-3 py-2 bg-bruma text-white rounded-lg hover:bg-opacity-90 transition-colors text-sm"
                              title="Restaurar colección"
                            >
                              <RotateCcw className="w-4 h-4" />
                              <span>Restaurar</span>
                            </button>
                          )}
                          {isExpired && (
                            <div className="flex items-center space-x-1 px-3 py-2 bg-red-100 text-red-600 rounded-lg text-sm">
                              <Trash2 className="w-4 h-4" />
                              <span>Expirado</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 bg-slate-50 border-t border-slate-200">
          <div className="flex items-center justify-between text-sm text-slate-600">
            <div>
              <p className="font-medium">Política de eliminación:</p>
              <p>Las colecciones se eliminan automáticamente después de 7 días.</p>
            </div>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors"
            >
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}