import React, { useMemo } from 'react';
import './Loader.css';

// Animaciones de carga de Pensadero. 8 variantes tematicas, todas CSS puro.
// Cada variante mapea a una operacion real del archivo audiovisual.
export type LoaderVariant =
  | 'escaneo'    // escaneo visual de la biblioteca (IA local)
  | 'cargando'   // carga generica de biblioteca
  | 'caras'      // reconocimiento de personas (InsightFace)
  | 'sync'       // sincronizacion de rutas
  | 'atlas'      // construccion del atlas de recuerdos
  | 'espacios'   // reconocimiento de espacios
  | 'descarga'   // exportacion / descarga de archivos
  | 'listo';     // operacion completada

interface LoaderProps {
  variant?: LoaderVariant;
  /** Sobrescriben el texto por defecto de cada variante. */
  micro?: string;
  cap?: string;
  sub?: string;
  /** 0-100 -> barra determinada; undefined -> barra indeterminada. */
  progress?: number;
  /** Overlay a pantalla completa con glows + tarjeta de cristal. */
  fullscreen?: boolean;
  /** Mostrar el bloque de texto inferior (micro/titulo/sub/barra). */
  showCaption?: boolean;
  className?: string;
}

// Texto por defecto por variante (sin contadores; el caller puede sobrescribir).
const META: Record<LoaderVariant, { micro: string; cap: string; sub: string }> = {
  escaneo:  { micro: 'IA · VISION LOCAL',  cap: 'Escaneando',            sub: 'Analizando archivos del catalogo' },
  cargando: { micro: 'BIBLIOTECA',         cap: 'Cargando biblioteca',   sub: 'Preparando miniaturas y metadata' },
  caras:    { micro: 'INSIGHTFACE',        cap: 'Reconociendo personas', sub: 'Detectando caras en la sesion' },
  sync:     { micro: 'SINCRONIZACION',     cap: 'Sincronizando rutas',   sub: 'Revisando discos y bibliotecas' },
  atlas:    { micro: 'ATLAS DE RECUERDOS', cap: 'Construyendo el atlas', sub: 'Enlazando sesiones y recuerdos' },
  espacios: { micro: 'CLIP / SigLIP-2',    cap: 'Reconociendo espacios', sub: 'Ubicando lugares en el mapa' },
  descarga: { micro: 'EXPORTACION',        cap: 'Descargando archivos',  sub: 'Transfiriendo seleccion' },
  listo:    { micro: 'COMPLETADO',         cap: 'Todo listo',            sub: 'Operacion finalizada' },
};

const TILE_PALETTE = ['#C8B6FF', '#F2B8A0', '#9CB7A5', '#8EA4FF', '#DACDFF', '#E6C177'];

// Nodos del grafo 3D (Atlas), posiciones del prototipo original.
const ATLAS_NODES = [
  { x: 150, y: 140, size: 24, color: '#C8B6FF', glow: 'rgba(200,182,255,.75)', z: 46, delay: '0s' },
  { x: 55,  y: 55,  size: 13, color: '#C8B6FF', glow: 'rgba(200,182,255,.6)',  z: 30, delay: '.2s' },
  { x: 245, y: 50,  size: 13, color: '#8EA4FF', glow: 'rgba(142,164,255,.6)',  z: 18, delay: '.5s' },
  { x: 40,  y: 205, size: 13, color: '#9CB7A5', glow: 'rgba(156,183,165,.6)',  z: 34, delay: '.8s' },
  { x: 262, y: 200, size: 13, color: '#F2B8A0', glow: 'rgba(242,184,160,.6)',  z: 14, delay: '1.1s' },
  { x: 150, y: 255, size: 12, color: '#DACDFF', glow: 'rgba(218,205,255,.6)',  z: 24, delay: '1.4s' },
  { x: 150, y: 30,  size: 12, color: '#7C6BB2', glow: 'rgba(124,107,178,.6)',  z: 20, delay: '.95s' },
];

const ATLAS_LINES: Array<[number, number, number, number, string]> = [
  [150, 140, 55, 55, '0s'], [150, 140, 245, 50, '.3s'], [150, 140, 40, 205, '.6s'],
  [150, 140, 262, 200, '.9s'], [150, 140, 150, 255, '1.2s'], [150, 140, 150, 30, '.45s'],
  [55, 55, 150, 30, '1.5s'], [245, 50, 150, 30, '1.7s'], [40, 205, 150, 255, '1.9s'],
];

function ScanGrid() {
  const tiles = useMemo(() => {
    const COLS = 5, ROWS = 4, dur = 3.4;
    const out: Array<{ delay: string; c1: string; c2: string; c3: string }> = [];
    let i = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const base = ((r + 0.4) / ROWS) * dur + c * 0.06;
        out.push({
          delay: base.toFixed(2) + 's',
          c1: TILE_PALETTE[i % TILE_PALETTE.length],
          c2: TILE_PALETTE[(i + 2) % TILE_PALETTE.length],
          c3: TILE_PALETTE[(i + 4) % TILE_PALETTE.length],
        });
        i++;
      }
    }
    return out;
  }, []);

  return (
    <div className="pl-escaneo">
      <div className="pl-escaneo__corner pl-escaneo__corner--tl" />
      <div className="pl-escaneo__corner pl-escaneo__corner--tr" />
      <div className="pl-escaneo__corner pl-escaneo__corner--bl" />
      <div className="pl-escaneo__corner pl-escaneo__corner--br" />
      <div className="pl-escaneo__grid">
        {tiles.map((t, i) => (
          <div className="pl-tile" key={i}>
            <div className="pl-tile__scan" style={{ animationDelay: t.delay }}>
              <div className="pl-tile__dots">
                <span style={{ background: t.c1 }} />
                <span style={{ background: t.c2 }} />
                <span style={{ background: t.c3 }} />
              </div>
            </div>
          </div>
        ))}
        <div className="pl-escaneo__beam">
          <div className="pl-escaneo__beam-bg" />
          <div className="pl-escaneo__beam-line" />
        </div>
      </div>
    </div>
  );
}

function Cargando() {
  return (
    <div className="pl-cargando">
      <div className="pl-abs-center">
        <svg width="172" height="172" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="34" fill="none" stroke="#1C2033" strokeWidth="5" />
        </svg>
      </div>
      <div className="pl-abs-center">
        <svg className="pl-cargando__ring" width="172" height="172" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="34" fill="none" stroke="#C8B6FF" strokeWidth="5" strokeLinecap="round" strokeDasharray="48 250" />
          <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(142,164,255,.4)" strokeWidth="5" strokeLinecap="round" strokeDasharray="10 252" strokeDashoffset="-70" />
        </svg>
      </div>
      <div className="pl-abs-center pl-cargando__halo" />
      <img className="pl-abs-center pl-cargando__logo" src="/pensadero-logo.png" alt="Pensadero" />
    </div>
  );
}

function Caras() {
  return (
    <div className="pl-caras">
      <div className="pl-abs-center">
        <svg className="pl-caras__ring-out" width="206" height="206" viewBox="0 0 206 206">
          <circle cx="103" cy="103" r="98" fill="none" stroke="#7C6BB2" strokeWidth="1.5" strokeDasharray="4 9" />
        </svg>
      </div>
      <div className="pl-abs-center">
        <svg className="pl-caras__ring-in" width="160" height="160" viewBox="0 0 160 160">
          <circle cx="80" cy="80" r="76" fill="none" stroke="rgba(200,182,255,.28)" strokeWidth="1.5" strokeDasharray="2 11" />
        </svg>
      </div>
      <div className="pl-caras__cross-v" />
      <div className="pl-caras__cross-h" />
      <div className="pl-caras__face pl-caras__face--1" />
      <div className="pl-caras__face pl-caras__face--2" />
      <div className="pl-caras__face pl-caras__face--3" />
      <div className="pl-caras__scan" />
    </div>
  );
}

function Sync() {
  return (
    <div className="pl-sync">
      <div className="pl-abs-center">
        <svg className="pl-sync__ring-out" width="190" height="190" viewBox="0 0 190 190">
          <circle cx="95" cy="95" r="90" fill="none" stroke="#7C6BB2" strokeWidth="1.5" strokeDasharray="6 11" />
        </svg>
      </div>
      <div className="pl-abs-center">
        <svg className="pl-sync__ring-in" width="130" height="130" viewBox="0 0 130 130">
          <circle cx="65" cy="65" r="61" fill="none" stroke="rgba(200,182,255,.3)" strokeWidth="1.5" strokeDasharray="3 10" />
        </svg>
      </div>
      <div className="pl-sync__orbit pl-sync__orbit--1">
        <span className="pl-sync__sat pl-sync__sat--top" style={{ width: 11, height: 11, background: '#C8B6FF', boxShadow: '0 0 14px #C8B6FF' }} />
      </div>
      <div className="pl-sync__orbit pl-sync__orbit--2">
        <span className="pl-sync__sat pl-sync__sat--top" style={{ width: 9, height: 9, background: '#8EA4FF', boxShadow: '0 0 12px #8EA4FF' }} />
      </div>
      <div className="pl-sync__orbit pl-sync__orbit--3">
        <span className="pl-sync__sat pl-sync__sat--bot" style={{ width: 8, height: 8, background: '#F2B8A0', boxShadow: '0 0 12px #F2B8A0' }} />
      </div>
      <div className="pl-abs-center pl-sync__core">
        <span />
      </div>
    </div>
  );
}

function Atlas() {
  return (
    <div className="pl-atlas">
      <div className="pl-atlas__scene">
        <svg className="pl-atlas__web" width="300" height="280" viewBox="0 0 300 280">
          <g stroke="#7C6BB2" strokeWidth="1.4" fill="none" strokeLinecap="round">
            {ATLAS_LINES.map(([x1, y1, x2, y2, delay], i) => (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeDasharray="260" style={{ animationDelay: delay }} />
            ))}
          </g>
        </svg>
        <div className="pl-atlas__halo"><div /></div>
        {ATLAS_NODES.map((n, i) => (
          <div className="pl-atlas__node" key={i} style={{ left: n.x, top: n.y, transform: `translateZ(${n.z}px)` }}>
            <div style={{
              width: n.size, height: n.size, margin: `${-n.size / 2}px 0 0 ${-n.size / 2}px`,
              background: n.color, boxShadow: `0 0 14px ${n.glow}`, animationDelay: n.delay,
            }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Espacios() {
  return (
    <div className="pl-espacios">
      <div className="pl-espacios__circle pl-espacios__circle--1" />
      <div className="pl-espacios__circle pl-espacios__circle--2" />
      <div className="pl-espacios__circle pl-espacios__circle--3" />
      <div className="pl-espacios__cross-v" />
      <div className="pl-espacios__cross-h" />
      <div className="pl-espacios__sweep" />
      <span className="pl-espacios__blip pl-espacios__blip--1" />
      <span className="pl-espacios__blip pl-espacios__blip--2" />
      <span className="pl-espacios__blip pl-espacios__blip--3" />
      <span className="pl-espacios__pin" />
    </div>
  );
}

function Descarga() {
  return (
    <div className="pl-descarga">
      <div className="pl-descarga__icon">
        <div className="pl-descarga__glow" />
        <div className="pl-abs-center">
          <svg className="pl-descarga__ring" width="150" height="150" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="36" fill="none" stroke="rgba(142,164,255,.28)" strokeWidth="2" strokeDasharray="3 10" />
          </svg>
        </div>
        <div className="pl-descarga__tray">
          <div className="pl-descarga__fill" />
          <div className="pl-descarga__fold" />
          <div className="pl-descarga__arrow">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#8EA4FF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4 L12 16 M6 11 L12 17 L18 11" />
            </svg>
          </div>
        </div>
        <div className="pl-descarga__base" />
      </div>
      <div className="pl-descarga__bar"><i /></div>
    </div>
  );
}

function Listo() {
  return (
    <div className="pl-listo">
      <div className="pl-listo__halo" />
      <svg className="pl-listo__svg" width="200" height="200" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(168,213,186,.18)" strokeWidth="4" />
        <circle className="pl-listo__ring" cx="50" cy="50" r="40" fill="none" stroke="#A8D5BA" strokeWidth="4" strokeLinecap="round" strokeDasharray="252" strokeDashoffset="252" transform="rotate(-90 50 50)" />
        <path className="pl-listo__check" d="M33 51 L45 63 L68 38" fill="none" stroke="#A8D5BA" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="52" strokeDashoffset="52" />
      </svg>
    </div>
  );
}

const GRAPHICS: Record<LoaderVariant, () => React.ReactElement> = {
  escaneo: ScanGrid,
  cargando: Cargando,
  caras: Caras,
  sync: Sync,
  atlas: Atlas,
  espacios: Espacios,
  descarga: Descarga,
  listo: Listo,
};

export default function Loader({
  variant = 'cargando',
  micro,
  cap,
  sub,
  progress,
  fullscreen = false,
  showCaption = true,
  className = '',
}: LoaderProps) {
  const meta = META[variant];
  const Graphic = GRAPHICS[variant];
  const isListo = variant === 'listo';
  const hasProgress = typeof progress === 'number';

  const caption = showCaption && (
    <div className={`pl-caption${fullscreen ? '' : ' pl-caption--inline'}`}>
      <div className="pl-micro">{micro ?? meta.micro}</div>
      <div className="pl-title">
        <span>{cap ?? meta.cap}</span>
        {!isListo && (
          <span className="pl-dots"><span>.</span><span>.</span><span>.</span></span>
        )}
      </div>
      <div className="pl-sub">{sub ?? meta.sub}</div>
      {!isListo && (
        <div className={`pl-progress${hasProgress ? ' pl-progress--determinate' : ''}`}>
          <i style={hasProgress ? { width: `${Math.max(0, Math.min(100, progress!))}%` } : undefined} />
        </div>
      )}
    </div>
  );

  const body = (
    <>
      <div className={`pl-stage${fullscreen ? '' : ' pl-stage--inline'}`}>
        <Graphic />
      </div>
      {caption}
    </>
  );

  if (fullscreen) {
    return (
      <div className={`pl-root pl-overlay ${className}`.trim()} role="status" aria-live="polite" aria-label={cap ?? meta.cap}>
        <div className="pl-glow pl-glow-1" />
        <div className="pl-glow pl-glow-2" />
        <div className="pl-glow pl-glow-3" />
        <div className="pl-card">{body}</div>
      </div>
    );
  }

  return (
    <div className={`pl-root ${className}`.trim()} role="status" aria-live="polite" aria-label={cap ?? meta.cap}>
      {body}
    </div>
  );
}
