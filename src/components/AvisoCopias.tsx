import { useEffect, useState } from 'react';
import { Copy, Loader2, Sparkles, X } from 'lucide-react';
import { api } from '../services/api';
import type { CopiasResumen } from '../types';
import { limpiarCopiasConDeshacer, textoDuplicados } from '../utils/copias';

/**
 * Aviso de copias exactas, abajo a la izquierda de la home.
 *
 * Sale cuando el mismo archivo esta a la vista en mas de un sitio y nadie ha
 * decidido cual se queda: lo tipico al conectar un disco junto a su copia de
 * seguridad. Dos salidas: que lo decida el sistema, o revisarlas una a una en
 * Tomas gemelas.
 *
 * Cerrarlo no lo silencia para siempre: vuelve si aparecen MAS copias que las
 * que habia al cerrarlo (otro disco, otra carpeta duplicada). Un aviso que
 * vuelve con el mismo numero cada vez deja de leerse.
 */

const CLAVE_CERRADO = 'pensadero.copias.avisoCerradoCon';

interface Props {
  /** Cambia cada vez que se recarga la lista de archivos: se vuelve a preguntar. */
  recarga: unknown;
  onRevisar: () => void;
}

export default function AvisoCopias({ recarga, onRevisar }: Props) {
  const [resumen, setResumen] = useState<CopiasResumen | null>(null);
  const [cerradoCon, setCerradoCon] = useState<number>(() => {
    try { return Number(localStorage.getItem(CLAVE_CERRADO)) || 0; } catch { return 0; }
  });
  const [limpiando, setLimpiando] = useState(false);

  const pedir = () => {
    api.getCopiasResumen()
      .then(r => { if (r.success && r.data) setResumen(r.data); })
      // Sin respuesta no hay aviso: no es algo que deba tapar la galeria.
      .catch(() => setResumen(null));
  };

  useEffect(pedir, [recarga]);

  const n = resumen?.sobrantes ?? 0;
  if (!resumen || n === 0 || n <= cerradoCon) return null;

  const cerrar = () => {
    setCerradoCon(n);
    try { localStorage.setItem(CLAVE_CERRADO, String(n)); } catch { /* modo privado */ }
  };

  const limpiar = async () => {
    setLimpiando(true);
    await limpiarCopiasConDeshacer(pedir);
    setLimpiando(false);
  };

  return (
    <div
      role="status"
      className="fixed bottom-6 left-6 z-40 w-[calc(100vw-3rem)] max-w-[340px] rounded-2xl bg-tinta/95 backdrop-blur-sm border border-borde-sutil shadow-2xl p-4"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 w-8 h-8 rounded-full bg-pizarra text-lavanda flex items-center justify-center shrink-0">
          <Copy className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-marfil">{textoDuplicados(n)}</p>
          <p className="mt-0.5 text-xs text-humo leading-relaxed">
            Son el mismo archivo en más de un sitio y salen repetidos en la galería.
            Esconder las copias no borra nada.
          </p>
        </div>
        <button
          onClick={cerrar}
          aria-label="Cerrar el aviso"
          title="Cerrar. Vuelve si aparecen más copias."
          className="-mt-1 -mr-1 p-1 rounded-full text-humo hover:text-marfil hover:bg-pizarra transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={limpiar}
          disabled={limpiando}
          title="Se queda una copia de cada archivo: la que tenga algo tuyo, la que no esté en un disco de copia de seguridad, la más escaneada…"
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-60 transition-colors"
        >
          {limpiando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          Limpiar automáticamente
        </button>
        <button
          onClick={onRevisar}
          className="flex-1 px-3 py-2 rounded-full text-xs font-medium bg-pizarra text-niebla hover:text-marfil transition-colors"
        >
          Revisarlas
        </button>
      </div>
    </div>
  );
}
