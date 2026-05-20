import React, { useState, useEffect } from 'react';
import { X, Wand2, Folder } from 'lucide-react';
import RulesEditor, { CanonicalRule, Combinator } from './RulesEditor';

interface EditCollectionModalProps {
  isOpen: boolean;
  collectionId: string;
  currentName: string;
  onClose: () => void;
  // Callback para colecciones estaticas (solo cambia nombre)
  onSave: (collectionId: string, newName: string) => void;
  existingNames: string[];
  // Smart Folder: si la coleccion es smart, pasar config y callback dedicado
  smart?: { rules: CanonicalRule[]; combinator: Combinator } | null;
  onSaveSmart?: (
    collectionId: string,
    newName: string,
    rules: CanonicalRule[],
    combinator: Combinator
  ) => void;
}

export function EditCollectionModal({
  isOpen,
  collectionId,
  currentName,
  onClose,
  onSave,
  existingNames,
  smart,
  onSaveSmart,
}: EditCollectionModalProps) {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string>('');
  const [rules, setRules] = useState<CanonicalRule[]>(smart?.rules || []);
  const [combinator, setCombinator] = useState<Combinator>(smart?.combinator || 'AND');

  useEffect(() => {
    setName(currentName);
    setError('');
    setRules(smart?.rules || []);
    setCombinator(smart?.combinator || 'AND');
  }, [currentName, isOpen, smart?.rules, smart?.combinator]);

  const isSmart = !!smart;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('El nombre de la colección no puede estar vacío');
      return;
    }
    if (trimmedName.length > 50) {
      setError('El nombre de la colección no puede tener más de 50 caracteres');
      return;
    }

    const nameExists = existingNames.some(
      existingName =>
        existingName.toLowerCase() === trimmedName.toLowerCase() &&
        existingName.toLowerCase() !== currentName.toLowerCase()
    );
    if (nameExists) {
      setError('Ya existe una colección con ese nombre');
      return;
    }

    if (isSmart) {
      if (rules.length === 0) {
        setError('Una Smart Folder necesita al menos una regla');
        return;
      }
      if (onSaveSmart) {
        onSaveSmart(collectionId, trimmedName, rules, combinator);
        return;
      }
    }
    onSave(collectionId, trimmedName);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-noche/50 flex items-center justify-center z-50 p-4">
      <div className={`bg-tinta rounded-3xl shadow-2xl w-full p-6 max-h-[90vh] overflow-y-auto ${isSmart ? 'max-w-lg' : 'max-w-md'}`}>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-marfil flex items-center gap-2">
            {isSmart ? <Wand2 className="w-6 h-6 text-lavanda" /> : <Folder className="w-6 h-6 text-lavanda" />}
            Editar {isSmart ? 'Smart Folder' : 'colección'}
          </h2>
          <button onClick={onClose} className="text-lavanda-archivo hover:text-marfil transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-5">
            <label htmlFor="collection-name" className="block text-sm font-medium text-marfil mb-2">
              Nombre
            </label>
            <input
              id="collection-name"
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              onKeyDown={handleKeyDown}
              className="w-full px-4 py-3 border border-pizarra rounded-2xl bg-pizarra/40 text-marfil focus:outline-none focus:ring-2 focus:ring-lavanda focus:border-transparent"
              placeholder="Ej: Vacaciones 2024"
              autoFocus
              maxLength={50}
            />
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
            <p className="mt-2 text-xs text-lavanda-archivo">{name.length}/50 caracteres</p>
          </div>

          {/* Editor de reglas — solo si es Smart Folder */}
          {isSmart && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-marfil mb-2">Reglas</label>
              <RulesEditor
                rules={rules}
                combinator={combinator}
                onChange={(r, c) => { setRules(r); setCombinator(c); }}
              />
            </div>
          )}

          <div className="flex gap-3 justify-end">
            <button type="button" onClick={onClose} className="px-6 py-3 bg-pizarra text-marfil rounded-full font-medium hover:bg-grafito transition-colors">
              Cancelar
            </button>
            <button type="submit" className="px-6 py-3 bg-lavanda text-white rounded-full font-medium hover:bg-opacity-90 transition-colors">
              Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
