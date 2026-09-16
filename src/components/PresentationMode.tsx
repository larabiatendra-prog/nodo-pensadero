import { useState, useEffect, useRef } from 'react';
import { X, Play, Pause, SkipForward, SkipBack, Volume2, VolumeX } from 'lucide-react';
import { MediaFile } from '../types';
import { resolvePlayable } from '../utils/playable';

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
  // Doble buffer: que player ('A'/'B') muestra el video activo
  const [activePlayer, setActivePlayer] = useState<'A' | 'B'>('A');
  const [isPreloaded, setIsPreloaded] = useState(false);

  // Referencias duales para doble buffer
  const videoRefA = useRef<HTMLVideoElement>(null);
  const videoRefB = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Solo videos
  const videoFiles = videos.filter(file => file.type === 'video');
  const total = videoFiles.length;

  const getActiveVideoRef = () => (activePlayer === 'A' ? videoRefA : videoRefB);
  const getInactiveVideoRef = () => (activePlayer === 'A' ? videoRefB : videoRefA);

  // El indice vive en estado, pero la LISTA puede cambiar debajo: abrir el pase
  // de una sesion corta despues de uno largo, un filtro, el randomizador o una
  // actualizacion por WebSocket. El reset a 0 llega en un efecto, o sea un
  // render DESPUES, y para entonces ya habriamos leido fuera de rango
  // (videoFiles[i] === undefined, y al pintar su nombre reventaba la vista).
  // Acotar aqui cubre de una vez todos los usos derivados.
  const indiceActual = currentVideoIndex < total ? currentVideoIndex : 0;

  const nextIndex = total > 0 ? (indiceActual + 1) % total : 0;

  // URLs reproducibles (proxy MP4 para formatos no web-nativos). Se resuelven
  // para el video actual y el siguiente (precarga). Cache por fileId.
  const [resolvedUrls, setResolvedUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!isOpen) return;
    const ctrl = new AbortController();
    const targets = [videoFiles[indiceActual], videoFiles[nextIndex]].filter(Boolean) as MediaFile[];
    for (const f of targets) {
      if (resolvedUrls[f.id]) continue;
      resolvePlayable(f.id, { signal: ctrl.signal })
        .then(info => {
          if (!ctrl.signal.aborted && info.url && (info.status === 'native' || info.status === 'ready')) {
            setResolvedUrls(prev => (prev[f.id] ? prev : { ...prev, [f.id]: info.url! }));
          }
        })
        .catch(() => {});
    }
    return () => ctrl.abort();
  }, [isOpen, indiceActual, nextIndex]);

  const activeUrl = resolvedUrls[videoFiles[indiceActual]?.id] ?? '';
  const inactiveUrl = resolvedUrls[videoFiles[nextIndex]?.id] ?? '';

  // Avanzar: swap de player + indice. El inactivo ya tiene precargado el siguiente,
  // asi que el corte es instantaneo. Setters funcionales => sin estado obsoleto.
  const advance = () => {
    if (total <= 1) return;
    setActivePlayer(p => (p === 'A' ? 'B' : 'A'));
    setCurrentVideoIndex(i => (i + 1) % total);
  };

  // Retroceder: no precargamos hacia atras, solo cambiamos indice (recarga el activo).
  const goPrev = () => {
    if (total <= 1) return;
    setCurrentVideoIndex(i => (i === 0 ? total - 1 : i - 1));
  };

  const togglePlayPause = () => setIsPlaying(p => !p);
  const toggleMute = () => setIsMuted(m => !m);

  // Reset al abrir
  useEffect(() => {
    if (isOpen) {
      setCurrentVideoIndex(0);
      setActivePlayer('A');
      setIsPlaying(true);
      setShowControls(true);
    }
  }, [isOpen]);

  // Salir limpio: abandona pantalla completa y cierra
  const handleClose = async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (error) {
        console.warn('Error saliendo de pantalla completa:', error);
      }
    }
    onClose();
  };

  // Pantalla completa + teclado. handleClose y los setters son funcionales,
  // por eso este efecto solo depende de isOpen/total y no captura estado obsoleto.
  useEffect(() => {
    if (!isOpen) return;

    const enterFullscreen = async () => {
      if (containerRef.current) {
        try {
          await containerRef.current.requestFullscreen();
        } catch (error) {
          console.warn('No se pudo entrar en pantalla completa:', error);
        }
      }
    };
    enterFullscreen();

    // Si el usuario sale de fullscreen (ESC del navegador), cerramos el modo
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) onClose();
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          handleClose();
          break;
        case ' ':
          event.preventDefault();
          togglePlayPause();
          break;
        case 'ArrowRight':
          event.preventDefault();
          advance();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          goPrev();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, total]);

  // Auto-ocultar controles
  useEffect(() => {
    if (!showControls) return;
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [showControls]);

  // Control unico de reproduccion: reacciona al swap/indice/play/mute.
  // El activo reproduce segun isPlaying; el inactivo queda pausado y silenciado
  // (precarga). Asi no hay logica de play dispersa ni audio del buffer oculto.
  useEffect(() => {
    if (!isOpen) return;
    const active = getActiveVideoRef().current;
    const inactive = getInactiveVideoRef().current;
    if (active) {
      active.muted = isMuted;
      if (isPlaying) {
        active.play().catch(error => console.warn('Error reproduciendo video:', error));
      } else {
        active.pause();
      }
    }
    if (inactive) {
      inactive.muted = true;
      inactive.pause();
    }
    // activeUrl entra en las dependencias a proposito: al abrir, la URL
    // reproducible aun se esta resolviendo y el elemento no tiene src todavia.
    // Sin esto el play() se lanza en vacio y el pase se queda parado en el
    // primer clip hasta que le das al play a mano.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, indiceActual, activePlayer, isPlaying, isMuted, activeUrl]);

  // Resetear indicador de precarga al cambiar de video
  useEffect(() => {
    setIsPreloaded(false);
  }, [currentVideoIndex]);

  const handleMouseMove = () => setShowControls(true);

  if (!isOpen || total === 0) return null;

  const currentVideo = videoFiles[indiceActual];
  // Cinturon: si aun asi no hubiera video, no pintamos en vez de reventar.
  if (!currentVideo) return null;
  const isActiveA = activePlayer === 'A';

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 bg-noche z-[9999] flex items-center justify-center"
      onMouseMove={handleMouseMove}
      style={{ cursor: showControls ? 'default' : 'none' }}
    >
      {/* Doble buffer: el src se controla SOLO de forma declarativa.
          Activo = video actual; inactivo = siguiente (precarga). Al hacer swap,
          el inactivo ya cargado pasa a activo sin recargar => corte instantaneo. */}
      <video
        ref={videoRefA}
        src={isActiveA ? activeUrl : inactiveUrl}
        preload="auto"
        className={`absolute inset-0 w-full h-full object-contain ${isActiveA ? 'z-10' : 'z-0'}`}
        style={{ opacity: isActiveA ? 1 : 0, pointerEvents: 'none' }}
        onEnded={isActiveA ? advance : undefined}
        onCanPlayThrough={!isActiveA ? () => setIsPreloaded(true) : undefined}
        playsInline
      />
      <video
        ref={videoRefB}
        src={!isActiveA ? activeUrl : inactiveUrl}
        preload="auto"
        className={`absolute inset-0 w-full h-full object-contain ${!isActiveA ? 'z-10' : 'z-0'}`}
        style={{ opacity: !isActiveA ? 1 : 0, pointerEvents: 'none' }}
        onEnded={!isActiveA ? advance : undefined}
        onCanPlayThrough={isActiveA ? () => setIsPreloaded(true) : undefined}
        playsInline
      />

      {/* Overlay de click (toggle play). Encima del video (z-10), debajo de controles (z-30). */}
      <div
        className="absolute inset-0 z-20"
        onClick={togglePlayPause}
        style={{ cursor: showControls ? 'pointer' : 'none' }}
      />

      {/* Controles superpuestos */}
      <div
        className={`absolute inset-0 z-30 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Header con informacion del video */}
        <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent p-6">
          <div className="flex items-center justify-between">
            <div className="text-white">
              <h1 className="text-xl font-semibold mb-2" title={currentVideo.name}>{currentVideo.displayName || currentVideo.name}</h1>
              <p className="text-white/80 text-sm flex items-center gap-3">
                <span>Video {indiceActual + 1} de {total}</span>
                {isPreloaded && total > 1 && (
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
              onClick={goPrev}
              className="text-white/80 hover:text-white transition-colors p-4 rounded-full hover:bg-tinta/20"
              disabled={total <= 1}
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
              onClick={advance}
              className="text-white/80 hover:text-white transition-colors p-4 rounded-full hover:bg-tinta/20"
              disabled={total <= 1}
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
                  width: `${((indiceActual + 1) / total) * 100}%`
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
    </div>
  );
}
