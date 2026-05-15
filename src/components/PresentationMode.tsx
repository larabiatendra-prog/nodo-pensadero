import React, { useState, useEffect, useRef } from 'react';
import { X, Play, Pause, SkipForward, SkipBack, Volume2, VolumeX } from 'lucide-react';
import { MediaFile } from '../types';

interface PresentationModeProps {
  videos: MediaFile[];
  isOpen: boolean;
  onClose: () => void;
}

export default function PresentationMode({ videos, isOpen, onClose }: PresentationModeProps) {
  const [currentVideoIndex, setCurrentVideoIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  // Estados para doble buffer
  const [activePlayer, setActivePlayer] = useState<'A' | 'B'>('A');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [nextVideoPreloaded, setNextVideoPreloaded] = useState(false);
  
  // Referencias duales para doble buffer
  const videoRefA = useRef<HTMLVideoElement>(null);
  const videoRefB = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout>();

  // Filtrar solo videos
  const videoFiles = videos.filter(file => file.type === 'video');

  useEffect(() => {
    if (!isOpen) return;

    // Entrar en pantalla completa al abrir
    const enterFullscreen = async () => {
      if (containerRef.current) {
        try {
          await containerRef.current.requestFullscreen();
          setIsFullscreen(true);
        } catch (error) {
          console.warn('No se pudo entrar en pantalla completa:', error);
        }
      }
    };

    enterFullscreen();

    // Listener para detectar cambios de pantalla completa
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      if (!document.fullscreenElement) {
        // Si se salió de pantalla completa, cerrar el modo presentación
        onClose();
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);

    // Listener para ESC
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          onClose();
          break;
        case ' ':
          event.preventDefault();
          togglePlayPause();
          break;
        case 'ArrowRight':
          event.preventDefault();
          nextVideo();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          previousVideo();
          break;
        case 'm':
        case 'M':
          event.preventDefault();
          toggleMute();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Auto-ocultar controles
  useEffect(() => {
    if (showControls) {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }

    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [showControls]);

  // Inicialización del doble buffer
  useEffect(() => {
    if (isOpen && videoFiles.length > 0 && videoRefA.current) {
      // Cargar el primer video en el player A
      const currentVideo = videoFiles[currentVideoIndex];
      videoRefA.current.src = currentVideo.url;
      videoRefA.current.muted = isMuted;
      
      console.log(`🎬 Cargando video inicial: ${currentVideo.name}`);
      
      // Pre-cargar el siguiente video después de un breve delay
      if (videoFiles.length > 1) {
        setTimeout(() => preloadNextVideo(), 2000);
      }
    }
  }, [isOpen, videoFiles.length, currentVideoIndex, isMuted]);

  const togglePlayPause = () => {
    const activeVideoRef = getActiveVideoRef();
    if (activeVideoRef.current) {
      if (isPlaying) {
        activeVideoRef.current.pause();
      } else {
        activeVideoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const toggleMute = () => {
    const activeVideoRef = getActiveVideoRef();
    const inactiveVideoRef = getInactiveVideoRef();
    
    if (activeVideoRef.current) {
      activeVideoRef.current.muted = !isMuted;
    }
    if (inactiveVideoRef.current) {
      inactiveVideoRef.current.muted = !isMuted;
    }
    setIsMuted(!isMuted);
  };

  const nextVideo = () => {
    if (nextVideoPreloaded && !isTransitioning) {
      // Transición inmediata usando el video pre-cargado
      setIsTransitioning(true);
      const nextIndex = getNextVideoIndex();
      
      // Swap de players
      setActivePlayer(prev => prev === 'A' ? 'B' : 'A');
      setCurrentVideoIndex(nextIndex);
      setNextVideoPreloaded(false);
      
      // Reproducir el video que ya estaba pre-cargado
      const newActiveVideoRef = getInactiveVideoRef(); // Será el nuevo activo después del swap
      if (newActiveVideoRef.current && isPlaying) {
        newActiveVideoRef.current.play().catch(error => {
          console.error('Error reproduciendo video pre-cargado:', error);
        });
      }
      
      // Pre-cargar el siguiente video
      setTimeout(() => {
        preloadNextVideo();
        setIsTransitioning(false);
      }, 100);
      
    } else {
      // Fallback al método tradicional si no hay pre-carga
      const nextIndex = getNextVideoIndex();
      setCurrentVideoIndex(nextIndex);
      setIsPlaying(true);
    }
  };

  const previousVideo = () => {
    // Para ir hacia atrás, usar método tradicional (no pre-cargamos hacia atrás)
    const prevIndex = getPrevVideoIndex();
    const activeVideoRef = getActiveVideoRef();
    
    if (activeVideoRef.current) {
      const prevVideo = videoFiles[prevIndex];
      activeVideoRef.current.src = prevVideo.url;
      activeVideoRef.current.muted = isMuted;
    }
    
    setCurrentVideoIndex(prevIndex);
    setIsPlaying(true);
    setNextVideoPreloaded(false);
    
    // Pre-cargar el siguiente video después del cambio
    setTimeout(() => preloadNextVideo(), 100);
  };

  const handleVideoEnded = () => {
    // Siguiente video automáticamente (loop infinito)
    nextVideo();
  };

  const handleVideoLoadedData = () => {
    const activeVideoRef = getActiveVideoRef();
    if (activeVideoRef.current && isPlaying) {
      activeVideoRef.current.play().catch(error => {
        console.error('Error reproduciendo video:', error);
      });
    }
    
    // Iniciar pre-carga del siguiente video
    if (!nextVideoPreloaded) {
      setTimeout(() => preloadNextVideo(), 1000);
    }
  };

  const handleMouseMove = () => {
    setShowControls(true);
  };

  const handleClose = async () => {
    // Salir de pantalla completa
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (error) {
        console.warn('Error saliendo de pantalla completa:', error);
      }
    }
    onClose();
  };

  // Funciones para doble buffer
  const getActiveVideoRef = () => activePlayer === 'A' ? videoRefA : videoRefB;
  const getInactiveVideoRef = () => activePlayer === 'A' ? videoRefB : videoRefA;
  
  const getNextVideoIndex = () => (currentVideoIndex + 1) % videoFiles.length;
  const getPrevVideoIndex = () => currentVideoIndex === 0 ? videoFiles.length - 1 : currentVideoIndex - 1;

  const preloadNextVideo = () => {
    if (videoFiles.length <= 1) return;
    
    const nextIndex = getNextVideoIndex();
    const nextVideo = videoFiles[nextIndex];
    const inactiveVideoRef = getInactiveVideoRef();
    
    if (inactiveVideoRef.current && nextVideo) {
      console.log(`🔄 Pre-cargando video: ${nextVideo.name}`);
      inactiveVideoRef.current.src = nextVideo.url;
      inactiveVideoRef.current.muted = isMuted;
      inactiveVideoRef.current.load();
      
      const handleCanPlayThrough = () => {
        setNextVideoPreloaded(true);
        console.log(`✅ Video pre-cargado: ${nextVideo.name}`);
        inactiveVideoRef.current?.removeEventListener('canplaythrough', handleCanPlayThrough);
      };
      
      inactiveVideoRef.current.addEventListener('canplaythrough', handleCanPlayThrough);
    }
  };

  if (!isOpen || videoFiles.length === 0) {
    return null;
  }

  const currentVideo = videoFiles[currentVideoIndex];

  return (
    <div 
      ref={containerRef}
      className="fixed inset-0 bg-noche z-[9999] flex items-center justify-center"
      onMouseMove={handleMouseMove}
      style={{ cursor: showControls ? 'default' : 'none' }}
    >
      {/* Doble buffer de videos - Corte instantáneo */}
      {/* Video Player A */}
      <video
        ref={videoRefA}
        src={activePlayer === 'A' ? currentVideo.url : ''}
        className={`absolute inset-0 w-full h-full object-contain ${
          activePlayer === 'A' ? 'z-50' : 'z-10'
        }`}
        style={{ 
          opacity: activePlayer === 'A' ? 1 : 0,
          pointerEvents: activePlayer === 'A' ? 'auto' : 'none'
        }}
        onEnded={activePlayer === 'A' ? handleVideoEnded : undefined}
        onLoadedData={activePlayer === 'A' ? handleVideoLoadedData : undefined}
        muted={isMuted}
        autoPlay={activePlayer === 'A'}
        playsInline
      />
      
      {/* Video Player B */}
      <video
        ref={videoRefB}
        src={activePlayer === 'B' ? currentVideo.url : ''}
        className={`absolute inset-0 w-full h-full object-contain ${
          activePlayer === 'B' ? 'z-50' : 'z-10'
        }`}
        style={{ 
          opacity: activePlayer === 'B' ? 1 : 0,
          pointerEvents: activePlayer === 'B' ? 'auto' : 'none'
        }}
        onEnded={activePlayer === 'B' ? handleVideoEnded : undefined}
        onLoadedData={activePlayer === 'B' ? handleVideoLoadedData : undefined}
        muted={isMuted}
        autoPlay={activePlayer === 'B'}
        playsInline
      />

      {/* Controles superpuestos */}
      <div 
        className={`absolute inset-0 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Header con información del video */}
        <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent p-6">
          <div className="flex items-center justify-between">
            <div className="text-white">
              <h1 className="text-xl font-semibold mb-2">{currentVideo.name}</h1>
              <p className="text-white/80 text-sm flex items-center gap-3">
                <span>Video {currentVideoIndex + 1} de {videoFiles.length}</span>
                {nextVideoPreloaded && videoFiles.length > 1 && (
                  <span className="inline-flex items-center gap-1 text-green-400 text-xs">
                    <span className="w-2 h-2 bg-green-400 rounded-full"></span>
                    Pre-cargado
                  </span>
                )}
                {currentVideo.tags.length > 0 && (
                  <span className="inline-flex items-center gap-2">
                    {currentVideo.tags.slice(0, 3).map((tag) => (
                      <span 
                        key={tag}
                        className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-lavanda-claro text-marfil font-medium"
                      >
                        {tag}
                      </span>
                    ))}
                    {currentVideo.tags.length > 3 && (
                      <span className="text-xs text-white/80">+{currentVideo.tags.length - 3}</span>
                    )}
                  </span>
                )}
              </p>
            </div>
            <button
              onClick={handleClose}
              className="text-white/80 hover:text-white transition-colors p-2 rounded-full hover:bg-tinta/20"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Controles centrales */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center space-x-8">
            <button
              onClick={previousVideo}
              className="text-white/80 hover:text-white transition-colors p-4 rounded-full hover:bg-tinta/20"
              disabled={videoFiles.length <= 1}
            >
              <SkipBack className="w-8 h-8" />
            </button>
            
            <button
              onClick={togglePlayPause}
              className="text-white bg-tinta/20 hover:bg-tinta/30 transition-colors p-6 rounded-full"
            >
              {isPlaying ? (
                <Pause className="w-10 h-10" />
              ) : (
                <Play className="w-10 h-10 ml-1" />
              )}
            </button>
            
            <button
              onClick={nextVideo}
              className="text-white/80 hover:text-white transition-colors p-4 rounded-full hover:bg-tinta/20"
              disabled={videoFiles.length <= 1}
            >
              <SkipForward className="w-8 h-8" />
            </button>
          </div>
        </div>

        {/* Controles inferiores */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <button
                onClick={toggleMute}
                className="text-white/80 hover:text-white transition-colors p-2 rounded-full hover:bg-tinta/20"
              >
                {isMuted ? (
                  <VolumeX className="w-5 h-5" />
                ) : (
                  <Volume2 className="w-5 h-5" />
                )}
              </button>
              <span className="text-white/80 text-sm">
                {isMuted ? 'Silenciado' : 'Con audio'}
              </span>
            </div>

            <div className="text-white/80 text-sm">
              <div className="flex items-center space-x-4">
                <span>Modo Presentación</span>
                <span className="text-white/60">|</span>
                <span>ESC para salir</span>
                <span className="text-white/60">|</span>
                <span>Espacio: Play/Pausa</span>
                <span className="text-white/60">|</span>
                <span>← → Cambiar video</span>
              </div>
            </div>
          </div>

          {/* Indicador de progreso de la lista */}
          <div className="mt-4">
            <div className="w-full bg-tinta/20 rounded-full h-1">
              <div
                className="bg-tinta rounded-full h-1 transition-all duration-300"
                style={{
                  width: `${((currentVideoIndex + 1) / videoFiles.length) * 100}%`
                }}
              />
            </div>
            <div className="flex justify-between mt-2 text-xs text-white/60">
              <span>Inicio de la lista</span>
              <span>Reproducción en bucle activa</span>
              <span>Final de la lista</span>
            </div>
          </div>
        </div>
      </div>

      {/* Overlay para clicks en el video */}
      <div 
        className="absolute inset-0 cursor-pointer"
        onClick={togglePlayPause}
        style={{ cursor: showControls ? 'pointer' : 'none' }}
      />
    </div>
  );
}