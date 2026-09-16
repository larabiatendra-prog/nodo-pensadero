import { useEffect, useRef, useState } from 'react';
import { CalendarClock, UserRound, Compass, Layers, X, Shuffle, Quote, Users, CalendarRange, Sun, Palette, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Eco, TipoEco } from '../utils/ecos';

/**
 * Reposo activo: la banda donde el archivo habla primero.
 *
 * Va arriba de la galeria, solo en el inicio y sin filtros puestos. No es un
 * panel administrativo: es la experiencia principal, asi que puede respirar.
 * Pero tampoco secuestra la pantalla — una fila, y se cierra.
 *
 * Las tarjetas son del mismo material que la galeria (miniaturas del propio
 * eco a sangre, degradado, recuento) y no cajas con borde. Cada tipo tiene un
 * gesto propio para no ser ocho veces la misma tarjeta: el año en grande en un
 * aniversario, las caras en una pareja, la paleta en un color, la cita en una
 * nota. Y todas son una tira de pelicula: al pasar por encima, el material
 * desfila despacio, como pasar el dedo por un contacto.
 *
 * "Otros" baraja: otra seleccion del mismo dia, repetible (volver atras en el
 * giro devuelve lo que habia).
 */

const ICONO: Record<TipoEco, typeof Compass> = {
  aniversario: CalendarClock,
  sin_ver: UserRound,
  nota: Quote,
  pareja: Users,
  mes: CalendarRange,
  tema: Sun,
  color: Palette,
  rincon: Compass,
};

const RETRATO = (id: string) => `/persons-avatars/people/${encodeURIComponent(id)}/avatar.jpg`;

interface Props {
  ecos: Eco[];
  /** Eco abierto ahora mismo (su galeria esta filtrada), o null. */
  activoId: string | null;
  onAbrir: (eco: Eco) => void;
  onCerrar: () => void;
  /** Ocultar la banda durante el resto del dia. */
  onDescartar: () => void;
  /** Otra seleccion del dia. */
  onBarajar?: () => void;
  /** Cuantas veces se ha barajado: reinicia la animacion de entrada. */
  giro?: number;
}

export default function Ecos({ ecos, activoId, onAbrir, onCerrar, onDescartar, onBarajar, giro = 0 }: Props) {
  const filaRef = useRef<HTMLDivElement>(null);
  const [bordes, setBordes] = useState({ izq: false, der: false });

  // Flechas solo cuando hay por donde ir. En movil se arrastra con el dedo.
  const medir = () => {
    const el = filaRef.current;
    if (!el) return;
    setBordes({ izq: el.scrollLeft > 8, der: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 });
  };
  useEffect(() => {
    medir();
    const el = filaRef.current;
    if (!el) return;
    el.scrollTo({ left: 0 });
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ecos.length, giro]);

  if (!ecos || ecos.length === 0) return null;

  const desplazar = (dir: 1 | -1) => {
    const el = filaRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  return (
    <section aria-label="Ecos del archivo" className="mb-8">
      <div className="flex items-center justify-end gap-1 mb-2 px-0.5">
        {onBarajar && (
          <button
            onClick={onBarajar}
            className="group/barajar text-xs text-humo hover:text-niebla transition-colors flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda rounded px-1.5 py-0.5"
            title="Otra selección de recuerdos"
          >
            <Shuffle className="w-3 h-3 transition-transform duration-500 group-hover/barajar:rotate-180" aria-hidden="true" />
            otros
          </button>
        )}
        <button
          onClick={onDescartar}
          className="text-xs text-humo hover:text-niebla transition-colors flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda rounded px-1.5 py-0.5"
          title="Ocultar hasta mañana"
        >
          <X className="w-3 h-3" aria-hidden="true" />
          ocultar
        </button>
      </div>

      <div className="relative group/fila">
        <div
          ref={filaRef}
          onScroll={medir}
          className="flex gap-3 overflow-x-auto snap-x snap-mandatory scroll-smooth pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {ecos.map((eco, i) => (
            <Tarjeta
              key={`${eco.id}#${giro}`}
              eco={eco}
              destacada={i === 0}
              orden={i}
              activo={activoId === eco.id}
              onPulsar={() => (activoId === eco.id ? onCerrar() : onAbrir(eco))}
            />
          ))}
        </div>

        {/* Bordes que se desvanecen y flechas: dicen "hay mas" sin rotulo. */}
        {bordes.izq && (
          <>
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-noche to-transparent" />
            <button
              onClick={() => desplazar(-1)}
              aria-label="Recuerdos anteriores"
              className="hidden md:flex absolute left-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-noche/80 backdrop-blur text-marfil items-center justify-center opacity-0 group-hover/fila:opacity-100 hover:bg-grafito transition-opacity"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </>
        )}
        {bordes.der && (
          <>
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-noche to-transparent" />
            <button
              onClick={() => desplazar(1)}
              aria-label="Más recuerdos"
              className="hidden md:flex absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-noche/80 backdrop-blur text-marfil items-center justify-center opacity-0 group-hover/fila:opacity-100 hover:bg-grafito transition-opacity"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </>
        )}
      </div>

      <style>{`
        @keyframes eco-entra { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) { .eco-tarjeta, .eco-tira { animation: none !important; transition: none !important; } }
      `}</style>
    </section>
  );
}

function Tarjeta({ eco, destacada, orden, activo, onPulsar }: {
  eco: Eco;
  destacada: boolean;
  orden: number;
  activo: boolean;
  onPulsar: () => void;
}) {
  const Icono = ICONO[eco.tipo] || Compass;
  const thumbs = eco.thumbnails?.length ? eco.thumbnails : [];
  // Celdas visibles a la vez: la destacada enseña mas.
  const visibles = Math.min(thumbs.length, destacada ? 4 : 3) || 1;
  const sobran = Math.max(0, thumbs.length - visibles);
  // La tira mide (n / visibles) del ancho de la tarjeta; al pasar por encima
  // se desliza hasta enseñar la ultima celda, a paso lento.
  const anchoTira = `${(Math.max(thumbs.length, 1) / visibles) * 100}%`;
  const desplazamiento = sobran > 0 ? `-${(sobran / thumbs.length) * 100}%` : '0%';
  const personas = eco.extra?.personas || [];
  const esNota = eco.tipo === 'nota';

  return (
    <button
      onClick={onPulsar}
      aria-pressed={activo}
      style={{ animation: `eco-entra .55s cubic-bezier(.2,.7,.2,1) ${orden * 70}ms both` }}
      className={`eco-tarjeta group snap-start shrink-0 relative h-36 md:h-40 overflow-hidden rounded-2xl text-left bg-grafito shadow-sm hover:shadow-xl transition-shadow duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda ${
        destacada ? 'w-[85vw] sm:w-[26rem]' : 'w-[70vw] sm:w-[17rem]'
      } ${activo ? 'ring-2 ring-lavanda' : ''}`}
    >
      {/* Tira de pelicula con el propio material */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="eco-tira h-full flex transition-transform ease-linear group-hover:[transform:translateX(var(--eco-desplaza))] group-focus-visible:[transform:translateX(var(--eco-desplaza))]"
          style={{
            width: anchoTira,
            transitionDuration: `${Math.max(3, sobran * 1.6)}s`,
            ['--eco-desplaza' as string]: desplazamiento,
          }}
        >
          {thumbs.map((src, i) => (
            <div key={`${eco.id}-t${i}`} className="h-full flex-1 overflow-hidden bg-pizarra/60 border-r border-noche/40 last:border-r-0">
              <img
                src={src}
                alt=""
                loading="lazy"
                className={`w-full h-full object-cover transition-transform duration-700 ${esNota ? 'opacity-60' : ''}`}
                onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Velo: la imagen se ve, el texto se apoya en el degradado */}
      <div className={`absolute inset-0 bg-gradient-to-t ${esNota ? 'from-noche via-noche/80 to-noche/40' : 'from-noche via-noche/55 to-transparent'}`} />

      {/* Gesto propio de cada tipo */}
      {eco.tipo === 'aniversario' && eco.extra?.anio && (
        <span aria-hidden="true" className="absolute -right-1 -bottom-5 text-[5.5rem] leading-none font-extralight tracking-tighter text-white/[0.13] select-none">
          {eco.extra.anio}
        </span>
      )}

      {/* Esquina: caras si va de personas, icono si no */}
      <div className="absolute top-2.5 left-2.5 flex items-center">
        {personas.length > 0 ? (
          <span className="flex -space-x-2">
            {personas.map(p => (
              <span key={p.id} className="relative w-8 h-8 rounded-full ring-2 ring-noche bg-pizarra overflow-hidden flex items-center justify-center text-[11px] font-semibold text-lavanda">
                {p.nombre.slice(0, 1)}
                <img
                  src={RETRATO(p.id)}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              </span>
            ))}
          </span>
        ) : (
          <span className={`p-1.5 rounded-full backdrop-blur-sm transition-colors ${activo ? 'bg-lavanda text-noche' : 'bg-noche/60 text-lavanda'}`}>
            <Icono className="w-3.5 h-3.5" aria-hidden="true" />
          </span>
        )}
      </div>

      {/* Recuento, y la paleta si es un color */}
      <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
        {eco.tipo === 'color' && (eco.extra?.colores || []).map(hex => (
          <span key={hex} aria-hidden="true" className="w-3.5 h-3.5 rounded-full ring-1 ring-white/30" style={{ background: hex }} />
        ))}
        <span className="flex items-center gap-1 bg-noche/70 text-white text-xs font-semibold px-2 py-1 rounded-full backdrop-blur-sm">
          <Layers className="w-3 h-3" aria-hidden="true" />
          {eco.total}
        </span>
      </div>

      <div className="relative h-full p-3.5 flex flex-col justify-end">
        {esNota ? (
          <p className={`italic text-lavanda-claro leading-snug ${destacada ? 'text-[15px] line-clamp-3' : 'text-sm line-clamp-3'}`}>
            “{eco.titulo}”
          </p>
        ) : (
          <p className={`text-marfil leading-snug line-clamp-2 ${destacada ? 'text-base font-medium' : 'text-sm'}`}>{eco.titulo}</p>
        )}
        <p className={`text-xs mt-1 truncate ${activo ? 'text-lavanda' : 'text-white/70'}`} title={eco.detalle}>
          {activo ? 'pulsa para volver al archivo' : eco.detalle}
        </p>
      </div>
    </button>
  );
}
