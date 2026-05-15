import React, { useState, useRef, useEffect, useCallback } from 'react';
import { VideoItem } from '../types';
import { useHoverPreview } from '../hooks/useHoverPreview';

interface VideoThumbnailProps {
  video: VideoItem;
  hoverDelayMs?: number;
  className?: string;
}

export default function VideoThumbnail({ 
  video, 
  hoverDelayMs = 450, 
  className = '' 
}: VideoThumbnailProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [hasFinePointer, setHasFinePointer] = useState(true);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const intersectionRef = useRef<IntersectionObserver | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { isHovering, onEnter, onLeave } = useHoverPreview({ delayMs: hoverDelayMs });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(pointer: fine)');
    setHasFinePointer(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setHasFinePointer(e.matches);
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    } else {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
  }, []);

  const setupIntersectionObserver = useCallback(() => {
    if (intersectionRef.current || !containerRef.current) return;

    intersectionRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting && videoRef.current) {
            videoRef.current.pause();
            setVideoReady(false);
          }
        });
      },
      { threshold: 0 }
    );

    intersectionRef.current.observe(containerRef.current);
  }, []);

  const cleanupIntersectionObserver = useCallback(() => {
    if (intersectionRef.current) {
      intersectionRef.current.disconnect();
      intersectionRef.current = null;
    }
  }, []);

  useEffect(() => {
    setupIntersectionObserver();
    return cleanupIntersectionObserver;
  }, [setupIntersectionObserver, cleanupIntersectionObserver]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isHovering && hasFinePointer && !hasError) {
      if (document.visibilityState !== 'visible') return;

      setIsLoading(true);
      video.preload = 'metadata';
      
      const handleCanPlay = () => {
        setIsLoading(false);
        setVideoReady(true);
        video.currentTime = 0;
        video.play().catch(() => {
          setHasError(true);
          setVideoReady(false);
        });
      };

      const handleError = () => {
        setHasError(true);
        setIsLoading(false);
        setVideoReady(false);
      };

      video.addEventListener('canplay', handleCanPlay);
      video.addEventListener('error', handleError);

      return () => {
        video.removeEventListener('canplay', handleCanPlay);
        video.removeEventListener('error', handleError);
      };
    } else {
      if (video) {
        video.pause();
        video.preload = 'none';
      }
      setIsLoading(false);
      setVideoReady(false);
    }
  }, [isHovering, hasFinePointer, hasError]);

  const handleMouseEnter = () => {
    if (hasFinePointer && !hasError) {
      onEnter();
    }
  };

  const handleMouseLeave = () => {
    onLeave();
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  };

  const shouldShowVideo = isHovering && hasFinePointer && videoReady && !hasError;

  return (
    <div
      ref={containerRef}
      className={`video-thumbnail ${className}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      aria-label={video.name}
    >
      <img
        src={video.thumbnail}
        alt={video.name}
        className={`preview-image fade-in ${shouldShowVideo ? '' : 'ready'}`}
      />
      
      {hasFinePointer && !hasError && (
        <video
          ref={videoRef}
          src={video.url}
          className={`preview-video fade-in ${shouldShowVideo ? 'ready' : ''}`}
          muted
          loop
          playsInline
          preload="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none'
          }}
        />
      )}
      
      {isLoading && (
        <div 
          className="loading-indicator"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            opacity: 0.7
          }}
        >
          ...
        </div>
      )}
    </div>
  );
}