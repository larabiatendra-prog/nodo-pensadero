import React, { useState, useEffect } from 'react';
import { ChevronUp } from 'lucide-react';

export function ScrollToTopButton() {
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 400);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!showScrollTop) return null;

  return (
    <button
      onClick={scrollToTop}
      className="p-3 bg-lavanda text-white rounded-full shadow-lg hover:bg-opacity-90 transition-all duration-300 hover:scale-110"
      aria-label="Volver arriba"
      title="Volver arriba"
    >
      <ChevronUp className="w-5 h-5" />
    </button>
  );
}