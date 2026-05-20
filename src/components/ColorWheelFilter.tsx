import React, { useEffect, useRef, useState } from 'react';
import { Palette, X } from 'lucide-react';
import { api } from '../services/api';

/**
 * Rueda HSL como filtro rapido de color en QuickFilters.
 *
 * UX:
 *  - Boton pequeño con icono Palette al lado de "Fechas".
 *  - Al pulsar abre un popover con una rueda canvas (hue=angulo, sat=radio,
 *    lightness=slider).
 *  - Click en la rueda → calcula el hex bajo el cursor, llama al endpoint
 *    /api/search/by-color y devuelve el set de fileIds que matchean.
 *  - Slider "tono exacto ↔ familia cromatica" controla el threshold (Delta E).
 *  - Boton X para limpiar.
 *
 * Comunica con App.tsx via onColorFilterChange — recibe `fileIds` (Set) que
 * applyAllFilters cruza con el resto de filtros (AND con tags, personas, etc.).
 */

interface ColorWheelFilterProps {
  onColorFilterChange: (fileIds: Set<string> | null, hex: string | null) => void;
  // Hex activo segun el padre. Sirve para que "Limpiar todos los filtros"
  // (que vive en App.tsx) tambien resetee el estado interno de la rueda.
  // Cuando el padre lo cambia a null, este componente borra su seleccion.
  activeHex?: string | null;
}

const WHEEL_SIZE = 200;
const RADIUS = WHEEL_SIZE / 2;

// Convierte HSL → hex usando rangos [0..360] / [0..100] / [0..100]
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// Dibuja la rueda HSL en el canvas dado, con la lightness solicitada.
function drawWheel(canvas: HTMLCanvasElement, lightness: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  // Pintar pixel por pixel — 200x200 = 40k pixeles, manejable
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > RADIUS) continue;
      // angulo en grados, 0 = derecha, sentido horario
      let angle = Math.atan2(dy, dx) * 180 / Math.PI;
      if (angle < 0) angle += 360;
      const sat = (dist / RADIUS) * 100;
      const hex = hslToHex(angle, sat, lightness);
      // Parse hex a rgb
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const idx = (y * w + x) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export default function ColorWheelFilter({ onColorFilterChange, activeHex }: ColorWheelFilterProps) {
  const [open, setOpen] = useState(false);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(25);
  const [lightness, setLightness] = useState(50);
  const [marker, setMarker] = useState<{ x: number; y: number } | null>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Redibujar la rueda cuando cambia la lightness
  useEffect(() => {
    if (open && canvasRef.current) {
      drawWheel(canvasRef.current, lightness);
    }
  }, [open, lightness]);

  // Cerrar al hacer click fuera
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Sincronizar con el estado del padre: si el padre limpia el filtro (ej.
  // "Limpiar todos los filtros" o tecla ESC), borrar tambien la seleccion
  // interna para que la UI refleje el estado real.
  useEffect(() => {
    if (activeHex === null || activeHex === undefined) {
      setSelectedHex(null);
      setMarker(null);
      setMatchCount(null);
    }
  }, [activeHex]);

  const applyColorFilter = async (hex: string, thr: number) => {
    setLoading(true);
    try {
      const r: any = await api.searchByColor(hex, thr);
      if (r.success && Array.isArray(r.data)) {
        const ids = new Set<string>(r.data.map((x: any) => x.fileId));
        setMatchCount(ids.size);
        onColorFilterChange(ids, hex);
      } else {
        setMatchCount(0);
        onColorFilterChange(new Set(), hex);
      }
    } catch (err) {
      console.warn('[color-filter] error:', err);
      setMatchCount(0);
      onColorFilterChange(new Set(), hex);
    } finally {
      setLoading(false);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - RADIUS;
    const dy = y - RADIUS;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > RADIUS) return; // fuera de la rueda
    let angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    const sat = Math.min(100, (dist / RADIUS) * 100);
    const hex = hslToHex(angle, sat, lightness);
    setSelectedHex(hex);
    setMarker({ x, y });
    applyColorFilter(hex, threshold);
  };

  const handleThresholdChange = (val: number) => {
    setThreshold(val);
    if (selectedHex) {
      // Re-aplicar con el nuevo threshold (debounce minimo via render)
      applyColorFilter(selectedHex, val);
    }
  };

  const handleClear = () => {
    setSelectedHex(null);
    setMarker(null);
    setMatchCount(null);
    onColorFilterChange(null, null);
    setOpen(false);
  };

  const buttonActive = !!selectedHex;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 px-3 md:px-4 py-1.5 md:py-2 rounded-full text-sm font-medium transition-all duration-200 ${
          buttonActive
            ? 'bg-lavanda text-white shadow-md'
            : 'bg-pizarra text-lavanda-archivo hover:bg-lavanda hover:bg-opacity-20'
        }`}
        title="Filtrar por color dominante"
      >
        {buttonActive && selectedHex ? (
          <span
            className="w-4 h-4 rounded-full border border-white/40"
            style={{ backgroundColor: selectedHex }}
          />
        ) : (
          <Palette className="w-4 h-4" />
        )}
        <span className="hidden sm:inline">
          {buttonActive ? (matchCount != null ? `${matchCount} con ${selectedHex}` : selectedHex) : 'Color'}
        </span>
        {buttonActive && (
          <button
            onClick={(e) => { e.stopPropagation(); handleClear(); }}
            className="ml-1 hover:bg-white/20 rounded-full p-0.5"
            title="Limpiar filtro de color"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute top-full mt-2 right-0 z-50 bg-tinta border border-pizarra rounded-2xl shadow-2xl p-4 w-[260px]"
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-marfil">Filtrar por color</h3>
            <button
              onClick={() => setOpen(false)}
              className="text-lavanda-archivo hover:text-marfil"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="relative mx-auto" style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}>
            <canvas
              ref={canvasRef}
              width={WHEEL_SIZE}
              height={WHEEL_SIZE}
              onClick={handleCanvasClick}
              className="cursor-crosshair rounded-full"
              style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
            />
            {marker && (
              <div
                className="absolute pointer-events-none border-2 border-white rounded-full shadow-lg"
                style={{
                  left: marker.x - 8,
                  top: marker.y - 8,
                  width: 16,
                  height: 16,
                  backgroundColor: selectedHex || 'transparent',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.3)',
                }}
              />
            )}
          </div>

          <div className="mt-4 space-y-3">
            <label className="block">
              <div className="flex items-center justify-between mb-1 text-xs text-lavanda-archivo">
                <span>Claridad</span>
                <span className="font-mono">{lightness}</span>
              </div>
              <input
                type="range"
                min={15}
                max={85}
                value={lightness}
                onChange={(e) => setLightness(parseInt(e.target.value, 10))}
                className="w-full accent-lavanda"
              />
            </label>

            <label className="block">
              <div className="flex items-center justify-between mb-1 text-xs text-lavanda-archivo">
                <span>Tolerancia</span>
                <span className="font-mono">{threshold}</span>
              </div>
              <input
                type="range"
                min={5}
                max={60}
                value={threshold}
                onChange={(e) => handleThresholdChange(parseInt(e.target.value, 10))}
                className="w-full accent-lavanda"
              />
              <div className="flex justify-between text-[10px] text-bruma mt-0.5">
                <span>exacto</span>
                <span>familia</span>
              </div>
            </label>

            <div className="text-xs text-lavanda-archivo">
              {loading ? 'Buscando...' : selectedHex ? (
                matchCount != null
                  ? `${matchCount} ${matchCount === 1 ? 'archivo' : 'archivos'} con tonos parecidos a `
                  : 'Color: '
              ) : 'Pulsa sobre la rueda para elegir un tono'}
              {selectedHex && (
                <span className="font-mono text-marfil ml-1">{selectedHex}</span>
              )}
            </div>

            {selectedHex && (
              <button
                onClick={handleClear}
                className="w-full text-xs text-lavanda hover:text-lavanda-claro py-1"
              >
                Limpiar filtro
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
