import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';

interface EditCollectionModalProps {
  isOpen: boolean;
  collectionId: string;
  currentName: string;
  onClose: () => void;
  onSave: (collectionId: string, newName: string) => void;
  existingNames: string[];
}

export function EditCollectionModal({
  isOpen,
  collectionId,
  currentName,
  onClose,
  onSave,
  existingNames
}: EditCollectionModalProps) {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    setName(currentName);
    setError('');
  }, [currentName, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName = name.trim();

    // Validation
    if (!trimmedName) {
      setError('El nombre de la colección no puede estar vacío');
      return;
    }

    if (trimmedName.length > 50) {
      setError('El nombre de la colección no puede tener más de 50 caracteres');
      return;
    }

    // Check if name already exists (case-insensitive, excluding current collection)
    const nameExists = existingNames.some(
      existingName => existingName.toLowerCase() === trimmedName.toLowerCase() &&
                      existingName.toLowerCase() !== currentName.toLowerCase()
    );

    if (nameExists) {
      setError('Ya existe una colección con ese nombre');
      return;
    }

    onSave(collectionId, trimmedName);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-noche/50 flex items-center justify-center z-50 p-4">
      <div className="bg-tinta rounded-3xl shadow-2xl max-w-md w-full p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-marfil">Editar colección</h2>
          <button
            onClick={onClose}
            className="text-lavanda-archivo hover:text-marfil transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div className="mb-6">
            <label htmlFor="collection-name" className="block text-sm font-medium text-marfil mb-2">
              Nombre de la colección
            </label>
            <input
              id="collection-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
              onKeyDown={handleKeyDown}
              className="w-full px-4 py-3 border border-pizarra rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda focus:border-transparent"
              placeholder="Ej: Vacaciones 2024"
              autoFocus
              maxLength={50}
            />
            {error && (
              <p className="mt-2 text-sm text-red-600">{error}</p>
            )}
            <p className="mt-2 text-xs text-lavanda-archivo">
              {name.length}/50 caracteres
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-3 bg-pizarra text-marfil rounded-full font-medium hover:bg-grafito transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-6 py-3 bg-lavanda text-white rounded-full font-medium hover:bg-opacity-90 transition-colors"
            >
              Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
