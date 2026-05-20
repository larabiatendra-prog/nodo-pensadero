import React, { useEffect, useState, useRef } from 'react';
import { Plus, X, Wand2 } from 'lucide-react';
import { api } from '../services/api';

/**
 * RulesEditor — editor de reglas para Smart Folders.
 *
 * Cada regla se basa en una "definicion" predefinida (ver FIELD_DEFINITIONS)
 * que abstrae los detalles tecnicos (field path, operador, tipo de input)
 * y presenta al usuario un dropdown amigable en español.
 *
 * Estado interno: array de RuleRow (defId + value).
 * Output al padre: array de reglas canonicas {field, op, value} via onChange.
 *
 * Preview en vivo: cada cambio dispara un POST /api/collections/preview-rules
 * con debounce de 400ms y muestra "N archivos coinciden".
 */

export type CanonicalRule = { field: string; op: string; value: any };
export type Combinator = 'AND' | 'OR';

interface RulesEditorProps {
  rules: CanonicalRule[];
  combinator: Combinator;
  onChange: (rules: CanonicalRule[], combinator: Combinator) => void;
}

// ============================================
// Definiciones de campos disponibles
// ============================================

type InputKind = 'enum' | 'text' | 'color' | 'date' | 'none' | 'person' | 'space';

interface FieldDef {
  id: string;
  label: string;
  group: 'Tipo' | 'Contenido' | 'Composicion' | 'Atmosfera' | 'Color' | 'Fecha' | 'Estado';
  field: string;
  op: string;
  input: {
    kind: InputKind;
    options?: { value: string; label: string }[];
    placeholder?: string;
  };
}

const FIELD_DEFINITIONS: FieldDef[] = [
  // Tipo
  {
    id: 'type', label: 'Tipo de archivo', group: 'Tipo', field: 'type', op: 'eq',
    input: {
      kind: 'enum',
      options: [
        { value: 'image', label: 'Foto' },
        { value: 'video', label: 'Vídeo' },
        { value: 'audio', label: 'Audio' },
        { value: 'export', label: 'Export' },
      ],
    },
  },

  // Contenido
  { id: 'tag', label: 'Etiqueta contiene', group: 'Contenido', field: 'tags', op: 'contains', input: { kind: 'text', placeholder: 'salto, marina...' } },
  { id: 'person', label: 'Persona aparece', group: 'Contenido', field: '', op: 'has_person', input: { kind: 'person' } },
  { id: 'space', label: 'Espacio aparece', group: 'Contenido', field: '', op: 'has_space', input: { kind: 'space' } },
  { id: 'description', label: 'Descripción contiene', group: 'Contenido', field: 'visual_description', op: 'contains', input: { kind: 'text', placeholder: 'palabra a buscar' } },

  // Composicion
  {
    id: 'shot_type', label: 'Tipo de plano', group: 'Composicion', field: 'composition.shot_type', op: 'eq',
    input: {
      kind: 'enum',
      options: [
        { value: 'plano_general', label: 'Plano general' },
        { value: 'plano_conjunto', label: 'Plano conjunto' },
        { value: 'plano_americano', label: 'Plano americano' },
        { value: 'plano_medio', label: 'Plano medio' },
        { value: 'plano_medio_corto', label: 'Plano medio corto' },
        { value: 'primer_plano', label: 'Primer plano' },
        { value: 'plano_detalle', label: 'Plano detalle' },
      ],
    },
  },
  {
    id: 'camera_angle', label: 'Ángulo de cámara', group: 'Composicion', field: 'composition.camera_angle', op: 'eq',
    input: {
      kind: 'enum',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'picado', label: 'Picado' },
        { value: 'contrapicado', label: 'Contrapicado' },
        { value: 'cenital', label: 'Cenital' },
        { value: 'nadir', label: 'Nadir' },
      ],
    },
  },
  {
    id: 'camera_movement', label: 'Movimiento de cámara', group: 'Composicion', field: 'composition.camera_movement', op: 'eq',
    input: {
      kind: 'enum',
      options: [
        { value: 'fijo', label: 'Fijo' },
        { value: 'panoramica', label: 'Panorámica' },
        { value: 'travelling', label: 'Travelling' },
        { value: 'dolly', label: 'Dolly' },
        { value: 'zoom_in', label: 'Zoom in' },
        { value: 'zoom_out', label: 'Zoom out' },
        { value: 'handheld', label: 'Cámara en mano' },
        { value: 'steady', label: 'Steadicam' },
      ],
    },
  },
  {
    id: 'people_framing', label: 'Encuadre de personas', group: 'Composicion', field: 'composition.people_framing', op: 'eq',
    input: {
      kind: 'enum',
      options: [
        { value: 'ninguno', label: 'Sin personas' },
        { value: 'individual', label: 'Individual' },
        { value: 'pareja', label: 'Pareja' },
        { value: 'grupo', label: 'Grupo' },
        { value: 'multitud', label: 'Multitud' },
      ],
    },
  },

  // Atmosfera
  {
    id: 'mood', label: 'Ambiente', group: 'Atmosfera', field: 'atmosphere.mood', op: 'eq',
    input: {
      kind: 'enum',
      options: [
        { value: 'alegre', label: 'Alegre' },
        { value: 'neutro', label: 'Neutro' },
        { value: 'serio', label: 'Serio' },
        { value: 'intimo', label: 'Íntimo' },
        { value: 'festivo', label: 'Festivo' },
        { value: 'melancolico', label: 'Melancólico' },
        { value: 'energico', label: 'Enérgico' },
        { value: 'formal', label: 'Formal' },
        { value: 'contemplativo', label: 'Contemplativo' },
      ],
    },
  },
  {
    id: 'lighting', label: 'Iluminación', group: 'Atmosfera', field: 'atmosphere.lighting', op: 'eq',
    input: {
      kind: 'enum',
      options: [
        { value: 'luz_natural', label: 'Luz natural' },
        { value: 'luz_dorada', label: 'Luz dorada' },
        { value: 'contraluz', label: 'Contraluz' },
        { value: 'interior', label: 'Interior' },
        { value: 'neon', label: 'Neón' },
        { value: 'nocturna', label: 'Nocturna' },
        { value: 'mixta', label: 'Mixta' },
      ],
    },
  },
  {
    id: 'space_type', label: 'Tipo de espacio', group: 'Atmosfera', field: 'atmosphere.space_type', op: 'eq',
    input: {
      kind: 'enum',
      options: [
        { value: 'interior', label: 'Interior' },
        { value: 'exterior', label: 'Exterior' },
        { value: 'urbano', label: 'Urbano' },
        { value: 'naturaleza', label: 'Naturaleza' },
        { value: 'oficina', label: 'Oficina' },
        { value: 'escenario', label: 'Escenario' },
        { value: 'hogar', label: 'Hogar' },
        { value: 'transito', label: 'En tránsito' },
      ],
    },
  },
  {
    id: 'time_of_day', label: 'Momento del día', group: 'Atmosfera', field: 'atmosphere.time_of_day', op: 'eq',
    input: {
      kind: 'enum',
      options: [
        { value: 'amanecer', label: 'Amanecer' },
        { value: 'manana', label: 'Mañana' },
        { value: 'mediodia', label: 'Mediodía' },
        { value: 'tarde', label: 'Tarde' },
        { value: 'atardecer', label: 'Atardecer' },
        { value: 'noche', label: 'Noche' },
      ],
    },
  },
  {
    id: 'style', label: 'Estilo', group: 'Atmosfera', field: 'atmosphere.style', op: 'eq',
    input: {
      kind: 'enum',
      options: [
        { value: 'documental', label: 'Documental' },
        { value: 'retrato', label: 'Retrato' },
        { value: 'paisaje', label: 'Paisaje' },
        { value: 'accion', label: 'Acción' },
        { value: 'producto', label: 'Producto' },
        { value: 'ambiente', label: 'Ambiente' },
        { value: 'abstracto', label: 'Abstracto' },
      ],
    },
  },

  // Color
  { id: 'color', label: 'Color similar a', group: 'Color', field: '', op: 'color_similar', input: { kind: 'color' } },

  // Fecha
  { id: 'date_from', label: 'Fecha desde', group: 'Fecha', field: 'createdAt', op: 'gte', input: { kind: 'date' } },
  { id: 'date_to', label: 'Fecha hasta', group: 'Fecha', field: 'createdAt', op: 'lte', input: { kind: 'date' } },

  // Estado
  { id: 'is_favorite', label: 'Es favorito', group: 'Estado', field: 'isFavorite', op: 'is_true', input: { kind: 'none' } },
];

const FIELD_GROUPS = ['Tipo', 'Contenido', 'Composicion', 'Atmosfera', 'Color', 'Fecha', 'Estado'] as const;

// Mapa interno: row del UI → regla canonica
interface RuleRow {
  defId: string;
  value: any;
}

// Reverse: dada una regla canonica, encuentra su def y value
function ruleToRow(rule: CanonicalRule): RuleRow | null {
  const def = FIELD_DEFINITIONS.find(d => d.field === rule.field && d.op === rule.op);
  if (!def) return null;
  return { defId: def.id, value: rule.value };
}

function rowToRule(row: RuleRow): CanonicalRule | null {
  const def = FIELD_DEFINITIONS.find(d => d.id === row.defId);
  if (!def) return null;
  return { field: def.field, op: def.op, value: row.value };
}

interface Person {
  person_id: string;
  display_name: string;
}

interface Space {
  space_id: string;
  display_name: string;
}

export default function RulesEditor({ rules, combinator, onChange }: RulesEditorProps) {
  // Convertir reglas externas en filas
  const [rows, setRows] = useState<RuleRow[]>(() =>
    rules.map(r => ruleToRow(r)).filter((x): x is RuleRow => x !== null)
  );
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [totalFiles, setTotalFiles] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [persons, setPersons] = useState<Person[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Cargar listas de personas y espacios para los dropdowns
  useEffect(() => {
    api.listPersonsRegistry().then((r: any) => {
      if (r.success && Array.isArray(r.data)) setPersons(r.data);
    }).catch(() => {});
    api.listSpacesRegistry().then((r: any) => {
      if (r.success && Array.isArray(r.data)) setSpaces(r.data);
    }).catch(() => {});
  }, []);

  // Propagar al padre cuando cambian las filas
  function pushChange(newRows: RuleRow[], newCombinator?: Combinator) {
    const canonical = newRows
      .map(r => rowToRule(r))
      .filter((x): x is CanonicalRule => x !== null && x.value !== '' && x.value !== null && x.value !== undefined);
    onChange(canonical, newCombinator ?? combinator);
  }

  // Preview en vivo con debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const canonical = rows
      .map(r => rowToRule(r))
      .filter((x): x is CanonicalRule => x !== null && x.value !== '' && x.value !== null && x.value !== undefined);
    if (canonical.length === 0) {
      setMatchCount(null);
      setTotalFiles(null);
      return;
    }
    setPreviewing(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r: any = await api.previewCollectionRules(canonical, combinator);
        setMatchCount(r.count);
        setTotalFiles(r.total);
      } catch {
        setMatchCount(null);
      } finally {
        setPreviewing(false);
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [rows, combinator]);

  function addRow(defId: string) {
    const def = FIELD_DEFINITIONS.find(d => d.id === defId);
    if (!def) return;
    let initialValue: any = '';
    if (def.input.kind === 'enum' && def.input.options && def.input.options.length > 0) {
      initialValue = def.input.options[0].value;
    } else if (def.input.kind === 'person' && persons.length > 0) {
      initialValue = persons[0].person_id;
    } else if (def.input.kind === 'space' && spaces.length > 0) {
      initialValue = spaces[0].space_id;
    } else if (def.input.kind === 'color') {
      initialValue = { hex: '#ff6600', threshold: 25 };
    } else if (def.input.kind === 'none') {
      initialValue = true;
    }
    const newRows = [...rows, { defId, value: initialValue }];
    setRows(newRows);
    pushChange(newRows);
  }

  function updateRow(idx: number, value: any) {
    const newRows = rows.map((r, i) => i === idx ? { ...r, value } : r);
    setRows(newRows);
    pushChange(newRows);
  }

  function removeRow(idx: number) {
    const newRows = rows.filter((_, i) => i !== idx);
    setRows(newRows);
    pushChange(newRows);
  }

  function changeCombinator(c: Combinator) {
    pushChange(rows, c);
  }

  return (
    <div className="space-y-3">
      {/* Combinator */}
      <div className="flex items-center gap-3 text-sm">
        <span className="text-lavanda-archivo">Cumplir</span>
        <div className="flex items-center bg-pizarra rounded-full p-0.5">
          <button
            onClick={() => changeCombinator('AND')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              combinator === 'AND' ? 'bg-lavanda text-white' : 'text-lavanda-archivo hover:text-marfil'
            }`}
          >
            Todas las reglas
          </button>
          <button
            onClick={() => changeCombinator('OR')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              combinator === 'OR' ? 'bg-lavanda text-white' : 'text-lavanda-archivo hover:text-marfil'
            }`}
          >
            Alguna regla
          </button>
        </div>
      </div>

      {/* Lista de reglas */}
      {rows.length === 0 ? (
        <div className="p-4 bg-pizarra/40 border border-dashed border-pizarra rounded-2xl text-center text-sm text-lavanda-archivo">
          Añade al menos una regla para definir qué archivos entran en esta Smart Folder.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row, idx) => {
            const def = FIELD_DEFINITIONS.find(d => d.id === row.defId);
            if (!def) return null;
            return (
              <div key={idx} className="flex items-center gap-2 p-2 bg-pizarra/40 rounded-xl">
                <span className="flex-shrink-0 text-xs text-lavanda-archivo whitespace-nowrap">{def.label}:</span>
                <div className="flex-1 min-w-0">
                  {def.input.kind === 'enum' && (
                    <select
                      value={row.value}
                      onChange={e => updateRow(idx, e.target.value)}
                      className="w-full px-2 py-1 bg-grafito border border-pizarra rounded-lg text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
                    >
                      {def.input.options!.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  )}
                  {def.input.kind === 'text' && (
                    <input
                      type="text"
                      value={row.value || ''}
                      onChange={e => updateRow(idx, e.target.value)}
                      placeholder={def.input.placeholder}
                      className="w-full px-2 py-1 bg-grafito border border-pizarra rounded-lg text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
                    />
                  )}
                  {def.input.kind === 'date' && (
                    <input
                      type="date"
                      value={row.value || ''}
                      onChange={e => updateRow(idx, e.target.value)}
                      className="w-full px-2 py-1 bg-grafito border border-pizarra rounded-lg text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
                    />
                  )}
                  {def.input.kind === 'person' && (
                    <select
                      value={row.value || ''}
                      onChange={e => updateRow(idx, e.target.value)}
                      className="w-full px-2 py-1 bg-grafito border border-pizarra rounded-lg text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
                    >
                      {persons.length === 0 && <option value="">(sin personas registradas)</option>}
                      {persons.map(p => (
                        <option key={p.person_id} value={p.person_id}>{p.display_name}</option>
                      ))}
                    </select>
                  )}
                  {def.input.kind === 'space' && (
                    <select
                      value={row.value || ''}
                      onChange={e => updateRow(idx, e.target.value)}
                      className="w-full px-2 py-1 bg-grafito border border-pizarra rounded-lg text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
                    >
                      {spaces.length === 0 && <option value="">(sin espacios registrados)</option>}
                      {spaces.map(s => (
                        <option key={s.space_id} value={s.space_id}>{s.display_name}</option>
                      ))}
                    </select>
                  )}
                  {def.input.kind === 'color' && (
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={row.value?.hex || '#ff6600'}
                        onChange={e => updateRow(idx, { ...row.value, hex: e.target.value })}
                        className="w-9 h-7 rounded cursor-pointer border border-pizarra"
                      />
                      <span className="font-mono text-xs text-marfil">{row.value?.hex || '#ff6600'}</span>
                      <span className="text-xs text-lavanda-archivo ml-2">tolerancia</span>
                      <input
                        type="range"
                        min={5}
                        max={60}
                        value={row.value?.threshold ?? 25}
                        onChange={e => updateRow(idx, { ...row.value, threshold: parseInt(e.target.value, 10) })}
                        className="flex-1 accent-lavanda min-w-0"
                      />
                      <span className="font-mono text-xs text-marfil w-5 text-right">{row.value?.threshold ?? 25}</span>
                    </div>
                  )}
                  {def.input.kind === 'none' && (
                    <span className="text-xs text-lavanda-archivo italic">(sin valor extra)</span>
                  )}
                </div>
                <button
                  onClick={() => removeRow(idx)}
                  className="p-1.5 text-lavanda-archivo hover:text-red-400 hover:bg-pizarra rounded-lg flex-shrink-0"
                  title="Quitar regla"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Selector de "Añadir regla" */}
      <div>
        <label className="block text-xs text-lavanda-archivo mb-1">Añadir regla</label>
        <select
          value=""
          onChange={e => { if (e.target.value) { addRow(e.target.value); e.target.value = ''; } }}
          className="w-full px-3 py-2 bg-pizarra border border-grafito rounded-2xl text-sm text-marfil focus:outline-none focus:ring-1 focus:ring-lavanda"
        >
          <option value="">— Selecciona un criterio —</option>
          {FIELD_GROUPS.map(group => (
            <optgroup key={group} label={group}>
              {FIELD_DEFINITIONS.filter(d => d.group === group).map(d => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Preview en vivo */}
      <div className="p-3 bg-lavanda/10 border border-lavanda/30 rounded-2xl flex items-center gap-2 text-sm">
        <Wand2 className="w-4 h-4 text-lavanda flex-shrink-0" />
        {rows.length === 0 ? (
          <span className="text-lavanda-archivo">Sin reglas todavia.</span>
        ) : previewing ? (
          <span className="text-lavanda-archivo">Evaluando reglas...</span>
        ) : matchCount === null ? (
          <span className="text-lavanda-archivo">Define algun valor en las reglas.</span>
        ) : (
          <span className="text-marfil">
            <span className="font-semibold">{matchCount}</span>{' '}
            <span className="text-lavanda-archivo">
              {matchCount === 1 ? 'archivo coincide' : 'archivos coinciden'} con estas reglas
              {totalFiles != null && ` (de ${totalFiles} totales)`}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
