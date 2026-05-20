import React, { useEffect, useState } from 'react';
import { Languages, Sparkles, Plus, Trash2, Check, X, ArrowLeft, Edit3, RefreshCw, AlertCircle } from 'lucide-react';
import { api } from '../services/api';

/**
 * SynonymsManager — pantalla de revision de sinonimos (alias table).
 *
 * Flujo de uso:
 *   1) Ver grupos actuales (canonical + aliases)
 *   2) Crear/editar grupos manualmente
 *   3) Pulsar "Sugerir con IA" → el LLM agrupa los tags del corpus y propone
 *      grupos nuevos; el usuario ✓ acepta / ✗ rechaza / ✎ edita cada uno
 *   4) Los aceptados se persisten via /api/tags/aliases/upsert
 *
 * Las decisiones tomadas en esta pantalla afectan a la busqueda Stage 1:
 * cuando buscas "salto", el sistema tambien encuentra "saltar", "brincar", etc.
 */

interface Group {
  canonical: string;
  aliases: string[];
}

interface SynonymsManagerProps {
  onBack?: () => void;
}

export default function SynonymsManager({ onBack }: SynonymsManagerProps) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [corpusTagsCount, setCorpusTagsCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [proposing, setProposing] = useState(false);
  const [proposals, setProposals] = useState<Group[] | null>(null);
  const [proposalEdits, setProposalEdits] = useState<Record<number, Group>>({});
  const [error, setError] = useState<string | null>(null);

  // Modal de creacion/edicion manual
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [formCanonical, setFormCanonical] = useState('');
  const [formAliases, setFormAliases] = useState('');

  useEffect(() => {
    refreshAll();
  }, []);

  async function refreshAll() {
    setLoading(true);
    setError(null);
    try {
      const [groupsRes, tagsRes]: [any, any] = await Promise.all([
        api.getAliasGroups(),
        api.getAllCorpusTags(),
      ]);
      if (groupsRes.success && Array.isArray(groupsRes.data)) setGroups(groupsRes.data);
      if (tagsRes.success && typeof tagsRes.count === 'number') setCorpusTagsCount(tagsRes.count);
    } catch (err: any) {
      setError(err.message || 'Error cargando');
    } finally {
      setLoading(false);
    }
  }

  async function handlePropose() {
    setProposing(true);
    setError(null);
    setProposals(null);
    setProposalEdits({});
    try {
      const r: any = await api.proposeAliases();
      if (!r.success) throw new Error(r.error || 'Error proponiendo');
      setProposals(Array.isArray(r.data) ? r.data : []);
    } catch (err: any) {
      setError(err.message || 'Error proponiendo sinonimos. ¿Ollama disponible?');
    } finally {
      setProposing(false);
    }
  }

  async function handleAcceptProposal(idx: number) {
    const g = proposalEdits[idx] || proposals![idx];
    try {
      const r: any = await api.upsertAliasGroup(g);
      if (!r.success) throw new Error(r.error || 'Error guardando');
      if (Array.isArray(r.data)) setGroups(r.data);
      // Quitar la propuesta aceptada de la lista
      setProposals(prev => prev ? prev.filter((_, i) => i !== idx) : prev);
      setProposalEdits(prev => {
        const next = { ...prev };
        delete next[idx];
        return next;
      });
    } catch (err: any) {
      setError(err.message || 'Error aceptando propuesta');
    }
  }

  function handleRejectProposal(idx: number) {
    setProposals(prev => prev ? prev.filter((_, i) => i !== idx) : prev);
    setProposalEdits(prev => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  }

  function startEditProposal(idx: number) {
    const cur = proposalEdits[idx] || proposals![idx];
    setProposalEdits(prev => ({ ...prev, [idx]: { ...cur, aliases: [...cur.aliases] } }));
  }

  function updateProposalCanonical(idx: number, val: string) {
    const cur = proposalEdits[idx] || proposals![idx];
    setProposalEdits(prev => ({ ...prev, [idx]: { ...cur, canonical: val } }));
  }

  function updateProposalAliases(idx: number, val: string) {
    const aliases = val.split(',').map(a => a.trim()).filter(Boolean);
    const cur = proposalEdits[idx] || proposals![idx];
    setProposalEdits(prev => ({ ...prev, [idx]: { ...cur, aliases } }));
  }

  async function handleAcceptAll() {
    if (!proposals || proposals.length === 0) return;
    if (!confirm(`¿Aceptar las ${proposals.length} sugerencias del LLM tal como están?`)) return;
    setError(null);
    try {
      for (let i = 0; i < proposals.length; i++) {
        const g = proposalEdits[i] || proposals[i];
        await api.upsertAliasGroup(g);
      }
      await refreshAll();
      setProposals([]);
      setProposalEdits({});
    } catch (err: any) {
      setError(err.message || 'Error en acept-todo');
    }
  }

  function startCreate() {
    setFormCanonical('');
    setFormAliases('');
    setEditingIndex(null);
    setCreating(true);
  }

  function startEditGroup(idx: number) {
    const g = groups[idx];
    setFormCanonical(g.canonical);
    setFormAliases(g.aliases.join(', '));
    setEditingIndex(idx);
    setCreating(true);
  }

  async function handleSaveManual() {
    const canonical = formCanonical.trim();
    if (!canonical) {
      setError('Falta el termino canonico');
      return;
    }
    const aliases = formAliases.split(',').map(a => a.trim()).filter(a => a && a !== canonical);
    try {
      if (editingIndex !== null) {
        // Edicion: el endpoint upsert no permite cambiar el canonical preservando el original.
        // Si el canonical cambia, borramos el antiguo y creamos el nuevo.
        const oldCanonical = groups[editingIndex].canonical;
        if (oldCanonical !== canonical) {
          await api.deleteAliasGroup(oldCanonical);
        }
      }
      const r: any = await api.upsertAliasGroup({ canonical, aliases });
      if (!r.success) throw new Error(r.error || 'Error guardando');
      if (Array.isArray(r.data)) setGroups(r.data);
      setCreating(false);
    } catch (err: any) {
      setError(err.message || 'Error guardando');
    }
  }

  async function handleDeleteGroup(canonical: string) {
    if (!confirm(`¿Eliminar el grupo "${canonical}"?`)) return;
    try {
      const r: any = await api.deleteAliasGroup(canonical);
      if (Array.isArray(r.data)) setGroups(r.data);
    } catch (err: any) {
      setError(err.message || 'Error eliminando');
    }
  }

  // Estadisticas
  const tagsCovered = groups.reduce((sum, g) => sum + 1 + g.aliases.length, 0);

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
          <h1 className="text-2xl font-bold text-marfil mb-2 flex items-center gap-3">
            <Languages className="w-7 h-7 text-lavanda" />
            Sinonimos
          </h1>
          <p className="text-lavanda-archivo">
            Agrupa palabras parecidas (saltar/salto/brincar) para que la busqueda las encuentre como si fueran la misma. Stage 1 expande las queries automaticamente usando estos grupos.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={handlePropose}
            disabled={proposing}
            className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${
              proposing
                ? 'bg-lavanda/20 text-lavanda cursor-wait'
                : 'bg-pizarra text-lavanda hover:bg-lavanda hover:text-white'
            }`}
            title="Pedir al LLM que agrupe los tags del corpus por significado"
          >
            <Sparkles className={`w-4 h-4 ${proposing ? 'animate-pulse' : ''}`} />
            {proposing ? 'Pensando...' : 'Sugerir con IA'}
          </button>
          <button
            onClick={startCreate}
            className="flex items-center gap-2 px-4 py-2 bg-lavanda text-white rounded-full hover:bg-lavanda-claro transition-colors font-medium"
          >
            <Plus className="w-4 h-4" />
            Nuevo grupo
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-pizarra border border-red-400/30 rounded-2xl text-sm text-red-300 flex items-start justify-between gap-3">
          <span className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            {error}
          </span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-200"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Banner de estadisticas */}
      <div className="mb-6 p-4 bg-pizarra rounded-2xl flex items-center gap-4 text-sm flex-wrap">
        <span className="text-marfil font-medium">{groups.length}</span>
        <span className="text-lavanda-archivo">{groups.length === 1 ? 'grupo definido' : 'grupos definidos'}</span>
        <span className="text-bruma">·</span>
        <span className="text-marfil font-medium">{tagsCovered}</span>
        <span className="text-lavanda-archivo">palabras cubiertas</span>
        <span className="text-bruma">·</span>
        <span className="text-marfil font-medium">{corpusTagsCount}</span>
        <span className="text-lavanda-archivo">tags unicos en la biblioteca</span>
      </div>

      {/* Propuestas del LLM */}
      {proposals !== null && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-marfil flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-lavanda" />
              Sugerencias del LLM
              <span className="text-sm font-normal text-lavanda-archivo">({proposals.length})</span>
            </h2>
            {proposals.length > 0 && (
              <button
                onClick={handleAcceptAll}
                className="text-xs px-3 py-1.5 bg-lavanda text-white rounded-full hover:bg-lavanda-claro"
              >
                Aceptar todas
              </button>
            )}
          </div>
          {proposals.length === 0 ? (
            <div className="bg-tinta border border-pizarra rounded-2xl p-6 text-center text-sm text-lavanda-archivo">
              El LLM no encontro mas agrupaciones validas en el corpus actual. Si añades mas archivos y tags, vuelve a pulsar "Sugerir con IA".
            </div>
          ) : (
            <div className="space-y-2">
              {proposals.map((p, idx) => {
                const edited = proposalEdits[idx];
                const editing = !!edited;
                const cur = edited || p;
                return (
                  <div key={`${p.canonical}_${idx}`} className="bg-tinta border border-lavanda/30 rounded-2xl p-4">
                    <div className="flex items-start gap-4">
                      <div className="flex-1 min-w-0">
                        {editing ? (
                          <>
                            <label className="block text-xs text-lavanda-archivo mb-1">Termino canonico</label>
                            <input
                              type="text"
                              value={cur.canonical}
                              onChange={e => updateProposalCanonical(idx, e.target.value)}
                              className="w-full mb-2 px-3 py-1.5 bg-pizarra border border-grafito rounded-xl text-marfil text-sm focus:outline-none focus:ring-1 focus:ring-lavanda"
                            />
                            <label className="block text-xs text-lavanda-archivo mb-1">Sinonimos (coma)</label>
                            <input
                              type="text"
                              value={cur.aliases.join(', ')}
                              onChange={e => updateProposalAliases(idx, e.target.value)}
                              className="w-full px-3 py-1.5 bg-pizarra border border-grafito rounded-xl text-marfil text-sm focus:outline-none focus:ring-1 focus:ring-lavanda"
                            />
                          </>
                        ) : (
                          <>
                            <p className="text-marfil font-semibold mb-2">{cur.canonical}</p>
                            <div className="flex flex-wrap gap-1.5">
                              {cur.aliases.map(a => (
                                <span key={a} className="px-2 py-0.5 text-xs bg-pizarra text-lavanda rounded-full">
                                  {a}
                                </span>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => handleAcceptProposal(idx)}
                          className="p-2 bg-lavanda/20 text-lavanda hover:bg-lavanda hover:text-white rounded-lg transition-colors"
                          title="Aceptar este grupo"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => editing ? setProposalEdits(prev => { const n = { ...prev }; delete n[idx]; return n; }) : startEditProposal(idx)}
                          className="p-2 bg-pizarra text-bruma hover:bg-bruma hover:text-noche rounded-lg transition-colors"
                          title={editing ? 'Cancelar edicion' : 'Editar antes de aceptar'}
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleRejectProposal(idx)}
                          className="p-2 bg-pizarra text-red-300 hover:bg-red-500/20 rounded-lg transition-colors"
                          title="Rechazar"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Modal de creacion/edicion manual */}
      {creating && (
        <div className="fixed inset-0 bg-noche/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-tinta rounded-3xl border border-pizarra p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-marfil">
                {editingIndex !== null ? 'Editar grupo' : 'Nuevo grupo de sinonimos'}
              </h2>
              <button onClick={() => { setCreating(false); setError(null); }} className="text-lavanda-archivo hover:text-marfil">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Termino canonico</label>
                <input
                  type="text"
                  value={formCanonical}
                  onChange={e => setFormCanonical(e.target.value)}
                  placeholder="saltar"
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                  autoFocus
                />
                <p className="text-xs text-lavanda-archivo mt-1">La forma "principal" del grupo. Cuando buscas, expande a todos los sinonimos.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-lavanda-archivo mb-1">Sinonimos</label>
                <input
                  type="text"
                  value={formAliases}
                  onChange={e => setFormAliases(e.target.value)}
                  placeholder="salto, saltito, brincar, brinco"
                  className="w-full px-3 py-2 bg-pizarra text-marfil border border-grafito rounded-2xl focus:outline-none focus:ring-2 focus:ring-lavanda"
                />
                <p className="text-xs text-lavanda-archivo mt-1">Separados por comas. Sin tildes especificas — la busqueda es insensible.</p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => { setCreating(false); setError(null); }}
                className="px-4 py-2 text-lavanda-archivo hover:text-marfil"
              >
                Cancelar
              </button>
              <button
                onClick={handleSaveManual}
                disabled={!formCanonical.trim()}
                className={`px-4 py-2 rounded-full font-medium ${
                  !formCanonical.trim()
                    ? 'bg-lavanda/30 text-marfil/50 cursor-not-allowed'
                    : 'bg-lavanda text-white hover:bg-lavanda-claro'
                }`}
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lista de grupos definidos */}
      <div>
        <h2 className="text-lg font-semibold text-marfil mb-3">Grupos definidos</h2>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-lavanda-archivo">
            <RefreshCw className="w-6 h-6 animate-spin mr-2" />
            Cargando...
          </div>
        ) : groups.length === 0 ? (
          <div className="bg-tinta rounded-3xl border border-pizarra p-8 text-center">
            <Languages className="w-12 h-12 text-lavanda-archivo mx-auto mb-3" />
            <p className="text-marfil font-medium mb-1">No hay grupos de sinonimos todavia</p>
            <p className="text-sm text-lavanda-archivo">
              Pulsa "Sugerir con IA" para que el LLM revise tu corpus y proponga agrupaciones, o crea un grupo manualmente.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {groups.map((g, idx) => (
              <div key={g.canonical} className="bg-tinta border border-pizarra rounded-2xl p-4 hover:border-lavanda-archivo transition-colors">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-marfil font-semibold mb-2">{g.canonical}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {g.aliases.map(a => (
                        <span key={a} className="px-2 py-0.5 text-xs bg-pizarra text-lavanda rounded-full">
                          {a}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => startEditGroup(idx)}
                      className="p-2 bg-pizarra text-lavanda hover:bg-lavanda hover:text-white rounded-lg transition-colors"
                      title="Editar"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteGroup(g.canonical)}
                      className="p-2 bg-pizarra text-red-300 hover:bg-red-500/20 rounded-lg transition-colors"
                      title="Eliminar grupo"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Nota informativa */}
      <div className="mt-8 p-4 bg-pizarra/50 border border-pizarra rounded-2xl">
        <h4 className="text-sm font-medium text-marfil mb-1">Como funciona</h4>
        <p className="text-xs text-lavanda-archivo">
          Cuando defines un grupo (p. ej. canonical=<span className="font-mono text-bruma">saltar</span>, sinonimos=<span className="font-mono text-bruma">salto, brincar</span>),
          el buscador trata todas las variantes como equivalentes. Buscar "salto" devuelve fotos etiquetadas con "saltar" o "brincar"
          y viceversa. Combina con todos los demas filtros (etiquetas, personas, color, fechas...).
        </p>
      </div>
    </div>
  );
}
