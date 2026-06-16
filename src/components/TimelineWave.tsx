import React from 'react';

/**
 * TimelineWave — onda vertical (pasiva) a la derecha del home.
 *
 * Eje Y = tiempo lineal por mes: la fecha mas reciente arriba (y=0) y la mas
 * antigua abajo. La amplitud horizontal de la onda = cantidad de archivos en
 * ese mes (mas pico = mas archivos). Escala sqrt para domar los picos enormes.
 *
 * Es PASIVA: no navega. Solo informa. Un indicador horizontal marca "estas
 * aqui" derivado del scroll de ventana, y el hover muestra la fecha del mes.
 *
 * Recibe los valores de fecha (YYYYMMDD) de TODA la lista ordenada del home
 * (reciente->antiguo) mas cuantos items hay cargados, para mapear el scroll
 * actual a una fecha.
 */

interface TimelineWaveProps {
  // Valores YYYYMMDD de cada archivo, en el mismo orden que el grid (reciente primero).
  // Un 0 significa "sin fecha" y se ignora para la forma de la onda.
  sortedDateValues: number[];
  // Numero de items actualmente cargados (scroll infinito).
  loadedCount: number;
}

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// YYYYMMDD -> indice de mes continuo (year*12 + (month-1)); -1 si no hay fecha.
function monthIndexOf(v: number): number {
  if (!v) return -1;
  const year = Math.floor(v / 10000);
  const month = Math.floor(v / 100) % 100;
  if (!year || !month) return -1;
  return year * 12 + (month - 1);
}

const TimelineWave: React.FC<TimelineWaveProps> = ({ sortedDateValues, loadedCount }) => {
  // ── Buckets mensuales sobre TODA la biblioteca ──────────────────────────
  const model = React.useMemo(() => {
    const counts = new Map<number, number>();
    let maxIdx = -Infinity;
    let minIdx = Infinity;
    for (const v of sortedDateValues) {
      const mi = monthIndexOf(v);
      if (mi < 0) continue;
      counts.set(mi, (counts.get(mi) || 0) + 1);
      if (mi > maxIdx) maxIdx = mi;
      if (mi < minIdx) minIdx = mi;
    }
    if (!isFinite(maxIdx)) return null;

    // Serie continua reciente(top) -> antiguo(bottom), con ceros en huecos.
    const totalMonths = maxIdx - minIdx + 1;
    const months: { mi: number; count: number; year: number; month: number }[] = [];
    let maxCount = 0;
    for (let mi = maxIdx; mi >= minIdx; mi--) {
      const count = counts.get(mi) || 0;
      if (count > maxCount) maxCount = count;
      months.push({ mi, count, year: Math.floor(mi / 12), month: mi % 12 });
    }

    // Granularidad adaptativa de etiquetas: meses solo si el rango es corto.
    const showMonthTicks = totalMonths <= 36;

    return { months, totalMonths, maxCount, maxIdx, minIdx, showMonthTicks };
  }, [sortedDateValues]);

  // ── Indicador "estas aqui": scroll de ventana -> fecha del item visible ──
  const [indicatorFrac, setIndicatorFrac] = React.useState<number | null>(null);
  const [hoverY, setHoverY] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!model) return;
    const onScroll = () => {
      const max = document.body.scrollHeight - window.innerHeight;
      const progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      const visibleCount = Math.max(1, Math.min(loadedCount, sortedDateValues.length));
      const idx = Math.min(visibleCount - 1, Math.round(progress * (visibleCount - 1)));
      const mi = monthIndexOf(sortedDateValues[idx] || 0);
      if (mi < 0) return;
      // Posicion vertical de ese mes en el eje tiempo (0=reciente arriba).
      const frac = (model.maxIdx - mi) / Math.max(1, model.totalMonths - 1);
      setIndicatorFrac(frac);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [model, loadedCount, sortedDateValues]);

  if (!model || model.months.length < 2) return null;

  const { months, totalMonths, maxCount } = model;

  // ── Path SVG de la onda (viewBox 100 ancho x totalMonths alto) ───────────
  // Suavizado: media movil para quitar el ruido mes-a-mes (ventana segun rango).
  const win = Math.min(4, Math.max(1, Math.round(months.length / 48)));
  const smooth = months.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = -win; k <= win; k++) {
      const j = i + k;
      if (j >= 0 && j < months.length) { sum += months[j].count; n++; }
    }
    return sum / n;
  });

  // x crece hacia la izquierda desde el borde derecho segun el count. Baseline
  // minima (x=94): incluso meses a cero mantienen una cinta fina, nunca tocan
  // el borde -> sin muescas que parezcan valores negativos.
  const amp = (count: number) => {
    if (maxCount <= 0) return 94;
    const norm = Math.sqrt(count) / Math.sqrt(maxCount); // 0..1
    return 94 - norm * 80; // 94 (cinta) .. 14 (pico maximo)
  };

  // Puntos del perfil y curva suave (Catmull-Rom -> Bezier cubica).
  const pts = smooth.map((c, i) => ({ x: amp(c), y: i + 0.5 }));
  let seg = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    seg += `C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} `;
  }
  const first = pts[0];
  const profile = `M ${first.x.toFixed(1)} ${first.y.toFixed(1)} ${seg}`;
  // Area rellena: perfil + cierre por el borde derecho (x=100).
  const d = `M 100 0 L ${first.x.toFixed(1)} ${first.y.toFixed(1)} ${seg}L 100 ${months.length} Z`;

  // ── Etiquetas de año (adaptativas para no saturar) ──────────────────────
  const yearBoundaries: { year: number; frac: number }[] = [];
  let lastYear: number | null = null;
  months.forEach((m) => {
    if (m.year !== lastYear) {
      lastYear = m.year;
      yearBoundaries.push({ year: m.year, frac: (m.mi - model.minIdx) >= 0 ? (model.maxIdx - m.mi) / Math.max(1, totalMonths - 1) : 0 });
    }
  });
  // Limitar a ~14 etiquetas: saltar años si hay demasiados.
  const maxLabels = 14;
  const labelStep = Math.max(1, Math.ceil(yearBoundaries.length / maxLabels));
  const yearLabels = yearBoundaries.filter((_, i) => i % labelStep === 0);

  // Fecha bajo el cursor (hover) para el tooltip.
  const hoverInfo = hoverY == null ? null : (() => {
    const mi = Math.round(model.maxIdx - hoverY * (totalMonths - 1));
    const m = months.find((x) => x.mi === mi) || months[0];
    return { label: `${MESES[m.month]} ${m.year}`, count: m.count, frac: hoverY };
  })();

  return (
    <div
      className="hidden md:flex fixed right-0 top-20 bottom-6 z-30 select-none pointer-events-none"
      aria-hidden="true"
    >
      <div className="relative h-full flex items-stretch pr-1">
        {/* Etiquetas de año */}
        <div className="relative w-9 h-full mr-0.5 text-[10px] font-mono text-humo">
          {yearLabels.map((yl) => (
            <span
              key={yl.year}
              className="absolute right-0 -translate-y-1/2 tabular-nums"
              style={{ top: `${(yl.frac * 100).toFixed(2)}%` }}
            >
              {yl.year}
            </span>
          ))}
        </div>

        {/* Onda */}
        <div
          className="relative w-12 h-full pointer-events-auto"
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHoverY(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
          }}
          onMouseLeave={() => setHoverY(null)}
        >
          <svg
            className="w-full h-full overflow-visible"
            viewBox={`0 0 100 ${months.length}`}
            preserveAspectRatio="none"
          >
            <path d={d} className="fill-lavanda/20" />
            <path
              d={profile}
              className="fill-none stroke-lavanda/70"
              strokeWidth={0.6}
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Indicador "estas aqui" */}
          {indicatorFrac != null && (
            <div
              className="absolute left-0 right-0 flex items-center pointer-events-none"
              style={{ top: `${(indicatorFrac * 100).toFixed(2)}%` }}
            >
              <div className="h-px w-full bg-lavanda-claro shadow-[0_0_4px] shadow-lavanda" />
            </div>
          )}

          {/* Tooltip en hover */}
          {hoverInfo && (
            <>
              <div
                className="absolute left-0 right-0 h-px bg-marfil/40 pointer-events-none"
                style={{ top: `${(hoverInfo.frac * 100).toFixed(2)}%` }}
              />
              <div
                className="absolute right-full mr-1 -translate-y-1/2 whitespace-nowrap rounded bg-grafito px-2 py-1 text-[10px] text-marfil shadow-lg border border-pizarra pointer-events-none"
                style={{ top: `${(hoverInfo.frac * 100).toFixed(2)}%` }}
              >
                {hoverInfo.label} · {hoverInfo.count}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default TimelineWave;
