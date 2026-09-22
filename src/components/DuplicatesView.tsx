import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Check, Undo2, Loader2, RotateCw, ChevronLeft, ChevronRight,
  SkipForward, Zap, Plus, Eye, EyeOff, Trash2, RotateCcw, Film,
  Waypoints, ArrowDownWideNarrow,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../services/api';
import type { MediaFile } from '../types';
import PestanasGemelas, { type ApartadoGemelas } from './PestanasGemelas';

/**
 * Tomas gemelas.
 *
 * En material de camara el mismo plano se repite doce veces y la galeria lo
 * enseña doce veces. Aqui salen agrupadas, grupo a grupo: el sistema PROPONE
 * cual se queda, tu confirmas o cambias, y el resto deja de aparecer en la
 * galeria. No se borra ni se mueve nada en disco.
 *
 * El modelo es de dos cajones —SE QUEDAN y SE APARTAN— y una tarjeta se mueve
 * de uno a otro con un clic. Puede quedarse MAS DE UNA: en una rafaga de doce
 * fotos a veces valen tres, y obligar a elegir una sola era mentir sobre como
 * se trabaja de verdad.
 *
 * Esto es una cadena de montaje, no una galeria: se diseña para hacer mil
 * decisiones seguidas. De ahi el teclado (flechas + Enter), que los ya
 * resueltos desaparezcan de la cola, y que al volver te deje donde lo dejaste.
 */

interface Grupo {
  id: string;
  carpeta: string;
  etiqueta: string;
  fileIds: string[];
  similitudMin: number | null;
  /** 'secuencia' = numeracion correlativa rellena de ceros (render exportado). */
  tipo?: string;
  prefijo?: string;
  desde?: number;
  hasta?: number;
  /** Puesto en cada uno de los dos ordenes que calcula el backend. */
  orden?: number;
  ordenCantidad?: number;
}

interface Props {
  files: MediaFile[];
  descartadas: Set<string>;
  /** Notas humanas por fileId: una toma anotada no la descarta una maquina. */
  notas?: Record<string, string>;
  /**
   * Falso cuando hay algo abierto encima (visor, vista rapida, pase). La vista
   * sigue montada debajo del visor, y sin esto sus atajos seguian vivos: Intro
   * o flecha abajo aceptaban el grupo que no estabas viendo.
   */
  tecladoActivo?: boolean;
  onBack: () => void;
  onCambiarApartado: (a: ApartadoGemelas) => void;
  onSelectFile: (file: MediaFile) => void;
  /** Persiste el cambio y actualiza el estado global. */
  onCambiarDescartes: (fileIds: string[], descartar: boolean) => Promise<void>;
}

// Rango util del parecido. Por debajo de 0.90 entran planos distintos del
// mismo sitio (no son gemelos); por encima de 0.99 solo quedan calcados.
const UMBRAL_MIN = 0.90;
const UMBRAL_MAX = 0.99;

/** Donde lo dejaste la ultima vez. Por umbral, porque cambiarlo cambia la cola. */
const CLAVE_CHECKPOINT = 'pensadero.gemelas.checkpoint';
const CLAVE_SOLO_PENDIENTES = 'pensadero.gemelas.soloPendientes';
const CLAVE_ORDEN = 'pensadero.gemelas.orden';

/** Como de exigente esta el liston, dicho en palabras. */
function descripcionUmbral(u: number): string {
  if (u <= 0.93) return 'abierto: entra material solo parecido';
  if (u <= 0.96) return 'equilibrado';
  if (u <= 0.98) return 'estricto: casi calcadas';
  return 'solo lo idéntico';
}

/**
 * Fondo de la barra. El tramo recorrido se enciende cuanto mas a la derecha
 * —de lavanda apagado a lavanda pleno—, asi el propio control dice hacia donde
 * aprieta sin necesidad de leer el numero.
 */
function fondoBarra(u: number): string {
  const t = Math.max(0, Math.min(1, (u - UMBRAL_MIN) / (UMBRAL_MAX - UMBRAL_MIN)));
  const pct = (t * 100).toFixed(1);
  const alfaIzq = (0.35 + 0.25 * t).toFixed(2);
  const alfaDer = (0.55 + 0.45 * t).toFixed(2);
  return `linear-gradient(90deg, rgba(124,107,178,${alfaIzq}) 0%, rgba(200,182,255,${alfaDer}) ${pct}%, rgba(37,42,66,0.55) ${pct}%, rgba(37,42,66,0.55) 100%)`;
}

/**
 * Elige la toma que se queda, y explica por que.
 *
 * El orden de los criterios no es arbitrario: primero lo que TU ya decidiste
 * (favorito, nota), despues lo que tiene mas material (duracion: las tomas
 * cortas de una tanda suelen ser arranques fallidos), y solo al final lo
 * tecnico. El desempate ultimo es el nombre, para que la propuesta no baile
 * entre recargas.
 *
 * Devuelve el motivo porque un automatismo que no dice por que ha elegido no
 * se puede auditar de un vistazo — y entonces no lo usas.
 */
function elegirMejor(
  candidatos: MediaFile[],
  notas?: Record<string, string>,
): { file: MediaFile; motivo: string } {
  const favorita = candidatos.find(f => f.isFavorite);
  if (favorita) return { file: favorita, motivo: 'la tenías en favoritos' };

  const conNota = candidatos.filter(f => (notas?.[f.id] || '').trim());
  if (conNota.length === 1) return { file: conNota[0], motivo: 'es la única con nota tuya' };

  const conDuracion = candidatos.filter(f => typeof f.duration === 'number' && f.duration > 0);
  if (conDuracion.length > 1) {
    const larga = conDuracion.reduce((a, b) => ((b.duration || 0) > (a.duration || 0) ? b : a));
    const resto = conDuracion.filter(f => f !== larga);
    const segunda = resto.reduce((a, b) => ((b.duration || 0) > (a.duration || 0) ? b : a));
    // Solo vale como motivo si destaca de verdad; si todas duran casi igual,
    // "la mas larga" seria una moneda al aire disfrazada de criterio.
    if ((larga.duration || 0) > (segunda.duration || 0) * 1.15) {
      return { file: larga, motivo: `la toma más larga (${(larga.duration || 0).toFixed(1)} s)` };
    }
  }

  const pixeles = (f: MediaFile) => (f.dimensions ? f.dimensions.width * f.dimensions.height : 0);
  const mayorRes = candidatos.reduce((a, b) => (pixeles(b) > pixeles(a) ? b : a));
  if (pixeles(mayorRes) > 0 && candidatos.some(f => pixeles(f) < pixeles(mayorRes))) {
    return {
      file: mayorRes,
      motivo: `más resolución (${mayorRes.dimensions?.width}×${mayorRes.dimensions?.height})`,
    };
  }

  const pesada = candidatos.reduce((a, b) => (b.size > a.size ? b : a));
  if (pesada.size > 0 && candidatos.some(f => f.size < pesada.size)) {
    return { file: pesada, motivo: 'el archivo con más datos' };
  }

  const porNombre = [...candidatos].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), 'es', { numeric: true }));
  return { file: porNombre[0], motivo: 'todas son equivalentes: se queda la primera' };
}

export default function DuplicatesView({
  files, descartadas, notas, tecladoActivo = true, onBack, onCambiarApartado, onSelectFile, onCambiarDescartes,
}: Props) {
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [umbral, setUmbral] = useState(0.96);
  // El valor que se arrastra va aparte del aplicado: recalcular en cada pixel
  // del arrastre serian cientos de comparaciones sobre decenas de miles de
  // archivos. Solo se recalcula al soltar.
  const [umbralUI, setUmbralUI] = useState(0.96);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [pagina, setPagina] = useState(0);
  /** Las que se quedan en cada grupo. Sin entrada = la propuesta automatica. */
  const [seleccion, setSeleccion] = useState<Record<string, string[]>>({});
  const [aplicandoLote, setAplicandoLote] = useState(false);
  /** Los ya resueltos salen de la cola: revisarlos otra vez no es trabajo. */
  const [soloPendientes, setSoloPendientes] = useState<boolean>(() => {
    try { return localStorage.getItem(CLAVE_SOLO_PENDIENTES) !== '0'; } catch { return true; }
  });
  /**
   * En que orden va la cola, con los dos puestos que ya trae cada grupo:
   *   'parecido' — encadenados carpeta a carpeta: el que viene se parece al
   *                que acabas de decidir.
   *   'cantidad' — primero los grupos con mas copias y, a igualdad de
   *                copias, encadenados por parecido igualmente.
   */
  const [ordenPor, setOrdenPor] = useState<'parecido' | 'cantidad'>(() => {
    try {
      const v = localStorage.getItem(CLAVE_ORDEN);
      return v === 'cantidad' || v === 'tamaño' ? 'cantidad' : 'parecido';
    } catch { return 'parecido'; }
  });
  /** Grupo al que volver en cuanto la cola se rehaga (al cambiar de orden). */
  const irAGrupo = useRef<string | null>(null);
  /** Evita que el checkpoint se restaure mas de una vez por carga. */
  const checkpointAplicado = useRef(false);
  /**
   * Ultima accion, para deshacerla. Esta vista invita a ir rapido con el
   * teclado; sin una vuelta atras barata, esa velocidad da miedo y no se usa.
   */
  const [ultimaAccion, setUltimaAccion] = useState<
    { apartadas: string[]; recuperadas: string[]; que: string } | null
  >(null);

  const porId = useMemo(() => new Map(files.map(f => [f.id, f])), [files]);

  // Cuantas copias exactas hay por decidir, para la pestaña de al lado.
  const [copiasPendientes, setCopiasPendientes] = useState<number | undefined>(undefined);
  useEffect(() => {
    api.getCopiasResumen()
      .then(r => { if (r.success && r.data) setCopiasPendientes(r.data.pendientes); })
      .catch(() => { /* la pestaña sale sin numero */ });
  }, []);

  const cargar = async (u: number) => {
    setCargando(true);
    setError(null);
    checkpointAplicado.current = false;
    try {
      const r = await api.getDuplicates(u);
      if (r.success && r.data) {
        setGrupos(r.data.grupos || []);
        setStats(r.data.stats || null);
        setSeleccion({});
      } else {
        setError((r as unknown as { error?: string }).error || 'no se pudo calcular');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'error de red');
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => { cargar(umbral); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [umbral]);

  const archivosDe = useCallback(
    (g: Grupo) => g.fileIds.map(id => porId.get(id)).filter(Boolean) as MediaFile[],
    [porId],
  );

  const estaResuelto = useCallback(
    (g: Grupo) => g.fileIds.some(id => descartadas.has(id)),
    [descartadas],
  );

  /**
   * La cola de trabajo. Con `soloPendientes`, los resueltos desaparecen: al
   * aceptar uno, el siguiente ocupa su sitio y no hay que avanzar a mano.
   */
  const cola = useMemo(() => {
    const base = soloPendientes ? grupos.filter(g => !estaResuelto(g)) : grupos;
    if (ordenPor === 'parecido') return base; // ya viene encadenado del backend
    return [...base].sort((a, b) => {
      const pa = typeof a.ordenCantidad === 'number' ? a.ordenCantidad : Infinity;
      const pb = typeof b.ordenCantidad === 'number' ? b.ordenCantidad : Infinity;
      if (pa !== pb) return pa - pb;
      // Sin el dato del backend (version vieja), al menos de mas copias a menos.
      return b.fileIds.length - a.fileIds.length || a.etiqueta.localeCompare(b.etiqueta, 'es');
    });
  }, [grupos, soloPendientes, estaResuelto, ordenPor]);

  // La cola encoge al resolver: sin esto la pagina se saldria del array y la
  // vista quedaria en blanco al llegar al final.
  useEffect(() => {
    setPagina(p => (cola.length === 0 ? 0 : Math.min(p, cola.length - 1)));
  }, [cola.length]);

  // Cambiar de orden no debe perderte: se vuelve al MISMO grupo, que ahora
  // esta en otro sitio de la cola.
  useEffect(() => {
    if (!irAGrupo.current) return;
    const i = cola.findIndex(g => g.id === irAGrupo.current);
    irAGrupo.current = null;
    if (i >= 0) setPagina(i);
  }, [cola]);

  /**
   * Checkpoint: al volver a la pestaña te deja donde lo dejaste, no en el
   * grupo 1. Se guarda por umbral porque cambiarlo rehace la cola entera y la
   * posicion vieja dejaria de significar nada.
   */
  useEffect(() => {
    if (cargando || cola.length === 0 || checkpointAplicado.current) return;
    checkpointAplicado.current = true;
    try {
      const crudo = localStorage.getItem(CLAVE_CHECKPOINT);
      if (!crudo) return;
      const cp = JSON.parse(crudo);
      if (!cp || cp.umbral !== umbral) return;
      // Por ID antes que por numero: el numero depende del orden, y el orden
      // puede haber cambiado entre una visita y la siguiente.
      const porId = cp.grupoId ? cola.findIndex(g => g.id === cp.grupoId) : -1;
      const destino = porId >= 0
        ? porId
        : (typeof cp.pagina === 'number' && cp.pagina < cola.length ? cp.pagina : -1);
      if (destino > 0) {
        setPagina(destino);
        toast(`Retomando donde lo dejaste: grupo ${destino + 1}`);
      }
    } catch { /* sin checkpoint utilizable: empezamos por el principio */ }
  }, [cargando, cola.length, umbral]);

  useEffect(() => {
    if (cargando) return;
    try {
      localStorage.setItem(CLAVE_CHECKPOINT, JSON.stringify({
        umbral, pagina, grupoId: cola[pagina]?.id, ts: Date.now(),
      }));
    } catch { /* modo privado */ }
  }, [pagina, umbral, cargando, cola]);

  /** Propuesta automatica del grupo (motivo incluido). */
  const propuestaDe = useCallback((g: Grupo) => {
    const candidatos = archivosDe(g);
    if (candidatos.length === 0) return null;
    return elegirMejor(candidatos, notas);
  }, [archivosDe, notas]);

  /** Las que se quedan ahora mismo: tu seleccion o, si no la has tocado, la propuesta. */
  const quedanDe = useCallback((g: Grupo): string[] => {
    const manual = seleccion[g.id];
    if (manual && manual.length > 0) return manual;
    const p = propuestaDe(g);
    return p ? [p.file.id] : [];
  }, [seleccion, propuestaDe]);

  const grupoActual = cola[pagina];
  const propuesta = grupoActual ? propuestaDe(grupoActual) : null;
  const quedan = grupoActual ? quedanDe(grupoActual) : [];
  const esPropuestaPura = grupoActual ? !seleccion[grupoActual.id] : true;

  /** Mueve una toma de un cajon al otro. Nunca deja el grupo sin ninguna. */
  const alternar = (fileId: string) => {
    if (!grupoActual) return;
    const actuales = quedan;
    const dentro = actuales.includes(fileId);
    if (dentro && actuales.length === 1) {
      toast('Alguna tiene que quedarse. Marca otra antes de soltar esta.');
      return;
    }
    const siguiente = dentro ? actuales.filter(id => id !== fileId) : [...actuales, fileId];
    setSeleccion(prev => ({ ...prev, [grupoActual.id]: siguiente }));
  };

  /**
   * Deja constancia de lo hecho y lo anuncia con un "deshacer" al lado. El
   * aviso es el sitio natural para arrepentirse: aparece justo donde acabas
   * de mirar y desaparece solo si no lo necesitas.
   */
  const registrarAccion = (apartadas: string[], recuperadas: string[], que: string) => {
    setUltimaAccion({ apartadas, recuperadas, que });
    toast.success(
      (t) => (
        <span className="flex items-center gap-3">
          {que}
          <button
            onClick={() => { toast.dismiss(t.id); deshacer({ apartadas, recuperadas, que }); }}
            className="px-2 py-0.5 rounded-full text-xs font-medium bg-pizarra text-lavanda hover:text-marfil"
          >
            Deshacer
          </button>
        </span>
      ),
      { duration: 6000 },
    );
  };

  /** Invierte la ultima accion: lo apartado vuelve y lo recuperado se aparta. */
  const deshacer = async (accion?: { apartadas: string[]; recuperadas: string[]; que: string }) => {
    const a = accion || ultimaAccion;
    if (!a) { toast('No hay nada que deshacer.'); return; }
    setTrabajando(true);
    try {
      if (a.apartadas.length) await onCambiarDescartes(a.apartadas, false);
      if (a.recuperadas.length) await onCambiarDescartes(a.recuperadas, true);
      setUltimaAccion(null);
      toast.success('Deshecho.');
    } finally {
      setTrabajando(false);
    }
  };

  /** Aplica el grupo actual: se quedan las marcadas, se apartan las demas. */
  const aceptarGrupo = async () => {
    if (!grupoActual || trabajando) return;
    const sequedan = new Set(quedan);
    const aApartar = grupoActual.fileIds.filter(id => !sequedan.has(id) && !descartadas.has(id));
    const aRecuperar = grupoActual.fileIds.filter(id => sequedan.has(id) && descartadas.has(id));
    setTrabajando(true);
    try {
      if (aApartar.length) await onCambiarDescartes(aApartar, true);
      if (aRecuperar.length) await onCambiarDescartes(aRecuperar, false);
      if (aApartar.length === 0 && aRecuperar.length === 0) {
        toast('Este grupo ya estaba así.');
      } else {
        registrarAccion(aApartar, aRecuperar,
          `${aApartar.length} apartadas · se ${quedan.length === 1 ? 'queda' : 'quedan'} ${quedan.length}`);
      }
      // Con la cola filtrada el grupo resuelto desaparece solo y el siguiente
      // ocupa su sitio; avanzar ademas se saltaria uno.
      if (!soloPendientes) setPagina(p => Math.min(p + 1, cola.length - 1));
    } finally {
      setTrabajando(false);
    }
  };

  /**
   * Apartar el grupo ENTERO, sin dejar ninguna. Existe para los subproductos
   * de trabajo —una secuencia de render, los fotogramas de un export— que no
   * son material del archivo y donde quedarse con uno no tiene sentido.
   */
  const apartarTodo = async () => {
    if (!grupoActual || trabajando) return;
    const aApartar = grupoActual.fileIds.filter(id => !descartadas.has(id));
    if (aApartar.length === 0) { toast('Ya estaban todas apartadas.'); return; }
    setTrabajando(true);
    try {
      await onCambiarDescartes(aApartar, true);
      registrarAccion(aApartar, [], `Grupo entero apartado (${aApartar.length})`);
      if (!soloPendientes) setPagina(p => Math.min(p + 1, cola.length - 1));
    } finally {
      setTrabajando(false);
    }
  };

  const recuperarGrupo = async () => {
    if (!grupoActual) return;
    setTrabajando(true);
    try {
      await onCambiarDescartes(grupoActual.fileIds, false);
      toast.success('Recuperadas. Vuelven a aparecer en la galería.');
    } finally {
      setTrabajando(false);
    }
  };

  /**
   * Acepta de golpe TODOS los grupos que quedan por delante en la cola, cada
   * uno con su seleccion (o su propuesta si no la has tocado). Es el unico
   * gesto masivo de la vista: se confirma con el numero exacto y recordando
   * que es reversible.
   */
  const aceptarLote = async () => {
    const pendientes = cola.slice(pagina);
    const aApartar: string[] = [];
    const aRecuperar: string[] = [];
    for (const g of pendientes) {
      const sequedan = new Set(quedanDe(g));
      if (sequedan.size === 0) continue;
      for (const id of g.fileIds) {
        if (sequedan.has(id)) { if (descartadas.has(id)) aRecuperar.push(id); }
        else if (!descartadas.has(id)) aApartar.push(id);
      }
    }
    if (aApartar.length === 0 && aRecuperar.length === 0) {
      toast('No queda nada que aplicar en estos grupos.');
      return;
    }
    const ok = window.confirm(
      `Se apartarán ${aApartar.length} tomas de ${pendientes.length} grupos, quedándose con lo marcado en cada uno.\n\n`
      + 'No se borra nada en disco: se puede deshacer grupo a grupo desde esta misma vista.'
    );
    if (!ok) return;

    setAplicandoLote(true);
    try {
      if (aApartar.length) await onCambiarDescartes(aApartar, true);
      if (aRecuperar.length) await onCambiarDescartes(aRecuperar, false);
      toast.success(`Listo: ${aApartar.length} tomas apartadas en ${pendientes.length} grupos.`);
      if (!soloPendientes) setPagina(cola.length - 1);
    } finally {
      setAplicandoLote(false);
    }
  };

  /**
   * Progreso real: un grupo esta RESUELTO cuando ya has apartado algo de el.
   * No se cuenta por paginas vistas —pasar de largo no es trabajo hecho— sino
   * por decisiones tomadas. Va sobre el total, no sobre la cola filtrada.
   */
  const resueltos = useMemo(() => grupos.filter(estaResuelto).length, [grupos, estaResuelto]);
  const pctResueltos = grupos.length ? (resueltos / grupos.length) * 100 : 0;
  const todoResuelto = grupos.length > 0 && resueltos === grupos.length;

  // Teclado: con cientos de grupos por delante, ir al raton para cada uno es
  // el cuello de botella.
  useEffect(() => {
    if (!tecladoActivo) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); deshacer(); }
      else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); aceptarGrupo(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setPagina(p => Math.min(cola.length - 1, p + 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setPagina(p => Math.max(0, p - 1)); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [grupoActual, quedan, cola.length, soloPendientes, trabajando, ultimaAccion, tecladoActivo]);

  const apartadasDelGrupo = grupoActual
    ? grupoActual.fileIds.filter(id => descartadas.has(id)).length
    : 0;
  const seApartan = grupoActual ? archivosDe(grupoActual).filter(f => !quedan.includes(f.id)) : [];
  const seQuedan = grupoActual ? archivosDe(grupoActual).filter(f => quedan.includes(f.id)) : [];

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Volver</span>
      </button>

      <PestanasGemelas activo="parecidas" onCambiar={onCambiarApartado} pendientesCopias={copiasPendientes} />

      {/* Cabecera y herramientas comparten fila: en escritorio sobra ancho de
          sobra y apilarlas solo empujaba el trabajo hacia abajo. */}
      <div className="flex flex-wrap items-start gap-x-10 gap-y-4 pb-4 mb-5 border-b border-pizarra">
        <div className="min-w-[280px]">
          <h1 className="text-2xl font-bold text-marfil mb-1">Tomas gemelas</h1>
          <p className="text-sm text-niebla max-w-2xl leading-relaxed">
            Material casi idéntico dentro de una misma carpeta. Marca las que se quedan y el resto
            desaparece de la galería — sin borrar nada en disco, y reversible.{' '}
            <span className="text-humo">Cada decisión se guarda sola.</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 ml-auto">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono uppercase tracking-wider text-humo shrink-0">parecido</span>
            <input
              type="range"
              min={UMBRAL_MIN}
              max={UMBRAL_MAX}
              step={0.01}
              value={umbralUI}
              onChange={(e) => setUmbralUI(parseFloat(e.target.value))}
              onPointerUp={() => setUmbral(umbralUI)}
              onKeyUp={() => setUmbral(umbralUI)}
              aria-label="Parecido mínimo entre tomas"
              className="umbral w-40"
              style={{ background: fondoBarra(umbralUI) }}
            />
            <span className="font-mono text-sm text-lavanda w-10 text-right shrink-0 tabular-nums">
              {umbralUI.toFixed(2)}
            </span>
            <span className="text-xs text-humo hidden xl:inline">{descripcionUmbral(umbralUI)}</span>
          </div>

          {!cargando && grupos.length > 0 && (
            <div className="flex items-center gap-3">
              <div className="w-28 h-1.5 rounded-full bg-pizarra overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ease-out ${
                    todoResuelto ? 'bg-salvia' : 'bg-lavanda'
                  }`}
                  style={{ width: `${pctResueltos}%` }}
                />
              </div>
              <span className="text-xs font-mono text-niebla tabular-nums">
                {todoResuelto ? 'todos revisados' : `${resueltos} / ${grupos.length}`}
              </span>
              {stats && (
                <span className="text-xs text-humo hidden 2xl:inline">
                  · {stats.archivosEnGrupos} archivos ·{' '}
                  <span className="text-lavanda">{descartadas.size} apartadas</span>
                </span>
              )}
            </div>
          )}

          <button
            onClick={() => {
              irAGrupo.current = cola[pagina]?.id || null;
              const v = ordenPor === 'parecido' ? 'cantidad' : 'parecido';
              setOrdenPor(v);
              try { localStorage.setItem(CLAVE_ORDEN, v); } catch { /* privado */ }
            }}
            title={ordenPor === 'parecido'
              ? 'Los grupos van encadenados: el siguiente se parece al que acabas de decidir'
              : 'Primero los grupos con más copias; con las mismas copias, encadenados por parecido'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-pizarra text-niebla hover:text-marfil transition-colors"
          >
            {ordenPor === 'parecido'
              ? <Waypoints className="w-3.5 h-3.5" />
              : <ArrowDownWideNarrow className="w-3.5 h-3.5" />}
            orden: {ordenPor === 'parecido' ? 'por parecido' : 'por cantidad'}
          </button>

          <button
            onClick={() => {
              const v = !soloPendientes;
              setSoloPendientes(v);
              try { localStorage.setItem(CLAVE_SOLO_PENDIENTES, v ? '1' : '0'); } catch { /* privado */ }
            }}
            title={soloPendientes
              ? 'Ahora solo ves los grupos sin resolver'
              : 'Ahora ves todos, incluidos los ya resueltos'}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-colors ${
              soloPendientes ? 'bg-pizarra text-lavanda' : 'bg-pizarra text-niebla hover:text-marfil'
            }`}
          >
            {soloPendientes ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {soloPendientes ? `solo pendientes (${resueltos} ocultos)` : 'viendo todos'}
          </button>

          <button
            onClick={() => cargar(umbral)}
            title="Recalcular los grupos"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm bg-pizarra text-niebla hover:text-marfil transition-colors"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Recalcular
          </button>
        </div>
      </div>

      {cargando && (
        <div className="flex items-center gap-2 text-niebla py-16">
          <Loader2 className="w-5 h-5 animate-spin text-lavanda" />
          Comparando…
        </div>
      )}

      {error && !cargando && <p className="text-estado-error py-8">{error}</p>}

      {!cargando && !error && cola.length === 0 && (
        <p className="text-niebla py-8">
          {grupos.length === 0
            ? 'No hay tomas gemelas con este parecido mínimo.'
            : '¡Cola vacía! Has resuelto todos los grupos con este parecido.'}
        </p>
      )}

      {!cargando && !error && grupoActual && (
        <div>
          {/* Cabecera del grupo */}
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPagina(p => Math.max(0, p - 1))}
                disabled={pagina === 0}
                className="p-1.5 rounded-full text-niebla hover:text-marfil hover:bg-pizarra disabled:text-humo disabled:hover:bg-transparent transition-colors"
                title="Grupo anterior (←)"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm font-mono text-humo tabular-nums">
                {pagina + 1} / {cola.length}
              </span>
              <button
                onClick={() => setPagina(p => Math.min(cola.length - 1, p + 1))}
                disabled={pagina >= cola.length - 1}
                className="p-1.5 rounded-full text-niebla hover:text-marfil hover:bg-pizarra disabled:text-humo disabled:hover:bg-transparent transition-colors"
                title="Grupo siguiente (→)"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <h2 className="text-base font-medium text-marfil truncate" title={grupoActual.carpeta}>
              {grupoActual.etiqueta}
            </h2>
            <span className="text-xs font-mono text-humo">
              {grupoActual.fileIds.length} tomas
              {typeof grupoActual.similitudMin === 'number'
                && ` · parecido ${grupoActual.similitudMin.toFixed(3)}`}
            </span>

            {/* Lo que se afirma es el hecho (numeracion correlativa), no la
                interpretacion ("es un render"): hay camaras que numeran igual. */}
            {grupoActual.tipo === 'secuencia' && (
              <span
                className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] bg-pizarra text-lavanda"
                title="Mismo prefijo y numeración correlativa rellena de ceros. Suele ser un render exportado a fotogramas."
              >
                <Film className="w-3 h-3" />
                numeración correlativa {grupoActual.desde}–{grupoActual.hasta}
              </span>
            )}

            {apartadasDelGrupo > 0 && (
              <button
                onClick={recuperarGrupo}
                disabled={trabajando}
                className="flex items-center gap-1.5 text-xs text-lavanda hover:text-marfil transition-colors"
              >
                <Undo2 className="w-3.5 h-3.5" />
                Recuperar las {apartadasDelGrupo} de este grupo
              </button>
            )}
          </div>

          {/* ── SE QUEDAN + acciones, en la misma banda ────────────────────
              Antes las acciones colgaban debajo y a la izquierda, con media
              pantalla vacia a la derecha. Ahora ocupan ese hueco. */}
          <div className="rounded-2xl bg-grafito/40 p-4 md:p-5 mb-6">
            <div className="flex flex-col xl:flex-row xl:items-center gap-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
                  <span className="text-xs font-mono uppercase tracking-wider text-lavanda">
                    se {seQuedan.length === 1 ? 'queda' : 'quedan'} ({seQuedan.length})
                  </span>
                  <span className="text-sm text-niebla">
                    {esPropuestaPura && propuesta ? `· ${propuesta.motivo}` : '· elegidas por ti'}
                  </span>
                </div>

                <div className="flex flex-wrap items-start gap-3">
                  {seQuedan.map((file, i) => (
                    <div
                      key={file.id}
                      className={`group relative rounded-xl overflow-hidden bg-grafito ring-2 ring-lavanda ${
                        i === 0 ? 'w-[420px] max-w-full aspect-video' : 'w-[180px] aspect-video'
                      }`}
                    >
                      <button
                        onClick={() => onSelectFile(file)}
                        title={`${file.name} — abrir para verla`}
                        className="absolute inset-0 w-full h-full"
                      >
                        <img
                          src={file.thumbnail}
                          alt=""
                          className="w-full h-full object-cover"
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        />
                      </button>
                      <div className="absolute top-1.5 left-1.5 w-6 h-6 rounded-full bg-lavanda text-noche flex items-center justify-center pointer-events-none">
                        <Check className="w-3.5 h-3.5" />
                      </div>
                      {seQuedan.length > 1 && (
                        <button
                          onClick={() => alternar(file.id)}
                          title="Apartar esta"
                          className="absolute bottom-1.5 right-1.5 flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium bg-noche/85 text-niebla backdrop-blur-sm opacity-0 group-hover:opacity-100 hover:text-marfil transition-all"
                        >
                          <Undo2 className="w-3 h-3" />
                          Apartar
                        </button>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-noche to-transparent p-1.5 pointer-events-none">
                        <span className="block text-[11px] font-mono text-marfil truncate">
                          {file.displayName || file.name}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Acciones: a la derecha en escritorio, donde antes no habia nada */}
              <div className="xl:w-[300px] shrink-0 xl:border-l xl:border-pizarra xl:pl-5">
                <div className="flex flex-col gap-2">
                  <button
                    onClick={aceptarGrupo}
                    disabled={trabajando || aplicandoLote}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-60 transition-colors"
                  >
                    {trabajando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Aceptar y siguiente
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setPagina(p => Math.min(cola.length - 1, p + 1))}
                      disabled={pagina >= cola.length - 1}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-full text-sm bg-pizarra text-niebla hover:text-marfil disabled:opacity-40 transition-colors"
                      title="Dejar este grupo como está (→)"
                    >
                      <SkipForward className="w-3.5 h-3.5" />
                      Saltar
                    </button>
                    <button
                      onClick={aceptarLote}
                      disabled={aplicandoLote || trabajando}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-full text-sm bg-pizarra text-lavanda hover:bg-grafito disabled:opacity-60 transition-colors"
                      title="Aplicar lo marcado en este grupo y en todos los siguientes"
                    >
                      {aplicandoLote ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                      Lote ({cola.length - pagina})
                    </button>
                  </div>
                  <button
                    onClick={apartarTodo}
                    disabled={trabajando || aplicandoLote}
                    title="Apartar el grupo entero, sin quedarse con ninguna"
                    className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-full text-sm transition-colors disabled:opacity-60 ${
                      grupoActual.tipo === 'secuencia'
                        ? 'bg-pizarra text-melocoton hover:bg-grafito'
                        : 'text-humo hover:text-niebla'
                    }`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Apartar las {grupoActual.fileIds.length} (ninguna se queda)
                  </button>

                  {ultimaAccion && (
                    <button
                      onClick={() => deshacer()}
                      disabled={trabajando}
                      className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-pizarra text-niebla hover:text-marfil transition-colors"
                      title="Deshacer lo último (Ctrl+Z)"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Deshacer: {ultimaAccion.que}
                    </button>
                  )}

                  <p className="text-[11px] text-humo leading-relaxed mt-1">
                    <span className="font-mono text-niebla">↓</span> acepta y pasa ·{' '}
                    <span className="font-mono text-niebla">→</span> salta ·{' '}
                    <span className="font-mono text-niebla">←</span> vuelve atrás ·{' '}
                    <span className="font-mono text-niebla">Ctrl+Z</span> deshace
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* ── SE APARTAN ────────────────────────────────────────────────── */}
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-xs font-mono uppercase tracking-wider text-humo">
              se apartan ({seApartan.length})
            </span>
            <span className="text-xs text-humo">· pulsa una para quedártela también</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {seApartan.map(file => (
              <button
                key={file.id}
                onClick={() => alternar(file.id)}
                title={`${file.displayName || file.name} — quedármela también`}
                className="group relative w-[150px] aspect-video rounded-lg overflow-hidden bg-grafito opacity-55 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda transition-opacity"
              >
                <img
                  src={file.thumbnail}
                  alt=""
                  loading="lazy"
                  className="w-full h-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
                <div className="absolute top-1 right-1 w-5 h-5 rounded-full bg-noche/80 text-lavanda flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <Plus className="w-3 h-3" />
                </div>
                <div className="absolute inset-x-0 top-0 p-1 bg-gradient-to-b from-noche/80 to-transparent pointer-events-none">
                  <span className="block text-[10px] font-mono text-marfil truncate text-left">
                    {file.displayName || file.name}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
