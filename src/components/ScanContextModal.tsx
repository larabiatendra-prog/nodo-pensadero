import { useEffect, useRef, useState } from 'react';
import { X, Sparkles, Users, Folder, Image as ImageIcon, Film, Check, ChevronLeft, ChevronRight, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../services/api';

/**
 * Estado editable de una carpeta en el flujo de diapositivas. Solo dos
 * entradas de cara al usuario: personas (chips) y un texto libre. El resto
 * de campos antiguos (tipo/lugar/fecha/priorizar/ignorar) se aplanan al
 * texto libre al cargar — el VLM recibe prosa de todas formas.
 */
interface FolderSlide {
  dir: string;
  relPath: string;
  displayName: string;   // nombre legible (subcarpeta o "<raíz> (raíz)")
  isRoot: boolean;
  mediaCount: number;
  imageCount: number;
  videoCount: number;
  personas: string[];
  notas: string;
  hasContext: boolean;
  // control de guardado autosave
  dirty: boolean;        // hay cambios sin persistir
  saving: boolean;
  saved: boolean;        // último guardado OK (para el check verde)
  error?: string;
}

interface ScanContextModalProps {
  isOpen: boolean;
  rootPath: string;
  onClose: () => void;
  /** Llamada cuando el usuario confirma. El padre gestiona el ciclo de vida del modal. */
  onConfirm: () => void;
  /** Omitir esta ruta (flujo scan-all: avanza a la siguiente sin lanzar). */
  onSkip?: () => void;
  /** Omitir todas las rutas restantes y lanzar el scan ya. */
  onSkipAll?: () => void;
  /** Texto del botón de confirmar. Por defecto "Lanzar escaneo". */
  confirmLabel?: string;
  /** Progreso en el flujo scan-all. */
  stepInfo?: { current: number; total: number };
}

/**
 * Aplana el contexto antiguo (meta estructurada + cuerpo) a un único texto
 * libre editable, preservando las personas aparte. Así un `_contexto.md`
 * con frontmatter heredado de la versión anterior sigue siendo legible y
 * editable, y al guardar se reescribe como texto libre + personas.
 */
function flattenContext(meta: Record<string, any> | null | undefined, body: string | undefined): { personas: string[]; notas: string } {
  const m = meta || {};
  const personas = Array.isArray(m.personas)
    ? m.personas.filter(Boolean)
    : (typeof m.personas === 'string' && m.personas.trim()
        ? m.personas.split(',').map((s) => s.trim()).filter(Boolean)
        : []);

  // Reconstruimos una frase con los campos estructurados antiguos para no
  // perder nada. Personas queda fuera porque tiene su propio chip-field.
  const parts: string[] = [];
  if (typeof m.tipo === 'string' && m.tipo.trim()) parts.push(`Tipo: ${m.tipo.trim()}.`);
  if (typeof m.lugar === 'string' && m.lugar.trim()) parts.push(`Lugar: ${m.lugar.trim()}.`);
  if (typeof m.fecha === 'string' && m.fecha.trim()) parts.push(`Fecha: ${m.fecha.trim()}.`);
  if (typeof m.priorizar === 'string' && m.priorizar.trim()) parts.push(`Priorizar: ${m.priorizar.trim()}.`);
  if (typeof m.ignorar === 'string' && m.ignorar.trim()) parts.push(`Ignorar: ${m.ignorar.trim()}.`);
  // Campos personalizados extra que no sean reservados.
  for (const [k, v] of Object.entries(m)) {
    if (['tipo', 'lugar', 'fecha', 'personas', 'priorizar', 'ignorar'].includes(k)) continue;
    if (Array.isArray(v) && v.length) parts.push(`${k}: ${v.join(', ')}.`);
    else if (typeof v === 'string' && v.trim()) parts.push(`${k}: ${v.trim()}.`);
  }

  const flattened = parts.join(' ');
  const freeBody = typeof body === 'string' ? body.trim() : '';
  const notas = [flattened, freeBody].filter(Boolean).join('\n\n');
  return { personas, notas };
}

/** Construye el payload que espera el backend, o null si está todo vacío. */
function slideToPayload(s: FolderSlide): Record<string, any> | null {
  const personas = s.personas.map((p) => p.trim()).filter(Boolean);
  const notas = s.notas.trim();
  if (personas.length === 0 && notas === '') return null;
  return {
    personas: personas.length ? personas : undefined,
    notas: notas || undefined,
  };
}

export default function ScanContextModal({ isOpen, rootPath, onClose, onConfirm, onSkip, onSkipAll, confirmLabel, stepInfo }: ScanContextModalProps) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slides, setSlides] = useState<FolderSlide[]>([]);
  const [idx, setIdx] = useState(0);
  const [personaDraft, setPersonaDraft] = useState('');

  // Ref para poder guardar el slide actual sin depender del closure de
  // estado dentro de los handlers de navegación.
  const slidesRef = useRef<FolderSlide[]>([]);
  slidesRef.current = slides;

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setLoadError(null);
    setIdx(0);
    setPersonaDraft('');
    api.scanInventory(rootPath)
      .then((res) => {
        if (!res.success || !res.data) {
          throw new Error((res as any).message || 'No se pudo cargar el inventario');
        }
        // Cada carpeta con material tiene su propia diapositiva — incluida la
        // raíz si contiene archivos directos (relPath '.'). Si la raíz no tiene
        // material directo pero queremos poder darle contexto general, la
        // añadimos igualmente como primer slide.
        const rootAbs = res.data.root;
        const rootName = (rootAbs.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || rootAbs);
        const raw = [...res.data.folders];
        const hasRootEntry = raw.some((f) => f.relPath === '.' || f.relPath === '');
        if (!hasRootEntry) {
          const rc = res.data.rootContext;
          raw.unshift({
            dir: rootAbs,
            relPath: '.',
            mediaCount: 0,
            imageCount: 0,
            videoCount: 0,
            hasContext: !!rc,
            context: rc,
          });
        }

        const entries: FolderSlide[] = raw.map((f) => {
          const { personas, notas } = flattenContext(f.context?.meta, f.context?.body);
          const isRoot = f.relPath === '.' || f.relPath === '';
          return {
            dir: f.dir,
            relPath: f.relPath,
            displayName: isRoot ? `${rootName} (raíz)` : f.relPath,
            isRoot,
            mediaCount: f.mediaCount,
            imageCount: f.imageCount,
            videoCount: f.videoCount,
            personas,
            notas,
            hasContext: f.hasContext,
            dirty: false,
            saving: false,
            saved: false,
          };
        });
        setSlides(entries);
      })
      .catch((err) => setLoadError(err.message || 'Error desconocido'))
      .finally(() => setLoading(false));
  }, [isOpen, rootPath]);

  if (!isOpen) return null;

  const current = slides[idx];

  const patchSlide = (i: number, patch: Partial<FolderSlide>) => {
    setSlides((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };

  /** Persiste el slide `i` si tiene cambios sin guardar. Devuelve promesa. */
  const persistSlide = async (i: number) => {
    const s = slidesRef.current[i];
    if (!s || !s.dirty) return;
    patchSlide(i, { saving: true, error: undefined });
    try {
      const payload = slideToPayload(s);
      const res = await api.saveScanContext(s.dir, payload);
      if (!res.success) throw new Error((res as any).error || 'Error guardando');
      patchSlide(i, { saving: false, saved: true, dirty: false, hasContext: payload !== null });
    } catch (err: any) {
      patchSlide(i, { saving: false, error: err.message || 'Error desconocido' });
    }
  };

  const commitPersonaDraft = () => {
    const v = personaDraft.trim();
    if (!v) return;
    if (!current.personas.includes(v)) {
      patchSlide(idx, { personas: [...current.personas, v], dirty: true, saved: false });
    }
    setPersonaDraft('');
  };

  const removePersona = (name: string) => {
    patchSlide(idx, { personas: current.personas.filter((p) => p !== name), dirty: true, saved: false });
  };

  const goTo = async (next: number) => {
    // Guardamos el draft de personas pendiente antes de movernos.
    if (personaDraft.trim()) commitPersonaDraft();
    await persistSlide(idx);
    setPersonaDraft('');
    setIdx(next);
  };

  const goPrev = () => { if (idx > 0) goTo(idx - 1); };
  const goNext = () => { if (idx < slides.length - 1) goTo(idx + 1); };

  const handleClose = async () => {
    if (personaDraft.trim()) commitPersonaDraft();
    await persistSlide(idx);
    onClose();
  };

  const handleConfirm = async () => {
    if (personaDraft.trim()) commitPersonaDraft();
    await persistSlide(idx);
    onConfirm();
    // El padre gestiona el cierre; no llamamos onClose aquí para que el
    // flujo scan-all pueda avanzar al siguiente modal sin cerrar todo.
  };

  const handleSkip = async () => {
    await persistSlide(idx);
    onSkip?.();
  };
  const handleSkipAll = async () => {
    await persistSlide(idx);
    onSkipAll?.();
  };

  const withContext = slides.filter((s) => s.hasContext).length;
  const isLast = idx === slides.length - 1;

  return (
    <div className="fixed inset-0 bg-noche bg-opacity-70 flex items-center justify-center p-4 z-50">
      <div className="bg-tinta text-marfil rounded-3xl max-w-2xl w-full max-h-[90vh] flex flex-col border border-pizarra">
        {/* Cabecera */}
        <div className="flex items-center justify-between p-6 border-b border-pizarra">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-lavanda" />
              Contexto para el escaneo
            </h2>
            <p className="text-sm text-lavanda-archivo mt-1">
              Escribe lo que ayude al modelo a entender cada carpeta. Se guarda solo al pasar.
            </p>
          </div>
          <button onClick={handleClose} className="text-lavanda-archivo hover:text-marfil">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Cuerpo */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading && (
            <div className="text-center py-16 text-lavanda-archivo flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Cargando inventario de carpetas...
            </div>
          )}

          {loadError && (
            <div className="p-4 bg-pizarra border border-lavanda-archivo rounded-2xl flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-bruma flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-marfil">No se pudo cargar el inventario</p>
                <p className="text-sm text-lavanda-archivo">{loadError}</p>
              </div>
            </div>
          )}

          {!loading && !loadError && slides.length === 0 && (
            <div className="text-center py-16 text-lavanda-archivo text-sm">
              No se ha encontrado material escaneable en esta ruta.
            </div>
          )}

          {!loading && !loadError && current && (
            <div className="space-y-5">
              {/* Progreso */}
              <div className="flex items-center justify-between text-xs text-lavanda-archivo">
                <span>
                  Carpeta <span className="text-marfil font-medium">{idx + 1}</span> / {slides.length}
                  <span className="ml-3">{withContext} con contexto</span>
                </span>
                {current.hasContext ? (
                  <span className="px-2 py-1 bg-lavanda text-noche rounded-full flex items-center gap-1">
                    <Check className="w-3 h-3" /> Con contexto
                  </span>
                ) : (
                  <span className="px-2 py-1 bg-pizarra text-lavanda-archivo rounded-full">Sin contexto</span>
                )}
              </div>

              {/* Barra de progreso */}
              <div className="h-1 bg-pizarra rounded-full overflow-hidden">
                <div
                  className="h-full bg-lavanda transition-all"
                  style={{ width: `${((idx + 1) / slides.length) * 100}%` }}
                />
              </div>

              {/* Nombre de la carpeta + conteo */}
              <div className="flex items-start gap-3">
                <Folder className="w-5 h-5 text-lavanda flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-lg font-medium text-marfil break-words">{current.displayName}</p>
                  <div className="flex items-center gap-3 text-xs text-lavanda-archivo mt-1">
                    {current.imageCount > 0 && (
                      <span className="flex items-center gap-1"><ImageIcon className="w-3 h-3" />{current.imageCount}</span>
                    )}
                    {current.videoCount > 0 && (
                      <span className="flex items-center gap-1"><Film className="w-3 h-3" />{current.videoCount}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Personas (chips) */}
              <div>
                <label className="block text-xs text-lavanda-archivo mb-1 flex items-center gap-1">
                  <Users className="w-3 h-3" /> Personas que pueden aparecer
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {current.personas.map((p) => (
                    <span key={p} className="inline-flex items-center gap-1 px-3 py-1 bg-pizarra rounded-full text-sm text-marfil">
                      {p}
                      <button onClick={() => removePersona(p)} className="text-lavanda-archivo hover:text-marfil">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  type="text"
                  value={personaDraft}
                  onChange={(e) => setPersonaDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      commitPersonaDraft();
                    } else if (e.key === 'Backspace' && !personaDraft && current.personas.length) {
                      removePersona(current.personas[current.personas.length - 1]);
                    }
                  }}
                  onBlur={commitPersonaDraft}
                  placeholder="Escribe un nombre y pulsa Enter..."
                  className="w-full px-3 py-2 bg-tinta border border-pizarra rounded-full text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
                />
              </div>

              {/* Texto libre */}
              <div>
                <label className="block text-xs text-lavanda-archivo mb-1">Contexto de la carpeta</label>
                <textarea
                  autoFocus
                  value={current.notas}
                  onChange={(e) => patchSlide(idx, { notas: e.target.value, dirty: true, saved: false })}
                  rows={6}
                  placeholder="Viaje a París, fin de semana. Priorizar momentos de grupo, ignorar planos de relleno..."
                  className="w-full px-3 py-2 bg-tinta border border-pizarra rounded-2xl text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda resize-none"
                />
                <div className="h-4 mt-1 text-xs">
                  {current.saving && (
                    <span className="text-lavanda-archivo flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Guardando...</span>
                  )}
                  {!current.saving && current.saved && (
                    <span className="text-salvia flex items-center gap-1"><Check className="w-3 h-3" /> Guardado</span>
                  )}
                  {current.error && <span className="text-red-400">{current.error}</span>}
                </div>
              </div>

              {/* Navegación entre slides */}
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={goPrev}
                  disabled={idx === 0}
                  className="btn-secondary flex items-center gap-1 disabled:opacity-30"
                >
                  <ChevronLeft className="w-4 h-4" /> Atrás
                </button>
                <button
                  onClick={goNext}
                  disabled={isLast}
                  className="btn-secondary flex items-center gap-1 disabled:opacity-30"
                >
                  Siguiente <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Pie con acciones globales */}
        <div className="flex items-center justify-between p-6 border-t border-pizarra">
          <div>
            {stepInfo ? (
              <p className="text-xs text-lavanda-archivo">
                Ruta <span className="text-marfil font-medium">{stepInfo.current}</span> de <span className="text-marfil font-medium">{stepInfo.total}</span>
              </p>
            ) : (
              <p className="text-xs text-lavanda-archivo">Las carpetas sin contexto usan el prompt genérico.</p>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={handleClose} className="btn-secondary">Cancelar</button>
            {onSkipAll && (
              <button onClick={handleSkipAll} className="btn-secondary">Omitir todo</button>
            )}
            {onSkip && (
              <button onClick={handleSkip} className="btn-secondary">Omitir</button>
            )}
            <button
              onClick={handleConfirm}
              disabled={loading || !!loadError}
              className="btn-primary flex items-center gap-2"
            >
              <Sparkles className="w-4 h-4" />
              {confirmLabel ?? 'Lanzar escaneo'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
