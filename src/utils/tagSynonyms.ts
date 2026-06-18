// Grupos de sinónimos para Smart Tag Matching.
//
// Cada grupo agrupa términos equivalentes entre sí (bidireccional): si el
// usuario escribe CUALQUIERA de los términos, se le sugieren los OTROS del
// grupo que existan como etiqueta real en la biblioteca. La comparación es
// insensible a mayúsculas/minúsculas y tildes (ver normalizeText), pero NO a
// plurales ni a variantes de palabra: por eso cada grupo incluye, junto a los
// términos coloquiales que el usuario podría teclear, la grafía EXACTA de la
// etiqueta real a la que queremos puentear.
//
// Calibrado al vocabulario real de la biblioteca (archivo EDEM / MdE: eventos,
// formaciones, instalaciones, premios…), no a sinónimos genéricos. Los términos
// coloquiales que no existen como etiqueta solo sirven de disparador; nunca se
// sugieren (findSynonymSuggestions filtra por etiquetas reales).
//
// Cómo ampliar:
//   - Añadir un término a un grupo existente -> push al array.
//   - Crear un nuevo grupo de equivalencias -> añadir un array nuevo.
//   - Para puentear hacia una etiqueta nueva, incluir su grafía EXACTA en el grupo.
export const TAG_SYNONYM_GROUPS: string[][] = [
  // ── Espacios / instalaciones ───────────────────────────────────────────
  ['auditorio', 'sala', 'salón de actos', 'salon de actos', 'Auditorio', 'Sala de Formación'],
  ['aula', 'clase', 'curso', 'formación', 'taller', 'Aula', 'Sala de Formación', 'Recursos Clase'],
  ['oficina', 'despacho', 'puesto', 'escritorio', 'Oficina', 'Escritorio', 'Mesa', 'Silla oficina'],
  ['edificio', 'instalaciones', 'fachada', 'obra', 'Instalaciones', 'Fachada', 'Construcción', 'Nuevo Edificio'],
  ['pasillo', 'hall', 'recibidor', 'vestíbulo', 'Pasillo', 'Hall'],
  ['jardín', 'jardin', 'exterior', 'patio', 'Jardín'],

  // ── Eventos / actos ────────────────────────────────────────────────────
  ['evento', 'eventos', 'acto', 'jornada', 'Eventos', 'Eventos & Formaciones', 'Acto'],
  ['conferencia', 'charla', 'ponencia', 'presentacion', 'Presentación'],
  ['graduación', 'graduacion', 'entrega de títulos', 'clausura', 'Graduación'],
  ['premio', 'premios', 'galardón', 'entrega de premios', 'Entrega Premios'],
  ['bienvenida', 'recepción', 'acogida', 'Bienvenida', 'Jornada de Bienvenida'],
  ['networking', 'encuentro', 'reunión', 'reunion', 'reencuentro', 'Networking', 'Encuentro', 'Reencuentro'],
  ['competición', 'competicion', 'reto', 'challenge', 'concurso', 'Competición', 'Business Challenge', 'Robotics Challenge'],
  ['visita', 'tour', 'recorrido', 'Visita'],

  // ── Tomas / recurso visual ─────────────────────────────────────────────
  ['dron', 'drone', 'aéreo', 'aereo', 'vista aérea', 'cenital', 'Dron', 'Aereo'],
];
