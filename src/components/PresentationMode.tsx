import { useState, useEffect, useRef } from 'react';
import { X, Play, Pause, SkipForward, SkipBack, Volume2, VolumeX } from 'lucide-react';
import { MediaFile } from '../types';
import { resolvePlayable } from '../utils/playable';
import { guardarVolumen, leerVolumen, tiempoCorto } from '../utils/volumen';

/** Lo que salta un Shift + flecha dentro del clip. */
const SALTO_S = 10;

interface PresentationModeProps {
  videos: MediaFile[];
  isOpen: boolean;
  onClose: () => void;
}

export default function PresentationMode({ videos, isOpen, onClose }: PresentationModeProps) {
  const [currentVideoIndex, setCurrentVideoIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  // Volumen y silencio salen de donde los dejo el otro reproductor.
  const [isMuted, setIsMuted] = useState(() => leerVolumen().muted);
  const [volumen, setVolumen] = useState(() => leerVolumen().volume);
  // Donde va el clip y cuanto dura: sin esto no habia forma de saber si
  // quedaban diez segundos o tres minutos, ni de moverse dentro.
  const [tiempo, setTiempo] = useState(0);
  const [duracion, setDuracion] = useState(0);
  const [arrastrando, setArrastrando] = useState(false);
  const [showControls, setShowControls] = useState(true);
  // Doble buffer: que player ('A'/'B') muestra el video activo
  const [activePlayer, setActivePlayer] = useState<'A' | 'B'>('A');
  const [isPreloaded, setIsPreloaded] = useState(false);

  // Referencias duales para doble buffer
  const videoRefA = useRef<HTMLVideoElement>(null);
  const videoRefB = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const barraRef = useRef<HTMLDivElement>(null);
  // El atajo de teclado se registra una vez y viviria con un activePlayer
  // viejo: por eso el player activo tambien va en una ref.
  const activePlayerRef = useRef<'A' | 'B'>('A');

  // Solo videos
  const videoFiles = videos.filter(file => file.type === 'video');
  const total = videoFiles.length;

  const getActiveVideoRef = () => (activePlayer === 'A' ? videoRefA : videoRefB);
  const getInactiveVideoRef = () => (activePlayer === 'A' ? videoRefB : videoRefA);
  /** El <video> que se esta viendo, valido tambien dentro de los atajos. */
  const videoActivo = () => (activePlayerRef.current === 'A' ? videoRefA.current : videoRefB.current);
  activePlayerRef.current = activePlayer;

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

  // Un original que parecia compatible y no abre: se pide la version ligera
  // y se sustituye su URL. Solo una vez por archivo.
  const forzados = useRef(new Set<string>());
  const alFallar = (fileId: string | undefined) => {
    if (!fileId || forzados.current.has(fileId)) return;
    forzados.current.add(fileId);
    resolvePlayable(fileId, { forzarProxy: true })
      .then(info => {
        if (info.status === 'ready' && info.url) setResolvedUrls(prev => ({ ...prev, [fileId]: info.url! }));
      })
      .catch(() => {});
  };

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
  const toggleMute = () => setIsMuted(m => { guardarVolumen(volumen, !m); return !m; });

  /** Mueve el volumen y lo recuerda para los dos reproductores. */
  const cambiarVolumen = (v: number) => {
    const limpio = Math.min(1, Math.max(0, v));
    setVolumen(limpio);
    // Subir el volumen con el sonido quitado es querer oirlo.
    const silencio = limpio === 0 ? true : (limpio > 0 && isMuted ? false : isMuted);
    setIsMuted(silencio);
    guardarVolumen(limpio, silencio);
  };

  /** Salta dentro del clip (segundos, con signo). */
  const saltar = (segundos: number) => {
    const v = videoActivo();
    if (!v || !isFinite(v.duration)) return;
    v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + segundos));
    setTiempo(v.currentTime);
  };

  /** Lleva el clip al punto que se ha tocado en la barra. */
  const buscarEn = (clientX: number) => {
    const barra = barraRef.current;
    const v = videoActivo();
    if (!barra || !v || !isFinite(v.duration) || v.duration <= 0) return;
    const caja = barra.getBoundingClientRect();
    const parte = Math.min(1, Math.max(0, (clientX - caja.left) / caja.width));
    v.currentTime = parte * v.duration;
    setTiempo(v.currentTime);
  };

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
          // Con Shift no se cambia de clip: se avanza dentro de este.
          if (event.shiftKey) saltar(SALTO_S); else advance();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          if (event.shiftKey) saltar(-SALTO_S); else goPrev();
          break;
        case 'ArrowUp':
          event.preventDefault();
          setVolumen(v => { const n = Math.round(Math.min(1, v + 0.05) * 100) / 100; guardarVolumen(n, false); setIsMuted(false); return n; });
          break;
        case 'ArrowDown':
          event.preventDefault();
          setVolumen(v => { const n = Math.round(Math.max(0, v - 0.05) * 100) / 100; guardarVolumen(n, n === 0); if (n === 0) setIsMuted(true); return n; });
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
    // Arrastrando la barra los controles no pueden desaparecer debajo del dedo.
    if (arrastrando) return;
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [showControls, arrastrando]);

  // Control unico de reproduccion: reacciona al swap/indice/play/mute.
  // El activo reproduce segun isPlaying; el inactivo queda pausado y silenciado
  // (precarga). Asi no hay logica de play dispersa ni audio del buffer oculto.
  useEffect(() => {
    if (!isOpen) return;
    const active = getActiveVideoRef().current;
    const inactive = getInactiveVideoRef().current;
    if (active) {
      active.muted = isMuted;
      active.volume = volumen;
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
  }, [isOpen, indiceActual, activePlayer, isPlaying, isMuted, volumen, activeUrl]);

  // Al cambiar de clip o de buffer se lee el que se ve: si venia precargado,
  // su onLoadedMetadata salto hace rato y no volvera a saltar. Aqui se pone la
  // duracion Y se reinicia el tiempo; hacerlo en otro efecto aparte borraba la
  // duracion recien leida y la barra se quedaba en 0:00.
  useEffect(() => {
    const v = getActiveVideoRef().current;
    setDuracion(v && isFinite(v.duration) ? v.duration : 0);
    setTiempo(v ? v.currentTime || 0 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlayer, indiceActual, activeUrl]);

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
        onError={() => alFallar((isActiveA ? videoFiles[indiceActual] : videoFiles[nextIndex])?.id)}
        onCanPlayThrough={!isActiveA ? () => setIsPreloaded(true) : undefined}
        onTimeUpdate={isActiveA ? (e) => { if (!arrastrando) setTiempo(e.currentTarget.currentTime); } : undefined}
        onLoadedMetadata={isActiveA ? (e) => setDuracion(isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0) : undefined}
        onDurationChange={isActiveA ? (e) => setDuracion(isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0) : undefined}
        playsInline
      />
      <video
        ref={videoRefB}
        src={!isActiveA ? activeUrl : inactiveUrl}
        preload="auto"
        className={`absolute inset-0 w-full h-full object-contain ${!isActiveA ? 'z-10' : 'z-0'}`}
        style={{ opacity: !isActiveA ? 1 : 0, pointerEvents: 'none' }}
        onEnded={!isActiveA ? advance : undefined}
        onError={() => alFallar((!isActiveA ? videoFiles[indiceActual] : videoFiles[nextIndex])?.id)}
        onCanPlayThrough={isActiveA ? () => setIsPreloaded(true) : undefined}
        onTimeUpdate={!isActiveA ? (e) => { if (!arrastrando) setTiempo(e.currentTarget.currentTime); } : undefined}
        onLoadedMetadata={!isActiveA ? (e) => setDuracion(isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0) : undefined}
        onDurationChange={!isActiveA ? (e) => setDuracion(isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0) : undefined}
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
                        className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-lavanda-claro text-noche font-medium"
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
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-6 pb-5 pt-10">
          {/* La barra del CLIP (antes solo estaba la de la lista, y por eso no
              habia forma de ver cuanto quedaba ni de moverse dentro). */}
          <div className="flex items-center gap-3">
            <span className="text-white/80 text-xs tabular-nums w-14 text-right">{tiempoCorto(tiempo)}</span>
            <div
              ref={barraRef}
              className="relative flex-1 py-2 cursor-pointer group"
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setArrastrando(true); buscarEn(e.clientX); }}
              onPointerMove={(e) => { if (arrastrando) buscarEn(e.clientX); }}
              onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); setArrastrando(false); }}
              onPointerCancel={() => setArrastrando(false)}
              role="slider"
              aria-label="Punto del clip"
              aria-valuemin={0}
              aria-valuemax={Math.round(duracion) || 0}
              aria-valuenow={Math.round(tiempo)}
              tabIndex={0}
            >
              <div className="h-1 rounded-full bg-white/25 overflow-hidden">
                <div
                  className="h-full rounded-full bg-lavanda"
                  style={{ width: `${duracion > 0 ? (tiempo / duracion) * 100 : 0}%` }}
                />
              </div>
              <span
                className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-lavanda shadow transition-opacity ${arrastrando ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                style={{ left: `${duracion > 0 ? (tiempo / duracion) * 100 : 0}%` }}
              />
            </div>
            <span className="text-white/60 text-xs tabular-nums w-14">{tiempoCorto(duracion)}</span>
          </div>

          <div className="mt-1.5 flex items-end justify-between gap-6 flex-wrap">
            {/* Volumen de verdad, no solo silencio; y el mismo del otro reproductor */}
            <div className="flex items-center gap-2.5">
              <button
                onClick={toggleMute}
                title={isMuted ? 'Quitar el silencio (M)' : 'Silenciar (M)'}
                className="text-white/80 hover:text-white transition-colors p-2 rounded-full hover:bg-tinta/20"
              >
                {isMuted || volumen === 0 ? (
                  <VolumeX className="w-5 h-5" />
                ) : (
                  <Volume2 className="w-5 h-5" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={isMuted ? 0 : volumen}
                onChange={(e) => cambiarVolumen(parseFloat(e.target.value))}
                className="w-28 accent-lavanda cursor-pointer"
                aria-label="Volumen"
              />
              <span className="text-white/60 text-xs tabular-nums w-10">{Math.round((isMuted ? 0 : volumen) * 100)}%</span>
            </div>

            <div className="text-white/60 text-xs flex items-center gap-2.5 flex-wrap justify-end">
              <span className="text-white/80">Vídeo {indiceActual + 1} de {total}</span>
              <span className="text-white/25">|</span>
              <span>Espacio: pausa</span>
              <span className="text-white/25">|</span>
              <span>← → clip</span>
              <span className="text-white/25">|</span>
              <span>Shift + ← → {SALTO_S}s</span>
              <span className="text-white/25">|</span>
              <span>↑ ↓ volumen</span>
              <span className="text-white/25">|</span>
              <span>ESC salir</span>
            </div>
          </div>

          {/* Por donde va la lista */}
          <div className="mt-3 w-full bg-white/15 rounded-full h-[3px]">
            <div
              className="bg-white/45 rounded-full h-[3px] transition-all duration-300"
              style={{ width: `${((indiceActual + 1) / total) * 100}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
