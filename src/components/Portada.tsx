import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './Portada.css';

/**
 * Portada — el pensadero.
 *
 * Pantalla de inicio y de carga a la vez: mientras el servidor indexa, el
 * archivo flota. Recuerdos a distintas profundidades giran despacio alrededor
 * del nombre, como en la pila de la que la aplicacion toma el nombre, y un
 * hilo de luz va de uno a otro por lo que los une: una persona, el mismo dia
 * de otro año, dos planos que se parecen, la misma luz. La etiqueta sale del
 * recuerdo de origen y viaja por el hilo hasta el de destino, y desde alli
 * sale el siguiente: no son saltos al azar, es una deriva, como la memoria.
 *
 * Es contemplativa a proposito. Pocos recuerdos, un hilo principal a la vez,
 * todo lento. El Atlas de recuerdos se retiro por ser una telaraña de lineas;
 * esto no debe acabar igual.
 *
 * Sabe que dia es: si el archivo tiene material de un dia como hoy de otros
 * años, la deriva empieza ahi y el centro lo dice. Y se puede tirar del hilo:
 * el raton encima para la deriva, un clic la manda a ese recuerdo, y para
 * entrar estan el boton, Intro o el doble clic. Cuando el hilo llega a un
 * video, ese video respira unos segundos (en silencio) y vuelve a congelarse.
 *
 * Y se renueva sola (el relevo): con material de sobra, cada pocos segundos un
 * recuerdo se va y entra otro, buscando lo que menos se parece a lo que ya hay
 * (otra situacion, otro evento). Cuanta mas reserva, mas relevo; con poco
 * material no hay relevo, porque ver los mismos en bucle cansa mas.
 *
 * Con poco o ningun material es la misma escena sin imagenes: orbes de luz e
 * hilos sin etiqueta.
 *
 * El motor va por fuera de React: posiciones, hilos y etiquetas se mueven en un
 * requestAnimationFrame tocando el DOM por referencia. React solo decide QUE
 * recuerdos e hilos existen, que cambia cada pocos segundos.
 */

type TipoHilo = 'persona' | 'lugar' | 'rima' | 'fecha' | 'tema' | 'luz' | 'color';

interface Nodo {
  i: number;
  id: string;
  tipo: string;
  fecha: string | null;
  personas: Array<{ id: string; nombre: string }>;
  miniatura: string; // '' = orbe sin imagen
  /** "escenario·mucha gente·noche": para no repetir situacion en pantalla. */
  situacion?: string;
  /** Evento como numero: dos del mismo evento a la vez aburren. */
  ev?: number;
}

interface Efemeride {
  nodos: number[];
  /** "17 de septiembre" */
  dia: string;
  anios: number[];
}

interface Enlace {
  a: number;
  b: number;
  tipo: TipoHilo;
  etiqueta: string;
  detalle: string;
  personaId?: string;
  color?: string;
}

interface Arranque {
  listo: boolean;
  indexando: boolean;
  progreso: { hechos?: number; total?: number; fase?: string; percentage?: number } | null;
  archivos: number | null;
}

interface Visible {
  clave: string;   // unica por aparicion: un recuerdo que vuelve es otro elemento
  nodo: number;
  hueco: number;
  saliendo?: number;
  /** Cuando entro: el relevo se lleva primero al que mas lleva en pantalla. */
  desde?: number;
}

interface Hilo {
  id: number;
  enlace: Enlace;
  de: number;
  a: number;
  t0: number;
  curva: 1 | -1;
}

export interface OpcionesEntrar {
  fileId?: string;
  destino?: 'rutas';
  sinEsperar?: boolean;
}

interface Props {
  /** Los archivos ya estan cargados en la aplicacion. */
  archivosCargados: boolean;
  /** Abierta desde el menu: no hay nada que esperar. */
  desdeMenu?: boolean;
  onEntrar: (opciones: OpcionesEntrar) => void;
}

const ESTILO: Record<TipoHilo, { color: string; ancho: number; trazo?: string; brillo: string }> = {
  persona: { color: '#F2B8A0', ancho: 1.8, brillo: 'rgba(242,184,160,.5)' },
  lugar: { color: '#9CB7A5', ancho: 1.6, brillo: 'rgba(156,183,165,.45)' },
  rima: { color: '#ECEAF7', ancho: 1.3, trazo: '16 6 2 6', brillo: 'rgba(236,234,247,.45)' },
  fecha: { color: '#C8B6FF', ancho: 2.2, trazo: '0.1 8', brillo: 'rgba(200,182,255,.5)' },
  tema: { color: '#DACDFF', ancho: 1.5, brillo: 'rgba(218,205,255,.45)' },
  luz: { color: '#E6C177', ancho: 1.6, brillo: 'rgba(230,193,119,.5)' },
  color: { color: '#b89be0', ancho: 1.8, brillo: 'rgba(184,155,224,.5)' },
};

// Que hilos se prefieren al elegir el siguiente paso de la deriva.
const PESO: Record<TipoHilo, number> = { persona: 5, rima: 4, fecha: 4, lugar: 4, tema: 3, luz: 2, color: 2 };

const T_DIBUJO = 2900;
const T_ESPERA = 1900;
const T_DESVANECE = 2800;
const T_ENTRADA = 1500; // lo que tarda en aparecer un recuerdo que se trae
const T_RESPIRA = 4200;  // lo que un video se mueve al llegarle el hilo
const OMEGA = (Math.PI * 2) / 480; // una vuelta del remolino cada 8 minutos

const RETRATO = (id: string) => `/persons-avatars/people/${encodeURIComponent(id)}/avatar.jpg`;
const miles = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// ── Geometria ─────────────────────────────────────────────────────────────

interface Hueco { ang: number; rad: number; prof: 0 | 1 | 2; f1: number; f2: number; periodo: number; amp: number }

/** Tamaño de un recuerdo segun su profundidad y la pantalla. */
function tamanoRecuerdo(prof: 0 | 1 | 2, W: number, H: number) {
  const unidad = Math.min(W, H * 1.45);
  const w = [Math.max(46, unidad * 0.082), Math.max(62, unidad * 0.115), Math.max(80, unidad * 0.158)][prof];
  return { w, h: w * 0.72 };
}

/**
 * Huecos sobre una elipse alrededor del nombre, sin pisarse: se prueban
 * posiciones al azar y se descartan las que chocan con otro recuerdo (con
 * margen para la deriva). Si la pantalla no da para todos, se relaja el margen
 * antes que amontonarlos.
 */
function crearHuecos(n: number, W: number, H: number): Hueco[] {
  const out: Hueco[] = [];
  const cx = W / 2;
  const cy = H / 2;
  const Rx = W * 0.5;
  const Ry = H * 0.47;
  // El nombre, el lema y el boton viven aqui: ningun recuerdo entra. Antes se
  // repartia solo por la elipse y en vertical caian encima del titulo.
  const centro = { w: Math.min(W * 0.82, 460), h: Math.min(H * 0.42, 300) };
  const pisaElCentro = (x: number, y: number, w: number, h: number) =>
    Math.abs(x - cx) < (centro.w + w) / 2 && Math.abs(y - cy) < (centro.h + h) / 2;
  const cajas: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (let k = 0; k < n; k++) {
    // Una de cada tres cerca, una lejos y una a media distancia.
    const prof = ([2, 1, 0, 1, 2, 0][k % 6]) as 0 | 1 | 2;
    const { w, h } = tamanoRecuerdo(prof, W, H);
    let colocado = false;
    for (let intento = 0; intento < 240 && !colocado; intento++) {
      // Dos tramos de holgura y ninguno pegado: con la deriva y el paralaje,
      // un margen de 2 px acababa en recuerdos montados unos sobre otros.
      // Mejor uno menos en pantalla (el relevo ya se encarga de la variedad).
      const margen = intento < 140 ? 34 : 20;
      const ang = Math.random() * Math.PI * 2;
      const rad = 0.5 + Math.random() * 0.46;
      const x = cx + Math.cos(ang) * Rx * rad;
      const y = cy + Math.sin(ang) * Ry * rad;
      if (x - w / 2 < 8 || x + w / 2 > W - 8 || y - h / 2 < 8 || y + h / 2 > H - 8) continue;
      if (pisaElCentro(x, y, w, h)) continue;
      const choca = cajas.some(c => Math.abs(c.x - x) < (c.w + w) / 2 + margen && Math.abs(c.y - y) < (c.h + h) / 2 + margen);
      if (choca) continue;
      cajas.push({ x, y, w, h });
      out.push({
        ang, rad, prof,
        f1: Math.random() * Math.PI * 2,
        f2: Math.random() * Math.PI * 2,
        periodo: 16 + Math.random() * 18,
        amp: 6 + Math.random() * 10,
      });
      colocado = true;
    }
    // Sin sitio para este: se prueba el siguiente (quiza de otro tamaño).
    // Mejor menos que amontonados.
    if (!colocado) continue;
  }
  return out;
}

function barajar<T>(lista: T[]): T[] {
  const out = lista.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const cuadratica = (t: number, p0: number, c: number, p1: number) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * c + t * t * p1;
const suave = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const limitar = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

function elegirPonderado<T>(lista: T[], peso: (x: T) => number): T {
  const total = lista.reduce((s, x) => s + Math.max(0.0001, peso(x)), 0);
  let r = Math.random() * total;
  for (const x of lista) {
    r -= Math.max(0.0001, peso(x));
    if (r <= 0) return x;
  }
  return lista[lista.length - 1];
}

/** Escena sin imagenes: orbes e hilos mudos. */
function datosMinimos(): { nodos: Nodo[]; enlaces: Enlace[] } {
  const n = 14;
  const nodos: Nodo[] = Array.from({ length: n }, (_, i) => ({ i, id: `orbe-${i}`, tipo: 'orbe', fecha: null, personas: [], miniatura: '' }));
  const enlaces: Enlace[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = 1; k <= 3; k++) {
      const j = (i + k * 3 + (i % 2)) % n;
      if (j !== i) enlaces.push({ a: Math.min(i, j), b: Math.max(i, j), tipo: 'rima', etiqueta: '', detalle: '' });
    }
  }
  return { nodos, enlaces };
}

export default function Portada({ archivosCargados, desdeMenu = false, onEntrar }: Props) {
  const [datos, setDatos] = useState<{ nodos: Nodo[]; enlaces: Enlace[]; efemeride?: Efemeride | null } | null>(null);
  /** Video que esta respirando ahora mismo (solo uno a la vez). */
  const [vivo, setVivo] = useState<{ clave: string; url: string } | null>(null);
  const [arranque, setArranque] = useState<Arranque | null>(null);
  const [sinServidor, setSinServidor] = useState(false);
  const [paciencia, setPaciencia] = useState(false);
  const [saliendo, setSaliendo] = useState(false);
  const [visibles, setVisibles] = useState<Visible[]>([]);
  const [hilos, setHilos] = useState<Hilo[]>([]);
  const [asomo, setAsomo] = useState<{ nodo: number; enlaces: Enlace[] } | null>(null);

  const raizRef = useRef<HTMLDivElement>(null);
  const lienzoRef = useRef<HTMLCanvasElement>(null);
  const elsRecuerdo = useRef(new Map<string, HTMLDivElement>());
  const elsHilo = useRef(new Map<number, { visible: SVGPathElement | null; halo: SVGPathElement | null; mascara: SVGPathElement | null; cabeza: SVGCircleElement | null; etiqueta: HTMLDivElement | null }>());
  const elsAsomo = useRef(new Map<string, { camino: SVGPathElement | null; etiqueta: HTMLDivElement | null }>());

  const visiblesRef = useRef<Visible[]>([]);
  const hilosRef = useRef<Hilo[]>([]);
  const huecosRef = useRef<Hueco[]>([]);
  const actualRef = useRef<number | null>(null);
  const recientesRef = useRef<number[]>([]);
  const ultimoTipoRef = useRef<TipoHilo | null>(null);
  const encendidosRef = useRef(new Map<number, { hasta: number; brillo: string }>());
  const cargadas = useRef(new Set<string>());
  const temporizadores = useRef<number[]>([]);
  const ratonRef = useRef({ x: 0, y: 0, sx: 0, sy: 0 });
  /**
   * Con el raton sobre un recuerdo la deriva espera: estas mirando eso. Se
   * guarda QUE recuerdo y DESDE cuando, porque una pausa no puede eternizarse:
   * si ese recuerdo ya no esta en pantalla o llevas mucho rato, la deriva
   * sigue. Un 'leave' que no llega (el recuerdo desaparece debajo del raton)
   * congelaba la escena entera.
   */
  const pausadoRef = useRef<{ nodo: number; desde: number } | null>(null);
  const vivoRef = useRef<string | null>(null);
  const porVerRef = useRef<number[]>([]);
  const salidaRef = useRef<number | null>(null);
  const contadorHilos = useRef(0);
  const pasosRef = useRef(0);

  const reducido = useMemo(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }, []);

  const modoMinimo = !!datos && datos.nodos.length > 0 && datos.nodos[0].miniatura === '';
  const archivoVacio = !!arranque?.listo && arranque.archivos === 0;
  const listo = desdeMenu || (!!arranque?.listo && (archivosCargados || arranque.archivos === 0));

  useEffect(() => {
    const html = document.documentElement;
    const antes = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = antes; };
  }, []);

  // ── Datos: portada y estado del arranque ────────────────────────────────
  useEffect(() => {
    let vivo = true;
    let tPortada: number | undefined;
    let tArranque: number | undefined;

    const cargarPortada = async () => {
      try {
        const r = await fetch('/api/portada');
        const j = await r.json();
        if (!vivo) return;
        const d = j && j.success && j.data ? j.data : { nodos: [], enlaces: [] };
        setDatos(d.nodos && d.nodos.length >= 6 ? d : datosMinimos());
        setSinServidor(false);
      } catch {
        if (!vivo) return;
        setSinServidor(true);
        // Sin servidor todavia: la escena empieza igual, sin imagenes.
        setDatos(prev => prev || datosMinimos());
        tPortada = window.setTimeout(cargarPortada, 2500);
      }
    };

    const sondear = async () => {
      try {
        const r = await fetch('/api/arranque');
        const j = await r.json();
        if (!vivo) return;
        setSinServidor(false);
        if (j && j.success) setArranque(j.data);
        if (!(j && j.success && j.data && j.data.listo)) tArranque = window.setTimeout(sondear, 1500);
      } catch {
        if (!vivo) return;
        setSinServidor(true);
        tArranque = window.setTimeout(sondear, 2000);
      }
    };

    cargarPortada();
    if (!desdeMenu) sondear();
    return () => {
      vivo = false;
      window.clearTimeout(tPortada);
      window.clearTimeout(tArranque);
    };
  }, [desdeMenu]);

  // Si la portada llego vacia (primer arranque de todos) y el indexado ya ha
  // terminado, ahora si hay algo que enseñar.
  const recargada = useRef(false);
  useEffect(() => {
    if (!arranque?.listo || recargada.current || !modoMinimo) return;
    recargada.current = true;
    fetch('/api/portada').then(r => r.json()).then(j => {
      if (j && j.success && j.data && j.data.nodos && j.data.nodos.length >= 6) setDatos(j.data);
    }).catch(() => {});
  }, [arranque?.listo, modoMinimo]);

  // Salida de emergencia: un indexado largo no puede dejarte fuera.
  useEffect(() => {
    if (listo) return;
    const t = window.setTimeout(() => setPaciencia(true), 12000);
    return () => window.clearTimeout(t);
  }, [listo]);

  const ady = useMemo(() => {
    const m = new Map<number, Enlace[]>();
    for (const e of datos?.enlaces || []) {
      (m.get(e.a) || m.set(e.a, []).get(e.a)!).push(e);
      (m.get(e.b) || m.set(e.b, []).get(e.b)!).push(e);
    }
    return m;
  }, [datos]);

  const programar = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    temporizadores.current.push(id);
    return id;
  }, []);

  const fijarVisibles = (v: Visible[]) => { visiblesRef.current = v; setVisibles(v); };
  const fijarHilos = (h: Hilo[]) => {
    hilosRef.current = h;
    const vivos = new Set(h.map(x => x.id));
    for (const id of Array.from(elsHilo.current.keys())) if (!vivos.has(id)) elsHilo.current.delete(id);
    setHilos(h);
  };

  const encender = (nodo: number, ms: number, brillo: string) => {
    encendidosRef.current.set(nodo, { hasta: performance.now() + ms, brillo });
  };

  /**
   * Al llegarle el hilo, un video se mueve unos segundos y vuelve a su
   * miniatura. Uno cada vez, siempre en silencio, y se pide "lo que haya":
   * la portada no pone a preparar nada, solo enseña lo que ya se puede ver.
   */
  const respirar = (nodo: number) => {
    if (reducido || modoMinimo || !datos) return;
    const n = datos.nodos[nodo];
    if (!n || n.tipo !== 'video') return;
    const v = visiblesRef.current.find(x => x.nodo === nodo && !x.saliendo);
    if (!v || vivoRef.current === v.clave) return;
    fetch(`/api/media/${encodeURIComponent(n.id)}/playable?sinPreparar=1`)
      .then(r => r.json())
      .then(j => {
        const d = j && j.success ? j.data : null;
        if (!d || !d.url) return;
        const puede = d.status === 'ready' || (d.status === 'native' && d.ligero !== false);
        if (!puede) return;
        if (salidaRef.current) return;
        // Puede haber tardado: solo si ese recuerdo sigue en pantalla.
        if (!visiblesRef.current.some(x => x.clave === v.clave && !x.saliendo)) return;
        vivoRef.current = v.clave;
        setVivo({ clave: v.clave, url: d.url });
        programar(() => {
          if (vivoRef.current !== v.clave) return;
          vivoRef.current = null;
          setVivo(null);
        }, T_RESPIRA);
      })
      .catch(() => {});
  };

  // ── Reparto inicial ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!datos || datos.nodos.length === 0) return;
    temporizadores.current.forEach(t => window.clearTimeout(t));
    temporizadores.current = [];
    hilosRef.current = [];
    setHilos([]);
    encendidosRef.current.clear();
    recientesRef.current = [];

    const ancho = window.innerWidth;
    const alto = window.innerHeight;
    // Cuantos caben: por AREA, no por ancho. En una pantalla alta y estrecha
    // repartir por ancho dejaba la mitad vacia.
    const cabidos = Math.round(limitar(Math.sqrt(ancho * alto) / 78, 9, 18));
    huecosRef.current = crearHuecos(Math.min(datos.nodos.length, cabidos), ancho, alto);
    const n = huecosRef.current.length;

    // Un dia como hoy manda: la deriva empieza ahi y esos recuerdos entran en
    // el reparto antes que nadie. Si no hay efemeride, se empieza por el
    // recuerdo mejor conectado, que es quien tiene mas hilos que tirar.
    const efe = (datos.efemeride?.nodos || []).filter(i => datos.nodos[i]);
    const porGrado = datos.nodos.map(x => x.i).sort((a, b) => (ady.get(b)?.length || 0) - (ady.get(a)?.length || 0));
    const conHilos = efe.filter(i => (ady.get(i) || []).length > 0);
    const inicio = conHilos.length
      ? conHilos[Math.floor(Math.random() * conHilos.length)]
      : porGrado[Math.floor(Math.random() * Math.min(8, porGrado.length))];
    const elegidos: number[] = [inicio];
    for (const i of efe) if (!elegidos.includes(i) && elegidos.length < Math.ceil(n * 0.6)) elegidos.push(i);
    const cola = [inicio];
    // La mitad sale de la red de hilos (para que los primeros tengan adonde ir
    // sin traer a nadie) y la otra mitad de lo mas distinto: si todo salia de
    // la red, la pantalla arrancaba llena de la misma gente.
    const porRed = Math.ceil(n * 0.5);
    while (cola.length && elegidos.length < porRed) {
      const x = cola.shift()!;
      const vecinos = barajar((ady.get(x) || []).map(e => (e.a === x ? e.b : e.a)));
      for (const v of vecinos) {
        if (elegidos.length >= porRed) break;
        if (!elegidos.includes(v)) { elegidos.push(v); cola.push(v); }
      }
    }
    porVerRef.current = [];
    while (elegidos.length < n) {
      const sig = siguienteDistinto(elegidos.map(nodo => ({ clave: '', nodo, hueco: 0 })));
      if (sig === null) break;
      elegidos.push(sig);
    }

    const huecosBarajados = barajar(Array.from({ length: n }, (_, k) => k));
    const ahora = performance.now();
    // Entradas escalonadas hacia atras: el relevo empieza pronto y no en el
    // mismo orden en que se colocaron.
    fijarVisibles(elegidos.map((nodo, k) => ({
      clave: `${nodo}-${k}-0`, nodo, hueco: huecosBarajados[k], desde: ahora - Math.random() * 9000,
    })));
    actualRef.current = inicio;
    programar(() => pasoRef.current(), 2200);
    return () => {
      temporizadores.current.forEach(t => window.clearTimeout(t));
      temporizadores.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datos, ady]);

  // ── La deriva ───────────────────────────────────────────────────────────
  const lanzarHilo = (enlace: Enlace, de: number, a: number) => {
    const ahora = performance.now();
    const estilo = ESTILO[enlace.tipo] || ESTILO.rima;
    const hilo: Hilo = { id: ++contadorHilos.current, enlace, de, a, t0: ahora, curva: Math.random() < 0.5 ? 1 : -1 };
    const dibujo = reducido ? 300 : T_DIBUJO;
    // Como mucho tres hilos: el que viaja y la estela de los dos anteriores.
    fijarHilos([...hilosRef.current.slice(-2), hilo]);
    encender(de, dibujo + T_ESPERA + 800, estilo.brillo);
    ultimoTipoRef.current = enlace.tipo;
    programar(() => {
      encender(a, T_ESPERA + T_DESVANECE, estilo.brillo);
      actualRef.current = a;
      recientesRef.current = [...recientesRef.current.slice(-8), de];
      respirar(a);
    }, dibujo);
    programar(() => pasoRef.current(), dibujo + T_ESPERA + 500);
    programar(() => fijarHilos(hilosRef.current.filter(h => h.id !== hilo.id)), dibujo + T_ESPERA + T_DESVANECE + 100);
  };

  /**
   * Quien puede irse: nadie que este en juego (en un hilo, encendido, bajo el
   * raton o respirando). De los libres, el que mas lleva en pantalla, para que
   * todos se vean un tiempo parecido.
   */
  const elegirVictima = (proteger: number[]): Visible | null => {
    const ahora = performance.now();
    const ocupados = new Set(hilosRef.current.flatMap(h => [h.de, h.a]).concat(proteger));
    const pausa = pausadoRef.current;
    const libres = visiblesRef.current.filter(v => !v.saliendo && !ocupados.has(v.nodo)
      && v.nodo !== pausa?.nodo && v.clave !== vivoRef.current
      && (encendidosRef.current.get(v.nodo)?.hasta ?? 0) < ahora);
    if (libres.length === 0) return null;
    return libres.reduce((a, b) => ((a.desde ?? 0) <= (b.desde ?? 0) ? a : b));
  };

  /** Uno se va (se desvanece) y en su hueco aparece otro. */
  const sustituir = (victima: Visible, nodo: number) => {
    const ahora = performance.now();
    const siguientes = visiblesRef.current.map(v => (v.clave === victima.clave ? { ...v, saliendo: ahora } : v));
    siguientes.push({ clave: `${nodo}-${victima.hueco}-${Math.round(ahora)}`, nodo, hueco: victima.hueco, desde: ahora });
    fijarVisibles(siguientes);
    programar(() => fijarVisibles(visiblesRef.current.filter(v => v.clave !== victima.clave)), T_ENTRADA + 200);
  };

  /** Trae un recuerdo que no esta en pantalla (lo pide la deriva). */
  const traer = (nodo: number, proteger: number[]): boolean => {
    const victima = elegirVictima(proteger);
    if (!victima) return false;
    sustituir(victima, nodo);
    return true;
  };

  /**
   * Lo siguiente que entra en el relevo: de lo que aun no ha salido en esta
   * vuelta, lo que MENOS se parece a lo que ya hay en pantalla (otra
   * situacion, otro evento). La cola es toda la reserva barajada; al acabarse,
   * otra vuelta.
   */
  const siguienteDistinto = (presentes: Visible[]): number | null => {
    if (!datos) return null;
    const enPantalla = new Set(presentes.map(v => v.nodo));
    const situaciones = new Map<string, number>();
    const eventos = new Set<number>();
    for (const v of presentes) {
      const nd = datos.nodos[v.nodo];
      if (!nd) continue;
      const s = nd.situacion || '';
      situaciones.set(s, (situaciones.get(s) || 0) + 1);
      if (nd.ev) eventos.add(nd.ev);
    }
    if (porVerRef.current.length === 0) porVerRef.current = barajar(datos.nodos.map(x => x.i));
    let mejor = -1;
    let mejorCoste = Infinity;
    porVerRef.current.slice(0, 30).forEach((nodo, k) => {
      if (enPantalla.has(nodo)) return;
      const nd = datos.nodos[nodo];
      if (!nd) return;
      const coste = (situaciones.get(nd.situacion || '') || 0) * 10
        + (nd.ev && eventos.has(nd.ev) ? 25 : 0)
        + k * 0.2;
      if (coste < mejorCoste) { mejorCoste = coste; mejor = k; }
    });
    if (mejor === -1) {
      // Todo lo de la ventana ya esta en pantalla: otra vuelta a la cola.
      porVerRef.current = porVerRef.current.slice(30);
      return null;
    }
    return porVerRef.current.splice(mejor, 1)[0];
  };

  /**
   * El relevo: un recuerdo que lleva un rato se va y entra el mas distinto.
   * Nunca dos a la vez y nunca uno que este en juego.
   */
  const relevo = () => {
    if (!datos || salidaRef.current || document.hidden) return;
    const ahora = performance.now();
    // Un recuerdo que salio y cuyo temporizador murio (un clic los cancela
    // todos) no puede quedarse ocupando su hueco para siempre.
    const colgados = visiblesRef.current.filter(v => v.saliendo && ahora - v.saliendo > T_ENTRADA + 800);
    if (colgados.length) fijarVisibles(visiblesRef.current.filter(v => !colgados.includes(v)));
    if (visiblesRef.current.some(v => v.saliendo)) return;
    const victima = elegirVictima(actualRef.current !== null ? [actualRef.current] : []);
    if (!victima || ahora - (victima.desde ?? 0) < 8000) return;
    const nodo = siguienteDistinto(visiblesRef.current.filter(v => !v.saliendo && v.clave !== victima.clave));
    if (nodo === null) return;
    sustituir(victima, nodo);
  };
  const relevoRef = useRef(relevo);
  relevoRef.current = relevo;

  // Cuanta mas reserva, mas relevo. Con 20 veces lo que cabe en pantalla, un
  // cambio cada ~2,6 s (la pantalla entera se renueva en unos 40 s); con el
  // doble justo, cada 9 s; con menos, nada.
  useEffect(() => {
    if (!datos || modoMinimo) return;
    const cabenAhora = Math.max(1, huecosRef.current.length || 12);
    const holgura = datos.nodos.length / cabenAhora;
    if (holgura < 2) return;
    const cada = limitar(15000 / (holgura - 1), 2600, 9000) * (reducido ? 2 : 1);
    const t = window.setInterval(() => relevoRef.current(), cada);
    return () => window.clearInterval(t);
  }, [datos, modoMinimo, reducido]);

  const paso = () => {
    if (!datos || salidaRef.current) return;
    // Mirando un recuerdo: la deriva espera, pero se vuelve a preguntar
    // enseguida. Nunca se cancela el ciclo, que era como se quedaba parada.
    const pausa = pausadoRef.current;
    if (pausa) {
      const sigueAhi = visiblesRef.current.some(v => v.nodo === pausa.nodo && !v.saliendo);
      if (sigueAhi && performance.now() - pausa.desde < 12000) {
        programar(() => pasoRef.current(), 700);
        return;
      }
      pausadoRef.current = null;
    }
    pasosRef.current++;
    const enPantalla = new Set(visiblesRef.current.filter(v => !v.saliendo).map(v => v.nodo));
    let actual = actualRef.current;
    if (actual === null || !enPantalla.has(actual)) {
      const conHilos = Array.from(enPantalla).filter(n => (ady.get(n) || []).length > 0);
      if (conHilos.length === 0) { programar(() => pasoRef.current(), 4000); return; }
      actual = conHilos[Math.floor(Math.random() * conHilos.length)];
      actualRef.current = actual;
    }

    const todos = (ady.get(actual) || []).map(e => ({ e, otro: e.a === actual ? e.b : e.a }));
    let cands = todos.filter(c => !recientesRef.current.includes(c.otro));
    if (cands.length === 0) cands = todos;
    if (cands.length === 0) {
      // Callejon sin salida: la deriva salta a otro recuerdo, sin hilo.
      const otros = Array.from(enPantalla).filter(n => n !== actual && (ady.get(n) || []).length > 0);
      if (otros.length) {
        actualRef.current = otros[Math.floor(Math.random() * otros.length)];
        encender(actualRef.current, 1800, 'rgba(200,182,255,.35)');
      }
      programar(() => pasoRef.current(), 2400);
      return;
    }

    // El primer hilo del dia, si se puede, es el salto entre años de hoy.
    const efeSet = new Set(datos.efemeride?.nodos || []);
    const peso = (c: { e: Enlace; otro: number }) => (PESO[c.e.tipo] || 1)
      * (c.e.tipo === ultimoTipoRef.current ? 0.35 : 1)
      * (c.e.detalle ? 1.4 : 1)
      * (pasosRef.current <= 2 && c.e.tipo === 'fecha' && efeSet.has(c.otro) ? 6 : 1);
    const enVista = cands.filter(c => enPantalla.has(c.otro));
    // A veces, aunque haya destino en pantalla, se trae uno nuevo: la escena
    // se renueva sola y no se queda en los mismos quince para siempre.
    const traerNuevo = enVista.length === 0 || (Math.random() < 0.38 && cands.length > enVista.length);
    const elegido = traerNuevo
      ? elegirPonderado(cands.filter(c => !enPantalla.has(c.otro)).length ? cands.filter(c => !enPantalla.has(c.otro)) : cands, peso)
      : elegirPonderado(enVista, peso);

    const origen = actual;
    if (!enPantalla.has(elegido.otro)) {
      if (!traer(elegido.otro, [origen])) { programar(() => pasoRef.current(), 2000); return; }
      programar(() => lanzarHilo(elegido.e, origen, elegido.otro), T_ENTRADA);
    } else {
      lanzarHilo(elegido.e, origen, elegido.otro);
    }
  };
  // El temporizador siempre llama a la version mas reciente (datos y ady al dia).
  const pasoRef = useRef(paso);
  pasoRef.current = paso;

  // ── Motor de animacion ──────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const inicio = performance.now();
    const lienzo = lienzoRef.current;
    const ctx = lienzo ? lienzo.getContext('2d') : null;

    // Motas y velos del remolino, en canvas: son muchas y no necesitan DOM.
    const motas = Array.from({ length: 90 }, () => ({
      rad: 0.08 + Math.random() * 1.05,
      ang: Math.random() * Math.PI * 2,
      vel: 0.35 + Math.random() * 0.6,
      tam: 0.5 + Math.random() * 1.5,
      alfa: 0.08 + Math.random() * 0.4,
      fase: Math.random() * Math.PI * 2,
    }));
    const velos = Array.from({ length: 6 }, (_, k) => ({
      rad: 0.25 + k * 0.14 + Math.random() * 0.05,
      ang: Math.random() * Math.PI * 2,
      largo: 0.5 + Math.random() * 0.9,
      vel: 0.5 + Math.random() * 0.4,
      alfa: 0.035 + Math.random() * 0.045,
    }));

    const dimensionar = () => {
      if (!lienzo) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      lienzo.width = Math.round(window.innerWidth * dpr);
      lienzo.height = Math.round(window.innerHeight * dpr);
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    dimensionar();
    window.addEventListener('resize', dimensionar);

    const frame = (ahora: number) => {
      const t = (ahora - inicio) / 1000;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const cx = W / 2;
      const cy = H / 2;
      const Rx = W * 0.5;
      const Ry = H * 0.47;
      const raton = ratonRef.current;
      raton.sx += (raton.x - raton.sx) * 0.04;
      raton.sy += (raton.y - raton.sy) * 0.04;
      const giro = reducido ? 0 : t * OMEGA;
      const salida = salidaRef.current ? limitar((ahora - salidaRef.current) / 950) : 0;
      const hundir = salida * salida;

      // Fondo: motas y velos
      if (ctx) {
        ctx.clearRect(0, 0, W, H);
        const g = reducido ? 0 : t;
        for (const v of velos) {
          const a0 = v.ang + g * OMEGA * 6 * v.vel;
          ctx.beginPath();
          ctx.ellipse(cx, cy, Rx * v.rad * (1 - hundir * 0.8), Ry * v.rad * 0.8 * (1 - hundir * 0.8), 0, a0, a0 + v.largo);
          ctx.strokeStyle = `rgba(222,214,250,${v.alfa})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        for (const m of motas) {
          const a = m.ang + g * OMEGA * 9 * m.vel * (1.25 - m.rad * 0.5);
          const r = m.rad * (1 - hundir * 0.9);
          const x = cx + Math.cos(a) * Rx * r;
          const y = cy + Math.sin(a) * Ry * r * 0.85 + Math.sin(g * 0.6 + m.fase) * 4;
          const titilar = 0.65 + 0.35 * Math.sin(g * 1.3 + m.fase);
          ctx.beginPath();
          ctx.arc(x, y, m.tam, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(226,220,252,${m.alfa * titilar * (1 - salida)})`;
          ctx.fill();
        }
      }

      // Recuerdos
      const huecos = huecosRef.current;
      const paralaje = [8, 18, 32];
      const posiciones = new Map<number, { x: number; y: number; w: number; h: number }>();
      for (const v of visiblesRef.current) {
        const el = elsRecuerdo.current.get(v.clave);
        const hu = huecos[v.hueco];
        if (!hu) continue;
        const a = hu.ang + giro * (1.04 - hu.rad * 0.08);
        const deriva = reducido ? 0 : 1;
        let x = cx + Math.cos(a) * Rx * hu.rad + Math.sin((t / hu.periodo) * Math.PI * 2 + hu.f1) * hu.amp * deriva - raton.sx * paralaje[hu.prof];
        let y = cy + Math.sin(a) * Ry * hu.rad + Math.cos((t / (hu.periodo * 1.3)) * Math.PI * 2 + hu.f2) * hu.amp * 0.7 * deriva - raton.sy * paralaje[hu.prof];
        x = x + (cx - x) * hundir;
        y = y + (cy - y) * hundir;
        const tam = tamanoRecuerdo(hu.prof, W, H);
        const w = tam.w * (modoMinimo ? 0.28 : 1);
        const h = modoMinimo ? w : tam.h;
        if (!v.saliendo) posiciones.set(v.nodo, { x, y, w, h });
        if (!el) continue;
        const escala = 1 - hundir * 0.8;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.transform = `translate3d(${x - w / 2}px, ${y - h / 2}px, 0) scale(${escala})`;
        el.style.zIndex = String(1 + hu.prof);
        const luz = encendidosRef.current.get(v.nodo);
        const encendido = !!luz && luz.hasta > ahora && !v.saliendo;
        el.classList.toggle('pt-recuerdo--encendido', encendido);
        if (encendido && luz) el.style.setProperty('--pt-brillo', luz.brillo);
      }

      // Hilos que viajan
      const dibujo = reducido ? 300 : T_DIBUJO;
      const listaHilos = hilosRef.current;
      for (let ih = 0; ih < listaHilos.length; ih++) {
        const h = listaHilos[ih];
        // Relevo: la etiqueta que llego a un recuerdo se funde en cuanto sale
        // de ese mismo recuerdo el hilo siguiente, en vez de montarse con el.
        const siguiente = listaHilos[ih + 1];
        const relevo = siguiente ? 1 - limitar((ahora - siguiente.t0) / 380) : 1;
        const refs = elsHilo.current.get(h.id);
        const A = posiciones.get(h.de);
        const B = posiciones.get(h.a);
        if (!refs || !refs.visible || !A || !B) continue;
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const rA = Math.min(A.w, A.h) * 0.5;
        const rB = Math.min(B.w, B.h) * 0.5;
        const x0 = A.x + ux * rA;
        const y0 = A.y + uy * rA;
        const x1 = B.x - ux * rB;
        const y1 = B.y - uy * rB;
        const ccx = (x0 + x1) / 2 - uy * dist * 0.22 * h.curva;
        const ccy = (y0 + y1) / 2 + ux * dist * 0.22 * h.curva;
        const d = `M${x0.toFixed(1)} ${y0.toFixed(1)} Q${ccx.toFixed(1)} ${ccy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
        const tr = ahora - h.t0;
        const p = suave(limitar(tr / dibujo));
        const desvanecer = tr > dibujo + T_ESPERA ? 1 - limitar((tr - dibujo - T_ESPERA) / T_DESVANECE) : 1;
        refs.visible.setAttribute('d', d);
        if (refs.halo) refs.halo.setAttribute('d', d);
        if (refs.mascara) {
          refs.mascara.setAttribute('d', d);
          const largo = refs.visible.getTotalLength() + 2;
          refs.mascara.setAttribute('stroke-dasharray', `${largo} ${largo}`);
          refs.mascara.setAttribute('stroke-dashoffset', String(largo * (1 - p)));
        }
        if (h.enlace.tipo === 'rima' && !reducido) refs.visible.setAttribute('stroke-dashoffset', String(-(ahora / 45) % 60));
        const grupo = refs.visible.parentElement;
        if (grupo) grupo.setAttribute('opacity', String(desvanecer * (1 - salida)));
        const hx = cuadratica(p, x0, ccx, x1);
        const hy = cuadratica(p, y0, ccy, y1);
        if (refs.cabeza) {
          refs.cabeza.setAttribute('cx', hx.toFixed(1));
          refs.cabeza.setAttribute('cy', hy.toFixed(1));
          refs.cabeza.setAttribute('opacity', String(tr < dibujo ? 1 : Math.max(0, 1 - (tr - dibujo) / 500)));
        }
        if (refs.etiqueta) {
          const aparecer = limitar(tr / 450);
          // Una etiqueta cortada por el borde no cuenta nada: se mantiene dentro.
          const mitad = (refs.etiqueta.offsetWidth || 140) / 2 + 10;
          const ex = limitar(hx, Math.min(mitad, W / 2), Math.max(W - mitad, W / 2));
          const ey = Math.max(hy, 52);
          refs.etiqueta.style.transform = `translate3d(${ex}px, ${ey}px, 0) translate(-50%, -150%)`;
          refs.etiqueta.style.opacity = String(aparecer * desvanecer * relevo * (1 - salida));
        }
      }

      // Asomo: al pasar por un recuerdo, sus relaciones posibles
      if (asomoRef.current) {
        const origen = posiciones.get(asomoRef.current.nodo);
        for (const e of asomoRef.current.enlaces) {
          const otro = e.a === asomoRef.current.nodo ? e.b : e.a;
          const refs = elsAsomo.current.get(`${e.a}|${e.b}`);
          const destino = posiciones.get(otro);
          if (!refs || !refs.camino || !origen || !destino) continue;
          const mx = (origen.x + destino.x) / 2;
          const my = (origen.y + destino.y) / 2 - Math.hypot(destino.x - origen.x, destino.y - origen.y) * 0.12;
          refs.camino.setAttribute('d', `M${origen.x.toFixed(1)} ${origen.y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${destino.x.toFixed(1)} ${destino.y.toFixed(1)}`);
          if (refs.etiqueta) {
            const mitad = (refs.etiqueta.offsetWidth || 120) / 2 + 10;
            const ex = limitar(cuadratica(0.5, origen.x, mx, destino.x), Math.min(mitad, W / 2), Math.max(W - mitad, W / 2));
            const ey = limitar(cuadratica(0.5, origen.y, my, destino.y), 24, Math.max(24, H - 24));
            refs.etiqueta.style.transform = `translate3d(${ex}px, ${ey}px, 0) translate(-50%, -50%)`;
          }
        }
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', dimensionar);
    };
  }, [reducido, modoMinimo]);

  const asomoRef = useRef(asomo);
  asomoRef.current = asomo;

  // ── Entrar ──────────────────────────────────────────────────────────────
  const entrar = useCallback((opciones: OpcionesEntrar = {}) => {
    if (salidaRef.current) return;
    salidaRef.current = performance.now();
    setSaliendo(true);
    temporizadores.current.forEach(t => window.clearTimeout(t));
    window.setTimeout(() => onEntrar(opciones), 950);
  }, [onEntrar]);

  // Teclado y rueda: Intro, Espacio o Escape entran; bajar la rueda, tambien.
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (!listo) return;
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        entrar(archivoVacio ? { destino: 'rutas' } : {});
      }
    };
    const rueda = (e: WheelEvent) => { if (listo && e.deltaY > 30) entrar(archivoVacio ? { destino: 'rutas' } : {}); };
    window.addEventListener('keydown', tecla);
    window.addEventListener('wheel', rueda, { passive: true });
    return () => { window.removeEventListener('keydown', tecla); window.removeEventListener('wheel', rueda); };
  }, [listo, entrar, archivoVacio]);

  const moverRaton = (e: React.PointerEvent) => {
    ratonRef.current.x = (e.clientX / window.innerWidth - 0.5) * 2;
    ratonRef.current.y = (e.clientY / window.innerHeight - 0.5) * 2;
    // Segunda red: si el puntero ya no esta sobre ningun recuerdo, se suelta la
    // pausa aunque su 'leave' no haya llegado nunca.
    if (pausadoRef.current && !(e.target as HTMLElement).closest?.('.pt-recuerdo')) {
      pausadoRef.current = null;
      setAsomo(null);
    }
  };

  /**
   * Un clic no entra: manda la deriva a ese recuerdo. Asi se puede pasear por
   * el archivo tirando del hilo, que es lo que esta pantalla promete. Para
   * entrar estan el boton, Intro y el doble clic.
   */
  const pulsarRecuerdo = (nodo: number) => {
    if (!datos || modoMinimo) return;
    temporizadores.current.forEach(t => window.clearTimeout(t));
    temporizadores.current = [];
    actualRef.current = nodo;
    recientesRef.current = [];
    encender(nodo, 2500, 'rgba(200,182,255,.45)');
    respirar(nodo);
    programar(() => fijarHilos([]), 900);
    programar(() => pasoRef.current(), 350);
  };

  const abrirRecuerdo = (nodo: number) => {
    if (!datos || modoMinimo || !listo) return;
    entrar({ fileId: datos.nodos[nodo]?.id });
  };

  const asomarse = (nodo: number | null) => {
    if (!datos || modoMinimo) return;
    pausadoRef.current = nodo === null ? null : { nodo, desde: performance.now() };
    if (nodo === null) { setAsomo(null); return; }
    const enPantalla = new Set(visiblesRef.current.filter(v => !v.saliendo).map(v => v.nodo));
    // Una etiqueta por nombre y como mucho cuatro: asomarse no es abrir el Atlas.
    const vistas = new Set<string>();
    const enlaces = (ady.get(nodo) || [])
      .filter(e => enPantalla.has(e.a === nodo ? e.b : e.a))
      .filter(e => { const k = e.tipo + ':' + e.etiqueta; if (vistas.has(k)) return false; vistas.add(k); return true; })
      .slice(0, 4);
    setAsomo(enlaces.length ? { nodo, enlaces } : null);
  };

  // ── Texto del estado ────────────────────────────────────────────────────
  const progreso = arranque?.progreso;
  let textoEstado = '';
  let pct: number | null = null;
  if (!listo) {
    if (sinServidor && !arranque) textoEstado = 'despertando el archivo';
    else if (progreso && progreso.fase === 'contando') textoEstado = 'contando recuerdos';
    else if (progreso && typeof progreso.hechos === 'number' && progreso.total) {
      textoEstado = `ordenando recuerdos · ${miles(progreso.hechos)} de ${miles(progreso.total)}`;
      pct = limitar(progreso.hechos / progreso.total) * 100;
    } else if (progreso && progreso.fase === 'rematando') textoEstado = 'casi';
    else textoEstado = arranque?.listo ? 'abriendo el archivo' : 'despertando el archivo';
  }

  const nodoDe = (i: number) => datos?.nodos[i];

  return (
    <div
      ref={raizRef}
      className={`pt-raiz${saliendo ? ' pt-raiz--saliendo' : ''}`}
      onPointerMove={moverRaton}
      role="dialog"
      aria-label="Portada de Pensadero"
    >
      <div className="pt-ondas" aria-hidden="true">
        <div className="pt-onda" /><div className="pt-onda" /><div className="pt-onda" />
      </div>
      <canvas ref={lienzoRef} className="pt-motas" aria-hidden="true" />

      {/* Recuerdos */}
      {visibles.map(v => {
        const n = nodoDe(v.nodo);
        if (!n) return null;
        const prof = huecosRef.current[v.hueco]?.prof ?? 1;
        if (!n.miniatura) {
          return (
            <div
              key={v.clave}
              ref={el => { if (el) elsRecuerdo.current.set(v.clave, el); else elsRecuerdo.current.delete(v.clave); }}
              className={`pt-orbe${v.saliendo ? ' pt-recuerdo--oculto' : ''}`}
              style={{ opacity: 0.35 + prof * 0.25 }}
              aria-hidden="true"
            />
          );
        }
        return (
          <div
            key={v.clave}
            ref={el => { if (el) elsRecuerdo.current.set(v.clave, el); else elsRecuerdo.current.delete(v.clave); }}
            className={`pt-recuerdo pt-recuerdo--p${prof}${cargadas.current.has(v.clave) && !v.saliendo ? '' : ' pt-recuerdo--oculto'}${(encendidosRef.current.get(v.nodo)?.hasta ?? 0) > performance.now() && !v.saliendo ? ' pt-recuerdo--encendido' : ''}`}
            data-saliendo={v.saliendo ? '1' : undefined}
            onClick={() => pulsarRecuerdo(v.nodo)}
            onDoubleClick={() => abrirRecuerdo(v.nodo)}
            onPointerEnter={() => asomarse(v.nodo)}
            onPointerLeave={() => asomarse(null)}
            role="button"
            tabIndex={-1}
            aria-label={n.personas.length ? n.personas.map(p => p.nombre).join(', ') : 'Recuerdo'}
          >
            <img
              src={n.miniatura}
              alt=""
              draggable={false}
              onLoad={(e) => {
                cargadas.current.add(v.clave);
                const caja = e.currentTarget.parentElement;
                if (caja && !caja.dataset.saliendo) caja.classList.remove('pt-recuerdo--oculto');
              }}
              onError={(e) => { const caja = e.currentTarget.parentElement; if (caja) caja.style.display = 'none'; }}
            />
            {vivo && vivo.clave === v.clave && (
              // Un vídeo al que le ha llegado el hilo: unos segundos de vida,
              // en silencio, y vuelve a ser una miniatura quieta.
              <video
                className="pt-recuerdo__vivo"
                src={vivo.url}
                autoPlay
                muted
                loop
                playsInline
                onError={() => { vivoRef.current = null; setVivo(null); }}
              />
            )}
          </div>
        );
      })}

      {/* Hilos */}
      <svg className="pt-hilos" aria-hidden="true" style={{ zIndex: 4 }}>
        <defs>
          <radialGradient id="pt-cometa">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="35%" stopColor="#F5F1FF" stopOpacity=".85" />
            <stop offset="100%" stopColor="#C8B6FF" stopOpacity="0" />
          </radialGradient>
          {hilos.map(h => (
            <mask key={`m${h.id}`} id={`pt-m-${h.id}`} maskUnits="userSpaceOnUse" x="-200" y="-200" width="8000" height="8000">
              <path
                ref={el => { const r = elsHilo.current.get(h.id) || { visible: null, halo: null, mascara: null, cabeza: null, etiqueta: null }; r.mascara = el; elsHilo.current.set(h.id, r); }}
                fill="none" stroke="#fff" strokeWidth="14" strokeLinecap="round"
              />
            </mask>
          ))}
        </defs>
        {asomo && asomo.enlaces.map(e => (
          <path
            key={`as-${e.a}|${e.b}`}
            ref={el => { const r = elsAsomo.current.get(`${e.a}|${e.b}`) || { camino: null, etiqueta: null }; r.camino = el; elsAsomo.current.set(`${e.a}|${e.b}`, r); }}
            fill="none"
            stroke={e.color || (ESTILO[e.tipo] || ESTILO.rima).color}
            strokeOpacity=".35"
            strokeWidth="1"
            strokeDasharray="3 5"
          />
        ))}
        {hilos.map(h => {
          const est = ESTILO[h.enlace.tipo] || ESTILO.rima;
          const color = h.enlace.color || est.color;
          const registrar = (campo: 'visible' | 'halo' | 'cabeza') => (el: SVGPathElement | SVGCircleElement | null) => {
            const r = elsHilo.current.get(h.id) || { visible: null, halo: null, mascara: null, cabeza: null, etiqueta: null };
            (r as Record<string, unknown>)[campo] = el;
            elsHilo.current.set(h.id, r);
          };
          return (
            <g key={h.id}>
              <path ref={registrar('halo')} fill="none" stroke={color} strokeOpacity=".18" strokeWidth="7" strokeLinecap="round" mask={`url(#pt-m-${h.id})`} style={{ filter: 'blur(3px)' }} />
              <path ref={registrar('visible')} fill="none" stroke={color} strokeWidth={est.ancho} strokeLinecap="round" strokeDasharray={est.trazo} mask={`url(#pt-m-${h.id})`} />
              <circle ref={registrar('cabeza')} r="9" fill="url(#pt-cometa)" />
            </g>
          );
        })}
      </svg>

      {/* Etiquetas que viajan */}
      {hilos.map(h => {
        if (!h.enlace.etiqueta) return null;
        const est = ESTILO[h.enlace.tipo] || ESTILO.rima;
        return (
          <div
            key={`e${h.id}`}
            ref={el => { const r = elsHilo.current.get(h.id) || { visible: null, halo: null, mascara: null, cabeza: null, etiqueta: null }; r.etiqueta = el; elsHilo.current.set(h.id, r); }}
            className="pt-etiqueta"
            style={{ zIndex: 7, opacity: 0 }}
          >
            {h.enlace.tipo === 'persona' && h.enlace.personaId ? (
              <span className="pt-etiqueta__cara">
                <img src={RETRATO(h.enlace.personaId)} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              </span>
            ) : (
              <span className="pt-etiqueta__punto" style={{ color: h.enlace.color || est.color }} />
            )}
            <span className="pt-etiqueta__texto">{h.enlace.etiqueta}</span>
            {h.enlace.detalle && <span className="pt-etiqueta__detalle">{h.enlace.detalle}</span>}
          </div>
        );
      })}
      {asomo && asomo.enlaces.map(e => (
        <div
          key={`ae-${e.a}|${e.b}`}
          ref={el => { const r = elsAsomo.current.get(`${e.a}|${e.b}`) || { camino: null, etiqueta: null }; r.etiqueta = el; elsAsomo.current.set(`${e.a}|${e.b}`, r); }}
          className="pt-etiqueta pt-etiqueta--asomo"
          style={{ zIndex: 7 }}
        >
          <span className="pt-etiqueta__punto" style={{ color: e.color || (ESTILO[e.tipo] || ESTILO.rima).color }} />
          <span className="pt-etiqueta__texto">{e.etiqueta}</span>
        </div>
      ))}

      {/* Centro */}
      <div className="pt-centro">
        <div className="pt-halo" aria-hidden="true" />
        <h1 className="pt-marca">Pensadero</h1>
        <p className="pt-lema">
          {archivoVacio
            ? 'todavía no hay recuerdos'
            : datos?.efemeride
              ? `un ${datos.efemeride.dia} · ${datos.efemeride.anios.join(' · ')}`
              : 'lo que guardas, flotando'}
        </p>
        <div className="pt-estado" aria-live="polite">
          {listo ? (
            archivoVacio ? (
              <>
                <button className="pt-entrar" onClick={() => entrar({ destino: 'rutas' })} autoFocus>Añadir una carpeta</button>
                <span className="pt-pista">Pensadero leerá tus fotos y vídeos sin moverlos de sitio</span>
              </>
            ) : (
              <>
                <button className="pt-entrar" onClick={() => entrar({})} autoFocus>Entrar</button>
                <span className="pt-pista">{modoMinimo ? 'o pulsa Intro' : 'o pulsa Intro · toca un recuerdo para tirar del hilo'}</span>
              </>
            )
          ) : (
            <>
              <span className="pt-progreso">{textoEstado}</span>
              <div className={`pt-barra${pct === null ? ' pt-barra--viva' : ''}`}>
                <i style={pct !== null ? { width: `${pct}%` } : undefined} />
              </div>
              {paciencia && (
                <button className="pt-sin-esperar" onClick={() => entrar({ sinEsperar: true })}>
                  entrar sin esperar
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
