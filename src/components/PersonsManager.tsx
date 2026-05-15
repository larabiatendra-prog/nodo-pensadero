import React, { useEffect, useRef, useState } from 'react';
import { User, Plus, Trash2, Upload, Star, RefreshCw, X, ArrowLeft, ImagePlus } from 'lucide-react';
import { api } from '../services/api';
import { API_CONFIG } from '../config';

interface Person {
  person_id: string;
  display_name: string;
  aliases: string[];
  avatar_path: string | null;
  avatar_url: string | null;
}

interface PersonPhoto {
  filename: string;
  url: string;
}

interface PersonsManagerProps {
  onBack?: () => void;
}

/**
 * Gestor de personas. Permite:
 *  - Listar las personas del registry
 *  - Crear/editar/eliminar entradas (display_name, aliases)
 *  - Subir fotos de referencia (que en el futuro alimentarán el modelo
 *    de reconocimiento facial cuando se integre)
 *  - Marcar una foto como avatar principal
 *
 * NO hace reconocimiento facial automático — eso entra en una segunda
 * iteración con InsightFace u otro modelo de embeddings faciales.
 */
export default function PersonsManager({ onBack }: PersonsManagerProps) {
  const [persons, setPersons] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [photos, setPhotos] = useState<PersonPhoto[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [newPersonId, setNewPersonId] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newAliases, setNewAliases] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadPersons();
  }, []);

  useEffect(() => {
    if (selectedPerson) {
      loadPhotos(selectedPerson.person_id);
    } else {
      setPhotos([]);
    }
  }, [selectedPerson]);

  async function loadPersons() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPersonsRegistry();
      if (res.success && Array.isArray(res.data)) {
        setPersons(res.data);
      } else {
        setPersons([]);
      }
    } catch (err: any) {
      setError(err.message || 'Error cargando personas');
    } finally {
      setLoading(false);
    }
  }

  async function loadPhotos(personId: string) {
    try {
      const res = await api.listPersonPhotos(personId);
      if (res.success && Array.isArray(res.data)) {
        setPhotos(res.data);
      } else {
        setPhotos([]);
      }
    } catch {
      setPhotos([]);
    }
  }

  async function handleCreate() {
    setError(null);
    const id = newPersonId.trim();
    const display = newDisplayName.trim();
    if (!id) {
      setError('person_id es requerido');
      return;
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
      setError('person_id sólo puede contener letras, números, _ y -');
      return;
    }
    const aliases = newAliases.split(',').map(a => a.trim()).filter(Boolean);

    try {
      const res = await api.upsertPerson({
        person_id: id,
        display_name: display || id,
        aliases,
      });
      if (!res.success) throw new Error(res.error || 'Error creando persona');
      setShowCreate(false);
      setNewPersonId('');
      setNewDisplayName('');
      setNewAliases('');
      await loadPersons();
    } catch (err: any) {
      setError(err.message || 'Error creando persona');
    }
  }

  async function handleUpdateAliases(person: Person, aliases: string[]) {
    try {
      await api.upsertPerson({ person_id: person.person_id, aliases });
      await loadPersons();
      if (selectedPerson?.person_id === person.person_id) {
        const updated = (await api.listPersonsRegistry()).data?.find((p: Person) => p.person_id === person.person_id);
        if (updated) setSelectedPerson(updated);
      }
    } catch (err: any) {
      setError(err.message || 'Error actualizando');
    }
  }

  async function handleDelete(person: Person) {
    if (!confirm(`¿Eliminar a ${person.display_name} y todas sus fotos? Esta acción no se puede deshacer.`)) return;
    try {
      await api.deletePerson(person.person_id);
      if (selectedPerson?.person_id === person.person_id) setSelectedPerson(null);
      await loadPersons();
    } catch (err: any) {
      setError(err.message || 'Error eliminando');
    }
  }

  async function handleUploadPhoto(personId: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      for (const f of Array.from(files)) {
        await api.uploadPersonPhoto(personId, f);
      }
      await loadPhotos(personId);
      await loadPersons();
    } catch (err: any) {
      setError(err.message || 'Error subiendo foto');
    }
  }

  async function handleDeletePhoto(personId: string, filename: string) {
    if (!confirm('¿Eliminar esta foto de referencia?')) return;
    try {
      await api.deletePersonPhoto(personId, filename);
      await loadPhotos(personId);
      await loadPersons();
    } catch (err: any) {
      setError(err.message || 'Error eliminando foto');
    }
  }

  async function handleSetAvatar(personId: string, filename: string) {
    try {
      await api.setPersonAvatar(personId, filename);
      await loadPersons();
    } catch (err: any) {
      setError(err.message || 'Error');
    }
  }

  function avatarSrc(person: Person): string | null {
    if (!person.avatar_url) return null;
    if (person.avatar_url.startsWith('http')) return person.avatar_url;
    return `${API_CONFIG.apiUrl.replace(/\/api$/, '')}${person.avatar_url}`;
  }

  function photoSrc(photo: PersonPhoto): string {
    return `${API_CONFIG.apiUrl.replace(/\/api$/, '')}${photo.url}`;
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          {onBack && (
            <button
              onClick={onBack}
              className="flex items-center gap-1 px-3 py-1.5 mb-4 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Volver</span>
            </button>
          )}
          <h1 className="text-2xl font-bold text-marfil mb-2">Personas</h1>
          <p className="text-lavanda-archivo">
            Gente que aparece en tu archivo. Sube fotos de referencia para que el sistema aprenda a reconocerlas (próximamente con detección automática).
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-lavanda text-white rounded-full hover:bg-lavanda-claro transition-colors font-medium"
        >
          <Plus className="w-4 h-4" />
          Añadir persona
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-pizarra border border-red-400/30 rounded-2xl text-sm text-red-300 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-200"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Modal: crear persona */}
      {showCreate && (
        <div className="fixed inset-0 bg-noche/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-tinta rounded-3xl border border-pizarra p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-marfil">Nueva persona</h2>
              <button onClick={() => { setShowCreate(false); setError(null); }} className="text-lavanda-archivo hover:text-marfil">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">
                  ID interno <span className="text-bruma">*</span>
                </label>
                <input
                  type="text"
                  value={newPersonId}
                  onChange={e => setNewPersonId(e.target.value)}
                  placeholder="ester, carlos99, sara_g..."
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                  autoFocus
                />
                <p className="text-xs text-lavanda-archivo mt-1">Sólo letras, números, _ y -. Es lo que usa el sistema internamente.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Nombre a mostrar</label>
                <input
                  type="text"
                  value={newDisplayName}
                  onChange={e => setNewDisplayName(e.target.value)}
                  placeholder="Ester García"
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Aliases (separados por coma)</label>
                <input
                  type="text"
                  value={newAliases}
                  onChange={e => setNewAliases(e.target.value)}
                  placeholder="Ester, Esti"
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                />
                <p className="text-xs text-lavanda-archivo mt-1">Otros nombres con los que se le conoce. Ayuda al LLM en búsquedas.</p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => { setShowCreate(false); setError(null); }}
                className="px-4 py-2 text-lavanda-archivo hover:text-marfil"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreate}
                className="px-4 py-2 bg-lavanda text-white rounded-full hover:bg-lavanda-claro font-medium"
              >
                Crear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Layout principal: lista + detalle */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Lista de personas */}
        <div className="lg:col-span-1">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-lavanda-archivo">
              <RefreshCw className="w-6 h-6 animate-spin mr-2" />
              Cargando...
            </div>
          ) : persons.length === 0 ? (
            <div className="bg-tinta rounded-3xl border border-pizarra p-8 text-center">
              <User className="w-12 h-12 text-lavanda-archivo mx-auto mb-3" />
              <p className="text-marfil font-medium mb-1">Sin personas todavía</p>
              <p className="text-sm text-lavanda-archivo">Pulsa "Añadir persona" para empezar tu registry.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {persons.map(person => (
                <button
                  key={person.person_id}
                  onClick={() => setSelectedPerson(person)}
                  className={`w-full text-left p-3 rounded-2xl border transition-colors flex items-center gap-3 ${
                    selectedPerson?.person_id === person.person_id
                      ? 'bg-lavanda/10 border-lavanda'
                      : 'bg-tinta border-pizarra hover:border-lavanda-archivo'
                  }`}
                >
                  <div className="w-10 h-10 rounded-full bg-pizarra overflow-hidden flex-shrink-0 flex items-center justify-center">
                    {avatarSrc(person) ? (
                      <img src={avatarSrc(person)!} alt={person.display_name} className="w-full h-full object-cover" />
                    ) : (
                      <User className="w-5 h-5 text-lavanda-archivo" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-marfil font-medium truncate">{person.display_name}</p>
                    <p className="text-xs text-lavanda-archivo truncate font-mono">{person.person_id}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Detalle de persona seleccionada */}
        <div className="lg:col-span-2">
          {selectedPerson ? (
            <div className="bg-tinta rounded-3xl border border-pizarra p-6">
              <div className="flex items-start justify-between mb-6">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-pizarra overflow-hidden flex items-center justify-center">
                    {avatarSrc(selectedPerson) ? (
                      <img src={avatarSrc(selectedPerson)!} alt={selectedPerson.display_name} className="w-full h-full object-cover" />
                    ) : (
                      <User className="w-7 h-7 text-lavanda-archivo" />
                    )}
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-marfil">{selectedPerson.display_name}</h2>
                    <p className="text-sm text-lavanda-archivo font-mono">{selectedPerson.person_id}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(selectedPerson)}
                  className="p-2 rounded-lg bg-pizarra text-red-300 hover:bg-red-500/20 transition-colors"
                  title="Eliminar persona"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Aliases editables */}
              <div className="mb-6">
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Aliases (separados por coma)</label>
                <AliasesEditor
                  initialAliases={selectedPerson.aliases}
                  onSave={(aliases) => handleUpdateAliases(selectedPerson, aliases)}
                />
              </div>

              {/* Fotos de referencia */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-marfil">Fotos de referencia</h3>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-lavanda text-white rounded-full hover:bg-lavanda-claro"
                  >
                    <ImagePlus className="w-3.5 h-3.5" />
                    Subir foto
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => handleUploadPhoto(selectedPerson.person_id, e.target.files)}
                  />
                </div>
                {photos.length === 0 ? (
                  <div className="p-6 border-2 border-dashed border-pizarra rounded-2xl text-center">
                    <Upload className="w-8 h-8 text-lavanda-archivo mx-auto mb-2" />
                    <p className="text-sm text-lavanda-archivo">
                      Sube fotos donde aparezca esta persona. Recomendado: 5-10 fotos con caras claras, distintos ángulos e iluminación.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                    {photos.map(photo => {
                      const isAvatar = selectedPerson.avatar_path?.endsWith(photo.filename);
                      return (
                        <div key={photo.filename} className="relative group rounded-2xl overflow-hidden bg-pizarra aspect-square">
                          <img src={photoSrc(photo)} alt={photo.filename} className="w-full h-full object-cover" />
                          {isAvatar && (
                            <div className="absolute top-2 left-2 bg-lavanda text-white text-xs px-2 py-0.5 rounded-full flex items-center gap-1">
                              <Star className="w-3 h-3 fill-current" />
                              Avatar
                            </div>
                          )}
                          <div className="absolute inset-0 bg-noche/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                            {!isAvatar && (
                              <button
                                onClick={() => handleSetAvatar(selectedPerson.person_id, photo.filename)}
                                className="p-2 bg-lavanda text-white rounded-full hover:bg-lavanda-claro"
                                title="Marcar como avatar"
                              >
                                <Star className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => handleDeletePhoto(selectedPerson.person_id, photo.filename)}
                              className="p-2 bg-red-500/80 text-white rounded-full hover:bg-red-500"
                              title="Eliminar foto"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-tinta rounded-3xl border border-pizarra p-12 text-center">
              <User className="w-12 h-12 text-lavanda-archivo mx-auto mb-3" />
              <p className="text-marfil font-medium mb-1">Selecciona una persona</p>
              <p className="text-sm text-lavanda-archivo">O añade una nueva con el botón de arriba a la derecha.</p>
            </div>
          )}
        </div>
      </div>

      {/* Nota informativa */}
      <div className="mt-8 p-4 bg-pizarra/50 border border-pizarra rounded-2xl">
        <h4 className="text-sm font-medium text-marfil mb-1">Próximamente: reconocimiento automático</h4>
        <p className="text-xs text-lavanda-archivo">
          Estas fotos serán la base para que Pensadero identifique automáticamente a cada persona cuando escanees nuevo material.
          Por ahora se usan como referencia visual y el sistema sabe quién es quién en las búsquedas en lenguaje natural.
        </p>
      </div>
    </div>
  );
}

/**
 * Mini-componente para editar aliases en línea con guardado al pulsar Enter
 * o al desfocar. Mantiene su propio estado intermedio para no spamear API.
 */
function AliasesEditor({ initialAliases, onSave }: { initialAliases: string[]; onSave: (aliases: string[]) => void }) {
  const [value, setValue] = useState(initialAliases.join(', '));
  const initial = useRef(initialAliases.join(', '));

  useEffect(() => {
    const joined = initialAliases.join(', ');
    if (joined !== initial.current) {
      setValue(joined);
      initial.current = joined;
    }
  }, [initialAliases]);

  const save = () => {
    const aliases = value.split(',').map(a => a.trim()).filter(Boolean);
    if (aliases.join(',') !== initialAliases.join(',')) {
      onSave(aliases);
    }
  };

  return (
    <input
      type="text"
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
      placeholder="Ester, Esti, mi prima"
      className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda text-sm"
    />
  );
}
