import { useEffect, useState } from 'react';
import { X, Folder, Image as ImageIcon, Film, Check, Loader2, AlertCircle, Tag, RotateCcw } from 'lucide-react';
import { api } from '../services/api';

/**
 * Renombrado de carpetas (display name) — Pensadero.
 *
 * El usuario asigna un nombre legible a cada carpeta-evento (p.ej.
 * "250412_Viaje, Amsterdam"). TODOS los archivos de la carpeta lo heredan, con
 * enumeracion "_NNN" si hay mas de uno, y el sistema deriva fecha + etiquetas
 * de ese nombre. El archivo FISICO conserva su nombre original siempre.
 *
 * Una fila por carpeta con material. Cada fila se guarda de forma independiente
 * (al pulsar Enter, salir del campo, o el boton de guardar). Vaciar el campo y
 * guardar restaura el nombre original.
 */

interface FolderRow {
  dir: string;
  relPath: string;
  mediaCount: number;
  imageCount: number;
  videoCount: number;
  original: string;   // nombre actual persistido en backend (folderName || '')
  draft: string;      // valor en edicion
  saving: boolean;
  saved: boolean;
  error?: string;
}

interface FolderRenameModalProps {
  isOpen: boolean;
  rootPath: string;
  onClose: () => void;
  /** Se llama tras cerrar si hubo algun cambio, para refrescar la galeria. */
  onSaved?: () => void;
}

export default function FolderRenameModal({ isOpen, rootPath, onClose, onSaved }: FolderRenameModalProps) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<FolderRow[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setLoadError(null);
    setDirty(false);
    api.scanInventory(rootPath)
      .then((res) => {
        if (!res.success || !res.data) {
          throw new Error((res as any).message || 'No se pudo cargar el inventario');
        }
        const entries: FolderRow[] = res.data.folders.map((f) => ({
          dir: f.dir,
          relPath: f.relPath,
          mediaCount: f.mediaCount,
          imageCount: f.imageCount,
          videoCount: f.videoCount,
          original: f.folderName || '',
          draft: f.folderName || '',
          saving: false,
          saved: false,
        }));
        setRows(entries);
      })
      .catch((err) => setLoadError(err.message || 'Error desconocido'))
      .finally(() => setLoading(false));
  }, [isOpen, rootPath]);

  if (!isOpen) return null;

  const patchRow = (i: number, patch: Partial<FolderRow>) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const saveRow = async (i: number) => {
    const r = rows[i];
    if (!r) return;
    const next = r.draft.trim();
    if (next === r.original.trim()) return; // sin cambios
    patchRow(i, { saving: true, error: undefined, saved: false });
    try {
      const res = await api.setFolderName(r.dir, next || null);
      if (!res.success) throw new Error((res as any).error || 'Error guardando');
      patchRow(i, { saving: false, saved: true, original: next });
      setDirty(true);
    } catch (err: any) {
      patchRow(i, { saving: false, error: err.message || 'Error desconocido' });
    }
  };

  const restoreRow = async (i: number) => {
    patchRow(i, { draft: '' });
    // Persistir el borrado inmediatamente.
    const r = rows[i];
    if (!r || !r.original.trim()) return;
    patchRow(i, { saving: true, error: undefined, saved: false });
    try {
      const res = await api.setFolderName(r.dir, null);
      if (!res.success) throw new Error((res as any).error || 'Error guardando');
      patchRow(i, { saving: false, saved: true, original: '', draft: '' });
      setDirty(true);
    } catch (err: any) {
      patchRow(i, { saving: false, error: err.message || 'Error desconocido' });
    }
  };

  const handleClose = () => {
    if (dirty) onSaved?.();
    onClose();
  };

  const renamedCount = rows.filter((r) => r.original.trim()).length;

  return (
    <div className="fixed inset-0 bg-noche bg-opacity-70 flex items-center justify-center p-4 z-50">
      <div className="bg-tinta text-marfil rounded-3xl max-w-2xl w-full max-h-[90vh] flex flex-col border border-pizarra">
        {/* Cabecera */}
        <div className="flex items-center justify-between p-6 border-b border-pizarra">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Tag className="w-5 h-5 text-lavanda" />
              Renombrar carpetas
            </h2>
            <p className="text-sm text-lavanda-archivo mt-1">
              El nombre se hereda a todos los archivos de la carpeta (con _NNN si hay varios).
              El archivo original no se modifica.
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
              <Loader2 className="w-4 h-4 animate-spin" /> Cargando carpetas...
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

          {!loading && !loadError && rows.length === 0 && (
            <div className="text-center py-16 text-lavanda-archivo text-sm">
              No se ha encontrado material en esta ruta.
            </div>
          )}

          {!loading && !loadError && rows.length > 0 && (
            <div className="space-y-3">
              {rows.map((r, i) => (
                <div key={r.dir} className="bg-grafito rounded-2xl p-3">
                  <div className="flex items-center gap-2 mb-2 text-sm">
                    <Folder className="w-4 h-4 text-lavanda flex-shrink-0" />
                    <span className="text-marfil break-all font-medium">
                      {r.relPath === '.' || r.relPath === '' ? '(raíz)' : r.relPath}
                    </span>
                    <div className="flex items-center gap-2 text-xs text-lavanda-archivo ml-auto flex-shrink-0">
                      {r.imageCount > 0 && (
                        <span className="flex items-center gap-1"><ImageIcon className="w-3 h-3" />{r.imageCount}</span>
                      )}
                      {r.videoCount > 0 && (
                        <span className="flex items-center gap-1"><Film className="w-3 h-3" />{r.videoCount}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={r.draft}
                      onChange={(e) => patchRow(i, { draft: e.target.value, saved: false })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); saveRow(i); }
                      }}
                      onBlur={() => saveRow(i)}
                      placeholder="250412_Viaje, Amsterdam"
                      className="flex-1 px-3 py-2 bg-tinta border border-pizarra rounded-full text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
                    />
                    {r.original.trim() && (
                      <button
                        onClick={() => restoreRow(i)}
                        title="Restaurar nombre original"
                        className="p-2 rounded-full text-lavanda-archivo hover:text-marfil hover:bg-pizarra"
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                    )}
                    <div className="w-5 flex-shrink-0 flex items-center justify-center">
                      {r.saving && <Loader2 className="w-4 h-4 animate-spin text-lavanda-archivo" />}
                      {!r.saving && r.saved && <Check className="w-4 h-4 text-salvia" />}
                    </div>
                  </div>
                  {r.error && <p className="text-xs text-red-400 mt-1">{r.error}</p>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pie */}
        <div className="flex items-center justify-between p-6 border-t border-pizarra">
          <p className="text-xs text-lavanda-archivo">{renamedCount} con nombre propio</p>
          <button onClick={handleClose} className="btn-primary">Hecho</button>
        </div>
      </div>
    </div>
  );
}
