import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Upload, Image, Search, X, RefreshCw, AlertCircle, Info, Settings, Trash2, ArrowLeft } from 'lucide-react';
import { api, ImageSearchResult, ImageSearchIndexStats } from '../services/api';
import { MediaFile } from '../types';
import MediaGrid from './MediaGrid';

interface ImageSearchViewProps {
  onFileClick: (file: MediaFile, event?: React.MouseEvent) => void;
  onToggleFavorite: (fileId: string) => void;
  onDownload: (file: MediaFile) => void;
  onAddToCollection?: (fileId: string) => void;
  downloadingFiles?: Set<string>;
  isSelectionMode?: boolean;
  selectedFiles?: Set<string>;
  isAdmin?: boolean;
  onBack?: () => void;
}

type SearchStatus = 'idle' | 'searching' | 'indexing' | 'error';

export default function ImageSearchView({
  onFileClick,
  onToggleFavorite,
  onDownload,
  onAddToCollection,
  downloadingFiles = new Set(),
  isSelectionMode = false,
  selectedFiles = new Set(),
  isAdmin = false,
  onBack
}: ImageSearchViewProps) {
  // Estados
  const [dragActive, setDragActive] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [searchResults, setSearchResults] = useState<ImageSearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [indexStats, setIndexStats] = useState<ImageSearchIndexStats | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [indexProgress, setIndexProgress] = useState<{ percentage: number; status: string } | null>(null);

  // Opciones de búsqueda
  const [searchOptions, setSearchOptions] = useState({
    topN: 20,
    useBlur: true,
    minScore: 0.1  // Reducido de 0.3 para permitir más resultados
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cargar estadísticas del índice al montar
  useEffect(() => {
    loadIndexStats();
  }, []);

  const loadIndexStats = async () => {
    try {
      const response = await api.getImageSearchStats();
      if (response.success && response.data) {
        setIndexStats(response.data);
      }
    } catch (error) {
      console.error('Error cargando estadísticas:', error);
    }
  };

  // Handlers de drag & drop
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  }, []);

  const handleFile = (file: File) => {
    // Validar tipo de archivo
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'];
    if (!validTypes.includes(file.type)) {
      setErrorMessage('Tipo de archivo no soportado. Use JPEG, PNG, WebP, GIF o BMP.');
      return;
    }

    setSelectedFile(file);
    setErrorMessage(null);

    // Crear preview
    const reader = new FileReader();
    reader.onload = (e) => {
      setPreviewImage(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleSearch = async () => {
    if (!selectedFile) return;

    setStatus('searching');
    setErrorMessage(null);
    setSearchResults([]);

    try {
      const response = await api.imageSearch(selectedFile, searchOptions);

      if (response.success && response.data) {
        setSearchResults(response.data);
        if (response.data.length === 0) {
          setErrorMessage('No se encontraron imágenes similares. Intenta con otra imagen o ajusta el score mínimo.');
        }
      } else {
        setErrorMessage('Error en la búsqueda. Inténtalo de nuevo.');
      }
    } catch (error: any) {
      console.error('Error en búsqueda por imagen:', error);
      if (error.message?.includes('índice vacío') || error.message?.includes('index')) {
        setErrorMessage('El índice de búsqueda no está construido. Por favor, construye el índice primero.');
      } else {
        setErrorMessage(error.message || 'Error realizando la búsqueda');
      }
    } finally {
      setStatus('idle');
    }
  };

  const handleBuildIndex = async () => {
    setStatus('indexing');
    setErrorMessage(null);
    setIndexProgress({ percentage: 0, status: 'Iniciando...' });

    try {
      const response = await api.buildImageSearchIndex();

      if (response.success) {
        await loadIndexStats();
        setIndexProgress(null);
      } else {
        setErrorMessage('Error construyendo el índice');
      }
    } catch (error: any) {
      console.error('Error construyendo índice:', error);
      setErrorMessage(error.message || 'Error construyendo el índice');
    } finally {
      setStatus('idle');
      setIndexProgress(null);
    }
  };

  const handleClearIndex = async () => {
    if (!window.confirm('¿Estás seguro de que quieres limpiar el índice? Deberás reconstruirlo para usar la búsqueda por imagen.')) {
      return;
    }

    try {
      await api.clearImageSearchIndex();
      await loadIndexStats();
      setSearchResults([]);
    } catch (error: any) {
      setErrorMessage(error.message || 'Error limpiando el índice');
    }
  };

  const clearSearch = () => {
    setSelectedFile(null);
    setPreviewImage(null);
    setSearchResults([]);
    setErrorMessage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Convertir resultados a MediaFile[] para MediaGrid
  const resultsAsMediaFiles: MediaFile[] = searchResults
    .filter(r => r.file)
    .map(r => r.file as MediaFile);

  // Función para obtener el color del score
  const getScoreColor = (score: number) => {
    if (score >= 0.8) return 'text-green-600 bg-green-100';
    if (score >= 0.6) return 'text-yellow-600 bg-yellow-100';
    return 'text-orange-600 bg-orange-100';
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header con título y configuración */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-lavanda hover:text-white hover:bg-lavanda rounded-lg transition-colors"
              title="Volver a la biblioteca"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Volver</span>
            </button>
          )}
          <div className="flex items-center gap-2">
            <Image className="w-6 h-6 text-lavanda-500" />
            <h2 className="text-xl font-semibold text-slate-800">Buscar por Imagen</h2>
            <span className="px-2 py-0.5 text-xs font-medium bg-lavanda-100 text-lavanda-700 rounded-full">
              Beta
            </span>
          </div>
        </div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`p-2 rounded-lg transition-colors ${
            showSettings ? 'bg-slate-200 text-slate-700' : 'hover:bg-slate-100 text-slate-500'
          }`}
          title="Configuración"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>

      {/* Panel de configuración */}
      {showSettings && (
        <div className="mb-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
          <h3 className="font-medium text-slate-700 mb-3">Configuración de búsqueda</h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm text-slate-600 mb-1">Resultados máximos</label>
              <input
                type="number"
                min="1"
                max="100"
                value={searchOptions.topN}
                onChange={(e) => setSearchOptions(prev => ({ ...prev, topN: parseInt(e.target.value) || 20 }))}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-lavanda-500 focus:border-lavanda-500"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">Score mínimo (0-1)</label>
              <input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={searchOptions.minScore}
                onChange={(e) => setSearchOptions(prev => ({ ...prev, minScore: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-lavanda-500 focus:border-lavanda-500"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={searchOptions.useBlur}
                  onChange={(e) => setSearchOptions(prev => ({ ...prev, useBlur: e.target.checked }))}
                  className="w-4 h-4 text-lavanda-500 rounded focus:ring-lavanda-500"
                />
                <span className="text-sm text-slate-600">Usar búsqueda con blur</span>
              </label>
            </div>
          </div>

          {/* Estadísticas del índice */}
          <div className="border-t border-slate-200 pt-3 mt-3">
            <h4 className="text-sm font-medium text-slate-700 mb-2">Estado del índice</h4>
            {indexStats ? (
              <div className="flex flex-wrap gap-4 text-sm">
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">Imágenes indexadas:</span>
                  <span className="font-medium text-slate-700">{indexStats.totalEntries.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">Última actualización:</span>
                  <span className="font-medium text-slate-700">
                    {indexStats.lastFullBuild
                      ? new Date(indexStats.lastFullBuild).toLocaleString('es-ES')
                      : 'Nunca'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-500">Modelo:</span>
                  <span className="font-medium text-slate-700">{indexStats.modelType}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">Cargando estadísticas...</p>
            )}

            <div className="flex gap-2 mt-3">
              <button
                onClick={handleBuildIndex}
                disabled={status === 'indexing'}
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-lavanda-500 text-lavanda-claro rounded-lg hover:bg-lavanda-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${status === 'indexing' ? 'animate-spin' : ''}`} />
                {status === 'indexing' ? 'Construyendo...' : 'Reconstruir índice'}
              </button>
              {indexStats && indexStats.totalEntries > 0 && (
                <button
                  onClick={handleClearIndex}
                  disabled={status === 'indexing'}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-50 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Limpiar índice
                </button>
              )}
            </div>

            {indexProgress && (
              <div className="mt-3">
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>{indexProgress.status}</span>
                  <span>{indexProgress.percentage}%</span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2">
                  <div
                    className="bg-lavanda-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${indexProgress.percentage}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Zona de drop / Preview */}
      <div className="mb-4">
        {!previewImage ? (
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`
              relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer
              transition-all duration-200
              ${dragActive
                ? 'border-lavanda-500 bg-lavanda-50'
                : 'border-slate-300 hover:border-lavanda-400 hover:bg-slate-50'
              }
            `}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/bmp"
              onChange={handleFileInput}
              className="hidden"
            />

            <Upload className={`w-12 h-12 mx-auto mb-3 ${dragActive ? 'text-lavanda-500' : 'text-slate-400'}`} />
            <p className="text-lg font-medium text-slate-700 mb-1">
              Arrastra una imagen aquí
            </p>
            <p className="text-sm text-slate-500 mb-3">
              o haz clic para seleccionar
            </p>
            <p className="text-xs text-slate-400">
              Soporta: JPEG, PNG, WebP, GIF, BMP
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-4 p-4 bg-slate-50 rounded-xl">
            {/* Preview de imagen */}
            <div className="relative flex-shrink-0">
              <img
                src={previewImage}
                alt="Imagen de búsqueda"
                className="w-32 h-32 object-cover rounded-lg shadow-sm"
              />
              <button
                onClick={clearSearch}
                className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                title="Quitar imagen"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Info y botón de búsqueda */}
            <div className="flex-1">
              <p className="font-medium text-slate-700 mb-1">{selectedFile?.name}</p>
              <p className="text-sm text-slate-500 mb-3">
                {selectedFile && `${(selectedFile.size / 1024).toFixed(1)} KB`}
              </p>

              <button
                onClick={handleSearch}
                disabled={status === 'searching' || !indexStats?.totalEntries}
                className="flex items-center gap-2 px-4 py-2 bg-lavanda-500 text-lavanda-claro rounded-lg hover:bg-lavanda-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {status === 'searching' ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Buscando...
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4" />
                    Buscar similares
                  </>
                )}
              </button>

              {!indexStats?.totalEntries && (
                <p className="mt-2 text-xs text-amber-600 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  Debes construir el índice primero (ver configuración)
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mensaje de error */}
      {errorMessage && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{errorMessage}</p>
        </div>
      )}

      {/* Info sobre la funcionalidad */}
      {!previewImage && !searchResults.length && (
        <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-start gap-2">
            <Info className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-1">Cómo funciona la búsqueda por imagen</p>
              <ul className="list-disc list-inside space-y-1 text-blue-700">
                <li>Arrastra una foto (puede estar recortada, con texto, o en blanco y negro)</li>
                <li>El sistema encontrará fotos similares en tu biblioteca</li>
                <li>Los resultados se ordenan por similitud (mayor = más parecido)</li>
                <li>Ideal para encontrar la foto original de una versión editada</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Resultados */}
      {searchResults.length > 0 && (
        <div className="flex-1 overflow-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-medium text-slate-700">
              {searchResults.length} resultado{searchResults.length !== 1 ? 's' : ''} encontrado{searchResults.length !== 1 ? 's' : ''}
            </h3>
            <button
              onClick={clearSearch}
              className="text-sm text-slate-500 hover:text-slate-700 transition-colors"
            >
              Nueva búsqueda
            </button>
          </div>

          {/* Badges de similitud encima del grid */}
          <div className="flex flex-wrap gap-2 mb-4">
            {searchResults.slice(0, 5).map((result, idx) => (
              <div
                key={result.fileId}
                className={`px-2 py-1 rounded-full text-xs font-medium ${getScoreColor(result.similarityScore)}`}
              >
                #{idx + 1}: {(result.similarityScore * 100).toFixed(0)}% similar
              </div>
            ))}
            {searchResults.length > 5 && (
              <span className="px-2 py-1 text-xs text-slate-500">
                +{searchResults.length - 5} más
              </span>
            )}
          </div>

          <MediaGrid
            files={resultsAsMediaFiles}
            viewMode="grid"
            onFileClick={onFileClick}
            onToggleFavorite={onToggleFavorite}
            onDownload={onDownload}
            onAddToCollection={onAddToCollection}
            downloadingFiles={downloadingFiles}
            isSelectionMode={isSelectionMode}
            selectedFiles={selectedFiles}
            isAdmin={isAdmin}
          />
        </div>
      )}

      {/* Estado vacío cuando hay preview pero no resultados */}
      {previewImage && status === 'idle' && searchResults.length === 0 && !errorMessage && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-slate-500">
            <Search className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>Haz clic en "Buscar similares" para encontrar coincidencias</p>
          </div>
        </div>
      )}
    </div>
  );
}
