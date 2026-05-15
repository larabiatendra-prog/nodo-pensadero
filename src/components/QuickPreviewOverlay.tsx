import React, { useEffect, useRef } from 'react';
import { MediaFile } from '../types';

interface QuickPreviewOverlayProps {
  file: MediaFile;
  onClose: () => void;
}

export function QuickPreviewOverlay({ file, onClose }: QuickPreviewOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Auto-pause video after 4 seconds; restart on file change
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    video.play().catch(() => {});
    const timer = setTimeout(() => video.pause(), 4000);
    return () => clearTimeout(timer);
  }, [file]);

  const isVideo = file.type === 'video' || file.type === 'export';
  const isAudio = file.type === 'audio';

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
          <span className="text-sm text-white font-medium truncate max-w-[85vw] md:max-w-[60vw] block">
            {file.name}
          </span>
        </div>

        {/* Media */}
        <div className="rounded-3xl overflow-hidden shadow-2xl bg-noche">
          {isVideo ? (
            <video
              ref={videoRef}
              src={file.url}
              autoPlay
              muted
              playsInline
              className="max-w-[85vw] max-h-[75vh] object-contain"
            />
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
