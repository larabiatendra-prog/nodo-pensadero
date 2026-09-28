import { useEffect, useState } from 'react';
import { ACOTAR, claveSugerencias, type SugerenciaAcotar } from '../utils/acotar';

interface AcotarProps {
  sugerencias: SugerenciaAcotar[];
  /** Pulsar una pill la convierte en etiqueta normal (con su chip y su "Limpiar"). */
  onElegir: (etiqueta: string) => void;
}

/**
 * «Acotar:» — por donde se puede seguir estrechando lo que se ve. Las pills
 * van semitransparentes porque aun no son filtros; al pasar por encima se
 * encienden con el color de acento. En el movil, una sola linea con scroll
 * horizontal (con salto de linea, cinco pills serian cinco renglones); desde
 * tablet, salto de linea normal.
 */
export default function Acotar({ sugerencias, onElegir }: AcotarProps) {
  const [abierto, setAbierto] = useState(false);

  // Si cambian las sugerencias (por contenido, no por referencia), se pliega.
  const clave = claveSugerencias(sugerencias);
  useEffect(() => { setAbierto(false); }, [clave]);

  if (sugerencias.length === 0) return null;
  const visibles = abierto ? sugerencias : sugerencias.slice(0, ACOTAR.visibles);
  const ocultas = sugerencias.length - ACOTAR.visibles;

  return (
    <div className="mt-2 flex items-center gap-1.5 overflow-x-auto md:flex-wrap md:overflow-visible pb-1 md:pb-0 px-1">
      <span className="flex-shrink-0 text-xs text-humo mr-0.5">Acotar:</span>
      {visibles.map(s => (
        <button
          key={s.etiqueta}
          type="button"
          onClick={() => onElegir(s.etiqueta)}
          title={`Acotar a los ${s.n} archivos con "${s.etiqueta}"`}
          className="group flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs border border-borde-sutil bg-grafito/60 text-niebla opacity-70 whitespace-nowrap transition-all duration-150 hover:opacity-100 hover:bg-lavanda hover:border-lavanda hover:text-noche focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lavanda"
        >
          <span>{s.etiqueta}</span>
          <span className="text-humo group-hover:text-noche/70">{s.n}</span>
        </button>
      ))}
      {ocultas > 0 && (
        <button
          type="button"
          onClick={() => setAbierto(a => !a)}
          className="flex-shrink-0 px-1.5 text-xs text-lavanda-archivo hover:text-lavanda whitespace-nowrap transition-colors"
        >
          {abierto ? 'Mostrar menos' : `+${ocultas} más`}
        </button>
      )}
    </div>
  );
}
