import React, { useState } from 'react';
import { X, Folder, Plus, Wand2 } from 'lucide-react';
import { CoverImageSelector } from './CoverImageSelector';
import { MediaFile } from '../types';
import { normalizePath } from '../utils/formatData';
import RulesEditor, { CanonicalRule, Combinator } from './RulesEditor';

interface SmartFolderConfig {
  rules: CanonicalRule[];
  combinator: Combinator;
}

interface CreateCollectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (
    name: string,
    description: string,
    coverImage?: { type: 'system' | 'custom'; value: string },
    smart?: SmartFolderConfig
  ) => void;
  mediaFiles: MediaFile[];
}

export function CreateCollectionModal({ isOpen, onClose, onCreate, mediaFiles }: CreateCollectionModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedCover, setSelectedCover] = useState<{ type: 'system' | 'custom'; value: string } | undefined>();
  const [showCoverSelector, setShowCoverSelector] = useState(false);
  // Tipo de coleccion: manual (estatica) o smart (dinamica con reglas)
  const [collectionType, setCollectionType] = useState<'manual' | 'smart'>('manual');
  const [rules, setRules] = useState<CanonicalRule[]>([]);
  const [combinator, setCombinator] = useState<Combinator>('AND');

  if (!isOpen) return null;

  const canSubmit = name.trim() && (collectionType === 'manual' || rules.length > 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const smart = collectionType === 'smart' ? { rules, combinator } : undefined;
    onCreate(name.trim(), description.trim(), selectedCover, smart);
    setName('');
    setDescription('');
    setSelectedCover(undefined);
    setRules([]);
    setCombinator('AND');
    setCollectionType('manual');
    onClose();
  };

  const getCoverPreview = () => {
    if (!selectedCover) return null;
    if (selectedCover.type === 'system') {
      const systemFile = mediaFiles.find(f => normalizePath(f.fullPath!) === selectedCover.value);
      return systemFile?.thumbnail;
    }
    return selectedCover.value;
  };

  return (
    <div className="fixed inset-0 bg-noche bg-opacity-70 flex items-center justify-center p-4 z-50">
      <div className="bg-tinta text-marfil rounded-3xl max-w-lg w-full border border-borde-sutil max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-pizarra">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            {collectionType === 'smart' ? (
              <Wand2 className="w-5 h-5 text-lavanda" />
            ) : (
              <Folder className="w-5 h-5 text-lavanda" />
            )}
            Nueva {collectionType === 'smart' ? 'Smart Folder' : 'Colección'}
          </h2>
          <button onClick={onClose} className="text-lavanda-archivo hover:text-marfil">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          {/* Toggle Manual / Smart */}
          <div className="mb-5 flex items-center bg-pizarra rounded-full p-1">
            <button
              type="button"
              onClick={() => setCollectionType('manual')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-full text-sm font-medium transition-colors ${
                collectionType === 'manual' ? 'bg-lavanda text-white' : 'text-lavanda-archivo hover:text-marfil'
              }`}
            >
              <Folder className="w-4 h-4" />
              Manual
            </button>
            <button
              type="button"
              onClick={() => setCollectionType('smart')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-full text-sm font-medium transition-colors ${
                collectionType === 'smart' ? 'bg-lavanda text-white' : 'text-lavanda-archivo hover:text-marfil'
              }`}
            >
              <Wand2 className="w-4 h-4" />
              Inteligente
            </button>
          </div>

          {/* Descripcion breve segun el tipo */}
          <p className="text-xs text-lavanda-archivo mb-4">
            {collectionType === 'manual'
              ? 'Una colección manual: tú decides qué archivos entran añadiéndolos uno a uno.'
              : 'Una Smart Folder se mantiene sola: defines reglas y cualquier archivo que las cumpla aparece automáticamente (también los que añadas en el futuro).'}
          </p>

          {/* Nombre */}
          <div className="mb-4">
            <label htmlFor="collection-name" className="block text-sm font-medium text-marfil mb-2">
              Nombre
            </label>
            <input
              id="collection-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={collectionType === 'smart' ? 'Ej: Retratos con luz dorada' : 'Ej: Fotos de vacaciones'}
              className="w-full px-3 py-2 border border-pizarra rounded-full focus:outline-none focus:ring-2 focus:ring-lavanda bg-pizarra/50 text-marfil"
              autoFocus
              required
            />
          </div>

          {/* Editor de reglas — solo para smart */}
          {collectionType === 'smart' && (
            <div className="mb-5">
              <label className="block text-sm font-medium text-marfil mb-2">Reglas</label>
              <RulesEditor rules={rules} combinator={combinator} onChange={(r, c) => { setRules(r); setCombinator(c); }} />
            </div>
          )}

          {/* Portada — disponible para ambos tipos */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-marfil mb-2">Portada (opcional)</label>
            <div className="flex items-center gap-3">
              {selectedCover ? (
                <div className="flex items-center gap-3 flex-1">
                  <div className="w-16 h-16 rounded-lg overflow-hidden border border-pizarra">
                    <img
                      src={getCoverPreview()}
                      alt="Preview"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="%23ef4444"/><text x="32" y="32" font-family="Arial" font-size="10" fill="white" text-anchor="middle">Error</text></svg>';
                      }}
                    />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-marfil">
                      {selectedCover.type === 'system' ? 'Imagen del sistema' : 'Imagen personalizada'}
                    </p>
                    <button type="button" onClick={() => setSelectedCover(undefined)} className="text-sm text-lavanda-archivo hover:text-lavanda">
                      Quitar portada
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowCoverSelector(true)}
                  className="flex items-center gap-2 px-4 py-2 border border-pizarra rounded-lg hover:bg-pizarra/50 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Seleccionar portada
                </button>
              )}
              {selectedCover && (
                <button
                  type="button"
                  onClick={() => setShowCoverSelector(true)}
                  className="px-3 py-2 text-sm text-lavanda hover:bg-lavanda/10 rounded-lg transition-colors"
                >
                  Cambiar
                </button>
              )}
            </div>
          </div>

          <div className="flex gap-3 justify-end">
            <button type="button" onClick={onClose} className="btn-secondary">Cancelar</button>
            <button
              type="submit"
              disabled={!canSubmit}
              className={`btn-primary ${!canSubmit ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              Crear {collectionType === 'smart' ? 'Smart Folder' : 'Colección'}
            </button>
          </div>
        </form>
      </div>

      <CoverImageSelector
        selectedCover={selectedCover}
        onCoverSelect={(cover) => { setSelectedCover(cover); setShowCoverSelector(false); }}
        systemImages={mediaFiles}
        isOpen={showCoverSelector}
        onClose={() => setShowCoverSelector(false)}
      />
    </div>
  );
}
