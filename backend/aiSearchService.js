/**
 * AI Search Service — Pensadero
 *
 * Búsqueda en lenguaje natural sobre la biblioteca local. Cada consulta
 * es independiente (sin contexto/iteración). El LLM solo extrae intención
 * y devuelve un JSON estructurado; el filtrado y el scoring son
 * deterministas y locales sobre los `mediaFiles` ya cargados.
 *
 * Contrato del intent (campos snake_case):
 *  - type: "image" | "video" | "audio" | null
 *  - year: number|string|null
 *  - month: "01".."12"|null
 *  - month_name: nombre del mes en español o null
 *  - person_ids: array de person_id resueltos contra el registry
 *  - space_ids: array de space_id (cuando se mencione un lugar)
 *  - tags: array de tags. Scoring (bonus +10 por tag coincidente), NO filtro
 *    estricto. Archivos sin todos los tags siguen apareciendo si encajan por
 *    otros campos; los que matchean más tags ranquean arriba.
 *  - free_terms: términos de texto libre (búsqueda OR sobre name/visual_description/etc.)
 *  - shot_type: vocabulario controlado (plano_general, primer_plano, ...) | null
 *  - people_framing: ninguno|individual|pareja|grupo|multitud|null
 *  - movement_type: estatico|moving|null
 *  - exposure: under|normal|over|null
 *  - color_terms: array de colores en español
 *
 * Si Ollama no está disponible o supera el timeout, se relanza un Error
 * con prefijo "Ollama" para que el handler de la ruta devuelva HTTP 503.
 */

const { Ollama } = require('ollama');
require('dotenv').config();

class AISearchService {
  constructor() {
    const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.ollama = new Ollama({ host: ollamaHost });
    this.model = process.env.OLLAMA_MODEL || 'qwen2.5:14b-instruct';
    // Timeout server-side por consulta. Cubre LLM lentos en cold-start.
    this.timeout = 30000;
    // Tope defensivo de seguridad por contexto del LLM (no por popularidad).
    // Para un archivo personal típico no se llega ni de lejos. Si se supera,
    // se loguea warning una vez por sesión y se trunca preservando orden.
    this.maxPeopleHints = 1000;
    this.warnedTruncatedHints = false;

    console.log('🤖 AI Search Service inicializado con modelo:', this.model);
  }

  /**
   * Normaliza texto: minúsculas + sin acentos.
   */
  normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  }

  /**
   * Llama a Ollama con AbortController para imponer timeout server-side.
   * Si timeout o conexión falla, lanza Error con prefijo reconocible.
   */
  async callOllamaChat(messages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      // ollama.chat acepta `signal` para AbortController.
      const response = await this.ollama.chat({
        model: this.model,
        messages,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 500,
        },
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      const msg = (error && error.message) || String(error);
      if (controller.signal.aborted || /aborted|abort/i.test(msg)) {
        const e = new Error(`Ollama timeout tras ${this.timeout}ms`);
        e.cause = error;
        throw e;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Construye el bloque de "Personas conocidas" para el prompt.
   * Sin cap por popularidad: pasa TODAS las personas conocidas. Solo
   * trunca como protección extrema si el listado supera `maxPeopleHints`
   * (1000); en ese caso emite warning una vez. Ese tope nunca debería
   * dispararse en uso personal.
   */
  formatPeopleHints(peopleHints) {
    if (!Array.isArray(peopleHints) || peopleHints.length === 0) return '';
    let source = peopleHints;
    if (peopleHints.length > this.maxPeopleHints) {
      if (!this.warnedTruncatedHints) {
        console.warn(`⚠️ peopleHints truncado a ${this.maxPeopleHints} de ${peopleHints.length}. ` +
          `Considera resolución determinista por query si esto es intencional.`);
        this.warnedTruncatedHints = true;
      }
      source = peopleHints.slice(0, this.maxPeopleHints);
    }
    const list = source.map(p => {
      const aliases = Array.isArray(p.aliases) && p.aliases.length > 0
        ? `, aliases: [${p.aliases.map(a => JSON.stringify(a)).join(', ')}]`
        : '';
      return `  - {person_id: ${JSON.stringify(p.person_id)}, display_name: ${JSON.stringify(p.display_name || p.person_id)}${aliases}}`;
    }).join('\n');
    return `\nPERSONAS CONOCIDAS (devuelve "person_ids" con estos identificadores cuando se mencionen):\n${list}\n`;
  }

  /**
   * Extrae intención (schema completo) de una query usando el LLM.
   * @param {string} query
   * @param {Array} peopleHints - [{person_id, display_name, aliases}]
   */
  async extractSearchIntent(query, peopleHints = []) {
    const peopleBlock = this.formatPeopleHints(peopleHints);

    const intentPrompt = `Eres un asistente que analiza búsquedas de archivos multimedia (fotos y videos) producidas por una pipeline de visión por computador. Devuelve SOLO un JSON sin explicaciones.

Campos esperados:
- type: "image" | "video" | "audio" | null
- year: número (ej. 2023) o null
- month: "01".."12" o null
- month_name: nombre del mes en minúsculas (enero, febrero, ...) o null
- person_ids: array de identificadores de la lista de PERSONAS CONOCIDAS abajo (vacío si nadie mencionado o no resoluble)
- space_ids: array de identificadores de espacios mencionados (auditorio, cocina, ...) — vacío si no aplica
- tags: array de etiquetas que el usuario pide que aparezcan (suman puntos al ranking, no filtran)
- free_terms: array de términos de texto libre que NO encajan en los demás campos
- expanded_terms: array de SINÓNIMOS y TRADUCCIONES (especialmente al INGLÉS) de los conceptos clave de la consulta, incluyendo pistas visuales que un VLM describiría. Las descripciones del corpus pueden estar en inglés, así que estos términos son cruciales para encontrar coincidencias semánticas. Máx 12 términos. NO repitas las palabras originales (esas ya están en tags/free_terms). Si la consulta no tiene conceptos visuales/temáticos que ampliar (solo personas o fechas), devuelve [].
- shot_type: "plano_general" | "plano_americano" | "plano_medio" | "plano_medio_corto" | "primer_plano" | "plano_detalle" | null
- people_framing: "ninguno" | "individual" | "pareja" | "grupo" | "multitud" | null
- movement_type: "estatico" | "moving" | null
- exposure: "under" | "normal" | "over" | null
- color_terms: array de colores en español (rojo, azul, lavanda, ...)
${peopleBlock}
EJEMPLOS:
Input: "videos de Alumni con seriedad de 2023"
Output: {"type":"video","year":2023,"month":null,"month_name":null,"person_ids":[],"space_ids":[],"tags":["alumni","seriedad"],"free_terms":[],"expanded_terms":["graduates","alumni network","serious","formal","reunion"],"shot_type":null,"people_framing":null,"movement_type":null,"exposure":null,"color_terms":[]}

Input: "primer plano de Ester en agosto"
Output: {"type":null,"year":null,"month":"08","month_name":"agosto","person_ids":["ester"],"space_ids":[],"tags":[],"free_terms":[],"expanded_terms":[],"shot_type":"primer_plano","people_framing":"individual","movement_type":null,"exposure":null,"color_terms":[]}

Input: "fotos del auditorio con gente"
Output: {"type":"image","year":null,"month":null,"month_name":null,"person_ids":[],"space_ids":["auditorio"],"tags":["gente"],"free_terms":[],"expanded_terms":["auditorium","audience","crowd","seats","stage","people sitting"],"shot_type":null,"people_framing":"grupo","movement_type":null,"exposure":null,"color_terms":[]}

Input: "clase formativa en aula"
Output: {"type":"image","year":null,"month":null,"month_name":null,"person_ids":[],"space_ids":["aula"],"tags":["clase","formativa"],"free_terms":[],"expanded_terms":["classroom","lecture","training","students","desks","whiteboard","teacher","seminar","educational"],"shot_type":null,"people_framing":"grupo","movement_type":null,"exposure":null,"color_terms":[]}

Input: "edificios al atardecer"
Output: {"type":"image","year":null,"month":null,"month_name":null,"person_ids":[],"space_ids":[],"tags":["edificios","atardecer"],"free_terms":[],"expanded_terms":["building","buildings","facade","tower","sunset","dusk","golden hour","skyline"],"shot_type":null,"people_framing":null,"movement_type":null,"exposure":null,"color_terms":[]}

Input: "${query}"
Output:`;

    let response;
    try {
      response = await this.callOllamaChat([{ role: 'user', content: intentPrompt }]);
    } catch (error) {
      const msg = (error && error.message) || String(error);
      const isConnError =
        msg.includes('ECONNREFUSED') ||
        msg.includes('fetch failed') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('timeout') ||
        msg.toLowerCase().includes('ollama');
      if (isConnError) {
        const wrapped = new Error(`Ollama no disponible: ${msg}`);
        wrapped.cause = error;
        throw wrapped;
      }
      console.warn('⚠️ Error inesperado del LLM (no conexión), fallback:', msg);
      return this.fallbackIntent(query);
    }

    const responseText = (response && response.message && response.message.content || '').trim();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('⚠️ Respuesta del LLM sin JSON detectable, usando fallback.');
      return this.fallbackIntent(query);
    }
    try {
      const intent = JSON.parse(jsonMatch[0]);
      return this.normalizeIntent(intent, query, peopleHints);
    } catch (parseErr) {
      console.warn('⚠️ JSON del LLM no parseable, usando fallback:', parseErr.message);
      return this.fallbackIntent(query);
    }
  }

  /**
   * Valida y normaliza el intent crudo del LLM. Acepta también nombres
   * antiguos (camelCase) por si el modelo los emite.
   */
  normalizeIntent(raw, _query, peopleHints = []) {
    const r = raw || {};
    const knownIds = new Set((peopleHints || []).map(p => p.person_id));

    const arrStr = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
    const str = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
    const num = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' && isFinite(v)) return v;
      if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v, 10);
      return null;
    };

    // year/month: aceptar campos planos o dateFilter legacy
    const year = num(r.year) ?? num(r.dateFilter && r.dateFilter.year);
    const month = str(r.month) ?? str(r.dateFilter && r.dateFilter.month);
    const monthName = str(r.month_name) ?? str(r.monthName) ?? str(r.dateFilter && r.dateFilter.monthName);

    // person_ids: conservar solo los conocidos por Pensadero. `knownIds` se
    // construye desde `peopleHints` que el server arma como UNIÓN de:
    //   - registry (entradas con display_name/avatar)
    //   - personsAggregate (incluye huérfanos: person_ids presentes en
    //     mediaFiles/sidecars sin entrada en registry)
    // Por tanto un huérfano (carlos99 sin registry) SÍ es válido si aparece
    // en algún sidecar/catalog. Si peopleHints está vacío (sin registry y
    // sin material), se aceptan tal cual para no bloquear primeras pruebas.
    const personIdsRaw = arrStr(r.person_ids);
    const personIds = knownIds.size > 0
      ? personIdsRaw.filter(id => knownIds.has(id))
      : personIdsRaw;

    return {
      type: str(r.type),
      year: year !== null ? String(year) : null,
      month: month && /^\d{1,2}$/.test(month) ? String(month).padStart(2, '0') : null,
      month_name: monthName ? monthName.toLowerCase() : null,
      person_ids: personIds,
      space_ids: arrStr(r.space_ids),
      tags: arrStr(r.tags),
      free_terms: arrStr(r.free_terms).length > 0 ? arrStr(r.free_terms) : arrStr(r.searchTerms),
      // expanded_terms: sinónimos y traducciones que el LLM genera para cubrir
      // el desajuste de idioma entre query (español) y visual_descriptions
      // (inglés en el corpus actual). Limitamos a 15 por si el modelo se va
      // de la mano. Si el LLM viejo no emite el campo, queda vacío.
      expanded_terms: arrStr(r.expanded_terms).slice(0, 15),
      shot_type: str(r.shot_type) ?? str(r.shotFilter),
      people_framing: str(r.people_framing) ?? str(r.peopleFraming),
      movement_type: str(r.movement_type) ?? str(r.movementType),
      exposure: str(r.exposure),
      color_terms: arrStr(r.color_terms).length > 0 ? arrStr(r.color_terms) : arrStr(r.colorTerms),
    };
  }

  /**
   * Intent determinista cuando el LLM no nos da JSON utilizable.
   * Reparte la query en free_terms.
   */
  fallbackIntent(query) {
    return {
      type: null,
      year: null,
      month: null,
      month_name: null,
      person_ids: [],
      space_ids: [],
      tags: [],
      free_terms: (query || '').split(/\s+/).filter(t => t.length > 2),
      expanded_terms: [],
      shot_type: null,
      people_framing: null,
      movement_type: null,
      exposure: null,
      color_terms: [],
    };
  }

  /**
   * Filtra y puntúa los mediaFiles según el intent.
   *
   * Filtros estrictos (descartan si no matchean):
   *  - type
   *  - year/month/month_name (sobre extractedDate o tags de fecha)
   *  - person_ids (OR entre listados; el archivo debe tener AL MENOS uno)
   *  - space_ids (igual: OR entre listados)
   *  - tags (AND: todos deben matchear)
   *
   * Bonus de scoring (no descartan):
   *  - shot_type, people_framing, movement_type, exposure
   *  - color_terms (matches contra dominant_colors[])
   *  - free_terms (búsqueda libre sobre name/tags/visual_description/ocr/composition)
   */
  scoreMediaFiles(intent, mediaFiles, limit = 200) {
    const {
      type, year, month, month_name,
      person_ids, space_ids, tags, free_terms, expanded_terms,
      shot_type, people_framing, movement_type, exposure, color_terms,
    } = intent;

    const results = [];
    const N = (s) => this.normalizeText(s);
    const shotN = shot_type ? N(shot_type).replace(/\s+/g, '_') : null;
    const framingN = people_framing ? N(people_framing) : null;
    const movementN = movement_type ? N(movement_type) : null;
    const exposureN = exposure ? N(exposure) : null;
    const colorTermsN = (color_terms || []).map(N).filter(Boolean);
    const tagsN = (tags || []).map(N).filter(Boolean);
    const freeN = (free_terms || []).map(N).filter(Boolean);
    // expanded_terms: sinónimos/traducciones generados por el LLM. Tienen
    // peso menor que free_terms porque son inferidos, no pedidos explícitamente.
    const expandedN = (expanded_terms || []).map(N).filter(Boolean);
    const personIdSet = new Set(person_ids || []);
    const spaceIdSet = new Set(space_ids || []);

    for (const file of mediaFiles) {
      // === FILTROS ESTRICTOS ===

      if (type && file.type !== type) continue;

      // Fecha: mismo enfoque que el endpoint /api/search (sobre tags + extractedDate)
      if (year || month || month_name) {
        const fileTagsN = (file.tags || []).map(N);
        let dateOk = true;

        if (year) {
          const y = String(year);
          const yy = y.slice(-2);
          const hasYear = fileTagsN.some(t => t === y || t.startsWith(yy + '-') || t.includes(yy + '-'));
          if (!hasYear) dateOk = false;
        }
        if (dateOk && (month || month_name)) {
          const monthNum = month;
          const monthNm = month_name ? N(month_name) : null;
          const hasMonth = fileTagsN.some(t => {
            if (monthNum && t.match(new RegExp(`\\d{2}-${monthNum}(-|$)`))) return true;
            if (monthNm && t === monthNm) return true;
            return false;
          });
          if (!hasMonth) dateOk = false;
        }
        if (!dateOk) continue;
      }

      if (personIdSet.size > 0) {
        const ok = (file.faces || []).some(f => f && f.person_id && personIdSet.has(f.person_id));
        if (!ok) continue;
      }

      // NOTA: space_ids YA NO es filtro estricto. Antes excluía cualquier
      // archivo cuyo `spaces[]` no tuviera al menos uno de los space_ids del
      // intent. Pero el LLM extrae conceptos espaciales en lenguaje natural
      // ("aula", "auditorio") que rara vez coinciden literalmente con los
      // `space_id` controlados del corpus — y muchos archivos no tienen
      // spaces[] etiquetados en absoluto. El filtro descartaba todo y la
      // query salía vacía. Ahora es scoring (bonus +10 por space coincidente)
      // igual que tags: precisión vía ranking, no vía exclusión.

      // === SCORING (incluye bonus para ranking) ===

      let score = 1;
      const matchedIn = [];
      const addMatch = (k) => { if (!matchedIn.includes(k)) matchedIn.push(k); };

      // Bonus por person_ids (cada match). Sigue siendo strict via filter
      // arriba (line 331): person_ids viene del registry, son IDs reales y
      // controlados — si dices "fotos de Ester", filtrar por Ester es
      // correcto. No así para space_ids, que son free-text del LLM.
      if (personIdSet.size > 0) {
        score += 15 * (file.faces || []).filter(f => f && f.person_id && personIdSet.has(f.person_id)).length;
        addMatch('person_ids');
      }
      if (spaceIdSet.size > 0) {
        const fileSpaceIds = (file.spaces || [])
          .map(s => s && s.space_id)
          .filter(Boolean);
        const matchedSpaces = fileSpaceIds.filter(sid => spaceIdSet.has(sid));
        if (matchedSpaces.length > 0) {
          score += 10 * matchedSpaces.length;
          addMatch('space_ids');
        }
      }
      if (tagsN.length > 0) {
        const fileTagsN = (file.tags || []).map(N);
        const matchedTags = tagsN.filter(t => fileTagsN.some(ft => ft.includes(t) || t.includes(ft)));
        if (matchedTags.length > 0) {
          score += 10 * matchedTags.length;
          addMatch('tags');
        }
      }

      // Bonus filtros visuales
      const compShot = N(file.composition && file.composition.shot_type);
      const compFraming = N(file.composition && file.composition.people_framing);
      const movement = N(file.technical && file.technical.movement_type);
      const fileExp = N(file.technical && file.technical.exposure);
      if (shotN && compShot && compShot === shotN) { score += 8; addMatch('shot_type'); }
      if (framingN && compFraming && compFraming === framingN) { score += 6; addMatch('people_framing'); }
      if (movementN && movement && (movement === movementN || (movementN === 'moving' && movement !== 'estatico'))) {
        score += 5;
        addMatch('movement_type');
      }
      if (exposureN && fileExp && fileExp === exposureN) { score += 4; addMatch('exposure'); }

      // Color terms contra dominant_colors[] / dominant_color
      const dominantColors = Array.isArray(file.dominant_colors)
        ? file.dominant_colors.map(c => N(typeof c === 'string' ? c : (c && c.name) || ''))
        : [];
      const dominantColorLegacy = N(file.dominant_color || '');
      for (const c of colorTermsN) {
        if (dominantColors.some(dc => dc && (dc.includes(c) || c.includes(dc)))) {
          score += 5; addMatch('dominant_colors');
        }
        if (dominantColorLegacy && !dominantColorLegacy.startsWith('#') &&
            (dominantColorLegacy.includes(c) || c.includes(dominantColorLegacy))) {
          score += 5; addMatch('dominant_color');
        }
      }

      // Free terms: búsqueda libre OR sobre name/tags/visual/ocr/composition.
      // Y expanded_terms: sinónimos/traducciones del LLM con pesos menores
      // (son inferidos, no pedidos). Las dos pasadas comparten la misma
      // lógica de búsqueda; cambia solo el peso.
      if (freeN.length > 0 || expandedN.length > 0) {
        const fileName = N(file.name);
        const visual = N(file.visual_description);
        const ocr = N(file.ocr_text);
        const fileTagsN = (file.tags || []).map(N);

        // Pasada 1: free_terms (pedidos por el usuario) — pesos altos
        for (const t of freeN) {
          if (fileTagsN.some(ft => ft.includes(t))) { score += 5; addMatch('tags'); }
          if (visual && visual.includes(t)) { score += 4; addMatch('visual_description'); }
          if (ocr && ocr.includes(t)) { score += 3; addMatch('ocr_text'); }
          if (fileName.includes(t)) { score += 3; addMatch('name'); }
          if (compShot && compShot.includes(t)) { score += 2; addMatch('shot_type'); }
        }

        // Pasada 2: expanded_terms (sinónimos/traducciones del LLM) — pesos
        // reducidos (~60% del free_terms). Match clave: visual_description
        // que suele estar en inglés. Un buen match aquí salva la query.
        for (const t of expandedN) {
          if (fileTagsN.some(ft => ft.includes(t))) { score += 3; addMatch('expanded_tags'); }
          if (visual && visual.includes(t)) { score += 3; addMatch('expanded_visual'); }
          if (ocr && ocr.includes(t)) { score += 2; addMatch('expanded_ocr'); }
          if (fileName.includes(t)) { score += 2; addMatch('expanded_name'); }
        }
      }

      results.push({ fileId: file.id, file, score, matchedIn });
    }

    results.sort((a, b) => b.score - a.score);

    // === CORTE DE RELEVANCIA EN DOS TRAMOS ===
    //
    // Para búsqueda en lenguaje natural el resultado no es binario. Se
    // separan los archivos en dos tramos según su score:
    //
    //   PRIMARY:   score >= max(topScore * 0.5, 5)
    //              → "resultados claros" — se muestran en primer plano.
    //
    //   SECONDARY: primaryCutoff > score >= max(topScore * 0.2, 2)
    //              → "menos probables" — se muestran bajo un separador, en
    //              segundo plano, para que el usuario pueda escanearlos
    //              cuando los del primer tramo no le convencen.
    //
    //   DESCARTE:  score por debajo del secondaryCutoff. Pura ruido.
    //
    // Esto evita el "todo o nada": cuando una query es ambigua y nada
    // matchea perfectamente, el sistema ya no se queda mudo — devuelve los
    // candidatos razonables como sugerencias visiblemente separadas.
    //
    // Ratios y suelos están aislados como constantes. Bajar a 0.4/3 si la
    // calibración real pide más laxo, subir a 0.6/8 si pide más estricto.
    const PRIMARY_RATIO = 0.5;
    const PRIMARY_FLOOR = 5;
    const SECONDARY_RATIO = 0.2;
    const SECONDARY_FLOOR = 2;
    const SECONDARY_CAP = 50;

    const topScore = results[0]?.score ?? 0;
    const primaryCutoff = Math.max(topScore * PRIMARY_RATIO, PRIMARY_FLOOR);
    const secondaryCutoff = Math.max(topScore * SECONDARY_RATIO, SECONDARY_FLOOR);

    const primary = [];
    const secondary = [];
    for (const r of results) {
      if (r.score >= primaryCutoff) {
        primary.push({ ...r, tier: 'primary' });
      } else if (r.score >= secondaryCutoff) {
        secondary.push({ ...r, tier: 'secondary' });
      }
    }

    const primaryOut = primary.slice(0, limit);
    const remainingSlots = Math.max(0, limit - primaryOut.length);
    const secondaryOut = secondary.slice(0, Math.min(SECONDARY_CAP, remainingSlots));

    const out = [...primaryOut, ...secondaryOut];
    // Diagnóstico en propiedad no enumerable para que parseNaturalQuery
    // pueda volcarlo al metadata sin alterar la forma del array iterable.
    Object.defineProperty(out, '__relevance', {
      value: {
        topScore,
        primaryCutoff,
        secondaryCutoff,
        primaryCount: primaryOut.length,
        secondaryCount: secondaryOut.length,
        totalCandidates: results.length,
      },
      enumerable: false,
    });
    return out;
  }

  /**
   * Selecciona el pool de candidatos para Stage 2 (re-ranking semántico).
   *
   * Estrategia:
   *  1. Empezar por los resultados de Stage 1 con score > 1 (algún match
   *     parcial, aunque sea débil).
   *  2. Completar con archivos del corpus de tipo correcto y descripción rica,
   *     PERO ORDENADOS por número de tokens del query original/intent que
   *     aparezcan en `name + visual_description + tags`. Esto evita que el
   *     pool se llene de los primeros 30 archivos alfabéticos cuando lo que
   *     queremos es lo más cercano semánticamente a la consulta.
   *  3. Limitar a STAGE2_CANDIDATE_LIMIT (30) para no saturar el contexto.
   *
   * Por qué este ranking importa: en queries donde Stage 1 da cero (filtros
   * estrictos o cero coincidencias literales), si dejamos que cualquier
   * archivo entre al pool, el LLM acaba puntuando "lo menos malo" del azar.
   * Si dejamos pasar arriba los archivos que ya tenían alguna pista literal,
   * el LLM trabaja sobre material genuinamente parecido.
   */
  selectStage2Candidates(intent, mediaFiles, stage1Results, query) {
    const STAGE2_CANDIDATE_LIMIT = 30;
    const MIN_DESC_LENGTH = 20;

    const baseFiles = (stage1Results || [])
      .filter(r => r.file && r.score > 1)
      .slice(0, STAGE2_CANDIDATE_LIMIT)
      .map(r => r.file);

    if (baseFiles.length >= STAGE2_CANDIDATE_LIMIT) return baseFiles;

    const baseIds = new Set(baseFiles.map(f => f.id));
    const typeN = intent && intent.type ? this.normalizeText(intent.type) : null;

    // Tokens para rankear el pool extra: combinamos query original (tras
    // quitar stopwords cortas) con free_terms y tags del intent. Todo
    // normalizado a minúsculas sin acentos para matching robusto.
    const STOPWORDS = new Set(['a','de','en','el','la','los','las','un','una','y','o','con','por','para','sin','del','al','que','es','se','su','sus','lo','le','les','mi','tu','ni','o','u']);
    const queryTokens = (query || '')
      .split(/\s+/)
      .map(t => this.normalizeText(t))
      .filter(t => t.length > 2 && !STOPWORDS.has(t));
    const intentTokens = [
      ...(intent && Array.isArray(intent.tags) ? intent.tags : []),
      ...(intent && Array.isArray(intent.free_terms) ? intent.free_terms : []),
      ...(intent && Array.isArray(intent.space_ids) ? intent.space_ids : []),
      // expanded_terms (sinónimos/traducciones) son cruciales aquí: cubren
      // el desajuste de idioma cuando las descripciones del corpus están
      // en inglés y la query en español.
      ...(intent && Array.isArray(intent.expanded_terms) ? intent.expanded_terms : []),
    ].map(t => this.normalizeText(t)).filter(Boolean);
    const allTokens = [...new Set([...queryTokens, ...intentTokens])];

    const scoreCandidate = (f) => {
      if (allTokens.length === 0) return 0;
      const haystack = [
        this.normalizeText(f.name || ''),
        this.normalizeText(f.visual_description || ''),
        ...(f.tags || []).map(t => this.normalizeText(t)),
      ].join(' ');
      let hits = 0;
      for (const t of allTokens) {
        if (haystack.includes(t)) hits++;
      }
      return hits;
    };

    const eligibles = [];
    for (const f of mediaFiles) {
      if (baseIds.has(f.id)) continue;
      if (typeN && f.type !== typeN) continue;
      const desc = f.visual_description || '';
      if (desc.length < MIN_DESC_LENGTH) continue;
      eligibles.push({ file: f, hits: scoreCandidate(f) });
    }

    // Ordenar por hits desc (más coincidencias literales arriba), tomar
    // top hasta llenar el límite.
    eligibles.sort((a, b) => b.hits - a.hits);
    const slotsLeft = STAGE2_CANDIDATE_LIMIT - baseFiles.length;
    const additional = eligibles.slice(0, slotsLeft).map(e => e.file);

    return [...baseFiles, ...additional];
  }

  /**
   * Stage 2: re-ranking semántico con LLM.
   *
   * Recibe un pool de candidatos y les pide al LLM que los clasifique en
   * `alto` (claramente relevantes) / `medio` (relacionados / interpretación
   * amplia) según la query del usuario. El LLM puede leer la
   * visual_description en cualquier idioma e interpretar semánticamente,
   * lo que resuelve queries como "edificios" o "imagen exterior" que el
   * matching literal (Stage 1) no puede.
   *
   * Si el LLM falla o devuelve algo no parseable, retorna null y el caller
   * cae a los resultados de Stage 1.
   */
  async reRankWithLLM(query, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    // Construir cada candidato con campos mínimos pero suficientes para
    // razonamiento semántico: nombre, descripción visual, tags clave.
    const candidateLines = candidates.map((f, i) => {
      const desc = (f.visual_description || '').slice(0, 200);
      const tags = (f.tags || []).slice(0, 8).join(', ');
      return `[${i}] id:${f.id}\n  nombre: ${(f.name || '').slice(0, 80)}\n  desc: ${desc || '(sin descripción)'}\n  tags: ${tags || '(sin tags)'}`;
    }).join('\n');

    const rerankPrompt = `Eres un asistente que clasifica archivos audiovisuales según su relevancia para una consulta del usuario.

REGLAS:
1. Para cada archivo, decide si es "alto" o "medio":
   - "alto": el archivo claramente representa lo que pide la consulta. Sin dudas.
   - "medio": el archivo tiene una conexión razonable y articulable con la consulta (concepto adyacente, contexto similar). NO uses "medio" como cajón de sastre.
2. Las descripciones pueden estar en INGLÉS u otro idioma. Interpreta SEMÁNTICAMENTE, no por coincidencia literal. Ej: "edificios" matchea descripciones con "building", "facade", "tower". "aula" matchea "classroom", "lecture hall", "people sitting at desks".
3. SI TIENES QUE ESTIRAR para justificar relevancia, OMITE el archivo. Es mejor devolver pocos buenos que muchos dudosos.
4. OMITE explícitamente los archivos que no tienen relación clara con la consulta — no los incluyas en la respuesta.
5. Responde SOLO con JSON válido (sin explicaciones, sin markdown, sin texto antes ni después).

FORMATO:
{"classifications": [{"id": "<fileId>", "tier": "alto"}, {"id": "<fileId>", "tier": "medio"}]}

CONSULTA: "${query}"

ARCHIVOS:
${candidateLines}

Respuesta JSON:`;

    let response;
    try {
      response = await this.callOllamaChat([{ role: 'user', content: rerankPrompt }]);
    } catch (err) {
      console.warn('[Stage 2] LLM no respondió:', err && err.message);
      return null;
    }

    const text = (response && response.message && response.message.content || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[Stage 2] sin JSON parseable en respuesta del LLM');
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.warn('[Stage 2] JSON inválido:', err.message);
      return null;
    }

    if (!parsed || !Array.isArray(parsed.classifications)) {
      console.warn('[Stage 2] respuesta sin array classifications');
      return null;
    }

    // Mapa id -> tier según el LLM.
    const tierMap = new Map();
    for (const c of parsed.classifications) {
      if (c && typeof c.id === 'string' && (c.tier === 'alto' || c.tier === 'medio')) {
        tierMap.set(c.id, c.tier);
      }
    }

    // Reconstruir resultados. Score sintético (100/50) solo para preservar
    // orden y rellenar metadata; lo que realmente importa es `tier`.
    const altos = [];
    const medios = [];
    for (const f of candidates) {
      const tier = tierMap.get(f.id);
      if (tier === 'alto') {
        altos.push({ fileId: f.id, file: f, score: 100, matchedIn: ['stage2'], tier: 'primary' });
      } else if (tier === 'medio') {
        medios.push({ fileId: f.id, file: f, score: 50, matchedIn: ['stage2'], tier: 'secondary' });
      }
      // Resto: descarte por omisión.
    }

    const out = [...altos, ...medios];
    Object.defineProperty(out, '__relevance', {
      value: {
        topScore: altos.length > 0 ? 100 : (medios.length > 0 ? 50 : 0),
        primaryCutoff: 100,
        secondaryCutoff: 50,
        primaryCount: altos.length,
        secondaryCount: medios.length,
        totalCandidates: candidates.length,
        stage: 2,
      },
      enumerable: false,
    });
    return out;
  }

  /**
   * Procesa una consulta natural y devuelve resultados puntuados.
   *
   * Flujo:
   *  - Stage 1: matching literal con scoring (rápido, sin LLM).
   *  - Stage 2 (condicional): re-ranking semántico con LLM cuando Stage 1
   *    devuelve pocos resultados claros. El LLM razona sobre las
   *    visual_descriptions y rescata candidatos que el matching literal
   *    no podría encontrar (sinónimos, idiomas mezclados, conceptos).
   *
   * @param {string} query
   * @param {Array} mediaFiles
   * @param {Array} peopleHints - lista del registry/aggregate
   */
  async parseNaturalQuery(query, mediaFiles = [], peopleHints = []) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('Query vacía o inválida');
    }
    const startTime = Date.now();
    const intent = await this.extractSearchIntent(query, peopleHints);

    // === STAGE 1 ===
    const stage1Results = this.scoreMediaFiles(intent, mediaFiles);
    const stage1Relevance = stage1Results.__relevance || null;
    const stage1PrimaryCount = stage1Relevance?.primaryCount ?? 0;

    // === STAGE 2 (condicional) ===
    // Se invoca cuando Stage 1 devuelve menos de N resultados claros.
    // Configurable vía AI_RERANK_ENABLED y AI_RERANK_MIN_PRIMARY.
    const RERANK_ENABLED = process.env.AI_RERANK_ENABLED !== 'false';
    const MIN_PRIMARY_TO_SKIP = parseInt(process.env.AI_RERANK_MIN_PRIMARY || '5', 10);

    let finalResults = stage1Results;
    let stage2Applied = false;
    let stage2Reason = null;
    let stage2Time = 0;

    if (RERANK_ENABLED && stage1PrimaryCount < MIN_PRIMARY_TO_SKIP) {
      const candidates = this.selectStage2Candidates(intent, mediaFiles, stage1Results, query);
      if (candidates.length > 0) {
        const stage2Start = Date.now();
        const reranked = await this.reRankWithLLM(query, candidates);
        stage2Time = Date.now() - stage2Start;
        if (reranked && Array.isArray(reranked)) {
          finalResults = reranked;
          stage2Applied = true;
          stage2Reason = `stage1 primary=${stage1PrimaryCount} < ${MIN_PRIMARY_TO_SKIP}`;
        }
      } else {
        stage2Reason = 'sin candidatos elegibles para stage 2';
      }
    }

    const relevance = finalResults.__relevance || null;
    return {
      results: finalResults,
      intent,
      metadata: {
        model: this.model,
        processingTime: Date.now() - startTime,
        originalQuery: query,
        totalScanned: mediaFiles.length,
        peopleHintsCount: Array.isArray(peopleHints) ? peopleHints.length : 0,
        // Diagnóstico de Stage 2.
        stage2Applied,
        stage2Reason,
        stage2Time,
        // Diagnóstico de relevancia para el separador y el debug.
        topScore: relevance?.topScore ?? 0,
        primaryCutoff: relevance?.primaryCutoff ?? 0,
        secondaryCutoff: relevance?.secondaryCutoff ?? 0,
        primaryCount: relevance?.primaryCount ?? 0,
        secondaryCount: relevance?.secondaryCount ?? 0,
        totalCandidates: relevance?.totalCandidates ?? 0,
      }
    };
  }

  /**
   * Health check de Ollama y disponibilidad del modelo.
   */
  async healthCheck() {
    try {
      const models = await this.ollama.list();
      const modelExists = models.models.some(m => m.name.includes(this.model.split(':')[0]));
      return {
        ollamaRunning: true,
        modelAvailable: modelExists,
        model: this.model
      };
    } catch (error) {
      return {
        ollamaRunning: false,
        modelAvailable: false,
        model: this.model,
        error: error.message
      };
    }
  }
}

module.exports = new AISearchService();
