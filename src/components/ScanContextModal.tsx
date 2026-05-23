import { useEffect, useState } from 'react';
import { X, Sparkles, MapPin, Users, Folder, Image as ImageIcon, Film, Check, ChevronDown, ChevronRight, Save, AlertCircle } from 'lucide-react';
import { api } from '../services/api';

/**
 * Estructura de un contexto editable en el modal. Refleja el frontmatter
 * que el backend serializa a `_contexto.md`. Todo opcional.
 */
interface ContextForm {
  tipo: string;
  lugar: string;
  fecha: string;
  personas: string;   // entrada como texto separado por comas
  priorizar: string;
  ignorar: string;
  notas: string;
}

interface FolderEntry {
  dir: string;
  relPath: string;
  mediaCount: number;
  imageCount: number;
  videoCount: number;
  hasContext: boolean;
  // estado en edición — separado del que vino del servidor
  form: ContextForm;
  expanded: boolean;
  saving: boolean;
  saved: boolean;
  error?: string;
}

interface ScanContextModalProps {
  isOpen: boolean;
  rootPath: string;
  onClose: () => void;
  /** Llamada cuando el usuario confirma. El padre se encarga del scan real. */
  onConfirm: () => void;
}

const EMPTY_FORM: ContextForm = {
  tipo: '',
  lugar: '',
  fecha: '',
  personas: '',
  priorizar: '',
  ignorar: '',
  notas: '',
};

const TIPO_SUGERENCIAS = [
  'viaje', 'evento', 'celebración', 'naturaleza',
  'cotidiano', 'familia', 'amigos', 'trabajo', 'otro'
];

/**
 * Convierte el contexto recibido del backend (meta object + body string) al
 * formato editable del formulario.
 */
function metaToForm(meta: Record<string, any> | null | undefined, body: string | undefined): ContextForm {
  const m = meta || {};
  const personas = Array.isArray(m.personas)
    ? m.personas.join(', ')
    : (typeof m.personas === 'string' ? m.personas : '');
  return {
    tipo: typeof m.tipo === 'string' ? m.tipo : '',
    lugar: typeof m.lugar === 'string' ? m.lugar : '',
    fecha: typeof m.fecha === 'string' ? m.fecha : '',
    personas,
    priorizar: typeof m.priorizar === 'string' ? m.priorizar : '',
    ignorar: typeof m.ignorar === 'string' ? m.ignorar : '',
    notas: typeof body === 'string' ? body : '',
  };
}

function formToPayload(f: ContextForm): Record<string, any> {
  const personasArr = f.personas
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    tipo: f.tipo.trim() || undefined,
    lugar: f.lugar.trim() || undefined,
    fecha: f.fecha.trim() || undefined,
    personas: personasArr.length > 0 ? personasArr : undefined,
    priorizar: f.priorizar.trim() || undefined,
    ignorar: f.ignorar.trim() || undefined,
    notas: f.notas.trim() || undefined,
  };
}

function isFormEmpty(f: ContextForm): boolean {
  return Object.values(f).every((v) => !v || v.trim() === '');
}

export default function ScanContextModal({ isOpen, rootPath, onClose, onConfirm }: ScanContextModalProps) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [rootForm, setRootForm] = useState<ContextForm>(EMPTY_FORM);
  const [rootHasContext, setRootHasContext] = useState(false);
  const [rootExpanded, setRootExpanded] = useState(true);
  const [rootSaving, setRootSaving] = useState(false);
  const [rootSaved, setRootSaved] = useState(false);
  const [rootError, setRootError] = useState<string | undefined>();

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setLoadError(null);
    api.scanInventory(rootPath)
      .then((res) => {
        if (!res.success || !res.data) {
          throw new Error((res as any).message || 'No se pudo cargar el inventario');
        }
        const rootCtx = res.data.rootContext;
        setRootHasContext(!!rootCtx);
        setRootForm(metaToForm(rootCtx?.meta, rootCtx?.body));
        setRootExpanded(!rootCtx);

        // Excluimos la raíz de la lista de subcarpetas: ya está
        // representada por su propia sección "Contexto de la raíz".
        const entries: FolderEntry[] = res.data.folders
          .filter((f) => f.relPath !== '.' && f.relPath !== '')
          .map((f) => ({
            dir: f.dir,
            relPath: f.relPath,
            mediaCount: f.mediaCount,
            imageCount: f.imageCount,
            videoCount: f.videoCount,
            hasContext: f.hasContext,
            form: metaToForm(f.context?.meta, f.context?.body),
            expanded: false,
            saving: false,
            saved: false,
          }));
        setFolders(entries);
      })
      .catch((err) => setLoadError(err.message || 'Error desconocido'))
      .finally(() => setLoading(false));
  }, [isOpen, rootPath]);

  if (!isOpen) return null;

  const updateFolder = (idx: number, patch: Partial<FolderEntry>) => {
    setFolders((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };

  const updateFolderForm = (idx: number, patch: Partial<ContextForm>) => {
    setFolders((prev) =>
      prev.map((f, i) => (i === idx ? { ...f, form: { ...f.form, ...patch }, saved: false } : f))
    );
  };

  const handleSaveRoot = async () => {
    setRootSaving(true);
    setRootError(undefined);
    setRootSaved(false);
    try {
      const payload = isFormEmpty(rootForm) ? null : formToPayload(rootForm);
      const res = await api.saveScanContext(rootPath, payload);
      if (!res.success) throw new Error((res as any).error || 'Error guardando');
      setRootSaved(true);
      setRootHasContext(!isFormEmpty(rootForm));
    } catch (err: any) {
      setRootError(err.message || 'Error desconocido');
    } finally {
      setRootSaving(false);
    }
  };

  const handleSaveFolder = async (idx: number) => {
    const f = folders[idx];
    updateFolder(idx, { saving: true, error: undefined, saved: false });
    try {
      const payload = isFormEmpty(f.form) ? null : formToPayload(f.form);
      const res = await api.saveScanContext(f.dir, payload);
      if (!res.success) throw new Error((res as any).error || 'Error guardando');
      updateFolder(idx, { saving: false, saved: true, hasContext: !isFormEmpty(f.form) });
    } catch (err: any) {
      updateFolder(idx, { saving: false, error: err.message || 'Error desconocido' });
    }
  };

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  const withContext = folders.filter((f) => f.hasContext).length;
  const totalMedia = folders.reduce((sum, f) => sum + f.mediaCount, 0);

  return (
    <div className="fixed inset-0 bg-noche bg-opacity-70 flex items-center justify-center p-4 z-50">
      <div className="bg-tinta text-marfil rounded-3xl max-w-4xl w-full max-h-[90vh] flex flex-col border border-pizarra">
        {/* Cabecera */}
        <div className="flex items-center justify-between p-6 border-b border-pizarra">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-lavanda" />
              Contexto para el escaneo
            </h2>
            <p className="text-sm text-lavanda-archivo mt-1">
              Antes de describir cada archivo, el modelo leerá el contexto que rellenes para cada carpeta.
            </p>
          </div>
          <button onClick={onClose} className="text-lavanda-archivo hover:text-marfil">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Cuerpo scrollable */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading && (
            <div className="text-center py-12 text-lavanda-archivo">
              Cargando inventario de carpetas...
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

          {!loading && !loadError && (
            <>
              {/* Resumen */}
              <div className="text-sm text-lavanda-archivo flex items-center gap-4 flex-wrap">
                <span>
                  <span className="text-marfil font-medium">{folders.length}</span> subcarpetas con material
                </span>
                <span>
                  <span className="text-marfil font-medium">{totalMedia}</span> archivos en total
                </span>
                <span>
                  <span className="text-marfil font-medium">{withContext}</span> con contexto
                </span>
              </div>

              {/* Contexto de la raíz */}
              <div className="bg-grafito rounded-2xl border border-pizarra">
                <button
                  onClick={() => setRootExpanded(!rootExpanded)}
                  className="w-full flex items-center justify-between p-4 hover:bg-pizarra/30 rounded-2xl transition-colors"
                >
                  <div className="flex items-center gap-3 text-left">
                    {rootExpanded ? (
                      <ChevronDown className="w-4 h-4 text-lavanda-archivo" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-lavanda-archivo" />
                    )}
                    <Folder className="w-4 h-4 text-lavanda" />
                    <div>
                      <p className="text-sm font-medium text-marfil">Contexto de la raíz</p>
                      <p className="text-xs text-lavanda-archivo truncate max-w-md">{rootPath}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {rootHasContext ? (
                      <span className="text-xs px-2 py-1 bg-lavanda text-noche rounded-full flex items-center gap-1">
                        <Check className="w-3 h-3" /> Con contexto
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-1 bg-pizarra text-lavanda-archivo rounded-full">
                        Sin contexto
                      </span>
                    )}
                  </div>
                </button>

                {rootExpanded && (
                  <div className="px-4 pb-4">
                    <p className="text-xs text-lavanda-archivo mb-3">
                      Este contexto aplica a todas las subcarpetas, salvo que cada una añada el suyo propio.
                    </p>
                    <ContextFormFields
                      form={rootForm}
                      onChange={(patch) => {
                        setRootForm((prev) => ({ ...prev, ...patch }));
                        setRootSaved(false);
                      }}
                    />
                    <div className="flex items-center gap-3 mt-3">
                      <button
                        onClick={handleSaveRoot}
                        disabled={rootSaving}
                        className="px-4 py-2 bg-lavanda text-noche rounded-full text-sm font-medium hover:bg-lavanda-claro transition-colors flex items-center gap-2 disabled:opacity-50"
                      >
                        <Save className="w-4 h-4" />
                        {rootSaving ? 'Guardando...' : 'Guardar contexto'}
                      </button>
                      {rootSaved && (
                        <span className="text-xs text-salvia flex items-center gap-1">
                          <Check className="w-3 h-3" /> Guardado
                        </span>
                      )}
                      {rootError && (
                        <span className="text-xs text-red-400">{rootError}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Subcarpetas */}
              <div className="space-y-2">
                {folders.map((f, idx) => (
                  <div key={f.dir} className="bg-grafito rounded-2xl border border-pizarra">
                    <button
                      onClick={() => updateFolder(idx, { expanded: !f.expanded })}
                      className="w-full flex items-center justify-between p-4 hover:bg-pizarra/30 rounded-2xl transition-colors"
                    >
                      <div className="flex items-center gap-3 text-left min-w-0">
                        {f.expanded ? (
                          <ChevronDown className="w-4 h-4 text-lavanda-archivo flex-shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-lavanda-archivo flex-shrink-0" />
                        )}
                        <Folder className="w-4 h-4 text-lavanda flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-marfil truncate">{f.relPath === '.' ? '(raíz)' : f.relPath}</p>
                          <div className="flex items-center gap-3 text-xs text-lavanda-archivo">
                            {f.imageCount > 0 && (
                              <span className="flex items-center gap-1">
                                <ImageIcon className="w-3 h-3" />
                                {f.imageCount}
                              </span>
                            )}
                            {f.videoCount > 0 && (
                              <span className="flex items-center gap-1">
                                <Film className="w-3 h-3" />
                                {f.videoCount}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {f.hasContext ? (
                          <span className="text-xs px-2 py-1 bg-lavanda text-noche rounded-full flex items-center gap-1">
                            <Check className="w-3 h-3" /> Con contexto
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-1 bg-pizarra text-lavanda-archivo rounded-full">
                            Sin contexto
                          </span>
                        )}
                      </div>
                    </button>

                    {f.expanded && (
                      <div className="px-4 pb-4">
                        <ContextFormFields
                          form={f.form}
                          onChange={(patch) => updateFolderForm(idx, patch)}
                        />
                        <div className="flex items-center gap-3 mt-3">
                          <button
                            onClick={() => handleSaveFolder(idx)}
                            disabled={f.saving}
                            className="px-4 py-2 bg-lavanda text-noche rounded-full text-sm font-medium hover:bg-lavanda-claro transition-colors flex items-center gap-2 disabled:opacity-50"
                          >
                            <Save className="w-4 h-4" />
                            {f.saving ? 'Guardando...' : 'Guardar contexto'}
                          </button>
                          {f.saved && (
                            <span className="text-xs text-salvia flex items-center gap-1">
                              <Check className="w-3 h-3" /> Guardado
                            </span>
                          )}
                          {f.error && (
                            <span className="text-xs text-red-400">{f.error}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {folders.length === 0 && (
                  <div className="text-center py-8 text-lavanda-archivo text-sm">
                    No se ha encontrado material en subcarpetas. El escaneo usará sólo el contexto de la raíz (si existe).
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Pie con acciones */}
        <div className="flex items-center justify-between p-6 border-t border-pizarra">
          <p className="text-xs text-lavanda-archivo">
            Las carpetas sin contexto se escanearán con el prompt genérico.
          </p>
          <div className="flex gap-3">
            <button onClick={onClose} className="btn-secondary">Cancelar</button>
            <button
              onClick={handleConfirm}
              disabled={loading || !!loadError}
              className="btn-primary flex items-center gap-2"
            >
              <Sparkles className="w-4 h-4" />
              Lanzar escaneo
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Sub-componente con los campos editables del contexto. Se reutiliza para
 * la raíz y para cada subcarpeta. Mantiene el layout consistente.
 */
function ContextFormFields({
  form,
  onChange,
}: {
  form: ContextForm;
  onChange: (patch: Partial<ContextForm>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-lavanda-archivo mb-1">Tipo de material</label>
          <input
            list="tipo-suggestions"
            type="text"
            value={form.tipo}
            onChange={(e) => onChange({ tipo: e.target.value })}
            placeholder="viaje, evento, naturaleza..."
            className="w-full px-3 py-2 bg-tinta border border-pizarra rounded-full text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
          />
          <datalist id="tipo-suggestions">
            {TIPO_SUGERENCIAS.map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>
        <div>
          <label className="block text-xs text-lavanda-archivo mb-1 flex items-center gap-1">
            <MapPin className="w-3 h-3" /> Lugar
          </label>
          <input
            type="text"
            value={form.lugar}
            onChange={(e) => onChange({ lugar: e.target.value })}
            placeholder="París, casa de Carlos..."
            className="w-full px-3 py-2 bg-tinta border border-pizarra rounded-full text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
          />
        </div>
        <div>
          <label className="block text-xs text-lavanda-archivo mb-1">Fecha (opcional)</label>
          <input
            type="text"
            value={form.fecha}
            onChange={(e) => onChange({ fecha: e.target.value })}
            placeholder="2024-03, marzo 2024..."
            className="w-full px-3 py-2 bg-tinta border border-pizarra rounded-full text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
          />
        </div>
        <div>
          <label className="block text-xs text-lavanda-archivo mb-1 flex items-center gap-1">
            <Users className="w-3 h-3" /> Personas (separadas por coma)
          </label>
          <input
            type="text"
            value={form.personas}
            onChange={(e) => onChange({ personas: e.target.value })}
            placeholder="Carlos, Sara, Ester..."
            className="w-full px-3 py-2 bg-tinta border border-pizarra rounded-full text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-lavanda-archivo mb-1">Priorizar</label>
          <input
            type="text"
            value={form.priorizar}
            onChange={(e) => onChange({ priorizar: e.target.value })}
            placeholder="momentos de grupo, retratos..."
            className="w-full px-3 py-2 bg-tinta border border-pizarra rounded-full text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
          />
        </div>
        <div>
          <label className="block text-xs text-lavanda-archivo mb-1">Ignorar</label>
          <input
            type="text"
            value={form.ignorar}
            onChange={(e) => onChange({ ignorar: e.target.value })}
            placeholder="planos de relleno, fondos..."
            className="w-full px-3 py-2 bg-tinta border border-pizarra rounded-full text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-lavanda-archivo mb-1">Notas adicionales para el modelo</label>
        <textarea
          value={form.notas}
          onChange={(e) => onChange({ notas: e.target.value })}
          rows={3}
          placeholder="Cualquier detalle libre que ayude a interpretar las imágenes..."
          className="w-full px-3 py-2 bg-tinta border border-pizarra rounded-2xl text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda resize-none"
        />
      </div>
    </div>
  );
}
