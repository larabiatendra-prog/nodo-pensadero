import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Clapperboard, Download, FileCode2, FolderOpen, GripVertical, Loader2, Send, Undo2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  api, type EstadoPremiere, type OrdenPremiere, type ResumenEnvioPremiere, type XmlPremiere,
} from '../services/api';
import { cestaPremiere, useCestaPremiere, type Cesta } from '../hooks/useCestaPremiere';
import { config } from '../config';
import type { MediaFile } from '../types';

/**
 * La cesta «Para Premiere» (docs/propuesta-premiere.md).
 *
 * Se llena desde la selección, la búsqueda, una colección o la ficha de un
 * archivo, y vive en una burbuja abajo a la izquierda con su botón «Enviar»:
 * añadir y enviar son dos clics. Lo demás es opcional (el panel: nombre, cómo
 * se ordena, marcadores, secuencia, otras formas de llevarlo).
 *
 * «Enviar» lo hace la extensión de Pensadero dentro de Premiere
 * (premiere/extension): bandejas, los originales importados por el propio
 * Premiere, textos, marcadores y secuencia. Al terminar, la cesta se vacía y
 * sale un resumen que dice lo que no entró y por qué. Si Premiere no está
 * listo, el botón dice exactamente qué falta (y la instalación es un clic).
 */

const ORDENES: Array<{ valor: OrdenPremiere; texto: string }> = [
  { valor: 'dia', texto: 'Por día' },
  { valor: 'persona', texto: 'Por persona' },
  { valor: 'carpeta', texto: 'Por carpeta' },
  { valor: 'todo', texto: 'Todo junto' },
];

const CLAVE = 'pensadero.premiere';
interface Preferencias { ordenar: OrdenPremiere; marcadores: boolean; secuencia: boolean }
function leerPreferencias(): Preferencias {
  const base: Preferencias = { ordenar: 'dia', marcadores: true, secuencia: true };
  try {
    const p = JSON.parse(localStorage.getItem(CLAVE) || 'null');
    if (p && typeof p === 'object') {
      return {
        ordenar: ORDENES.some(o => o.valor === p.ordenar) ? p.ordenar : base.ordenar,
        marcadores: typeof p.marcadores === 'boolean' ? p.marcadores : base.marcadores,
        secuencia: typeof p.secuencia === 'boolean' ? p.secuencia : base.secuencia,
      };
    }
  } catch { /* sin preferencias guardadas */ }
  return base;
}

// DownloadURL solo existe en los navegadores Chromium (Chrome, Edge, Brave...).
const PUEDE_ARRASTRAR = typeof navigator !== 'undefined' && /Chrome\/|Edg\//.test(navigator.userAgent);
const MINIATURAS = 11;

const numero = (n: number) => n.toLocaleString('es-ES');
const plural = (n: number, uno: string, varios: string) => `${numero(n)} ${n === 1 ? uno : varios}`;
const nombrePorDefecto = () =>
  `Pensadero · ${new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '')}`;
const fps = (n: number) => (Math.round(n * 100) / 100).toLocaleString('es-ES');

function urlCompleta(relativa: string) {
  const base = config.apiBaseUrl.replace(/\/api$/, '');
  return new URL(base + relativa, window.location.href).href;
}

/** Qué le falta a Premiere para poder enviar, dicho corto (botón) y largo (panel). */
interface Situacion { listo: boolean; corto: string; largo: string; instalar?: boolean }
function situacionDe(p: EstadoPremiere): Situacion {
  if (p.conectado && p.fallo) {
    return { listo: false, corto: 'Reinstala la extensión', instalar: true, largo: `La extensión de Pensadero está en Premiere pero no consigue hablar con él (${p.fallo}). Reinstálala y reinicia Premiere.` };
  }
  if (p.conectado && (p.puente || 1) < (p.puenteActual || 1)) {
    return { listo: false, corto: 'Reinicia Premiere', largo: 'Hay una versión nueva de la extensión de Pensadero. Guarda, cierra Premiere y vuelve a abrirlo (solo esta vez: a partir de ahora se pone al día sola).' };
  }
  if (p.conectado && !p.proyecto) {
    return { listo: false, corto: 'Abre un proyecto', largo: 'Premiere está abierto pero sin proyecto: abre (o crea) uno y podrás enviar.' };
  }
  if (p.conectado) return { listo: true, corto: 'Enviar', largo: `Al proyecto abierto: «${p.proyecto}».` };
  if (p.instalada === false) {
    return { listo: false, corto: 'Instalar', instalar: true, largo: 'Para enviar directamente, Pensadero se instala una vez en Premiere (un clic).' };
  }
  if (p.abierto) {
    return { listo: false, corto: 'Reinicia Premiere', largo: 'Premiere está abierto pero no responde. Si lo abriste antes de instalar, guarda, ciérralo y ábrelo. Si sigue igual, mira si tiene una ventana esperando respuesta.' };
  }
  return { listo: false, corto: 'Abre Premiere', largo: 'Abre Premiere con tu proyecto y espera unos segundos.' };
}

/** Si hay un Premiere con la extensión. Pregunta más a menudo cuando hace falta. */
function useEstadoPremiere(activo: boolean, deprisa: boolean) {
  const [estado, setEstado] = useState<EstadoPremiere>({ conectado: false, proyecto: null, version: null });
  const [vuelta, setVuelta] = useState(0);
  useEffect(() => {
    if (!activo) return;
    let vivo = true;
    const mirar = () => api.estadoPremiere().then(e => { if (vivo) setEstado(e); }).catch(() => {});
    mirar();
    const t = window.setInterval(mirar, deprisa ? 1500 : 4000);
    return () => { vivo = false; window.clearInterval(t); };
  }, [activo, deprisa, vuelta]);
  return { estado, mirarYa: () => setVuelta(v => v + 1) };
}

type Fase =
  | { tipo: 'quieto' }
  | { tipo: 'preparando' }
  | { tipo: 'enviando'; texto: string };

type Resultado =
  | { ok: true; resumen: ResumenEnvioPremiere | null; proyecto: string | null; antes: Cesta }
  | { ok: false; error: string; resumen: ResumenEnvioPremiere | null };

interface Props {
  /** Todo el catálogo, para las miniaturas de lo que hay en la cesta. */
  archivos: MediaFile[];
}

export default function CestaPremiere({ archivos }: Props) {
  const cesta = useCestaPremiere();
  const [abierta, setAbierta] = useState(false);
  const [prefs, setPrefs] = useState<Preferencias>(leerPreferencias);
  const [xml, setXml] = useState<XmlPremiere | null>(null);
  const [preparandoXml, setPreparandoXml] = useState(false);
  const [errorXml, setErrorXml] = useState<string | null>(null);
  const [fase, setFase] = useState<Fase>({ tipo: 'quieto' });
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [otras, setOtras] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const [mostrando, setMostrando] = useState(false);
  const [instalando, setInstalando] = useState(false);
  const [pulso, setPulso] = useState<number | null>(null);
  // Importar otra vez lo que el proyecto ya tiene. No se recuerda: es una
  // excepción para un envío, no una costumbre que se quede puesta sin verla.
  const [duplicar, setDuplicar] = useState(false);
  const cajaRef = useRef<HTMLDivElement>(null);
  const pedido = useRef(0);
  // Lo que valió para el XML preparado: si cambia algo, ya no sirve.
  const claveXml = useRef('');

  const hay = cesta.ids.length > 0;
  const ocupado = fase.tipo !== 'quieto';
  const { estado: premiere, mirarYa } = useEstadoPremiere(hay || ocupado || !!resultado, abierta || ocupado);
  const situacion = situacionDe(premiere);
  const nombre = cesta.nombre.trim() || nombrePorDefecto();
  const claveActual = JSON.stringify([cesta.ids, nombre, prefs, duplicar]);

  const porId = useMemo(() => new Map(archivos.map(f => [f.id, f])), [archivos]);
  const dentro = useMemo(() => cesta.ids.map(id => porId.get(id)).filter((f): f is MediaFile => !!f), [cesta.ids, porId]);

  useEffect(() => {
    try { localStorage.setItem(CLAVE, JSON.stringify(prefs)); } catch { /* sin almacenamiento */ }
  }, [prefs]);

  // «+14» en la burbuja cada vez que entra algo; un resumen viejo sobra.
  useEffect(() => {
    if (!cesta.ultimoAnadido) return;
    setPulso(cesta.ultimoAnadido.n);
    setResultado(r => (r && r.ok ? null : r));
    const t = window.setTimeout(() => setPulso(null), 1600);
    return () => window.clearTimeout(t);
  }, [cesta.ultimoAnadido]);

  useEffect(() => { if (!hay) setAbierta(false); }, [hay]);

  /** Pide el XML (y el plan) de lo que hay ahora en la cesta. */
  const preparar = useCallback(async (): Promise<XmlPremiere> => {
    const r = await api.prepararPremiere({ ids: cesta.ids, nombre, ...prefs, duplicar });
    claveXml.current = JSON.stringify([cesta.ids, nombre, prefs, duplicar]);
    setXml(r);
    setErrorXml(null);
    return r;
  }, [cesta.ids, nombre, prefs, duplicar]);

  // Con el panel abierto se prepara ya (para la previsión y para arrastrar).
  useEffect(() => {
    if (!abierta || !hay) return;
    const n = ++pedido.current;
    setPreparandoXml(true);
    const t = window.setTimeout(() => {
      preparar()
        .catch(e => { if (n === pedido.current) { setXml(null); setErrorXml(e instanceof Error ? e.message : String(e)); } })
        .finally(() => { if (n === pedido.current) setPreparandoXml(false); });
    }, xml ? 350 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierta, claveActual]);

  // Esc y un clic fuera cierran el panel (la cesta se queda).
  useEffect(() => {
    if (!abierta) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setAbierta(false);
    };
    const clic = (e: MouseEvent) => {
      if (cajaRef.current?.contains(e.target as Node)) return;
      setAbierta(false);
    };
    window.addEventListener('keydown', tecla, true);
    document.addEventListener('mousedown', clic);
    return () => {
      window.removeEventListener('keydown', tecla, true);
      document.removeEventListener('mousedown', clic);
    };
  }, [abierta]);

  // Un resumen sin nada que contar se va solo.
  useEffect(() => {
    if (!resultado || !resultado.ok) return;
    const r = resultado.resumen;
    if (r && (r.avisos.length > 0 || r.importados + (r.reutilizados?.n ?? 0) < r.total)) return;
    const t = window.setTimeout(() => setResultado(null), 8000);
    return () => window.clearTimeout(t);
  }, [resultado]);

  const enviar = async () => {
    if (ocupado || !hay) return;
    setResultado(null);
    setAbierta(false);
    setFase({ tipo: 'preparando' });
    const antes = cestaPremiere.get();
    try {
      const listo = xml && claveXml.current === claveActual ? xml : await preparar();
      const id = await api.enviarPremiere(listo.token);
      setFase({ tipo: 'enviando', texto: 'Esperando a Premiere…' });
      // La extensión lo recoge en su siguiente latido (cada 2 s) y va contando.
      for (;;) {
        await new Promise(r => setTimeout(r, 700));
        const e = await api.envioPremiere(id);
        if (e.estado === 'hecho') {
          cestaPremiere.vaciar();
          setDuplicar(false);
          setResultado({ ok: true, resumen: e.resumen, proyecto: e.proyecto, antes });
          break;
        }
        if (e.estado === 'error') {
          // Lo que ya entró, entró; la cesta sigue llena para reintentar.
          setResultado({ ok: false, error: e.error || 'Premiere no ha podido importarlo.', resumen: e.resumen });
          break;
        }
        if (e.progreso) setFase({ tipo: 'enviando', texto: e.progreso });
      }
    } catch (e) {
      setResultado({ ok: false, error: e instanceof Error ? e.message : String(e), resumen: null });
    } finally {
      setFase({ tipo: 'quieto' });
      mirarYa();
    }
  };

  const instalar = async () => {
    setInstalando(true);
    try {
      await api.instalarPremiere();
      toast.success(premiere.abierto
        ? 'Instalado. Ahora guarda, cierra Premiere y vuelve a abrirlo.'
        : 'Instalado. Abre Premiere y espera unos segundos.', { duration: 8000 });
      mirarYa();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se ha podido instalar');
    } finally {
      setInstalando(false);
    }
  };

  const vaciar = () => {
    const antes = cestaPremiere.get();
    cestaPremiere.vaciar();
    toast(t => (
      <span className="flex items-center gap-3">
        Cesta vaciada
        <button className="text-lavanda underline" onClick={() => { cestaPremiere.restaurar(antes); toast.dismiss(t.id); }}>Deshacer</button>
      </span>
    ), { duration: 6000 });
  };

  const alEmpezarArrastre = (e: React.DragEvent) => {
    if (!xml) { e.preventDefault(); return; }
    const url = urlCompleta(xml.url);
    e.dataTransfer.setData('DownloadURL', `application/xml:${xml.archivo}:${url}`);
    e.dataTransfer.setData('text/uri-list', url);
    e.dataTransfer.effectAllowed = 'copy';
    setArrastrando(true);
  };

  const guardar = () => {
    if (!xml) return;
    const a = document.createElement('a');
    a.href = urlCompleta(xml.url);
    a.download = xml.archivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const mostrar = async () => {
    if (!xml) return;
    setMostrando(true);
    try {
      const r = await api.mostrarPremiere(xml.token);
      toast.success(`Guardado en Descargas: ${r.ruta.split(/[\\/]/).pop()}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se ha podido guardar');
    } finally {
      setMostrando(false);
    }
  };

  if (!hay && !ocupado && !resultado) return null;

  const r = xml?.resumen;
  const av = xml?.avisos;
  const prev = xml?.prevision;
  const listoXml = !!xml && !preparandoXml;

  return (
    <div ref={cajaRef} className="relative z-10 self-start">
      {/* ── El resumen de lo enviado ── */}
      {resultado && !abierta && (
        <div role="status" className="absolute bottom-full left-0 mb-3 w-[min(24rem,calc(100vw-3rem))] bg-tinta/95 backdrop-blur-xs border border-pizarra rounded-2xl shadow-2xl p-4 animate-fadeIn">
          <div className="flex items-start gap-2">
            {resultado.ok
              ? <Check className="w-5 h-5 text-estado-exito shrink-0 mt-0.5" />
              : <AlertTriangle className="w-5 h-5 text-estado-error shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              {resultado.ok ? (
                <>
                  <p className="text-sm text-marfil">
                    {resultado.resumen
                      ? (() => {
                        const dentro = resultado.resumen.importados + (resultado.resumen.reutilizados?.n ?? 0);
                        return dentro === resultado.resumen.total
                          ? `${plural(dentro, 'archivo', 'archivos')} en Premiere`
                          : `${numero(dentro)} de ${numero(resultado.resumen.total)} en Premiere`;
                      })()
                      : 'Enviado a Premiere'}
                    {resultado.proyecto ? <span className="text-niebla"> · «{resultado.proyecto}»</span> : null}
                  </p>
                  {resultado.resumen?.bandeja && (
                    <p className="text-xs text-niebla mt-0.5">
                      En la bandeja «{resultado.resumen.bandeja}»
                      {resultado.resumen.secuencia
                        ? `, con su secuencia (${resultado.resumen.secuencia.ancho}×${resultado.resumen.secuencia.alto}${resultado.resumen.secuencia.fps ? ` · ${fps(resultado.resumen.secuencia.fps)} fps` : ''})`
                        : ''}.
                    </p>
                  )}
                  {resultado.resumen?.reutilizados && resultado.resumen.reutilizados.n > 0 && (
                    <p className="text-xs text-niebla mt-1">
                      {resultado.resumen.reutilizados.n === 1 ? '1 ya estaba' : `${numero(resultado.resumen.reutilizados.n)} ya estaban`} en el proyecto
                      {resultado.resumen.reutilizados.bandejas.length > 0 && (
                        <> (en {resultado.resumen.reutilizados.bandejas.slice(0, 2).map(b => (b ? `«${b}»` : 'la raíz')).join(', ')}{resultado.resumen.reutilizados.bandejas.length > 2 ? '…' : ''})</>
                      )}: se {resultado.resumen.reutilizados.n === 1 ? 'ha usado ese' : 'han usado esos'} en la secuencia, sin duplicar{resultado.resumen.reutilizados.n === 1 ? 'lo' : 'los'} ni tocar sus notas.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm text-estado-error">{resultado.error}</p>
                  {resultado.resumen && resultado.resumen.importados > 0 && (
                    <p className="text-xs text-niebla mt-0.5">Antes del fallo entraron {numero(resultado.resumen.importados)} de {numero(resultado.resumen.total)}, en la bandeja «{resultado.resumen.bandeja}». La cesta sigue llena.</p>
                  )}
                </>
              )}
              {resultado.resumen && resultado.resumen.avisos.length > 0 && (
                <ul className="mt-2 space-y-1.5 text-xs text-estado-aviso list-disc pl-4">
                  {resultado.resumen.avisos.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              )}
              <div className="flex gap-2 mt-3">
                {resultado.ok ? (
                  <button
                    onClick={() => { cestaPremiere.restaurar(resultado.antes); setResultado(null); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-grafito text-niebla hover:bg-pizarra hover:text-marfil"
                    title="Vuelve a poner en la cesta lo que se envió (lo de Premiere no se toca)"
                  >
                    <Undo2 className="w-3.5 h-3.5" /> Volver a la cesta
                  </button>
                ) : hay && (
                  <button onClick={enviar} className="px-3 py-1.5 rounded-full text-xs bg-lavanda text-noche hover:bg-lavanda-claro">Reintentar</button>
                )}
                <button onClick={() => setResultado(null)} className="px-3 py-1.5 rounded-full text-xs text-humo hover:text-marfil hover:bg-pizarra">Cerrar</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── El panel (opcional) ── */}
      {abierta && hay && (
        <div
          role="dialog"
          aria-label="Para Premiere"
          className="absolute bottom-full left-0 mb-3 w-[min(26rem,calc(100vw-3rem))] max-h-[calc(100vh-8rem)] overflow-y-auto bg-tinta/95 backdrop-blur-xs border border-pizarra rounded-2xl shadow-2xl p-4 animate-fadeIn"
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-marfil font-medium flex items-center gap-2">
              <Clapperboard className="w-4 h-4 text-lavanda" />
              Para Premiere <span className="text-niebla font-normal">· {plural(cesta.ids.length, 'archivo', 'archivos')}</span>
            </h2>
            <div className="flex items-center gap-1">
              <button onClick={vaciar} className="px-2 py-1 rounded-full text-xs text-humo hover:text-estado-error hover:bg-pizarra">Vaciar</button>
              <button onClick={() => setAbierta(false)} className="p-1 rounded-full text-humo hover:text-marfil hover:bg-pizarra" title="Cerrar (Esc)">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-6 gap-1.5 mb-3">
            {dentro.slice(0, MINIATURAS).map(f => (
              <div key={f.id} className="group relative aspect-square rounded-md overflow-hidden bg-grafito" title={f.name}>
                <img src={f.thumbnail} alt="" loading="lazy" className="w-full h-full object-cover"
                  onError={e => { (e.target as HTMLImageElement).style.opacity = '0'; }} />
                <button
                  onClick={() => cestaPremiere.quitar([f.id])}
                  className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-noche/80 text-marfil flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100"
                  title="Quitar de la cesta"
                  aria-label={`Quitar ${f.name}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {cesta.ids.length > MINIATURAS && (
              <div className="aspect-square rounded-md bg-grafito text-niebla text-xs flex items-center justify-center">
                +{numero(cesta.ids.length - MINIATURAS)}
              </div>
            )}
          </div>

          <label className="block text-xs text-niebla mb-1" htmlFor="cesta-nombre">Nombre de la bandeja</label>
          <input
            id="cesta-nombre"
            value={cesta.nombre}
            placeholder={nombrePorDefecto()}
            onChange={e => cestaPremiere.renombrar(e.target.value)}
            maxLength={120}
            className="w-full bg-grafito border border-pizarra rounded-lg px-3 py-2 text-sm text-marfil placeholder:text-humo focus:outline-hidden focus:border-lavanda-archivo mb-3"
          />

          <div className="text-xs text-niebla mb-1">Ordenar dentro</div>
          <div className="flex flex-wrap gap-1.5 mb-3" role="radiogroup" aria-label="Ordenar dentro">
            {ORDENES.map(o => (
              <button
                key={o.valor}
                role="radio"
                aria-checked={prefs.ordenar === o.valor}
                onClick={() => setPrefs(p => ({ ...p, ordenar: o.valor }))}
                className={`px-3 py-1.5 rounded-full text-sm transition-colors ${prefs.ordenar === o.valor
                  ? 'bg-lavanda text-noche'
                  : 'bg-grafito text-niebla hover:bg-pizarra hover:text-marfil'}`}
              >
                {o.texto}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-niebla mb-1.5 cursor-pointer">
            <input type="checkbox" className="accent-lavanda" checked={prefs.secuencia}
              onChange={e => setPrefs(p => ({ ...p, secuencia: e.target.checked }))} />
            Crear una secuencia con los clips en orden
          </label>
          {prefs.secuencia && prev && (
            <p className="text-xs text-humo ml-6 mb-1.5">
              Será {prev.forma ?? ''} {prev.ancho}×{prev.alto} a {prev.fpsTexto} fps, como la mayoría.
              {prev.otraForma > 0 && <span className="text-estado-aviso"> {prev.otraForma === 1 ? '1 clip tiene otra forma: no se deforma, irá con bandas.' : `${numero(prev.otraForma)} clips tienen otra forma: no se deforman, irán con bandas.`}</span>}
              {prev.otraCadencia > 0 && <span className="text-estado-aviso"> {plural(prev.otraCadencia, 'va', 'van')} a otra cadencia: Premiere {prev.otraCadencia === 1 ? 'lo adapta' : 'los adapta'}.</span>}
            </p>
          )}
          <label className="flex items-center gap-2 text-sm text-niebla mb-4 cursor-pointer">
            <input type="checkbox" className="accent-lavanda" checked={prefs.marcadores}
              onChange={e => setPrefs(p => ({ ...p, marcadores: e.target.checked }))} />
            Notas y descripciones como marcadores
          </label>
          <label className="flex items-start gap-2 text-sm text-niebla -mt-2.5 mb-4 cursor-pointer">
            <input type="checkbox" className="accent-lavanda mt-1" checked={duplicar}
              onChange={e => setDuplicar(e.target.checked)} />
            <span>
              Importar otra vez aunque ya esté en el proyecto
              <span className="block text-xs text-humo">Si no, se usa el clip que ya tienes y no se duplica.</span>
            </span>
          </label>

          {errorXml ? (
            <div className="rounded-xl border border-estado-error/40 bg-estado-error/10 text-estado-error text-sm p-3">{errorXml}</div>
          ) : situacion.listo ? (
            <>
              <button
                onClick={enviar}
                disabled={ocupado}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium bg-lavanda text-noche hover:bg-lavanda-claro transition-colors disabled:opacity-60"
              >
                <Send className="w-4 h-4" /> Enviar a Premiere
              </button>
              <p className="text-xs text-niebla text-center mt-2 flex items-center justify-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-estado-exito shrink-0" />
                {situacion.largo}{r ? ` · ${plural(r.clips, 'archivo', 'archivos')}` : ''}
              </p>
            </>
          ) : (
            <div className="rounded-xl border border-pizarra bg-grafito/60 p-3">
              <p className="text-sm text-marfil">{situacion.corto}</p>
              <p className="text-xs text-niebla mt-1">{situacion.largo}</p>
              {situacion.instalar && (
                <button
                  onClick={instalar}
                  disabled={instalando}
                  className="mt-3 flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-60"
                >
                  {instalando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Instalar en Premiere
                </button>
              )}
            </div>
          )}

          {/* Otras formas: el XML, para DaVinci o para importarlo a mano */}
          {!errorXml && (
            <div className="mt-3 border-t border-pizarra pt-3">
              <button onClick={() => setOtras(o => !o)} className="flex items-center gap-1 text-xs text-humo hover:text-niebla">
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${otras ? '' : '-rotate-90'}`} />
                Otras formas (XML para DaVinci o para importar a mano)
              </button>
              {otras && (
                <div className="mt-2 space-y-2">
                  {PUEDE_ARRASTRAR && (
                    <div
                      draggable={listoXml}
                      onDragStart={alEmpezarArrastre}
                      onDragEnd={() => setArrastrando(false)}
                      title="Arrástrala a tu editor"
                      className={`flex items-center gap-3 rounded-xl border border-dashed px-3 py-2 select-none transition-all ${listoXml
                        ? 'border-lavanda-archivo bg-grafito cursor-grab active:cursor-grabbing hover:border-lavanda'
                        : 'border-pizarra bg-grafito/60'} ${arrastrando ? 'opacity-50' : ''}`}
                    >
                      <GripVertical className="w-4 h-4 text-humo shrink-0" />
                      <FileCode2 className="w-5 h-5 text-lavanda shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm text-marfil truncate">{xml ? xml.archivo : `${nombre}.xml`}</div>
                        <div className="text-xs text-humo">{arrastrando ? 'Suéltala en tu editor' : 'Arrástrala a tu editor'}</div>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={mostrar}
                      disabled={!listoXml || mostrando}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm bg-grafito text-niebla hover:bg-pizarra hover:text-marfil disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Lo guarda en Descargas y abre la carpeta con el archivo marcado"
                    >
                      {mostrando ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />} Mostrar en la carpeta
                    </button>
                    <button
                      onClick={guardar}
                      disabled={!listoXml}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm bg-grafito text-niebla hover:bg-pizarra hover:text-marfil disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Download className="w-4 h-4" /> Guardar el XML
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {av && (av.desconectados.length > 0 || av.sinDatos > 0 || av.fuera > 0 || (av.ilegibles || []).length > 0) && (
            <ul className="mt-3 space-y-1.5 text-xs text-estado-aviso">
              {av.desconectados.map(d => (
                <li key={d.disco}>
                  {d.n === 1 ? '1 está' : `${numero(d.n)} están`} en «{d.disco}», que no está conectado: enchúfalo antes de enviar o no {d.n === 1 ? 'entrará' : 'entrarán'}.
                </li>
              ))}
              {av.sinDatos > 0 && (
                <li>{av.sinDatos === 1 ? '1 no entra' : `${numero(av.sinDatos)} no entran`}: {av.sinDatos === 1 ? 'está' : 'están'} en un disco desconectado y aún no se sabe cuánto duran.</li>
              )}
              {av.fuera > 0 && <li>{av.fuera === 1 ? '1 no entra' : `${numero(av.fuera)} no entran`} (bajo candado o ya no {av.fuera === 1 ? 'está' : 'están'}).</li>}
              {(av.ilegibles || []).length > 0 && (
                <li>{av.ilegibles.length === 1 ? '1 no se puede leer y no se enviará' : `${numero(av.ilegibles.length)} no se pueden leer y no se enviarán`} (¿dañado{av.ilegibles.length === 1 ? '' : 's'}?): {av.ilegibles.slice(0, 3).join(', ')}{av.ilegibles.length > 3 ? '…' : ''}.</li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* ── La burbuja: abrir (izquierda) y enviar (derecha) ── */}
      <div className={`flex items-stretch rounded-full shadow-2xl border overflow-hidden ${abierta ? 'border-lavanda' : 'border-pizarra'} bg-tinta/95 backdrop-blur-xs`}>
        <button
          onClick={() => { setResultado(null); setAbierta(a => !a); }}
          disabled={!hay}
          className={`relative flex items-center gap-2.5 pl-3 pr-3 py-2.5 transition-colors ${abierta ? 'bg-lavanda text-noche' : 'text-marfil hover:bg-grafito'}`}
          title={abierta ? 'Cerrar' : 'Ver lo que vas a llevar a Premiere'}
        >
          <Clapperboard className={`w-5 h-5 ${abierta ? '' : 'text-lavanda'}`} />
          <span className="text-sm font-medium whitespace-nowrap">Para Premiere</span>
          <span className={`min-w-6 h-6 px-1.5 rounded-full text-xs font-semibold flex items-center justify-center ${abierta ? 'bg-noche text-lavanda' : 'bg-lavanda text-noche'} ${pulso ? 'animate-bounce' : ''}`}>
            {numero(cesta.ids.length)}
          </span>
          {pulso !== null && (
            <span className="absolute -top-3 right-2 px-2 py-0.5 rounded-full bg-estado-exito text-noche text-xs font-semibold animate-fadeIn pointer-events-none">
              +{numero(pulso)}
            </span>
          )}
        </button>
        {ocupado ? (
          <span className="flex items-center gap-2 px-3 text-xs text-niebla border-l border-pizarra max-w-48">
            <Loader2 className="w-4 h-4 animate-spin text-lavanda shrink-0" />
            <span className="truncate">{fase.tipo === 'enviando' ? fase.texto : 'Preparando…'}</span>
          </span>
        ) : hay && situacion.listo ? (
          <button
            onClick={enviar}
            className="flex items-center gap-1.5 px-4 text-sm font-medium bg-lavanda text-noche hover:bg-lavanda-claro transition-colors"
            title={situacion.largo}
          >
            <Send className="w-4 h-4" /> Enviar
          </button>
        ) : hay ? (
          <button
            onClick={() => { setResultado(null); setAbierta(true); }}
            className="flex items-center gap-1.5 px-3 text-xs text-estado-aviso border-l border-pizarra hover:bg-grafito whitespace-nowrap"
            title={situacion.largo}
          >
            <span className="w-2 h-2 rounded-full bg-estado-aviso" /> {situacion.corto}
          </button>
        ) : null}
      </div>
    </div>
  );
}
