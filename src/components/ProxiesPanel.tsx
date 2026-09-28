import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Zap } from 'lucide-react';
import { api, ProxiesDisco, ProxiesEstado, ProxiesFluidez, ProxiesLote } from '../services/api';
import { completar, numero, tamaño, tiempo } from '../utils/proxies';

/**
 * Vídeos preparados (proxies) — panel de Estadísticas.
 *
 * Lo que se busca aquí es que un vídeo se abra al instante, siempre. Un 4K de
 * cámara el navegador lo abre, pero lo arrastra: tarda en arrancar y mover la
 * barra es lento. La versión ligera (1080p, 5 Mbps) lo vuelve instantáneo y
 * ocupa una fracción del original.
 *
 * Tres cosas pasan solas y no hace falta tocar nada: el original se sirve ya
 * mientras su versión ligera se prepara por detrás, se adelantan los vecinos
 * de la carpeta que estás mirando, y el tope por disco va soltando lo que hace
 * más que no ves. Este panel es para lo otro: ver cómo va y, si te apetece,
 * preparar de golpe todo un disco antes de ponerte a trabajar.
 *
 * El tope es por disco a propósito: 40 GB en el del sistema es mucho y en una
 * LaCie de 8 TB no es nada.
 */

const gbTexto = (n: number) => n.toLocaleString('es-ES', { maximumFractionDigits: 1 });

const GB = 1073741824;

export default function ProxiesPanel() {
  const [estado, setEstado] = useState<ProxiesEstado | null>(null);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await api.getProxiesEstado();
      if (r.success && r.data) setEstado(completar(r.data));
    } catch { /* el panel simplemente no se pinta */ }
    finally { setCargando(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Con un lote en marcha el panel se refresca solo: es su barra de progreso.
  const enMarcha = !!estado?.lote && !estado.lote.terminado;
  useEffect(() => {
    if (!enMarcha) return;
    const t = setInterval(() => { cargar(); }, 2000);
    return () => clearInterval(t);
  }, [enMarcha, cargar]);

  const guardar = async (parcial: Parameters<typeof api.setProxiesAjustes>[0], marca: string) => {
    setOcupado(marca);
    try {
      const r = await api.setProxiesAjustes(parcial);
      if (r.success && r.data) setEstado(completar(r.data.estado));
    } catch { /* se queda como estaba */ }
    finally { setOcupado(null); }
  };

  const liberar = async (raiz: string) => {
    setOcupado(`liberar:${raiz}`);
    try {
      const r = await api.liberarProxies(raiz);
      if (r.success && r.data) setEstado(completar(r.data.estado));
    } catch { /* se queda como estaba */ }
    finally { setOcupado(null); }
  };

  const preparar = async (raiz: string) => {
    setOcupado(`preparar:${raiz}`);
    try {
      const r = await api.prepararProxies(raiz);
      if (r.success && r.data) setEstado(completar(r.data.estado));
    } catch { /* se queda como estaba */ }
    finally { setOcupado(null); }
  };

  const parar = async () => {
    setOcupado('parar');
    try {
      const r = await api.cancelarPreparacion();
      if (r.success && r.data) setEstado(completar(r.data.estado));
    } catch { /* se queda como estaba */ }
    finally { setOcupado(null); }
  };

  if (cargando || !estado) return null;

  const { ajustes, totales, discos, fluidez, lote } = estado;
  const esperando = discos.filter(d => d.aviso);
  const porRaiz = new Map(discos.map(d => [d.raiz, d]));

  return (
    <section className="mt-12 pt-8 border-t border-borde-sutil">
      <div className="flex items-baseline justify-between gap-4 mb-5 flex-wrap">
        <h2 className="text-[15px] font-semibold text-marfil">Vídeos preparados</h2>
        <span className="text-[11px] text-humo">
          versiones ligeras para que todo abra al instante · el original nunca se toca
        </span>
      </div>

      {/* Lo accionable primero: lo que falta por preparar y el lote en marcha */}
      {lote && !lote.terminado ? (
        <EnMarcha lote={lote} parando={ocupado === 'parar'} onParar={parar} />
      ) : (
        <>
          {lote && lote.terminado && lote.procesados > 0 && <Resultado lote={lote} />}
          {fluidez.length > 0 && (
            <div className="mb-7 flex flex-col gap-3">
              {fluidez.map(f => (
                <Candidatos
                  key={f.raiz}
                  f={f}
                  disco={porRaiz.get(f.raiz)}
                  topeGeneral={ajustes.topeGB}
                  ocupado={ocupado}
                  onPreparar={() => preparar(f.raiz)}
                  onSubirTope={(gb) => guardar({ porDisco: { [f.raiz]: gb } }, `tope:${f.raiz}`)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Cifras de cabecera: lo preparado frente a lo que no hizo falta preparar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mb-7">
        <Cifra valor={numero(totales.listos)} pie={`preparados · ${tamaño(totales.bytes)}`} destacada />
        <Cifra valor={numero(totales.nativos)} pie="se abren tal cual" />
        <Cifra valor={numero(totales.antiguos)} pie="de la regla antigua" apagada={totales.antiguos === 0} />
        <Cifra
          valor={numero(totales.errores + totales.pendientes)}
          pie={totales.pendientes > 0 ? 'en cola o fallidos' : 'no se pudieron'}
          apagada={totales.errores + totales.pendientes === 0}
        />
      </div>

      {/* Lo que espera una decisión: es lo único que pide algo */}
      {esperando.map(d => (
        <div key={`aviso-${d.raiz}`} className="mb-5 p-3.5 rounded-lg bg-melocoton/10 border border-melocoton/30">
          <p className="flex items-start gap-2 text-[12px] text-melocoton leading-snug">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
            <span>
              <span className="font-mono">{d.raiz}</span> ha llegado a su tope de {gbTexto(d.topeGB)} GB.
              {d.aviso!.esperando > 0 && ` ${numero(d.aviso!.esperando)} ${d.aviso!.esperando === 1 ? 'vídeo espera' : 'vídeos esperan'} a poder prepararse.`}
              {' '}Sube el tope de ese disco o libera los que hace más que no ves.
            </span>
          </p>
        </div>
      ))}

      {/* Discos sin sitio: sus proxies irían al del sistema, pero solo si lo decides */}
      {(estado.consentir || []).map(c => (
        <div key={`sistema-${c.raiz}`} className="mb-5 p-3.5 rounded-lg bg-melocoton/10 border border-melocoton/30">
          <AvisoSistema
            raiz={c.raiz}
            raizSistema={estado.raizSistema || 'C:\\'}
            esperando={c.esperando}
            alineado="izquierda"
            onResuelto={() => { cargar(); }}
          />
        </div>
      ))}

      {discos.length === 0 ? (
        <p className="text-[12px] text-humo mb-7">
          Ningún vídeo ha necesitado prepararse todavía. Se preparan al abrirlos, sin que tengas
          que esperar: mientras tanto se ve el original.
        </p>
      ) : (
        <div className="flex flex-col gap-5 mb-8">
          {discos.map(d => (
            <Disco
              key={d.raiz}
              disco={d}
              topeGeneral={ajustes.topeGB}
              minLibreGB={estado.minLibreGB}
              ocupado={ocupado}
              onTope={(gb) => guardar({ porDisco: { [d.raiz]: gb } }, `tope:${d.raiz}`)}
              onLiberar={() => liberar(d.raiz)}
            />
          ))}
        </div>
      )}

      {/* Lo que sobra de la regla vieja: son copias del original, y son las que
          de verdad ocupan el disco. No se miden aqui porque el indice viejo no
          guardaba ni ruta ni tamaño. */}
      {totales.antiguos > 0 && (
        <p className="text-[11px] text-humo leading-snug mb-8 -mt-4">
          Hay {numero(totales.antiguos)} vídeos preparados con la regla antigua (copias casi enteras
          del original) que no se miden aquí ni cuentan para el tope. Se borran de una vez con{' '}
          <span className="font-mono text-niebla">node backend/tools/limpiar-proxies.js --apply</span>,
          con los discos conectados.
        </p>
      )}

      {/* Ajustes generales */}
      <div className="grid sm:grid-cols-2 gap-6 pt-5 border-t border-borde-sutil">
        <div>
          <p className="font-mono text-[10px] tracking-wider uppercase text-humo mb-2">Tope general</p>
          <CampoGB
            valor={ajustes.topeGB}
            guardando={ocupado === 'tope:general'}
            onGuardar={(gb) => guardar({ topeGB: gb }, 'tope:general')}
          />
          <p className="mt-2 text-[11px] text-humo leading-snug">
            Para los discos que no tengan uno propio. Un 0 significa sin tope.
          </p>
        </div>

        <div>
          <p className="font-mono text-[10px] tracking-wider uppercase text-humo mb-2">Al llegar al tope</p>
          <div className="inline-flex items-center gap-1 rounded-full bg-grafito/70 p-1">
            {([['preguntar', 'Preguntarme'], ['liberar', 'Liberar los menos vistos']] as const).map(([id, txt]) => (
              <button
                key={id}
                onClick={() => guardar({ alLlegar: id }, 'alLlegar')}
                disabled={ocupado === 'alLlegar'}
                className={`h-8 px-3.5 rounded-full text-[12px] font-medium transition-colors ${
                  ajustes.alLlegar === id ? 'bg-lavanda text-noche' : 'text-niebla hover:text-marfil'
                }`}
              >
                {txt}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-humo leading-snug">
            {ajustes.alLlegar === 'preguntar'
              ? 'No se borra nada: se deja de preparar en ese disco hasta que decidas.'
              : 'Se borran solos los que hace más que no ves. Son regenerables: al volver a abrir uno, se prepara otra vez.'}
          </p>
        </div>

        <div className="sm:col-span-2">
          <p className="font-mono text-[10px] tracking-wider uppercase text-humo mb-2">
            Discos sin sitio · guardar en {estado.raizSistema || 'el disco del sistema'}
          </p>
          {Object.keys(ajustes.alSistema || {}).length === 0 ? (
            <p className="text-[11px] text-humo leading-snug">
              Cuando a un disco le quede poco sitio, se te preguntará si sus vídeos preparados pueden
              guardarse en {estado.raizSistema || 'el disco del sistema'}, en la carpeta de Pensadero. Mientras no
              lo decidas, allí no se escribe nada.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {Object.entries(ajustes.alSistema || {}).map(([raiz, si]) => (
                <div key={raiz} className="flex items-center gap-3 flex-wrap">
                  <span className="font-mono text-[12px] text-marfil w-10">{raiz}</span>
                  <div className="inline-flex items-center gap-1 rounded-full bg-grafito/70 p-1">
                    {([[true, 'Sí'], [false, 'No'], [null, 'Preguntar']] as const).map(([valor, txt]) => (
                      <button
                        key={txt}
                        onClick={() => guardar({ alSistema: { [raiz]: valor } }, `sistema:${raiz}`)}
                        disabled={ocupado === `sistema:${raiz}`}
                        className={`h-7 px-3 rounded-full text-[11px] font-medium transition-colors ${
                          si === valor ? 'bg-lavanda text-noche' : 'text-niebla hover:text-marfil'
                        }`}
                      >
                        {txt}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-humo leading-snug">
                Si a ese disco le falta sitio, sus vídeos preparados van (sí) o no (no) a la carpeta de Pensadero.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Los que ganarían fluidez en un disco, con su botón para prepararlos de golpe. */
function Candidatos({
  f, disco, topeGeneral, ocupado, onPreparar, onSubirTope,
}: {
  f: ProxiesFluidez;
  disco?: ProxiesDisco;
  topeGeneral: number;
  ocupado: string | null;
  onPreparar: () => void;
  onSubirTope: (gb: number) => void;
}) {
  const topeGB = disco ? disco.topeGB : topeGeneral;
  const usado = disco ? disco.bytes : 0;
  const sitio = topeGB > 0 ? topeGB * GB - usado : Infinity;
  // Si no caben, el lote se pararía a mitad: mejor decirlo antes.
  const noCaben = f.bytes > sitio;
  const sugerido = Math.ceil((usado + f.bytes * 1.25) / GB / 10) * 10;

  return (
    <div className="p-3.5 rounded-lg bg-grafito/50 border border-borde-sutil">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="text-[13px] text-marfil">
            <span className="font-mono">{f.raiz}</span> · {numero(f.n)} {f.n === 1 ? 'vídeo iría' : 'vídeos irían'} más fluidos
          </p>
          <p className="mt-1 text-[11px] text-humo">
            de {numero(f.total)} en ese disco · sus versiones ligeras ocuparían ~{tamaño(f.bytes)}
            {f.sinMedir > 0 && ` (${numero(f.sinMedir)} sin medir)`}
          </p>
        </div>
        <button
          onClick={onPreparar}
          disabled={ocupado !== null}
          className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full bg-lavanda text-noche text-[12px] font-medium hover:bg-lavanda-claro transition-colors disabled:opacity-50 shrink-0"
        >
          {ocupado === `preparar:${f.raiz}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
          Prepararlos
        </button>
      </div>

      {noCaben && (
        <p className="mt-2.5 text-[11px] text-melocoton leading-snug">
          No caben en el tope de este disco ({gbTexto(topeGB)} GB, quedan {tamaño(Math.max(0, sitio))}): se pararía a mitad.{' '}
          <button
            onClick={() => onSubirTope(sugerido)}
            disabled={ocupado !== null}
            className="underline underline-offset-2 hover:text-marfil transition-colors"
          >
            Subir el tope a {numero(sugerido)} GB
          </button>
        </p>
      )}
    </div>
  );
}

/** El lote en marcha: cuántos van, cuánto queda y el botón de parar. */
function EnMarcha({ lote, parando, onParar }: { lote: ProxiesLote; parando: boolean; onParar: () => void }) {
  const hecho = lote.total > 0 ? lote.procesados / lote.total : 0;
  return (
    <div className="mb-7 p-4 rounded-lg bg-grafito/60 border border-lavanda/25">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
        <p className="text-[13px] text-marfil">Preparando vídeos…</p>
        <p className="font-mono text-[11px] text-humo tabular-nums">
          {numero(lote.procesados)} de {numero(lote.total)}
          {lote.restanteSeg !== null && ` · quedan ~${tiempo(lote.restanteSeg)}`}
        </p>
      </div>
      <div className="h-1.5 rounded-full bg-pizarra overflow-hidden">
        <div className="h-full rounded-full bg-lavanda transition-all" style={{ width: `${hecho * 100}%` }} />
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <p className="text-[11px] text-humo truncate">{lote.actual || 'en cola…'}</p>
        <button
          onClick={onParar}
          disabled={parando}
          className="h-7 px-3 rounded-full bg-grafito hover:bg-pizarra text-[11px] text-niebla hover:text-marfil transition-colors disabled:opacity-50 shrink-0"
        >
          Parar
        </button>
      </div>
      <p className="mt-2 text-[11px] text-humo leading-snug">
        Puedes seguir usando la app mientras tanto.
      </p>
    </div>
  );
}

/** Cómo acabó la última preparación. */
function Resultado({ lote }: { lote: ProxiesLote }) {
  const cortado = lote.motivo === 'tope' || lote.motivo === 'espacio';
  return (
    <p className={`mb-7 text-[12px] leading-snug ${cortado ? 'text-melocoton' : 'text-humo'}`}>
      {lote.topes && lote.topes.length > 0 && !lote.cancelado
        ? `${numero(lote.hechos)} listos (${tamaño(lote.bytes)}). ${numero(lote.sinSitio || 0)} sin preparar: ${lote.topes.map(t => `${t.raiz} ${t.motivo === 'tope' ? 'llegó a su tope' : t.motivo === 'sistema' ? 'espera a que decidas si puede usar el disco del sistema' : 'se quedó sin sitio'}`).join('; ')}.`
        : lote.motivo === 'tope'
        ? `La preparación se paró: ${lote.raiz || 'el disco'} llegó a su tope. ${numero(lote.hechos)} listos (${tamaño(lote.bytes)}).`
        : lote.motivo === 'espacio'
          ? `La preparación se paró: no queda sitio en disco. ${numero(lote.hechos)} listos.`
          : lote.cancelado
            ? `Preparación parada. ${numero(lote.hechos)} listos (${tamaño(lote.bytes)}); lo hecho se queda hecho.`
            : `Última preparación: ${numero(lote.hechos)} listos (${tamaño(lote.bytes)})${lote.fallos > 0 ? ` · ${numero(lote.fallos)} fallaron` : ''}.`}
    </p>
  );
}

/** Una cifra de cabecera con su pie. */
function Cifra({ valor, pie, destacada, apagada }: { valor: string; pie: string; destacada?: boolean; apagada?: boolean }) {
  return (
    <div className={apagada ? 'opacity-40' : ''}>
      <p className={`text-[26px] leading-none font-bold tabular-nums ${destacada ? 'text-lavanda' : 'text-marfil'}`}>{valor}</p>
      <p className="mt-1.5 text-[11px] text-humo">{pie}</p>
    </div>
  );
}

/** Un disco: cuánto llevan ocupado sus proxies, su tope y qué se puede hacer. */
function Disco({
  disco, topeGeneral, minLibreGB, ocupado, onTope, onLiberar,
}: {
  disco: ProxiesDisco;
  topeGeneral: number;
  minLibreGB: number;
  ocupado: string | null;
  onTope: (gb: number | null) => void;
  onLiberar: () => void;
}) {
  const limite = disco.topeGB * GB;
  const lleno = limite > 0 ? Math.min(1, disco.bytes / limite) : 0;
  const apretado = limite > 0 && lleno >= 0.9;
  // Un disco casi sin sitio no acepta proxies aunque le sobre tope.
  const sinSitio = disco.libreGB !== null && disco.libreGB < minLibreGB;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1.5 flex-wrap">
        <span className="font-mono text-[12px] text-marfil">{disco.raiz}</span>
        <span className="font-mono text-[11px] text-humo tabular-nums">
          {tamaño(disco.bytes)}
          {disco.topeGB > 0 ? ` / ${gbTexto(disco.topeGB)} GB` : ' · sin tope'}
          {disco.n > 0 && ` · ${numero(disco.n)} ${disco.n === 1 ? 'vídeo' : 'vídeos'}`}
        </span>
      </div>

      <div className="h-1.5 rounded-full bg-pizarra overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${apretado ? 'bg-melocoton' : 'bg-lavanda'}`}
          style={{ width: `${(limite > 0 ? lleno : disco.bytes > 0 ? 1 : 0) * 100}%` }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-humo">
          {disco.libreGB !== null ? `${numero(Math.round(disco.libreGB))} GB libres en el disco` : 'disco no conectado'}
          {sinSitio && ' · por debajo del mínimo: aquí no se escribe nada'}
          {!disco.propio && disco.topeGB > 0 && ` · sigue al tope general (${gbTexto(topeGeneral)} GB)`}
        </p>
        <div className="flex items-center gap-2">
          <CampoGB
            valor={disco.topeGB}
            guardando={ocupado === `tope:${disco.raiz}`}
            onGuardar={(gb) => onTope(gb)}
          />
          {disco.propio && (
            <button
              onClick={() => onTope(null)}
              className="text-[11px] text-humo hover:text-niebla transition-colors"
              title="Volver a usar el tope general"
            >
              general
            </button>
          )}
          {disco.bytes > 0 && (
            <button
              onClick={onLiberar}
              disabled={ocupado === `liberar:${disco.raiz}`}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-grafito hover:bg-pizarra text-[11px] text-niebla hover:text-marfil transition-colors disabled:opacity-50"
              title="Borra los menos vistos hasta bajar del tope. Se regeneran al volver a abrirlos."
            >
              {ocupado === `liberar:${disco.raiz}` && <Loader2 className="w-3 h-3 animate-spin" />}
              Liberar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Campo de GB que solo guarda cuando el número cambia (Enter o salir). */
function CampoGB({ valor, guardando, onGuardar }: { valor: number; guardando: boolean; onGuardar: (gb: number) => void }) {
  const [texto, setTexto] = useState(String(valor));
  useEffect(() => { setTexto(String(valor)); }, [valor]);

  const confirmar = () => {
    const n = parseFloat(texto.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) { setTexto(String(valor)); return; }
    if (n !== valor) onGuardar(n);
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        min={0}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onBlur={confirmar}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        disabled={guardando}
        className="w-16 h-7 px-2 rounded bg-grafito border border-borde-sutil text-[12px] text-marfil font-mono tabular-nums focus:outline-none focus:border-lavanda/60 disabled:opacity-50"
      />
      <span className="text-[11px] text-humo">GB</span>
      {guardando && <Loader2 className="w-3 h-3 animate-spin text-lavanda" />}
    </span>
  );
}

/**
 * La pregunta, donde de verdad ocurre: has abierto un vídeo que NO se puede ver
 * sin preparar y ese disco ya está en su tope. Solo sale en ese caso: si el
 * original se puede abrir, se abre y no se pregunta nada.
 */
/**
 * A un disco le falta sitio y sus proxies irían al disco de la carpeta de
 * Pensadero: se pregunta, una vez por disco. Mientras no se decida, allí no
 * se escribe nada. Se usa en el reproductor y en este panel.
 */
export function AvisoSistema({ raiz, raizSistema, esperando, alineado = 'centro', onResuelto }: {
  raiz: string;
  raizSistema: string;
  esperando?: number;
  alineado?: 'centro' | 'izquierda';
  onResuelto: (si: boolean) => void;
}) {
  const [ocupado, setOcupado] = useState<'si' | 'no' | null>(null);
  const decidir = async (si: boolean) => {
    setOcupado(si ? 'si' : 'no');
    try {
      const r = await api.setProxiesAjustes({ alSistema: { [raiz]: si } });
      if (r.success) onResuelto(si);
    } catch { /* sigue la pregunta */ }
    finally { setOcupado(null); }
  };
  const centro = alineado === 'centro';
  return (
    <div className={`flex flex-col gap-3 ${centro ? 'items-center text-center max-w-[420px]' : 'items-start'}`}>
      <p className="text-sm text-niebla">
        A <span className="font-mono text-marfil">{raiz}</span> le queda poco sitio para sus vídeos preparados.
        {esperando && esperando > 0 ? ` ${numero(esperando)} ${esperando === 1 ? 'espera' : 'esperan'}.` : ''}
      </p>
      <p className="text-xs text-humo leading-snug">
        ¿Guardarlos en <span className="font-mono text-niebla">{raizSistema}</span>, en la carpeta de Pensadero?
        Se decide una vez para todo ese disco y se puede cambiar en Estadísticas.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => decidir(true)}
          disabled={ocupado !== null}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-lavanda text-noche text-xs font-medium hover:bg-lavanda-claro transition-colors disabled:opacity-50"
        >
          {ocupado === 'si' && <Loader2 className="w-3 h-3 animate-spin" />}
          Sí, en {raizSistema}
        </button>
        <button
          onClick={() => decidir(false)}
          disabled={ocupado !== null}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-grafito hover:bg-pizarra text-marfil text-xs transition-colors disabled:opacity-50"
        >
          {ocupado === 'no' && <Loader2 className="w-3 h-3 animate-spin" />}
          No
        </button>
      </div>
    </div>
  );
}

export function AvisoTope({ raiz, topeGB, onResuelto }: { raiz: string; topeGB?: number; onResuelto: () => void }) {
  const actual = topeGB && topeGB > 0 ? topeGB : 40;
  const [gb, setGb] = useState(String(Math.round(actual + 50)));
  const [ocupado, setOcupado] = useState<'subir' | 'liberar' | null>(null);

  const subir = async () => {
    const n = parseFloat(gb.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return;
    setOcupado('subir');
    try {
      const r = await api.setProxiesAjustes({ porDisco: { [raiz]: n } });
      if (r.success) onResuelto();
    } catch { /* sigue la pregunta */ }
    finally { setOcupado(null); }
  };

  const liberar = async () => {
    setOcupado('liberar');
    try {
      const r = await api.liberarProxies(raiz);
      if (r.success) onResuelto();
    } catch { /* sigue la pregunta */ }
    finally { setOcupado(null); }
  };

  return (
    <div className="flex flex-col items-center gap-3 max-w-[420px] text-center">
      <p className="text-sm text-niebla">
        Los vídeos preparados de <span className="font-mono text-marfil">{raiz}</span> han llegado
        a su tope de {gbTexto(actual)} GB.
      </p>
      <p className="text-xs text-humo leading-snug">
        No se ha borrado nada. Puedes subirle el tope a este disco o liberar los que hace más que
        no ves (se vuelven a preparar solos si los abres).
      </p>
      <div className="flex items-center gap-2 flex-wrap justify-center">
        <input
          type="number"
          min={0}
          value={gb}
          onChange={(e) => setGb(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') subir(); }}
          className="w-20 h-8 px-2 rounded bg-grafito border border-borde-sutil text-xs text-marfil font-mono tabular-nums focus:outline-none focus:border-lavanda/60"
        />
        <button
          onClick={subir}
          disabled={ocupado !== null}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-lavanda text-noche text-xs font-medium hover:bg-lavanda-claro transition-colors disabled:opacity-50"
        >
          {ocupado === 'subir' && <Loader2 className="w-3 h-3 animate-spin" />}
          Subir el tope
        </button>
        <button
          onClick={liberar}
          disabled={ocupado !== null}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-grafito hover:bg-pizarra text-marfil text-xs transition-colors disabled:opacity-50"
        >
          {ocupado === 'liberar' && <Loader2 className="w-3 h-3 animate-spin" />}
          Liberar los menos vistos
        </button>
      </div>
      <p className="text-[11px] text-humo">
        También se ajusta en Estadísticas, en «Vídeos preparados».
      </p>
    </div>
  );
}
