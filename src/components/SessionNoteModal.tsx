import { useEffect, useState } from 'react';
import { X, Layers, Loader2, Check, Trash2 } from 'lucide-react';

/**
 * Editor de la nota humana de una sesion colapsada. Texto libre que resume
 * esa sesion; se guarda en el store de notas (keyed por la session key).
 * Vaciar y guardar borra la nota.
 */
interface SessionNoteModalProps {
  isOpen: boolean;
  sessionKey: string;
  label: { line1: string; line2: string };
  initialNote: string;
  onClose: () => void;
  /** Persiste la nota. Devuelve promesa para mostrar estado de guardado. */
  onSave: (key: string, note: string) => Promise<void> | void;
}

export default function SessionNoteModal({ isOpen, sessionKey, label, initialNote, onClose, onSave }: SessionNoteModalProps) {
  const [draft, setDraft] = useState(initialNote);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setDraft(initialNote);
      setSaving(false);
      setSaved(false);
    }
  }, [isOpen, initialNote, sessionKey]);

  if (!isOpen) return null;

  const persist = async (text: string) => {
    setSaving(true);
    setSaved(false);
    try {
      await onSave(sessionKey, text);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    await persist(draft.trim());
    onClose();
  };

  const handleDelete = async () => {
    setDraft('');
    await persist('');
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-noche bg-opacity-70 flex items-center justify-center p-4 z-[60]" onClick={onClose}>
      <div
        className="bg-tinta text-marfil rounded-3xl max-w-lg w-full flex flex-col border border-pizarra"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabecera */}
        <div className="flex items-start justify-between p-6 border-b border-pizarra">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Layers className="w-5 h-5 text-lavanda flex-shrink-0" />
              Nota de la sesion
            </h2>
            <p className="text-sm text-lavanda-archivo mt-1 truncate">
              {label.line1}{label.line2 ? ` · ${label.line2}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-lavanda-archivo hover:text-marfil flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Cuerpo */}
        <div className="p-6">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
            rows={5}
            placeholder="Resume esta sesion: que paso, que material vale la pena, que destacar..."
            className="w-full px-3 py-2 bg-noche border border-pizarra rounded-2xl text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda resize-none"
          />
          <div className="h-4 mt-1 text-xs">
            {saving && <span className="text-lavanda-archivo flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Guardando...</span>}
            {!saving && saved && <span className="text-salvia flex items-center gap-1"><Check className="w-3 h-3" /> Guardado</span>}
          </div>
        </div>

        {/* Pie */}
        <div className="flex items-center justify-between p-6 border-t border-pizarra">
          {initialNote ? (
            <button onClick={handleDelete} disabled={saving} className="btn-secondary flex items-center gap-2 text-melocoton">
              <Trash2 className="w-4 h-4" /> Borrar nota
            </button>
          ) : <span />}
          <div className="flex gap-3">
            <button onClick={onClose} className="btn-secondary">Cancelar</button>
            <button onClick={handleSave} disabled={saving} className="btn-primary">Guardar</button>
          </div>
        </div>
      </div>
    </div>
  );
}
