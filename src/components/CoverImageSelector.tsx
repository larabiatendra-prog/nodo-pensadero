import React, { useState, useRef } from 'react';
import { Upload, Image, X, Check, FolderOpen } from 'lucide-react';
import { MediaFile } from '../types';
import { normalizePath } from '../utils/formatData';

interface CoverImageSelectorProps {
  selectedCover?: { type: 'system' | 'custom'; value: string };
  onCoverSelect: (cover: { type: 'system' | 'custom'; value: string }) => void;
  systemImages: MediaFile[]; // Available media files that can be used as covers
  collectionFiles?: MediaFile[]; // Files in the current collection (optional)
  isOpen: boolean;
  onClose: () => void;
}

export function CoverImageSelector({
  selectedCover,
  onCoverSelect,
  systemImages,
  collectionFiles,
  isOpen,
  onClose
}: CoverImageSelectorProps) {
  const [activeTab, setActiveTab] = useState<'collection' | 'system' | 'custom'>(
    collectionFiles && collectionFiles.length > 0 ? 'collection' : 'system'
  );
  const [customImageUrl, setCustomImageUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleSystemImageSelect = (mediaFile: MediaFile) => {
    onCoverSelect({ type: 'system', value: normalizePath(mediaFile.fullPath!) });
  };

  const handleCustomImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // In a real implementation, you would upload the file to your server
      // For now, we'll create a temporary URL
      const imageUrl = URL.createObjectURL(file);
      onCoverSelect({ type: 'custom', value: imageUrl });
    }
  };

  const handleCustomUrlSubmit = () => {
    if (customImageUrl.trim()) {
      onCoverSelect({ type: 'custom', value: customImageUrl.trim() });
      setCustomImageUrl('');
    }
  };

  return (
    <div className="fixed inset-0 bg-noche/50 flex items-center justify-center z-50 p-4">
      <div className="bg-tinta rounded-xl max-w-4xl w-full max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <h2 className="text-xl font-semibold text-slate-900">Seleccionar Portada</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b">
          {collectionFiles && collectionFiles.length > 0 && (
            <button
              onClick={() => setActiveTab('collection')}
              className={`flex-1 px-6 py-3 font-medium transition-colors ${
                activeTab === 'collection'
                  ? 'text-lavanda border-b-2 border-lavanda'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FolderOpen className="w-4 h-4 inline mr-2" />
              De esta Colección
            </button>
          )}
          <button
            onClick={() => setActiveTab('system')}
            className={`flex-1 px-6 py-3 font-medium transition-colors ${
              activeTab === 'system'
                ? 'text-lavanda border-b-2 border-lavanda'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Image className="w-4 h-4 inline mr-2" />
            Imágenes del Sistema
          </button>
          {/* <button
            onClick={() => setActiveTab('custom')}
            className={`flex-1 px-6 py-3 font-medium transition-colors ${
              activeTab === 'custom'
                ? 'text-lavanda border-b-2 border-lavanda'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Upload className="w-4 h-4 inline mr-2" />
            Imagen Personalizada
          </button> */}
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-96">
          {activeTab === 'collection' ? (
            <div>
              <p className="text-slate-600 mb-4">
                Selecciona una imagen de esta colección para usar como portada:
              </p>
              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {collectionFiles
                  ?.filter(file => file.type === 'image' || file.type === 'video')
                  .map((file) => (
                    <div
                      key={file.id}
                      onClick={() => handleSystemImageSelect(file)}
                      className={`relative aspect-square rounded-lg overflow-hidden cursor-pointer border-2 transition-all hover:scale-105 ${
                        selectedCover?.type === 'system' && selectedCover.value === file.id
                          ? 'border-lavanda ring-2 ring-lavanda/20'
                          : 'border-slate-200 hover:border-lavanda/50'
                      }`}
                    >
                      <img
                        src={file.thumbnail}
                        alt={file.name}
                        className="w-full h-full object-cover"
                      />
                      {selectedCover?.type === 'system' && selectedCover.value === file.id && (
                        <div className="absolute inset-0 bg-lavanda/20 flex items-center justify-center">
                          <Check className="w-6 h-6 text-lavanda bg-tinta rounded-full p-1" />
                        </div>
                      )}
                    </div>
                  ))}
              </div>
              {(!collectionFiles || collectionFiles.length === 0) && (
                <div className="text-center py-8 text-slate-500">
                  <FolderOpen className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No hay archivos en esta colección</p>
                </div>
              )}
            </div>
          ) : activeTab === 'system' ? (
            <div>
              <p className="text-slate-600 mb-4">
                Selecciona una imagen de tu biblioteca para usar como portada:
              </p>
              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {systemImages
                  .filter(file => file.type === 'image' || file.type === 'video')
                  .slice(0, 24) // Limit to first 24 images for performance
                  .map((file) => (
                    <div
                      key={file.id}
                      onClick={() => handleSystemImageSelect(file)}
                      className={`relative aspect-square rounded-lg overflow-hidden cursor-pointer border-2 transition-all hover:scale-105 ${
                        selectedCover?.type === 'system' && selectedCover.value === file.id
                          ? 'border-lavanda ring-2 ring-lavanda/20'
                          : 'border-slate-200 hover:border-lavanda/50'
                      }`}
                    >
                      <img
                        src={file.thumbnail}
                        alt={file.name}
                        className="w-full h-full object-cover"
                      />
                      {selectedCover?.type === 'system' && selectedCover.value === file.id && (
                        <div className="absolute inset-0 bg-lavanda/20 flex items-center justify-center">
                          <Check className="w-6 h-6 text-lavanda bg-tinta rounded-full p-1" />
                        </div>
                      )}
                    </div>
                  ))}
              </div>
              {systemImages.length === 0 && (
                <div className="text-center py-8 text-slate-500">
                  <Image className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No hay imágenes disponibles en el sistema</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              {/* Upload from computer */}
              <div>
                <h3 className="font-medium text-slate-900 mb-3">Subir desde tu computadora</h3>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleCustomImageUpload}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full p-6 border-2 border-dashed border-slate-300 rounded-lg hover:border-lavanda/50 hover:bg-lavanda/5 transition-colors"
                >
                  <Upload className="w-8 h-8 mx-auto mb-2 text-slate-400" />
                  <p className="text-slate-600">Haz clic para seleccionar una imagen</p>
                  <p className="text-sm text-slate-500 mt-1">PNG, JPG hasta 10MB</p>
                </button>
              </div>

              {/* URL input */}
              <div>
                <h3 className="font-medium text-slate-900 mb-3">O usar una URL de imagen</h3>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={customImageUrl}
                    onChange={(e) => setCustomImageUrl(e.target.value)}
                    placeholder="https://ejemplo.com/imagen.jpg"
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-lavanda"
                  />
                  <button
                    onClick={handleCustomUrlSubmit}
                    disabled={!customImageUrl.trim()}
                    className="px-4 py-2 bg-lavanda text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Usar
                  </button>
                </div>
              </div>

              {/* Preview of custom image */}
              {selectedCover?.type === 'custom' && (
                <div>
                  <h3 className="font-medium text-slate-900 mb-3">Vista previa</h3>
                  <div className="w-32 h-32 rounded-lg overflow-hidden border border-slate-200">
                    <img
                      src={selectedCover.value}
                      alt="Preview"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="%23ef4444"/><text x="64" y="64" font-family="Arial" font-size="12" fill="white" text-anchor="middle">Error</text></svg>';
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t bg-slate-50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-slate-600 hover:text-slate-900 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onClose}
            disabled={!selectedCover}
            className="px-4 py-2 bg-lavanda text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Seleccionar
          </button>
        </div>
      </div>
    </div>
  );
}