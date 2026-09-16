import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Plus, Wand2, Download, Image as ImageIcon, Pencil, Trash2, Loader, GripVertical,
} from 'lucide-react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Collection, MediaFile } from '../types';
import { api } from '../services/api';
import { normalizePath } from '../utils/formatData';

/**
 * Colecciones.
 *
 * Una coleccion es lo que hay dentro, asi que la portada la hacen sus propios
 * archivos y el nombre se lee SIEMPRE, no al pasar el raton. Antes esta pantalla
 * era un carrusel con flechas para dos tarjetas, con la tarjeta en gris slate
 * (fuera de la paleta), el nombre oculto hasta el hover, dos contadores
 * pisandose en la misma esquina y, debajo, un manual de dos parrafos explicando
 * que es una coleccion — permanente, ocupando mas que las propias colecciones.
 *
 * Lo que de verdad faltaba: que una Smart Folder diga QUE recoge. Sin eso, una
 * carpeta que no encuentra nada (porque su regla apunta a una persona que no
 * sale en ningun archivo) se ve igual que una vacia recien creada.
 */

interface CollectionsViewProps {
  onBack?: () => void;
  collections: Collection[];
  mediaFiles: MediaFile[];
  onCollectionSelect: (id: string) => void;
  onCreateCollection: () => void;
  onEditCollection: (id: string) => void;
  onDeleteCollection: (id: string) => void;
  onDownloadCollection: (id: string, e?: React.MouseEvent) => void;
  onEditCover?: (id: string) => void;
  onCollectionsReorder?: (reordered: Collection[]) => void;
  downloadingCollectionId?: string | null;
}

type Regla = { field?: string; op?: string; value?: any };

/**
 * Los valores del catalogo de reglas, dichos como se dicen. Sin esto la
 * tarjeta enseñaba "atmosphere.time_of_day: noche", que es el nombre del
 * campo en el schema, no algo que nadie diga en voz alta.
 */
const ETIQUETAS: Record<string, Record<string, string>> = {
  'composition.shot_type': {
    plano_general: 'plano general', plano_conjunto: 'plano conjunto',
    plano_americano: 'plano americano', plano_medio: 'plano medio',
    plano_medio_corto: 'plano medio corto', primer_plano: 'primer plano',
    plano_detalle: 'plano detalle',
  },
  'composition.camera_angle': {
    normal: 'ángulo normal', picado: 'picado', contrapicado: 'contrapicado',
    cenital: 'cenital', nadir: 'nadir',
  },
  'composition.camera_movement': {
    fijo: 'cámara fija', panoramica: 'panorámica', travelling: 'travelling',
    dolly: 'dolly', zoom_in: 'zoom in', zoom_out: 'zoom out',
    handheld: 'cámara en mano', steady: 'steadicam',
  },
  'composition.people_framing': {
    ninguno: 'sin personas', individual: 'una persona', pareja: 'en pareja',
    grupo: 'en grupo', multitud: 'multitud',
  },
  'atmosphere.mood': {
    alegre: 'alegre', neutro: 'neutro', serio: 'serio', intimo: 'íntimo',
    festivo: 'festivo', melancolico: 'melancólico', energico: 'enérgico',
    formal: 'formal', contemplativo: 'contemplativo',
  },
  'atmosphere.lighting': {
    luz_natural: 'luz natural', luz_dorada: 'luz dorada', contraluz: 'contraluz',
    interior: 'luz de interior', neon: 'neón', nocturna: 'luz nocturna', mixta: 'luz mixta',
  },
  'atmosphere.time_of_day': {
    amanecer: 'al amanecer', manana: 'por la mañana', mediodia: 'al mediodía',
    tarde: 'por la tarde', atardecer: 'al atardecer', noche: 'de noche',
  },
  'atmosphere.space_type': {
    interior: 'en interior', exterior: 'en exterior', urbano: 'urbano',
    naturaleza: 'en la naturaleza', oficina: 'en oficina', escenario: 'en escenario',
    hogar: 'en casa', transito: 'en tránsito',
  },
  'atmosphere.style': {
    documental: 'documental', retrato: 'retrato', paisaje: 'paisaje',
    accion: 'acción', producto: 'producto', ambiente: 'ambiente', abstracto: 'abstracto',
  },
  type: { image: 'fotos', video: 'vídeos', audio: 'audios', export: 'exports' },
};

/**
 * La regla, dicha en castellano. Es lo que convierte una Smart Folder en algo
 * que se entiende de un vistazo en vez de en una caja negra.
 */
function describirRegla(r: Regla, nombrePersona: (id: string) => string): string {
  const v = r.value;
  const campo = r.field || '';

  if (r.op === 'has_person') {
    const ids = Array.isArray(v) ? v : [v];
    return ids.filter(Boolean).map(id => nombrePersona(String(id))).join(' o ');
  }
  if (r.op === 'has_space') {
    const ids = Array.isArray(v) ? v : [v];
    return `en ${ids.filter(Boolean).join(' o ')}`;
  }
  if (r.op === 'color_similar') {
    const hex = v && typeof v === 'object' ? v.hex : v;
    return `color ${hex}`;
  }
  if (r.op === 'is_true') return campo === 'isFavorite' ? 'favoritos' : campo;
  const tabla = ETIQUETAS[campo];
  if (tabla && typeof v === 'string' && tabla[v]) return tabla[v];
  if (campo === 'tags') return `etiqueta “${v}”`;
  if (campo.includes('description')) return `dice “${v}”`;
  if (campo === 'createdAt' && r.op === 'gte') return `desde ${v}`;
  if (campo === 'createdAt' && r.op === 'lte') return `hasta ${v}`;
  if (r.op === 'between' && Array.isArray(v)) return `entre ${v[0]} y ${v[1]}`;
  if (r.op === 'gte') return `${campo} ≥ ${v}`;
  if (r.op === 'lte') return `${campo} ≤ ${v}`;
  if (typeof v === 'object' && v !== null) return campo || 'regla';
  return `${v}`;
}

export default function CollectionsView({
  onBack, collections, mediaFiles, onCollectionSelect, onCreateCollection,
  onEditCollection, onDeleteCollection, onDownloadCollection, onEditCover,
  onCollectionsReorder, downloadingCollectionId,
}: CollectionsViewProps) {
  const [orden, setOrden] = useState<Collection[]>(collections);
  const [personas, setPersonas] = useState<Record<string, string>>({});

  useEffect(() => { setOrden(collections); }, [collections]);

  // Nombres de persona para poder contar las reglas en cristiano.
  useEffect(() => {
    let cancelado = false;
    api.getPersons()
      .then(r => {
        if (cancelado || !r.success || !Array.isArray(r.data)) return;
        const m: Record<string, string> = {};
        for (const p of r.data as Array<{ person_id: string; display_name: string }>) {
          m[p.person_id] = p.display_name;
        }
        setPersonas(m);
      })
      .catch(() => { /* sin nombres: se muestra el id, que tampoco miente */ });
    return () => { cancelado = true; };
  }, []);

  const nombrePersona = (id: string) => personas[id] || id;

  // Indice para resolver los archivos de cada coleccion. Las manuales guardan
  // rutas normalizadas y las Smart Folders devuelven ids ya resueltos por el
  // servidor: hay que poder buscar por las dos.
  const porRuta = useMemo(() => {
    const m = new Map<string, MediaFile>();
    for (const f of mediaFiles) if (f.fullPath) m.set(normalizePath(f.fullPath), f);
    return m;
  }, [mediaFiles]);
  const porId = useMemo(() => {
    const m = new Map<string, MediaFile>();
    for (const f of mediaFiles) m.set(f.id, f);
    return m;
  }, [mediaFiles]);

  const archivosDe = (c: Collection): MediaFile[] => {
    const out: MediaFile[] = [];
    for (const clave of (c.mediaFiles || [])) {
      const f = porId.get(clave) || porRuta.get(normalizePath(clave));
      if (f) out.push(f);
      if (out.length >= 4) break;
    }
    return out;
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const alSoltar = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const desde = orden.findIndex(c => c.id === active.id);
    const hasta = orden.findIndex(c => c.id === over.id);
    if (desde < 0 || hasta < 0) return;
    const nuevo = arrayMove(orden, desde, hasta);
    setOrden(nuevo);
    onCollectionsReorder?.(nuevo);
  };

  const smart = orden.filter(c => c.type === 'smart').length;
  const manuales = orden.length - smart;

  return (
    <div>
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-1 mb-4 text-sm font-medium text-lavanda hover:text-marfil transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Volver</span>
        </button>
      )}

      {/* ── Cabecera ──────────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between flex-wrap gap-4 mb-8">
        <div>
          <h1 className="text-[1.7rem] font-bold text-marfil leading-none">Colecciones</h1>
          <p className="mt-2 text-sm text-niebla">
            {orden.length === 0
              ? 'Carpetas que haces tú, y carpetas que se hacen solas.'
              : (
                <>
                  <span className="text-marfil font-medium tabular-nums">{orden.length}</span>
                  {orden.length === 1 ? ' colección' : ' colecciones'}
                  {manuales > 0 && <> · {manuales} {manuales === 1 ? 'manual' : 'manuales'}</>}
                  {smart > 0 && <> · {smart} que se {smart === 1 ? 'actualiza' : 'actualizan'} sola{smart === 1 ? '' : 's'}</>}
                </>
              )}
          </p>
        </div>
        <button
          onClick={onCreateCollection}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-lavanda text-noche text-[13px] font-semibold hover:bg-lavanda-claro transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nueva colección
        </button>
      </div>

      {/* ── Vacío: una invitación, no un manual ───────────────────────────── */}
      {orden.length === 0 ? (
        <div className="max-w-xl py-6">
          <p className="text-[15px] text-marfil leading-relaxed">
            Todavía no hay ninguna. Hay dos maneras de hacer una:
          </p>
          <div className="mt-5 flex flex-col gap-4">
            <p className="text-[13px] text-niebla leading-relaxed">
              <span className="text-marfil font-medium">A mano.</span> Vas eligiendo archivos y los
              metes dentro. No cambia nunca si tú no la tocas — como una caja.
            </p>
            <p className="text-[13px] text-niebla leading-relaxed">
              <span className="inline-flex items-center gap-1.5 text-lavanda font-medium">
                <Wand2 className="w-3.5 h-3.5" /> Con una regla.
              </span>{' '}
              Dices qué quieres —«donde sale Ester», «todo lo naranja de 2019», «primeros planos»— y
              se llena sola. Cuando entra material nuevo al archivo, lo que encaje entra también.
            </p>
          </div>
          <button
            onClick={onCreateCollection}
            className="mt-6 inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-lavanda text-noche text-[13px] font-semibold hover:bg-lavanda-claro transition-colors"
          >
            <Plus className="w-4 h-4" />
            Hacer la primera
          </button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={alSoltar}>
          <SortableContext items={orden.map(c => c.id)} strategy={rectSortingStrategy}>
            <div className="grid gap-x-5 gap-y-8" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))' }}>
              {orden.map(c => (
                <TarjetaColeccion
                  key={c.id}
                  coleccion={c}
                  archivos={archivosDe(c)}
                  total={(c.mediaFiles || []).length}
                  nombrePersona={nombrePersona}
                  descargando={downloadingCollectionId === c.id}
                  onAbrir={() => onCollectionSelect(c.id)}
                  onEditar={() => onEditCollection(c.id)}
                  onBorrar={() => onDeleteCollection(c.id)}
                  onDescargar={(e) => onDownloadCollection(c.id, e)}
                  onPortada={onEditCover ? () => onEditCover(c.id) : undefined}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

/** Portada hecha con lo que hay dentro. */
function Mosaico({ archivos, nombre }: { archivos: MediaFile[]; nombre: string }) {
  if (archivos.length === 0) {
    return (
      <div className="w-full h-full bg-grafito flex items-center justify-center">
        <span className="font-mono text-[10px] tracking-wider uppercase text-humo">vacía</span>
      </div>
    );
  }
  if (archivos.length === 1) {
    return (
      <img
        src={archivos[0].thumbnail}
        alt={nombre}
        loading="lazy"
        className="w-full h-full object-cover"
        onError={e => { (e.target as HTMLImageElement).style.opacity = '0.25'; }}
      />
    );
  }
  // Dos, tres o cuatro: una rejilla que ya dice de que va la coleccion. Cada
  // celda reserva su hueco con un fondo, asi la portada no se encoge mientras
  // cargan las miniaturas.
  return (
    <div className="w-full h-full grid gap-[2px]" style={{
      gridTemplateColumns: 'repeat(2, 1fr)',
      gridTemplateRows: archivos.length > 2 ? 'repeat(2, 1fr)' : '1fr',
    }}>
      {archivos.slice(0, 4).map((f, i) => (
        <span
          key={f.id}
          className="relative block overflow-hidden bg-pizarra/60"
          style={archivos.length === 3 && i === 0 ? { gridRow: 'span 2' } : undefined}
        >
          <img
            src={f.thumbnail}
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
            onError={e => { (e.target as HTMLImageElement).style.opacity = '0'; }}
          />
        </span>
      ))}
    </div>
  );
}

function TarjetaColeccion({
  coleccion, archivos, total, nombrePersona, descargando,
  onAbrir, onEditar, onBorrar, onDescargar, onPortada,
}: {
  coleccion: Collection;
  archivos: MediaFile[];
  total: number;
  nombrePersona: (id: string) => string;
  descargando: boolean;
  onAbrir: () => void;
  onEditar: () => void;
  onBorrar: () => void;
  onDescargar: (e: React.MouseEvent) => void;
  onPortada?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: coleccion.id });

  const esSmart = coleccion.type === 'smart';
  const reglas = (coleccion.rules || []) as Regla[];
  const union = coleccion.rule_combinator === 'OR' ? ' o ' : ' + ';
  const resumenReglas = esSmart && reglas.length > 0
    ? reglas.map(r => describirRegla(r, nombrePersona)).filter(Boolean).join(union)
    : '';

  const parar = (e: React.MouseEvent, accion: () => void) => { e.stopPropagation(); accion(); };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 20 : undefined }}
      className={`group ${isDragging ? 'opacity-80' : ''}`}
    >
      {/* La portada: el mosaico pinta, una capa transparente recoge el clic y
          las acciones van por encima. Asi no hay botones dentro de botones. */}
      <div
        className="relative rounded-xl overflow-hidden bg-grafito transition-transform duration-200 group-hover:-translate-y-0.5"
        style={{ aspectRatio: '16/10' }}
      >
        <Mosaico archivos={archivos} nombre={coleccion.name} />

        <button
          onClick={onAbrir}
          aria-label={`Abrir ${coleccion.name}`}
          title={`Abrir ${coleccion.name}`}
          className="absolute inset-0 w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda rounded-xl"
        />

        {/* Acciones: aparecen sobre la portada, no viven ahi */}
        <div className="absolute top-2 right-2 z-10 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={e => parar(e, () => onDescargar(e))}
            title={descargando ? 'Descargando…' : 'Descargar'}
            className="w-7 h-7 rounded-full bg-noche/75 backdrop-blur-sm flex items-center justify-center text-marfil hover:bg-noche"
          >
            {descargando ? <Loader className="w-3.5 h-3.5 animate-spin text-lavanda" /> : <Download className="w-3.5 h-3.5" />}
          </button>
          {onPortada && (
            <button
              onClick={e => parar(e, onPortada)}
              title="Cambiar portada"
              className="w-7 h-7 rounded-full bg-noche/75 backdrop-blur-sm flex items-center justify-center text-marfil hover:bg-noche"
            >
              <ImageIcon className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={e => parar(e, onEditar)}
            title="Editar"
            className="w-7 h-7 rounded-full bg-noche/75 backdrop-blur-sm flex items-center justify-center text-marfil hover:bg-noche"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={e => parar(e, onBorrar)}
            title="Eliminar"
            className="w-7 h-7 rounded-full bg-noche/75 backdrop-blur-sm flex items-center justify-center text-estado-error hover:bg-noche"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Agarre para reordenar, separado del cuerpo: antes la tarjeta entera
            escuchaba al arrastre y cada clic era medio arrastre. */}
        <button
          {...attributes}
          {...listeners}
          onClick={e => e.stopPropagation()}
          title="Arrastra para ordenar"
          className="absolute bottom-2 right-2 z-10 w-7 h-7 rounded-full bg-noche/75 backdrop-blur-sm flex items-center justify-center text-humo opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
        >
          <GripVertical className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* El nombre SIEMPRE visible: es lo que distingue una coleccion de otra */}
      <div className="mt-2.5">
        <div className="flex items-center gap-1.5">
          {esSmart && (
            <span title="Se actualiza sola" className="shrink-0 flex">
              <Wand2 className="w-3.5 h-3.5 text-lavanda" />
            </span>
          )}
          <h3 className="text-sm font-semibold text-marfil truncate">{coleccion.name}</h3>
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-humo tabular-nums">
          {total === 0 ? 'sin archivos' : `${total.toLocaleString('es-ES')} ${total === 1 ? 'archivo' : 'archivos'}`}
        </p>
        {resumenReglas && (
          <p className="mt-1 text-[11px] text-lavanda-archivo leading-snug line-clamp-2" title={resumenReglas}>
            {resumenReglas}
          </p>
        )}
        {esSmart && total === 0 && (
          <p className="mt-1 text-[11px] text-melocoton leading-snug">
            La regla no encuentra nada ahora mismo.
          </p>
        )}
      </div>
    </div>
  );
}
