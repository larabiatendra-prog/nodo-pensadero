import { useState, useCallback, useRef } from 'react';

interface UseHoverPreviewOptions {
  delayMs?: number;
}

export function useHoverPreview({ delayMs = 450 }: UseHoverPreviewOptions = {}) {
  const [isHovering, setIsHovering] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const onEnter = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setIsHovering(true);
      timeoutRef.current = null;
    }, delayMs);
  }, [delayMs]);

  const onLeave = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsHovering(false);
  }, []);

  return {
    isHovering,
    onEnter,
    onLeave
  };
}