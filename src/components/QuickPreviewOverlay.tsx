import React, { useEffect, useRef, useState } from 'react';
import { MediaFile } from '../types';
import { resolvePlayable } from '../utils/playable';

interface QuickPreviewOverlayProps {
  file: MediaFile;
  onClose: () => void;
}

export function QuickPreviewOverlay({ file, onClose }: QuickPreviewOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const isVideo = file.type === 'video' || file.type === 'export';
  const isAudio = file.type === 'audio';

  // URL reproducible (proxy MP4 si el formato original no es web-nativo).
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!isVideo) { setVideoSrc(null); return; }
    const ctrl = new AbortController();
    setVideoSrc(null);
    resolvePlayable(file.id, { signal: ctrl.signal })
      .then(info => { if (!ctrl.signal.aborted && (info.status === 'native' || info.status === 'ready')) setVideoSrc(info.url || null); })
      .catch(() => {});
    return () => ctrl.abort();
  }, [file.id, isVideo]);

  // Auto-pause video after 4 seconds; restart when the source is ready
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSrc) return;
    video.currentTime = 0;
    video.play().catch(() => {});
    const timer = setTimeout(() => video.pause(), 4000);
    return () => clearTimeout(timer);
  }, [videoSrc]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-noche/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-w-[85vw] max-h-[85vh] flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* File name */}
        <div className="mb-3 px-4 py-1.5 bg-noche/70 rounded-full">
          <span className="text-sm text-white font-medium truncate max-w-[85vw] md:max-w-[60vw] block" title={file.name}>
            {file.displayName || file.name}
          </span>
        </div>

        {/* Media */}
        <div className="rounded-3xl overflow-hidden shadow-2xl bg-noche">
          {isVideo ? (
            videoSrc ? (
              <video
                ref={videoRef}
                src={videoSrc}
                autoPlay
                muted
                playsInline
                className="max-w-[85vw] max-h-[75vh] object-contain"
              />
            ) : (
              <div className="w-80 h-48 flex items-center justify-center bg-pizarra">
                <span className="text-sm text-niebla">Preparando vídeo…</span>
              </div>
            )
          ) : isAudio ? (
            <div className="w-80 h-48 flex items-center justify-center bg-pizarra">
              <span className="text-6xl text-lavanda">&#9835;</span>
            </div>
          ) : (
            <img
              src={file.url}
              alt={file.name}
              className="max-w-[85vw] max-h-[75vh] object-contain"
            />
          )}
        </div>
      </div>
    </div>
  );
}
