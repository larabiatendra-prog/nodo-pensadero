import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, HardDrive } from 'lucide-react';
import { api } from '../services/api';
import type { MediaFile } from '../types';

/**
 * La carta de la semana: el archivo escribe.
 *
 * Va encima de los ecos y a proposito NO es una tarjeta. Es lo unico de toda
 * la app que se LEE en vez de mirarse, asi que se compone como prosa y no como
 * interfaz: cuerpo grande, medida corta, aire alrededor y una linea que la
 * ancla — la misma que marca los años en la linea de vida. Si fuera otra caja
 * seria un panel mas y perderia lo unico que tiene.
 *
 * El hallazgo lo calcula el backend sobre datos duros y el modelo local solo
 * lo redacta (ver backend/services/cartaService.js), asi que lo que se lee aqui
 * no puede contener fechas ni nombres inventados.
 */

interface CartaData {
  semana: string;
  texto: string;
  tipo: string;
  fileIds: string[];
  redactadaPor: string;
}

interface Props {
  files: MediaFile[];
  onSelectFile: (file: MediaFile) => void;
}

const CLAVE_OCULTA = 'pensadero.cartaOculta';

const MESES_CORTOS = ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sept.', 'oct.', 'nov.', 'dic.'];

/** "2026-W38" -> "semana del 14 sept." (lunes de esa semana ISO). */
function rotuloSemana(clave: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(clave || '');
  if (!m) return clave;
  const anio = Number(m[1]);
  const semana = Number(m[2]);
  const cuatroEnero = new Date(Date.UTC(anio, 0, 4));
  const diaSemana = cuatroEnero.getUTCDay() || 7;
  const lunes = new Date(cuatroEnero);
  lunes.setUTCDate(cuatroEnero.getUTCDate() - diaSemana + 1 + (semana - 1) * 7);
  const esteAnio = new Date().getFullYear();
  return `semana del ${lunes.getUTCDate()} ${MESES_CORTOS[lunes.getUTCMonth()]}${lunes.getUTCFullYear() !== esteAnio ? ` ${lunes.getUTCFullYear()}` : ''}`;
}

export default function Carta({ files, onSelectFile }: Props) {
  const [actual, setActual] = useState<CartaData | null>(null);
  // Cartas anteriores, para releerlas. Indice 0 = la de esta semana.
  const [archivo, setArchivo] = useState<CartaData[]>([]);
  const [indice, setIndice] = useState(0);
  const [oculta, setOculta] = useState<string>(() => {
    try { return localStorage.getItem(CLAVE_OCULTA) || ''; } catch { return ''; }
  });

  useEffect(() => {
    let cancelado = false;
    api.getCarta()
      .then(r => {
        if (cancelado || !r.success || !r.data) return;
        setActual(r.data as CartaData);
        // Las anteriores se piden despues: la de hoy no espera a nada.
        api.getCartas()
          .then(l => { if (!cancelado && l.success && Array.isArray(l.data)) setArchivo(l.data as CartaData[]); })
          .catch(() => { /* sin historico: solo la de esta semana */ });
      })
      .catch(() => { /* sin backend nuevo o sin material: no hay carta */ });
    return () => { cancelado = true; };
  }, []);

  // La de esta semana manda aunque el historico aun no haya llegado.
  const lista = actual
    ? [actual, ...archivo.filter(c => c.semana !== actual.semana)]
    : archivo;
  const carta = lista[Math.min(indice, Math.max(0, lista.length - 1))] || null;

  if (!actual || !carta || !carta.texto) return null;

  const porId = new Map(files.map(f => [f.id, f]));
  const clips = carta.fileIds.map(id => porId.get(id)).filter(Boolean) as MediaFile[];

  const ocultar = () => {
    // Se oculta la carta de ESTA semana, no la seccion: la que viene vuelve sola.
    try { localStorage.setItem(CLAVE_OCULTA, actual.semana); } catch { /* modo privado */ }
    setOculta(actual.semana);
    setIndice(0);
  };

  const recuperar = () => {
    try { localStorage.removeItem(CLAVE_OCULTA); } catch { /* modo privado */ }
    setOculta('');
  };

  // Apartada NO es borrada: queda su raiz y una linea para traerla de vuelta.
  // Antes se devolvia null y la carta desaparecia hasta el lunes siguiente sin
  // ninguna forma de recuperarla.
  if (oculta === actual.semana) {
    return (
      <section aria-label="La carta del archivo" className="mb-6 mt-1">
        <button
          onClick={recuperar}
          className="group/vuelve flex items-center gap-3 text-left focus:outline-none"
          title="Volver a leer la carta de esta semana"
        >
          <span
            aria-hidden="true"
            className="w-px h-4 shrink-0 bg-lavanda-archivo/50 group-hover/vuelve:bg-lavanda transition-colors"
          />
          <span className="text-xs text-humo group-hover/vuelve:text-niebla transition-colors">
            la carta de esta semana
          </span>
        </button>
      </section>
    );
  }

  return (
    <section aria-label="La carta del archivo" className="mb-8 mt-1 group/carta">
      <style>{`@keyframes carta-entra{from{opacity:0;filter:blur(6px);transform:translateY(4px)}to{opacity:1;filter:none;transform:none}}@media (prefers-reduced-motion: reduce){.carta-texto{animation:none!important}}`}</style>
      <div className="flex items-start gap-4 md:gap-5 max-w-3xl">
        {/* Raiz de la carta: una linea que se desvanece, como la del año en la
            linea de vida. Ancla el parrafo sin meterlo en una caja. */}
        <div
          aria-hidden="true"
          className="w-px self-stretch shrink-0 mt-2 bg-gradient-to-b from-lavanda/70 via-lavanda-archivo/40 to-transparent"
        />

        <div className="min-w-0 flex-1">
          {/* Prosa, no interfaz: cuerpo grande, medida corta y aire. */}
          {indice > 0 && (
            <p className="mb-2 font-mono text-[10px] tracking-wider uppercase text-humo">{rotuloSemana(carta.semana)}</p>
          )}
          <p
            key={carta.semana}
            className="carta-texto text-lg md:text-xl font-light leading-relaxed text-marfil/90"
            style={{ animation: 'carta-entra .7s ease-out both' }}
          >
            {carta.texto}
          </p>

          {/* Sus imagenes estan en un disco que no esta: se dice, en vez de
              dejar la carta sin fotos y sin explicacion. */}
          {clips.length === 0 && carta.fileIds.length > 0 && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-humo">
              <HardDrive className="w-3.5 h-3.5" aria-hidden="true" />
              Sus imágenes están en un disco que ahora no está conectado.
            </p>
          )}

          {/* En pantallas tactiles no hay "pasar por encima": los controles van
              debajo y a la vista, sin robarle anchura al texto. */}
          <div className="mt-3 flex sm:hidden items-center gap-4 text-xs text-humo">
            {lista.length > 1 && (
              <span className="flex items-center gap-1">
                <button onClick={() => setIndice(i => Math.min(lista.length - 1, i + 1))} disabled={indice >= lista.length - 1} aria-label="Carta anterior" className="p-1 disabled:opacity-30">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="tabular-nums">{lista.length - indice}/{lista.length}</span>
                <button onClick={() => setIndice(i => Math.max(0, i - 1))} disabled={indice === 0} aria-label="Carta siguiente" className="p-1 disabled:opacity-30">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </span>
            )}
            <button onClick={ocultar} className="flex items-center gap-1 p-1">
              <X className="w-3 h-3" />
              ocultar
            </button>
          </div>

          {clips.length > 0 && (
            /* Las fotos, apiladas como sobre una mesa. Al pasar por la carta se
               abren solas: el gesto dice "esto es de lo que te hablo". */
            <div className="flex mt-5">
              {clips.map((file, i) => (
                <button
                  key={file.id}
                  onClick={() => onSelectFile(file)}
                  title={file.displayName || file.name}
                  style={{ zIndex: clips.length - i }}
                  className={`relative w-20 h-20 rounded-xl overflow-hidden bg-grafito ring-2 ring-noche transition-all duration-500 ease-out hover:z-10 hover:scale-105 focus:outline-none focus-visible:ring-lavanda ${
                    i > 0 ? '-ml-5 group-hover/carta:ml-1' : ''
                  }`}
                >
                  <img
                    src={file.thumbnail}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover opacity-75 hover:opacity-100 transition-opacity duration-300"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Cartas anteriores: aparecen al pasar por la carta, como el resto
            de sus controles. */}
        {lista.length > 1 && (
          <div className="shrink-0 hidden sm:flex items-center mt-0.5 opacity-0 group-hover/carta:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              onClick={() => setIndice(i => Math.min(lista.length - 1, i + 1))}
              disabled={indice >= lista.length - 1}
              title="Carta anterior"
              aria-label="Carta anterior"
              className="p-1 rounded text-humo hover:text-niebla disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[11px] text-humo tabular-nums px-0.5">{lista.length - indice}/{lista.length}</span>
            <button
              onClick={() => setIndice(i => Math.max(0, i - 1))}
              disabled={indice === 0}
              title="Carta siguiente"
              aria-label="Carta siguiente"
              className="p-1 rounded text-humo hover:text-niebla disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        <button
          onClick={ocultar}
          title="Ocultar esta carta"
          aria-label="Ocultar esta carta"
          className="shrink-0 hidden sm:block p-1 mt-1 rounded text-humo opacity-0 group-hover/carta:opacity-100 hover:text-niebla transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda focus-visible:opacity-100"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </section>
  );
}
