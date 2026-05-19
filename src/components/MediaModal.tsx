import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Download,
  Heart,
  FileText,
  Tag,
  Share2,
  Play,
  Volume2,
  FolderPlus,
  ChevronLeft,
  ChevronRight,
  Scissors,
  Loader2,
  Eye,
  EyeOff
} from 'lucide-react';
import { MediaFile, FaceBox } from '../types';
import { api } from '../services/api';

interface MediaModalProps {
  file: MediaFile | null;
  isOpen: boolean;
  onClose: () => void;
  onToggleFavorite: (fileId: string) => void;
  onDownload: (file: MediaFile) => void;
  onAddToCollection?: (fileId: string) => void;
  allFiles?: MediaFile[]; // Array de todos los archivos para encontrar relacionados
  onFileSelect?: (file: MediaFile) => void; // Callback para seleccionar archivo relacionado
  onTagClick?: (tag: string) => void; // Callback para filtrar por etiqueta
  onBackgroundRemoved?: (newFileId: string, newFileName: string) => void; // Callback cuando se quita el fondo
}

export default function MediaModal({
  file,
  isOpen,
  onClose,
  onToggleFavorite,
  onDownload,
  onAddToCollection,
  allFiles = [],
  onFileSelect,
  onTagClick,
  onBackgroundRemoved
}: MediaModalProps) {
  const [relatedFilesStartIndex, setRelatedFilesStartIndex] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isRemovingBackground, setIsRemovingBackground] = useState(false);
  const [backgroundRemovalError, setBackgroundRemovalError] = useState<string | null>(null);

  // Toggle de overlay de bboxes de caras — preferencia persistida en localStorage
  const [showFaceBoxes, setShowFaceBoxes] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const v = localStorage.getItem('pensadero_show_face_boxes');
    return v === null ? true : v === '1';
  });
  useEffect(() => {
    try { localStorage.setItem('pensadero_show_face_boxes', showFaceBoxes ? '1' : '0'); } catch {}
  }, [showFaceBoxes]);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  // Resetear dimensiones cuando cambia el archivo
  useEffect(() => { setImgNatural(null); }, [file?.id]);


  // Calcular índice actual del archivo en allFiles - ANTES de los useEffect
  const currentIndex = file ? allFiles.findIndex(f => f.id === file.id) : -1;
  const hasMultipleFiles = allFiles.length > 1;

  // Funciones de navegación con loop circular - ANTES de los useEffect
  const goToPreviousFile = () => {
    if (!hasMultipleFiles || currentIndex === -1 || !onFileSelect) return;

    // Loop circular: si estás en el primero, ir al último
    const previousIndex = currentIndex === 0
      ? allFiles.length - 1
      : currentIndex - 1;

    onFileSelect(allFiles[previousIndex]);
  };

  const goToNextFile = () => {
    if (!hasMultipleFiles || currentIndex === -1 || !onFileSelect) return;

    // Loop circular: si estás en el último, ir al primero
    const nextIndex = currentIndex === allFiles.length - 1
      ? 0
      : currentIndex + 1;

    onFileSelect(allFiles[nextIndex]);
  };

  // Manejar tecla Esc para cerrar modal o fullscreen y flechas para navegación
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isFullscreen) {
          setIsFullscreen(false);
        } else if (isOpen) {
          onClose();
        }
      }

      // Navegación con flechas
      if (event.key === 'ArrowLeft') {
        event.preventDefault(); // Evitar scroll horizontal
        goToPreviousFile();
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToNextFile();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose, isFullscreen, currentIndex, allFiles, onFileSelect]);

  // Solo cerrar fullscreen si el nuevo archivo NO es imagen
  useEffect(() => {
    if (file?.type !== 'image') {
      setIsFullscreen(false);
    }
  }, [file?.id, file?.type]);


  if (!isOpen || !file) return null;

  const formatFileSize = (bytes: number) => {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Función para calcular similaridad de etiquetas usando el coeficiente de Jaccard
  const calculateTagSimilarity = (tags1: string[], tags2: string[]): number => {
    const set1 = new Set(tags1.map(tag => tag.toLowerCase()));
    const set2 = new Set(tags2.map(tag => tag.toLowerCase()));
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size; // Coeficiente de Jaccard
  };

  // Encontrar archivos relacionados basados en similitud de etiquetas
  const getRelatedFiles = (): MediaFile[] => {
    if (!file || allFiles.length === 0) return [];

    // Filtrar archivos que no sean el actual y calcular similitud
    const candidates = allFiles
      .filter(f => f.id !== file.id)
      .map(f => ({
        file: f,
        similarity: calculateTagSimilarity(file.tags, f.tags)
      }))
      .sort((a, b) => b.similarity - a.similarity) // Ordenar por similitud descendente (mayor a menor)
      .slice(0, 30) // Tomar hasta 30 archivos para mostrar
      .map(candidate => candidate.file);

    return candidates;
  };

  const relatedFiles = getRelatedFiles();
  const visibleRelatedFiles = relatedFiles.slice(relatedFilesStartIndex, relatedFilesStartIndex + 8);

  const canScrollLeft = relatedFilesStartIndex > 0;
  const canScrollRight = relatedFilesStartIndex + 8 < relatedFiles.length;

  const scrollRelatedLeft = () => {
    if (canScrollLeft) {
      setRelatedFilesStartIndex(Math.max(0, relatedFilesStartIndex - 4));
    }
  };

  const scrollRelatedRight = () => {
    if (canScrollRight) {
      setRelatedFilesStartIndex(Math.min(relatedFiles.length - 8, relatedFilesStartIndex + 4));
    }
  };

  const handleRelatedFileClick = (relatedFile: MediaFile) => {
    if (onFileSelect) {
      setRelatedFilesStartIndex(0); // Reset scroll position
      onFileSelect(relatedFile);
    }
  };

  const handleTagClick = (tag: string) => {
    if (onTagClick) {
      onTagClick(tag);
      onClose(); // Cerrar modal al hacer click en una etiqueta
    }
  };

  // Función para quitar fondo de imagen
  const handleRemoveBackground = async () => {
    if (!file || file.type !== 'image') return;

    setIsRemovingBackground(true);
    setBackgroundRemovalError(null);

    try {
      const response = await api.removeBackground(file.id);

      if (response.success && response.data) {
        // Notificar al componente padre que se creó un nuevo archivo
        if (onBackgroundRemoved) {
          onBackgroundRemoved(response.data.newFile.id, response.data.newFile.name);
        }

        // Mostrar mensaje de éxito (el toast lo manejará el padre)
        console.log('✅ Fondo eliminado:', response.data.newFile.name);

        // Descargar automáticamente el archivo sin fondo
        const blob = await api.downloadFile(response.data.newFile.id);
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = response.data.newFile.name;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
        console.log('📥 Descarga iniciada:', response.data.newFile.name);
      } else {
        throw new Error(response.message || 'Error desconocido');
      }
    } catch (error: any) {
      console.error('❌ Error eliminando fondo:', error);
      setBackgroundRemovalError(error.message || 'Error al procesar la imagen');
    } finally {
      setIsRemovingBackground(false);
    }
  };

  const renderMediaPreview = () => {
    switch (file.type) {
      case 'video':
      case 'export':
        return (
          <div className="relative bg-noche rounded-lg overflow-hidden">
            <video
              key={file.id}
              controls
              className="w-full h-full object-contain max-h-96"
              poster={file.thumbnail.startsWith('data:') ? undefined : file.thumbnail}
              preload="metadata"
            >
              <source src={file.url} type="video/mp4" />
              Tu navegador no soporta la reproducción de video.
            </video>
          </div>
        );
      case 'audio':
        return (
          <div className="bg-gradient-to-br from-green-400 to-green-600 rounded-lg p-8 flex flex-col items-center justify-center text-white">
            <Volume2 className="w-20 h-20 mb-4 opacity-80" />
            <h3 className="text-xl font-semibold mb-4">{file.name}</h3>
            <audio
              key={file.id}
              controls
              className="w-full max-w-80 md:max-w-md"
              preload="metadata"
            >
              <source src={file.url} type="audio/mpeg" />
              Tu navegador no soporta la reproducción de audio.
            </audio>
            {file.duration && (
              <p className="text-green-100 mt-2">Duración: {formatDuration(file.duration)}</p>
            )}
          </div>
        );
      case 'image':
      default: {
        const boxes = file.face_boxes || [];
        return (
          <div className="rounded-lg overflow-hidden relative group">
            <div
              className="relative inline-block max-w-full cursor-pointer"
              onClick={() => setIsFullscreen(true)}
            >
              <img
                ref={imgRef}
                key={file.id}
                src={file.url}
                alt={file.name}
                className="block max-h-96 w-auto max-w-full object-contain"
                onLoad={(e) => {
                  const t = e.currentTarget;
                  if (t.naturalWidth && t.naturalHeight) {
                    setImgNatural({ w: t.naturalWidth, h: t.naturalHeight });
                  }
                }}
                onError={(e) => {
                  console.error('Error cargando imagen:', file.url);
                  e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="%23f3f4f6"/><text x="150" y="100" font-family="Arial" font-size="16" fill="%236b7280" text-anchor="middle">❌ Error cargando imagen</text></svg>';
                }}
              />
              {showFaceBoxes && imgNatural && boxes.length > 0 && (
                <FaceBoxesOverlay boxes={boxes} naturalWidth={imgNatural.w} naturalHeight={imgNatural.h} />
              )}
              {/* Hint hover de fullscreen — se oculta cuando hay bboxes visibles
                  para no tapar las caras. */}
              {!(showFaceBoxes && boxes.length > 0) && (
                <div className="absolute inset-0 bg-noche bg-opacity-50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
                  <span className="text-white text-sm font-medium px-4 py-2 bg-noche bg-opacity-50 rounded-lg">
                    Pincha para pantalla completa
                  </span>
                </div>
              )}
            </div>
            {/* Toggle de bboxes — solo visible si la imagen tiene caras detectadas */}
            {boxes.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowFaceBoxes(v => !v); }}
                className="absolute top-2 right-2 z-10 p-2 bg-noche/70 hover:bg-noche/90 backdrop-blur-sm rounded-full text-marfil transition-colors"
                title={showFaceBoxes ? 'Ocultar caras' : 'Mostrar caras detectadas'}
              >
                {showFaceBoxes ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </button>
            )}
          </div>
        );
      }
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-noche bg-opacity-50 flex items-center justify-center p-4 z-50">
        <div className="bg-tinta rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-auto relative">

        {/* Navigation Arrows - Solo si hay múltiples archivos */}
        {hasMultipleFiles && (
          <>
            {/* Left Arrow */}
            <button
              onClick={goToPreviousFile}
              className="absolute left-1 md:left-2 top-1/2 -translate-y-1/2 z-10 p-2 md:p-3 bg-noche bg-opacity-50 hover:bg-opacity-70 text-white rounded-full transition-all hover:scale-110"
              title="Anterior (←)"
            >
              <ChevronLeft className="w-5 h-5 md:w-6 md:h-6" />
            </button>

            {/* Right Arrow */}
            <button
              onClick={goToNextFile}
              className="absolute right-1 md:right-2 top-1/2 -translate-y-1/2 z-10 p-2 md:p-3 bg-noche bg-opacity-50 hover:bg-opacity-70 text-white rounded-full transition-all hover:scale-110"
              title="Siguiente (→)"
            >
              <ChevronRight className="w-5 h-5 md:w-6 md:h-6" />
            </button>
          </>
        )}

        {/* Header */}
        <div className="flex items-center justify-between p-4 md:p-6 border-b border-slate-200">
          <div className="flex items-center space-x-4 min-w-0">
            <div className={`w-3 h-3 rounded-full flex-shrink-0 ${
              file.type === 'video' ? 'bg-purple-500' :
              file.type === 'audio' ? 'bg-green-500' :
              file.type === 'export' ? 'bg-orange-500' :
              'bg-blue-500'
            }`}></div>
            <h2 className="text-base md:text-xl font-semibold text-slate-900 truncate max-w-[40vw] md:max-w-none">{file.name}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-4 md:p-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Media preview */}
            <div className="md:col-span-2">
              {renderMediaPreview()}
            </div>

            {/* File details */}
            <div className="space-y-4">
              {/* Actions — burbujas solo icono */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onToggleFavorite(file.id)}
                  title={file.isFavorite ? 'Quitar favorito' : 'Añadir a favoritos'}
                  aria-label={file.isFavorite ? 'Quitar favorito' : 'Añadir a favoritos'}
                  className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                    file.isFavorite
                      ? 'bg-lavanda bg-opacity-10 text-lavanda hover:bg-opacity-20'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <Heart className={`w-4 h-4 ${file.isFavorite ? 'fill-current' : ''}`} />
                </button>
                <button
                  onClick={() => onDownload(file)}
                  title="Descargar"
                  aria-label="Descargar"
                  className="w-10 h-10 rounded-full flex items-center justify-center bg-bruma text-white hover:bg-opacity-90 transition-colors"
                >
                  <Download className="w-4 h-4" />
                </button>
                {file.type === 'image' && (
                  <button
                    onClick={handleRemoveBackground}
                    disabled={isRemovingBackground}
                    title={isRemovingBackground ? 'Procesando…' : 'Quitar fondo (beta) — genera una copia PNG transparente'}
                    aria-label="Quitar fondo (beta)"
                    className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors border ${
                      isRemovingBackground
                        ? 'bg-purple-100 text-purple-400 border-purple-200 cursor-wait'
                        : 'bg-purple-50 text-purple-700 hover:bg-purple-100 border-purple-200'
                    }`}
                  >
                    {isRemovingBackground ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Scissors className="w-4 h-4" />
                    )}
                  </button>
                )}
              </div>
              {file.type === 'image' && backgroundRemovalError && (
                <p className="text-xs text-red-500">{backgroundRemovalError}</p>
              )}

              {/* File info */}
              <div className="space-y-4">
                <div>
                  <div className="space-y-3">
                    <div className="flex items-center space-x-3">
                      <FileText className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-sm text-slate-500">Tamaño</p>
                        <p className="text-sm font-medium text-slate-900">{formatFileSize(file.size)}</p>
                      </div>
                    </div>
                    {file.dimensions && (
                      <div className="flex items-center space-x-3">
                        <Share2 className="w-4 h-4 text-slate-400" />
                        <div>
                          <p className="text-sm text-slate-500">Dimensiones</p>
                          <p className="text-sm font-medium text-slate-900">
                            {file.dimensions.width} x {file.dimensions.height}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Description */}
                {file.description && (
                  <div>
                    <h3 className="font-medium text-slate-900 mb-2">Descripción</h3>
                    <p className="text-sm text-slate-600 leading-relaxed">{file.description}</p>
                  </div>
                )}

                {/* Tags */}
                <div>
                  <div className="flex items-center space-x-2 mb-3">
                    <Tag className="w-4 h-4 text-slate-400" />
                    <h3 className="font-medium text-slate-900">Etiquetas</h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {file.tags.map((tag) => (
                      <button
                        key={tag}
                        onClick={() => handleTagClick(tag)}
                        className="inline-flex items-center px-3 py-1 rounded-full text-xs bg-lavanda-claro text-marfil font-medium hover:bg-opacity-80 border border-transparent transition-all duration-200 cursor-pointer group"
                        title={`Filtrar por etiqueta: ${tag}`}
                      >
                        <span className="group-hover:scale-105 transition-transform duration-200">
                          {tag}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

              </div>
            </div>
          </div>

          {/* Related Files Section */}
          {relatedFiles.length > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-200">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium text-slate-900">Archivos relacionados</h3>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={scrollRelatedLeft}
                    disabled={!canScrollLeft}
                    className={`p-1 rounded transition-colors ${
                      canScrollLeft
                        ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                        : 'text-slate-300 cursor-not-allowed'
                    }`}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-xs text-slate-500">
                    {Math.min(relatedFilesStartIndex + visibleRelatedFiles.length, relatedFiles.length)} de {relatedFiles.length}
                  </span>
                  <button
                    onClick={scrollRelatedRight}
                    disabled={!canScrollRight}
                    className={`p-1 rounded transition-colors ${
                      canScrollRight
                        ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                        : 'text-slate-300 cursor-not-allowed'
                    }`}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
              
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {visibleRelatedFiles.map((relatedFile) => (
                  <button
                    key={relatedFile.id}
                    onClick={() => handleRelatedFileClick(relatedFile)}
                    title={relatedFile.name}
                    className="group text-left bg-tinta hover:bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-lg p-1.5 transition-all duration-200 hover:shadow-md overflow-hidden"
                  >
                    <div className="aspect-[4/3] rounded overflow-hidden relative" style={{ backgroundColor: relatedFile.type === 'audio' ? '#f2efe4' : '#f1f5f9' }}>
                      {relatedFile.type === 'audio' ? (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="text-3xl text-lavanda">&#9835;</span>
                        </div>
                      ) : relatedFile.thumbnail.startsWith('data:image/svg') ? (
                        <div
                          className="w-full h-full flex items-center justify-center"
                          dangerouslySetInnerHTML={{
                            __html: decodeURIComponent(relatedFile.thumbnail.split(',')[1])
                          }}
                        />
                      ) : (
                        <img
                          src={relatedFile.thumbnail}
                          alt={relatedFile.name}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90"><rect width="120" height="90" fill="%23f3f4f6"/><text x="60" y="45" font-family="Arial" font-size="10" fill="%236b7280" text-anchor="middle">Sin imagen</text></svg>';
                          }}
                        />
                      )}

                      {/* File type badge */}
                      <div className="absolute bottom-1 right-1">
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                          relatedFile.type === 'export' ? 'bg-bruma text-white' : 'bg-pizarra text-marfil'
                        }`}>
                          {relatedFile.type === 'video' ? 'VID' :
                           relatedFile.type === 'export' ? 'EXP' :
                           relatedFile.type === 'audio' ? 'AUD' : 'IMG'}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              
              {relatedFiles.length > 8 && (
                <div className="text-center mt-2">
                  <p className="text-xs text-slate-500">
                    Usa las flechas para ver más archivos relacionados
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>

    {/* Fullscreen Overlay */}
    {isFullscreen && file.type === 'image' && (
      <div
        className="fixed inset-0 z-[9999] bg-noche bg-opacity-95 flex items-center justify-center cursor-pointer animate-fade-in"
        onClick={() => setIsFullscreen(false)}
      >
        <img
          src={file.url}
          alt={file.name}
          className="max-w-[95vw] max-h-[95vh] object-contain"
          onClick={(e) => e.stopPropagation()}
        />

        {/* Navigation Arrows in Fullscreen */}
        {hasMultipleFiles && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                goToPreviousFile();
              }}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-4 bg-noche bg-opacity-50 hover:bg-opacity-70 text-white rounded-full transition-all hover:scale-110"
              title="Anterior (←)"
            >
              <ChevronLeft className="w-8 h-8" />
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                goToNextFile();
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-4 bg-noche bg-opacity-50 hover:bg-opacity-70 text-white rounded-full transition-all hover:scale-110"
              title="Siguiente (→)"
            >
              <ChevronRight className="w-8 h-8" />
            </button>
          </>
        )}

        {/* Close hint */}
        <div className="absolute top-4 right-4 text-white text-sm bg-noche bg-opacity-50 px-3 py-2 rounded-lg">
          ESC para salir
        </div>
      </div>
    )}
    </>
  );
}

/**
 * Overlay de bboxes de caras sobre una imagen. Se posiciona como hijo de un
 * wrapper inline-block que envuelve la <img>, asi los porcentajes son
 * relativos al tamaño renderizado de la imagen sin bandas vacias.
 */
function FaceBoxesOverlay({ boxes, naturalWidth, naturalHeight }: { boxes: FaceBox[]; naturalWidth: number; naturalHeight: number }) {
  if (!naturalWidth || !naturalHeight) return null;
  return (
    <div className="absolute inset-0 pointer-events-none">
      {boxes.map((b, i) => {
        const [x1, y1, x2, y2] = b.bbox;
        const left = (x1 / naturalWidth) * 100;
        const top = (y1 / naturalHeight) * 100;
        const width = ((x2 - x1) / naturalWidth) * 100;
        const height = ((y2 - y1) / naturalHeight) * 100;
        const isKnown = !!b.person_id;
        // Si la cara esta cerca del borde superior (<15%), colocar label DEBAJO
        const labelBelow = top < 15;
        const label = b.display_name || 'desconocido';
        return (
          <div
            key={i}
            className="absolute pointer-events-auto group/face"
            style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
          >
            <div
              className={`absolute inset-0 rounded-md border-2 transition-colors ${
                isKnown
                  ? 'border-lavanda shadow-[0_0_0_1px_rgba(15,17,26,0.6)]'
                  : 'border-bruma/70 border-dashed'
              }`}
            />
            <div
              className={`absolute whitespace-nowrap text-xs px-1.5 py-0.5 rounded-md backdrop-blur-sm transition-opacity ${
                isKnown
                  ? 'bg-lavanda/90 text-white'
                  : 'bg-noche/70 text-lavanda-archivo'
              } ${labelBelow ? 'top-full mt-1' : 'bottom-full mb-1'} left-0`}
              style={{ fontSize: '11px' }}
            >
              {label}
            </div>
          </div>
        );
      })}
    </div>
  );
}