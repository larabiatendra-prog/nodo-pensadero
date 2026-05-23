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
  EyeOff,
  UserPlus,
  Search,
  Pencil
} from 'lucide-react';
import { MediaFile, FaceBox } from '../types';
import { api } from '../services/api';
import { config } from '../config';
import { slugifyPersonId } from '../utils/persons';

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
  onPersonFilter?: (personId: string) => void; // Click en un bbox identificado para filtrar por persona
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
  onBackgroundRemoved,
  onPersonFilter
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  // Para video: dimensiones naturales del video y currentTime para mostrar
  // bboxes solo cuando estamos cerca del frame donde se detectaron caras
  const [videoNatural, setVideoNatural] = useState<{ w: number; h: number } | null>(null);
  const [videoCurrentTime, setVideoCurrentTime] = useState<number>(0);
  // Resetear dimensiones cuando cambia el archivo
  useEffect(() => {
    setImgNatural(null);
    setVideoNatural(null);
    setVideoCurrentTime(0);
  }, [file?.id]);
  // Tolerancia (segundos) alrededor de detection_frame_time donde se muestran
  // los bboxes en video. Si te pasas, los bboxes desaparecen.
  const VIDEO_BBOX_TOLERANCE_S = 1.5;

  // Hover compartido: cuando se pasa el raton sobre un bbox dentro de la
  // imagen O sobre una bubble de persona en el sidebar, los demas se ocultan.
  // La key identifica a la "entidad": para personas conocidas es p:<person_id>
  // (agrupa todos los bboxes del mismo person_id); para desconocidas es
  // i:<idx> (solo ese bbox individual).
  const [hoveredFaceKey, setHoveredFaceKey] = useState<string | null>(null);
  // Resetear hover al cambiar de archivo
  useEffect(() => { setHoveredFaceKey(null); }, [file?.id]);

  // Overlay de descripcion encima de la imagen/video. Se abre con el boton
  // del lapiz; se cierra clicando fuera o con la X.
  const [showDescription, setShowDescription] = useState(false);
  useEffect(() => { setShowDescription(false); }, [file?.id]);

  // Flujo "crear persona desde cara desconocida": click en bbox sin person_id
  // dispara una busqueda de caras similares en toda la biblioteca, luego abre
  // un modal donde el usuario nombra y crea la persona.
  interface SeedCluster {
    cluster_id: string;
    face_count: number;
    avg_score: number;
    dominant_age: string | null;
    dominant_gender: string | null;
    sample_count: number;
    samples_meta?: Array<{ folder: string; basename: string; det_score: number }>;
  }
  const [seedingLoading, setSeedingLoading] = useState(false);
  const [seedingError, setSeedingError] = useState<string | null>(null);
  const [seedingCluster, setSeedingCluster] = useState<SeedCluster | null>(null);
  const [seedingDisplayName, setSeedingDisplayName] = useState('');
  const [seedingSubmitting, setSeedingSubmitting] = useState(false);

  // Resetear estado del seed al cerrar / cambiar archivo
  useEffect(() => {
    setSeedingCluster(null);
    setSeedingError(null);
    setSeedingDisplayName('');
  }, [file?.id]);

  async function handleSeedFromUnknownFace(faceIndex: number) {
    if (!file || !file.fullPath) {
      setSeedingError('No se puede determinar la ruta del archivo');
      return;
    }
    const fp = file.fullPath;
    const idx = Math.max(fp.lastIndexOf('\\'), fp.lastIndexOf('/'));
    if (idx < 0) {
      setSeedingError('Ruta del archivo no valida');
      return;
    }
    const folder = fp.slice(0, idx);
    const basename = fp.slice(idx + 1);

    setSeedingLoading(true);
    setSeedingError(null);
    setSeedingCluster(null);
    setSeedingDisplayName('');
    try {
      const r: any = await api.seedFaceCluster({ folder, basename, face_index: faceIndex });
      if (!r.success || !r.data) {
        setSeedingError(r.error || 'No se encontraron caras similares');
        return;
      }
      setSeedingCluster(r.data);
    } catch (err: any) {
      setSeedingError(err.message || 'Error buscando similares');
    } finally {
      setSeedingLoading(false);
    }
  }

  async function handleSeedPromote() {
    if (!seedingCluster) return;
    const display = seedingDisplayName.trim();
    if (!display) {
      setSeedingError('Escribe un nombre');
      return;
    }
    const id = slugifyPersonId(display);
    if (!id) {
      setSeedingError('El nombre debe tener al menos una letra o numero');
      return;
    }
    setSeedingSubmitting(true);
    setSeedingError(null);
    try {
      const r: any = await api.promoteFaceCluster(seedingCluster.cluster_id, {
        person_id: id,
        display_name: display,
      });
      if (!r.success) throw new Error(r.error || 'Error creando persona');
      // Exito — cerrar modal y limpiar
      setSeedingCluster(null);
      setSeedingDisplayName('');
    } catch (err: any) {
      setSeedingError(err.message || 'Error creando persona');
    } finally {
      setSeedingSubmitting(false);
    }
  }


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

  const hasDescription = fileHasVisualAnalysis(file);

  const renderMediaPreview = () => {
    switch (file.type) {
      case 'video':
      case 'export': {
        const boxes = file.face_boxes || [];
        const detTime = typeof file.detection_frame_time === 'number' ? file.detection_frame_time : null;
        const inWindow = detTime != null && Math.abs(videoCurrentTime - detTime) < VIDEO_BBOX_TOLERANCE_S;
        const showOverlay = showFaceBoxes && videoNatural && boxes.length > 0 && detTime != null && inWindow;
        return (
          <div className="relative bg-noche rounded-lg overflow-hidden">
            <div className="relative inline-block max-w-full">
              <video
                ref={videoRef}
                key={file.id}
                controls
                className="block max-h-96 w-auto max-w-full object-contain"
                poster={file.thumbnail.startsWith('data:') ? undefined : file.thumbnail}
                preload="metadata"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  if (v.videoWidth && v.videoHeight) {
                    setVideoNatural({ w: v.videoWidth, h: v.videoHeight });
                  }
                }}
                onTimeUpdate={(e) => setVideoCurrentTime(e.currentTarget.currentTime)}
                onSeeked={(e) => setVideoCurrentTime(e.currentTarget.currentTime)}
              >
                <source src={file.url} type="video/mp4" />
                Tu navegador no soporta la reproducción de video.
              </video>
              {showOverlay && (
                <FaceBoxesOverlay
                  boxes={boxes}
                  naturalWidth={videoNatural!.w}
                  naturalHeight={videoNatural!.h}
                  onPersonFilter={onPersonFilter}
                  onSeedUnknown={handleSeedFromUnknownFace}
                  onClosePreview={onClose}
                  hoveredFaceKey={hoveredFaceKey}
                  setHoveredFaceKey={setHoveredFaceKey}
                />
              )}
              {showDescription && (
                <DescriptionOverlay file={file} onClose={() => setShowDescription(false)} />
              )}
            </div>
            {boxes.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowFaceBoxes(v => !v); }}
                className="absolute top-2 right-2 z-10 p-2 bg-noche/70 hover:bg-noche/90 backdrop-blur-sm rounded-full text-marfil transition-colors"
                title={showFaceBoxes ? `Caras detectadas a los ${detTime?.toFixed(1)}s — salta ahi para verlas` : 'Mostrar caras detectadas'}
              >
                {showFaceBoxes ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </button>
            )}
            {hasDescription && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowDescription(v => !v); }}
                className={`absolute top-2 ${boxes.length > 0 ? 'right-14' : 'right-2'} z-10 p-2 bg-noche/70 hover:bg-noche/90 backdrop-blur-sm rounded-full text-marfil transition-colors`}
                title={showDescription ? 'Ocultar descripcion' : 'Ver descripcion'}
                aria-label={showDescription ? 'Ocultar descripcion' : 'Ver descripcion'}
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}
            {/* Indicador sutil sobre cuando aparecen los bboxes */}
            {showFaceBoxes && boxes.length > 0 && detTime != null && !inWindow && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (videoRef.current) {
                    videoRef.current.currentTime = detTime;
                  }
                }}
                className="absolute bottom-12 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-lavanda/90 hover:bg-lavanda text-white text-xs rounded-full backdrop-blur-sm transition-colors"
                title={`Saltar al frame con caras detectadas (${detTime.toFixed(1)}s)`}
              >
                Caras a {detTime.toFixed(1)}s — ir
              </button>
            )}
          </div>
        );
      }
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
                <FaceBoxesOverlay
                  boxes={boxes}
                  naturalWidth={imgNatural.w}
                  naturalHeight={imgNatural.h}
                  onPersonFilter={onPersonFilter}
                  onSeedUnknown={handleSeedFromUnknownFace}
                  onClosePreview={onClose}
                  hoveredFaceKey={hoveredFaceKey}
                  setHoveredFaceKey={setHoveredFaceKey}
                />
              )}
              {showDescription && (
                <DescriptionOverlay file={file} onClose={() => setShowDescription(false)} />
              )}
              {/* Hint hover de fullscreen — se oculta cuando hay bboxes visibles
                  o overlay de descripcion abierto para no tapar el contenido. */}
              {!(showFaceBoxes && boxes.length > 0) && !showDescription && (
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
            {hasDescription && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowDescription(v => !v); }}
                className={`absolute top-2 ${boxes.length > 0 ? 'right-14' : 'right-2'} z-10 p-2 bg-noche/70 hover:bg-noche/90 backdrop-blur-sm rounded-full text-marfil transition-colors`}
                title={showDescription ? 'Ocultar descripcion' : 'Ver descripcion'}
                aria-label={showDescription ? 'Ocultar descripcion' : 'Ver descripcion'}
              >
                <Pencil className="w-4 h-4" />
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

              {/* File info — sin encabezados redundantes, solo los valores */}
              <div className="space-y-4">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
                  <span>{formatFileSize(file.size)}</span>
                  {file.dimensions && (
                    <span>{file.dimensions.width} × {file.dimensions.height}</span>
                  )}
                </div>

                {file.description && (
                  <p className="text-sm text-slate-600 leading-relaxed">{file.description}</p>
                )}

                <FilePersonsBubbles
                  file={file}
                  onPersonFilter={onPersonFilter}
                  onClosePreview={onClose}
                  hoveredFaceKey={hoveredFaceKey}
                  setHoveredFaceKey={setHoveredFaceKey}
                />

                <TagsList tags={file.tags} onTagClick={handleTagClick} />
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

    {/* Toast: cargando busqueda de caras similares */}
    {seedingLoading && (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-tinta border border-melocoton/40 rounded-2xl px-4 py-3 flex items-center gap-3 shadow-xl">
        <Search className="w-4 h-4 text-melocoton animate-pulse" />
        <span className="text-sm text-marfil">Buscando caras similares en tu archivo...</span>
      </div>
    )}

    {/* Toast de error en seed */}
    {seedingError && !seedingCluster && !seedingLoading && (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-tinta border border-red-400/40 rounded-2xl px-4 py-3 flex items-center gap-3 shadow-xl">
        <span className="text-sm text-red-300">{seedingError}</span>
        <button onClick={() => setSeedingError(null)} className="text-red-300 hover:text-red-200">
          <X className="w-4 h-4" />
        </button>
      </div>
    )}

    {/* Modal: crear persona desde caras similares */}
    {seedingCluster && (
      <div className="fixed inset-0 bg-noche/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4 overflow-y-auto">
        <div className="bg-tinta rounded-3xl border border-pizarra p-6 w-full max-w-3xl my-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-marfil flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-melocoton" />
              Crear persona desde esta cara
            </h2>
            <button
              onClick={() => { setSeedingCluster(null); setSeedingError(null); }}
              className="text-lavanda-archivo hover:text-marfil"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="mb-4">
            <p className="text-marfil font-medium text-sm">
              {seedingCluster.face_count} {seedingCluster.face_count === 1 ? 'cara similar encontrada' : 'caras similares encontradas'} en tu archivo
            </p>
            <p className="text-lavanda-archivo text-xs mt-0.5">
              {[seedingCluster.dominant_gender, seedingCluster.dominant_age].filter(Boolean).join(' · ') || 'sin demografia'}
              {seedingCluster.sample_count > 0 && (
                <> · mostrando hasta {seedingCluster.sample_count} muestras representativas</>
              )}
            </p>
            <p className="text-xs text-bruma mt-1">
              Verifica que todas las caras sean la misma persona antes de crearla. Si hay errores, mejor usa "Descubrir caras" en la pestaña Personas.
            </p>
          </div>
          {seedingCluster.sample_count > 0 && (
            <div className="mb-5 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {Array.from({ length: seedingCluster.sample_count }).map((_, i) => (
                <div key={i} className="aspect-square rounded-xl bg-pizarra overflow-hidden border border-grafito">
                  <img
                    src={api.faceClusterSampleUrl(seedingCluster.cluster_id, i)}
                    alt={`Muestra ${i + 1}`}
                    className="w-full h-full object-cover"
                    loading="lazy"
                    onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <div>
              <label className="block text-xs font-medium text-lavanda-archivo mb-1">
                Nombre <span className="text-bruma">*</span>
              </label>
              <input
                type="text"
                value={seedingDisplayName}
                onChange={e => setSeedingDisplayName(e.target.value)}
                placeholder="Ester Garcia, Jose Carlos..."
                className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                autoFocus
              />
              {seedingDisplayName.trim() && (
                <p className="text-xs text-bruma mt-1">
                  ID interno: <span className="font-mono text-lavanda-archivo">{slugifyPersonId(seedingDisplayName) || '(invalido)'}</span>
                </p>
              )}
            </div>
          </div>
          {seedingError && (
            <div className="mt-3 p-2 bg-red-500/10 border border-red-400/30 rounded-xl text-xs text-red-300">
              {seedingError}
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <button
              onClick={() => { setSeedingCluster(null); setSeedingError(null); }}
              disabled={seedingSubmitting}
              className="px-4 py-2 text-lavanda-archivo hover:text-marfil"
            >
              Cancelar
            </button>
            <button
              onClick={handleSeedPromote}
              disabled={seedingSubmitting || !seedingDisplayName.trim() || !slugifyPersonId(seedingDisplayName)}
              className={`px-4 py-2 rounded-full font-medium ${
                seedingSubmitting || !seedingDisplayName.trim() || !slugifyPersonId(seedingDisplayName)
                  ? 'bg-lavanda/30 text-marfil/50 cursor-not-allowed'
                  : 'bg-lavanda text-white hover:bg-lavanda-claro'
              }`}
            >
              {seedingSubmitting ? 'Creando...' : 'Crear persona'}
            </button>
          </div>
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
function boxKey(b: FaceBox, idx: number): string {
  return b.person_id ? `p:${b.person_id}` : `i:${idx}`;
}

function FaceBoxesOverlay({
  boxes,
  naturalWidth,
  naturalHeight,
  onPersonFilter,
  onSeedUnknown,
  onClosePreview,
  hoveredFaceKey,
  setHoveredFaceKey,
}: {
  boxes: FaceBox[];
  naturalWidth: number;
  naturalHeight: number;
  onPersonFilter?: (personId: string) => void;
  onSeedUnknown?: (faceIndex: number) => void;
  onClosePreview?: () => void;
  hoveredFaceKey: string | null;
  setHoveredFaceKey: (key: string | null) => void;
}) {
  if (!naturalWidth || !naturalHeight) return null;
  return (
    <div className="absolute inset-0 pointer-events-none">
      {boxes.map((b, i) => {
        const myKey = boxKey(b, i);
        // dimmed cuando hay otra entidad hovered. Si comparto person_id con
        // el hovered (e.g. el hover viene de la bubble de Pepe y este bbox
        // tambien es de Pepe), no se atenua.
        const dimmed = hoveredFaceKey !== null && hoveredFaceKey !== myKey;
        const [x1, y1, x2, y2] = b.bbox;
        const left = (x1 / naturalWidth) * 100;
        const top = (y1 / naturalHeight) * 100;
        const width = ((x2 - x1) / naturalWidth) * 100;
        const height = ((y2 - y1) / naturalHeight) * 100;
        const isKnown = !!b.person_id;
        // Si la cara esta cerca del borde superior (<15%), colocar label DEBAJO
        const labelBelow = top < 15;
        const label = b.display_name || 'desconocido';
        const faceIdx = typeof b.face_index === 'number' ? b.face_index : i;
        const seedable = !isKnown && !!onSeedUnknown;
        const clickable = (isKnown && !!onPersonFilter) || seedable;
        const handleClick = (e: React.MouseEvent) => {
          // Evitar que el click llegue a la <img> (que abre fullscreen)
          e.stopPropagation();
          if (isKnown && b.person_id && onPersonFilter) {
            onPersonFilter(b.person_id);
            onClosePreview?.();
          } else if (seedable && onSeedUnknown) {
            onSeedUnknown(faceIdx);
          }
        };
        return (
          <div
            key={i}
            className={`absolute pointer-events-auto group/face transition-opacity duration-150 ${clickable ? 'cursor-pointer' : ''} ${dimmed ? 'opacity-0' : 'opacity-100'}`}
            style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
            onClick={handleClick}
            onMouseEnter={() => setHoveredFaceKey(myKey)}
            onMouseLeave={() => setHoveredFaceKey(null)}
            title={
              isKnown
                ? `Filtrar galeria por ${label}`
                : seedable
                  ? 'Buscar caras similares y crear persona'
                  : undefined
            }
          >
            <div
              className={`absolute inset-0 rounded-md border-2 transition-colors ${
                isKnown
                  ? 'border-lavanda shadow-[0_0_0_1px_rgba(15,17,26,0.6)] group-hover/face:border-lavanda-claro group-hover/face:shadow-[0_0_0_2px_rgba(200,182,255,0.5)]'
                  : `border-bruma/70 border-dashed ${seedable ? 'group-hover/face:border-melocoton group-hover/face:border-solid' : ''}`
              }`}
            />
            <div
              className={`absolute whitespace-nowrap text-xs px-1.5 py-0.5 rounded-md backdrop-blur-sm transition-opacity ${
                isKnown
                  ? 'bg-lavanda/90 text-white group-hover/face:bg-lavanda'
                  : `bg-noche/70 text-lavanda-archivo ${seedable ? 'group-hover/face:bg-melocoton group-hover/face:text-noche' : ''}`
              } ${labelBelow ? 'top-full mt-1' : 'bottom-full mb-1'} left-0 flex items-center gap-1`}
              style={{ fontSize: '11px' }}
            >
              {seedable && <UserPlus className="w-3 h-3" />}
              {label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Lista de etiquetas colapsable. Muestra las primeras N por defecto y un boton
 * "+M" para expandir. Cuando esta expandido aparece "- menos" para colapsar.
 */
function TagsList({ tags, onTagClick }: { tags: string[]; onTagClick: (t: string) => void }) {
  const COLLAPSED_LIMIT = 8;
  const [expanded, setExpanded] = useState(false);
  if (!tags || tags.length === 0) return null;
  const visible = expanded ? tags : tags.slice(0, COLLAPSED_LIMIT);
  const hidden = tags.length - COLLAPSED_LIMIT;
  return (
    <div className="flex flex-wrap gap-2">
      {visible.map((tag) => (
        <button
          key={tag}
          onClick={() => onTagClick(tag)}
          className="inline-flex items-center px-3 py-1 rounded-full text-xs bg-lavanda-claro text-marfil font-medium hover:bg-opacity-80 border border-transparent transition-all duration-200 cursor-pointer group"
          title={`Filtrar por etiqueta: ${tag}`}
        >
          <span className="group-hover:scale-105 transition-transform duration-200">{tag}</span>
        </button>
      ))}
      {hidden > 0 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="inline-flex items-center px-3 py-1 rounded-full text-xs bg-pizarra text-lavanda font-medium hover:bg-lavanda hover:text-white transition-colors"
          title={`Mostrar ${hidden} etiquetas mas`}
        >
          +{hidden}
        </button>
      )}
      {expanded && tags.length > COLLAPSED_LIMIT && (
        <button
          onClick={() => setExpanded(false)}
          className="inline-flex items-center px-3 py-1 rounded-full text-xs bg-pizarra text-lavanda font-medium hover:bg-lavanda hover:text-white transition-colors"
          title="Colapsar etiquetas"
        >
          mostrar menos
        </button>
      )}
    </div>
  );
}

/**
 * Overlay con el analisis visual del VLM: descripcion, composicion, atmosfera
 * y texto detectado (OCR). Se renderiza encima de la imagen/video con un
 * fondo oscuro para legibilidad. Se controla desde fuera con el boton lapiz.
 */
const COMPOSITION_LABELS: Record<string, string> = {
  shot_type: 'Plano',
  camera_angle: 'Angulo',
  camera_movement: 'Movimiento',
  people_framing: 'Personas',
};

const ATMOSPHERE_LABELS: Record<string, string> = {
  mood: 'Ambiente',
  lighting: 'Iluminacion',
  space_type: 'Espacio',
  time_of_day: 'Momento',
  style: 'Estilo',
};

function humanizeValue(v: unknown): string {
  if (v == null) return '';
  return String(v).replace(/_/g, ' ');
}

function objectToChips(
  obj: Record<string, unknown> | undefined,
  labels: Record<string, string>
): Array<{ label: string; value: string }> {
  if (!obj || typeof obj !== 'object') return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '' || v === 'ninguno') continue;
    const value = humanizeValue(v);
    if (!value) continue;
    out.push({ label: labels[k] || k.replace(/_/g, ' '), value });
  }
  return out;
}

function fileHasVisualAnalysis(file: MediaFile): boolean {
  const visualDesc = file.visual_description?.trim() || '';
  const ocr = file.ocr_text?.trim() || '';
  const compChips = objectToChips(file.composition, COMPOSITION_LABELS);
  const atmoChips = objectToChips(file.atmosphere, ATMOSPHERE_LABELS);
  return visualDesc.length > 0 || ocr.length > 0 || compChips.length > 0 || atmoChips.length > 0;
}

function DescriptionOverlay({ file, onClose }: { file: MediaFile; onClose: () => void }) {
  const visualDesc = file.visual_description?.trim() || '';
  const ocr = file.ocr_text?.trim() || '';
  const compChips = objectToChips(file.composition, COMPOSITION_LABELS);
  const atmoChips = objectToChips(file.atmosphere, ATMOSPHERE_LABELS);

  return (
    <div
      className="absolute inset-0 z-20 bg-noche/85 backdrop-blur-sm overflow-auto cursor-default"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div
        className="p-4 md:p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="absolute top-2 right-2 p-1.5 rounded-full bg-noche/70 hover:bg-noche/90 text-marfil"
          title="Cerrar"
          aria-label="Cerrar descripcion"
        >
          <X className="w-4 h-4" />
        </button>

        {visualDesc && (
          <p className="text-sm text-marfil leading-relaxed whitespace-pre-line pr-8">
            {visualDesc}
          </p>
        )}

        {compChips.length > 0 && (
          <div>
            <h4 className="text-[10px] uppercase tracking-wide text-lavanda-archivo mb-1.5">Composicion</h4>
            <div className="flex flex-wrap gap-1.5">
              {compChips.map(c => (
                <span
                  key={c.label}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-pizarra/80 text-marfil"
                >
                  <span className="text-lavanda-archivo">{c.label}:</span>
                  <span>{c.value}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {atmoChips.length > 0 && (
          <div>
            <h4 className="text-[10px] uppercase tracking-wide text-lavanda-archivo mb-1.5">Atmosfera</h4>
            <div className="flex flex-wrap gap-1.5">
              {atmoChips.map(c => (
                <span
                  key={c.label}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-pizarra/80 text-marfil"
                >
                  <span className="text-lavanda-archivo">{c.label}:</span>
                  <span>{c.value}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {ocr && (
          <div>
            <h4 className="text-[10px] uppercase tracking-wide text-lavanda-archivo mb-1.5">Texto detectado</h4>
            <p className="text-xs text-niebla leading-relaxed font-mono whitespace-pre-line">
              {ocr}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Bubbles de las personas detectadas en este archivo. Carga el registry para
 * obtener avatares; muestra iniciales como fallback cuando no hay avatar o
 * la imagen falla. Click filtra la galeria por esa persona.
 */
function FilePersonsBubbles({
  file,
  onPersonFilter,
  onClosePreview,
  hoveredFaceKey,
  setHoveredFaceKey,
}: {
  file: MediaFile;
  onPersonFilter?: (personId: string) => void;
  onClosePreview?: () => void;
  hoveredFaceKey: string | null;
  setHoveredFaceKey: (key: string | null) => void;
}) {
  const PEOPLE_COLLAPSED_LIMIT = 4;
  const [registry, setRegistry] = useState<Array<{ person_id: string; display_name: string; avatar_url: string | null }> | null>(null);
  const [brokenAvatars, setBrokenAvatars] = useState<Set<string>>(new Set());
  const [peopleExpanded, setPeopleExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listPersonsRegistry().then((r: any) => {
      if (cancelled) return;
      if (r && r.success && Array.isArray(r.data)) setRegistry(r.data);
      else setRegistry([]);
    }).catch(() => { if (!cancelled) setRegistry([]); });
    return () => { cancelled = true; };
  }, []);

  const faces = file.faces || [];
  if (faces.length === 0) return null;

  // Cruzar faces con registry para obtener avatar_url
  const enriched = faces.map(f => {
    const reg = registry?.find(p => p.person_id === f.person_id);
    return {
      person_id: f.person_id,
      display_name: f.display_name || reg?.display_name || f.person_id,
      avatar_url: reg?.avatar_url || null,
    };
  });

  const lavendaColor = (personId: string) => {
    let h = 0;
    for (let i = 0; i < personId.length; i++) { h = (h << 5) - h + personId.charCodeAt(i); h |= 0; }
    return `hsl(${240 + (Math.abs(h) % 61)}, 40%, 65%)`;
  };

  const visiblePeople = peopleExpanded ? enriched : enriched.slice(0, PEOPLE_COLLAPSED_LIMIT);
  const hiddenPeopleCount = enriched.length - PEOPLE_COLLAPSED_LIMIT;

  return (
    <div className="flex flex-wrap gap-3">
      {visiblePeople.map(p => {
          const showFallback = !p.avatar_url || brokenAvatars.has(p.person_id);
          const initials = (p.display_name || p.person_id).trim().slice(0, 2).toUpperCase();
          const clickable = !!onPersonFilter;
          const myKey = `p:${p.person_id}`;
          const isThisHovered = hoveredFaceKey === myKey;
          // Atenuar las bubbles cuando hay otra entidad hovered (igual que
          // los bboxes en la imagen) para reforzar visualmente la conexion.
          const otherHovered = hoveredFaceKey !== null && !isThisHovered;
          return (
            <button
              key={p.person_id}
              onClick={() => {
                if (clickable && p.person_id && onPersonFilter) {
                  onPersonFilter(p.person_id);
                  onClosePreview?.();
                }
              }}
              onMouseEnter={() => setHoveredFaceKey(myKey)}
              onMouseLeave={() => setHoveredFaceKey(null)}
              title={`${p.display_name} — click para filtrar la galeria`}
              className={`flex items-center gap-2 pl-1 pr-3 py-1 rounded-full transition-all text-xs ${clickable ? 'cursor-pointer' : 'cursor-default'} ${
                isThisHovered ? 'bg-lavanda text-white ring-2 ring-lavanda-claro' : 'bg-pizarra hover:bg-lavanda hover:text-white'
              } ${otherHovered ? 'opacity-30' : 'opacity-100'}`}
            >
              <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0">
                {showFallback ? (
                  <div
                    className="w-full h-full flex items-center justify-center text-noche font-semibold text-[10px]"
                    style={{ backgroundColor: lavendaColor(p.person_id) }}
                  >
                    {initials}
                  </div>
                ) : (
                  <img
                    src={`${config.apiUrl.replace(/\/api$/, '')}${p.avatar_url}`}
                    alt={p.display_name}
                    className="w-full h-full object-cover"
                    onError={() => {
                      setBrokenAvatars(prev => { const n = new Set(prev); n.add(p.person_id); return n; });
                    }}
                  />
                )}
              </div>
              <span className="font-medium">{p.display_name}</span>
            </button>
          );
        })}
        {hiddenPeopleCount > 0 && !peopleExpanded && (
          <button
            onClick={() => setPeopleExpanded(true)}
            className="inline-flex items-center px-3 py-1 rounded-full text-xs bg-pizarra text-lavanda font-medium hover:bg-lavanda hover:text-white transition-colors"
            title={`Mostrar ${hiddenPeopleCount} personas mas`}
          >
            +{hiddenPeopleCount}
          </button>
        )}
        {peopleExpanded && enriched.length > PEOPLE_COLLAPSED_LIMIT && (
          <button
            onClick={() => setPeopleExpanded(false)}
            className="inline-flex items-center px-3 py-1 rounded-full text-xs bg-pizarra text-lavanda font-medium hover:bg-lavanda hover:text-white transition-colors"
            title="Colapsar lista de personas"
          >
            mostrar menos
          </button>
        )}
    </div>
  );
}