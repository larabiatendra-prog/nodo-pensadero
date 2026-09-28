import { config } from '../config';
import type { CopiaGrupo, CopiasPar, CopiasResumen, GrupoPersonas, MediaFile } from '../types';

const API_BASE_URL = config.apiBaseUrl;

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  /** El motivo cuando success es false (lo manda el servidor). */
  error?: string;
  count?: number;
}

// Vídeos preparados (proxies). El tope es por disco: 40 GB en el disco del
// sistema es mucho y en una LaCie de 8 TB no es nada. topeGB 0 = sin tope.
// Lo que se puede hacer con todo el material de una persona (vista previa).
export interface ArchivosPersona {
  persona: { id: string; nombre: string };
  alcance: 'todos' | 'sin_otros';
  total: number;
  bytes: number;
  porTipo: { video: number; image: number; audio: number };
  /** En cuantos no sale nadie mas identificado. */
  soloElla: number;
  /** En cuantos del alcance sale tambien otra persona identificada. */
  conOtros: number;
  otros: Array<{ id: string; nombre: string; n: number }>;
  carpetas: Array<{ nombre: string; n: number }>;
  discos: Array<{ raiz: string; n: number; bytes: number; conectado: boolean }>;
  ocultos: number;
  muestra: string[];
}

export interface LotePapelera {
  id: string;
  motivo: string;
  fecha: string;
  estado: string;
  archivos: number;
  /** Los que siguen de verdad en la papelera (en disco). */
  presentes: number;
  bytes: number;
  conectado: boolean;
  muestra: string[];
}

export interface ProxiesAjustes {
  topeGB: number;
  porDisco: Record<string, number>;
  /** Al llegar al tope: preguntar (no borra nada) o liberar los menos vistos. */
  alLlegar: 'preguntar' | 'liberar';
}

export interface ProxiesDisco {
  raiz: string;
  n: number;
  bytes: number;
  /** Última vez que se vio alguno de sus proxies (epoch ms). */
  visto: number;
  topeGB: number;
  /** true si este disco tiene tope propio, false si sigue al general. */
  propio: boolean;
  libreGB: number | null;
  aviso: { desde: number; esperando: number; ultimo?: string } | null;
}

/** Cuántos vídeos de un disco ganarían fluidez con una versión ligera. */
export interface ProxiesFluidez {
  raiz: string;
  /** Los que ganarían y aún no la tienen. */
  n: number;
  /** Vídeos del disco en total, para dar proporción. */
  total: number;
  /** Lo que ocuparían sus versiones ligeras (estimado por duración). */
  bytes: number;
  /** De los que ganarían, cuántos no tienen duración conocida (sin escanear). */
  sinMedir: number;
}

/** Preparación en lote en marcha (o la última que hubo). */
export interface ProxiesLote {
  total: number;
  hechos: number;
  saltados: number;
  fallos: number;
  bytes: number;
  procesados: number;
  desde: number;
  terminado: boolean;
  cancelado: boolean;
  actual: string | null;
  /** Por qué paró antes de tiempo: 'tope' | 'espacio' | 'cancelado'. */
  motivo: string | null;
  raiz: string | null;
  restanteSeg: number | null;
  /** Discos que se pararon por su tope o por sitio (el lote sigue con los demás). */
  topes?: Array<{ raiz: string; motivo: 'tope' | 'espacio' }>;
  /** Los que se quedaron sin preparar por eso. */
  sinSitio?: number;
}

/** Cuánto tardaría y ocuparía preparar todos: se mide este equipo con muestras. */
export interface ProxiesEstimacion {
  total: number;
  /** Los que se prepararían. */
  n: number;
  /** Los que se quedarían sin preparar por el tope o el sitio de su disco. */
  fuera: number;
  bytes: number;
  sinMedir: number;
  /** null si no se pudo medir el equipo. */
  segundos: number | null;
  discos: Array<{ raiz: string; n: number; fuera: number; bytes: number; limite: 'tope' | 'sitio' | null; topeGB: number }>;
  encoder: 'grafica' | 'procesador' | null;
  muestras: number;
}

export interface ProxiesEstado {
  ajustes: ProxiesAjustes;
  minLibreGB: number;
  discos: ProxiesDisco[];
  fluidez: ProxiesFluidez[];
  lote: ProxiesLote | null;
  totales: {
    listos: number; bytes: number; pendientes: number; errores: number; nativos: number; forzados: number;
    /** Preparados con la regla vieja: no se pueden medir ni cuentan para el tope. */
    antiguos: number;
  };
}

// Entrada del catalogo VLM que devuelve GET /scan/models. tier:
// produccion | experimento | legacy | otro. installed=false → "pendiente de descarga".
export interface VlmModel {
  name: string;
  // 'no_cabe': modelo valido pero que no entra en la VRAM de esta maquina.
  // Se ofrece igual, avisando, en vez de dejar que el escaneo se arrastre sin
  // explicacion.
  tier: 'produccion' | 'experimento' | 'legacy' | 'otro' | 'no_cabe';
  label: string;
  notes: string;
  installed: boolean;
}

/** Trabajos que puede hacer un escaneo (ver backend/services/escaneoConfig.js). */
// Momentos de los vídeos (backend/services/momentosVideo.js).
export interface MomentosTrabajo {
  total: number;
  hechos: number;
  fallidos: number;
  /** Huellas nuevas calculadas en este trabajo. */
  momentos: number;
  actual: string | null;
  esperandoEscaneo: boolean;
  terminado: boolean;
  cancelado: boolean;
  /** 'fallos' = demasiados seguidos (un disco que se desconectó); 'error' = se cortó. */
  motivo: 'fallos' | 'error' | null;
  inicio: string;
  restanteSeg: number | null;
}

export interface MomentosEstado {
  /** Vídeos de los discos conectados con huella visual (escaneados). */
  videosConHuella: number;
  completos: number;
  pendientes: number;
  estimacionSeg: number;
  trabajo: MomentosTrabajo | null;
  escaneoEnMarcha?: boolean;
}

export type CapacidadEscaneo = 'descripcion' | 'caras' | 'busquedaVisual' | 'movimiento' | 'proxies';

export interface CapacidadInfo {
  id: CapacidadEscaneo;
  nombre: string;
  detalle: string;
  recurso: string;
  coste: 'alto' | 'medio' | 'bajo';
  soloVideo?: boolean;
}

class ApiService {
  private async fetchWithErrorHandling<T>(url: string, options?: RequestInit): Promise<T> {
    try {
      console.log('🌐 Realizando petición a:', url);

      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      });

      if (!response.ok) {
        console.error(`❌ HTTP Error ${response.status}: ${response.statusText}`);

        // Intentar extraer mensaje de error del body
        let errorMessage = response.statusText;
        let errorData: any = null;
        try {
          errorData = await response.json();
          // Buscar mensaje en 'message' o 'error'
          if (errorData.message) {
            errorMessage = errorData.message;
          } else if (errorData.error) {
            errorMessage = errorData.error;
          }
        } catch (e) {
          // Si no hay JSON, usar statusText
        }

        const error: any = new Error(errorMessage);
        error.status = response.status;
        error.statusText = response.statusText;
        // El cuerpo entero, para errores que traen algo mas que el mensaje
        // (p. ej. "este disco ya es la biblioteca X": `mismoDisco`).
        error.data = errorData;
        throw error;
      }

      const data = await response.json();
      console.log('✅ Respuesta recibida:', data);
      return data;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        console.error('🔌 Error de conexión: No se puede conectar al servidor. ¿Está el backend ejecutándose en puerto 5000?');
      } else {
        console.error('❌ API Error:', error);
      }
      throw error;
    }
  }

  // Archivos
  async getFiles() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/files`);
  }

  async syncFiles() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/sync`, {
      method: 'POST'
    });
  }

  async getFile(id: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/files/${id}`);
  }

  async searchFiles(params: {
    q?: string;
    type?: string;
    tags?: string;
    year?: string;
    month?: string;
    dateFrom?: string;
    dateTo?: string;
    exports?: boolean;
  }) {
    // Filter out undefined values and convert boolean to string
    const cleanParams = Object.fromEntries(
      Object.entries(params)
        .filter(([_, value]) => value !== undefined && value !== '')
        .map(([key, value]) => [key, String(value)])
    );
    const queryString = new URLSearchParams(cleanParams).toString();
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/search?${queryString}`);
  }

  async updateFile(id: string, updates: any) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/files/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  // ── Notas humanas (por archivo y por sesion colapsada) ──────────────────
  /** Carga todas las notas: { files: { id: nota }, sessions: { key: nota } }. */
  async getNotes() {
    return this.fetchWithErrorHandling<ApiResponse<{
      files: Record<string, string>;
      sessions: Record<string, string>;
    }>>(`${API_BASE_URL}/notes`);
  }

  /** Guarda (o borra, si `note` viene vacio) una nota de archivo o de sesion. */
  /**
   * Guarda (o borra, con `note` vacio) una nota.
   * `legacyKey`: clave anterior del MISMO archivo (id md5) para que el backend
   * retire el duplicado al escribir bajo la mediaKey portable.
   */
  async saveNote(scope: 'file' | 'session', key: string, note: string, legacyKey?: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/notes`, {
      method: 'POST',
      body: JSON.stringify({ scope, key, note, legacyKey }),
    });
  }

  // Colecciones
  async getCollections() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/collections`);
  }

  async createCollection(name: string, description: string, coverImage?: string, coverType?: 'system' | 'custom', clientTempId?: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections`, {
      method: 'POST',
      body: JSON.stringify({ name, description, coverImage, coverType, clientTempId }),
    });
  }

  async addFileToCollection(collectionId: string, fileId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections/${collectionId}/files`, {
      method: 'POST',
      body: JSON.stringify({ fileId }),
    });
  }

  async addFilesToCollection(collectionId: string, fileIds: string[]) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections/${collectionId}/files/bulk`, {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
    });
  }

  async removeFileFromCollection(collectionId: string, fileId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections/${collectionId}/files/${fileId}`, {
      method: 'DELETE',
    });
  }

  // Descarga de archivos
  async downloadFile(fileId: string): Promise<Blob> {
    try {
      console.log('🌐 Descargando archivo con ID:', fileId);

      const response = await fetch(`${API_BASE_URL}/download/${fileId}`, {
        method: 'GET',
      });

      if (!response.ok) {
        console.error(`❌ HTTP Error ${response.status}: ${response.statusText}`);
        throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
      }

      const blob = await response.blob();
      console.log('✅ Archivo descargado como blob, tamaño:', blob.size);
      return blob;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        console.error('🔌 Error de conexión: No se puede conectar al servidor. ¿Está el backend ejecutándose en puerto 5000?');
      } else {
        console.error('❌ Download Error:', error);
      }
      throw error;
    }
  }

  /**
   * Descarga varios archivos en un ZIP que el navegador va guardando en disco
   * mientras llega (formulario a un marco oculto), con su barra de descarga
   * de siempre. Antes se pedía con fetch y se guardaba ENTERO en memoria
   * antes de ofrecerlo: con varios GB de vídeo la pestaña podía colgarse.
   * Un fallo dentro del marco no se ve, así que antes se comprueba que hay
   * algo que descargar y se lanza con el motivo si no.
   * @returns cuántos archivos van en el ZIP y cuántos se pidieron
   */
  async descargarZip(fileIds: string[], nombre?: string): Promise<{ disponibles: number; total: number }> {
    const r = await this.fetchWithErrorHandling<ApiResponse<{ disponibles: number; total: number }>>(
      `${API_BASE_URL}/download/zip/comprobar`,
      { method: 'POST', body: JSON.stringify({ fileIds }) },
    );
    const info = r.data || { disponibles: 0, total: fileIds.length };
    if (info.disponibles === 0) {
      throw new Error('Ninguno de esos archivos está disponible ahora (¿disco desconectado?)');
    }
    const NOMBRE_MARCO = 'pensadero-descargas';
    if (!document.querySelector(`iframe[name="${NOMBRE_MARCO}"]`)) {
      const marco = document.createElement('iframe');
      marco.name = NOMBRE_MARCO;
      marco.style.display = 'none';
      document.body.appendChild(marco);
    }
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `${API_BASE_URL}/download/zip`;
    form.target = NOMBRE_MARCO;
    form.style.display = 'none';
    const campo = (name: string, value: string) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    };
    campo('fileIds', JSON.stringify(fileIds));
    if (nombre) campo('nombre', nombre);
    document.body.appendChild(form);
    form.submit();
    form.remove();
    return info;
  }


  // Sistema
  async getSystemInfo() {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/system/info`);
  }

  // Estadísticas
  /** Estado del circuito entero: IA, caras, ffmpeg, bibliotecas, pendientes. */
  async getHealth() {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/health`);
  }

  async getStatistics() {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/statistics`);
  }

  // Momentos de los vídeos: varias huellas por clip para la búsqueda visual.
  async getMomentosEstado() {
    return this.fetchWithErrorHandling<ApiResponse<MomentosEstado>>(`${API_BASE_URL}/momentos/estado`);
  }

  /** Calcula en segundo plano los momentos que faltan. */
  async empezarMomentos() {
    return this.fetchWithErrorHandling<ApiResponse<MomentosEstado>>(
      `${API_BASE_URL}/momentos/empezar`,
      { method: 'POST' },
    );
  }

  /** Para el cálculo en marcha. Lo hecho se queda hecho. */
  async pararMomentos() {
    return this.fetchWithErrorHandling<ApiResponse<MomentosEstado>>(
      `${API_BASE_URL}/momentos/parar`,
      { method: 'POST' },
    );
  }

  // Vídeos preparados (proxies): cuánto ocupan por disco y contra qué tope.
  async getProxiesEstado() {
    return this.fetchWithErrorHandling<ApiResponse<ProxiesEstado>>(`${API_BASE_URL}/proxies/estado`);
  }

  /** `porDisco: { "F:\\": null }` devuelve ese disco al tope general; `0` = sin tope. */
  async setProxiesAjustes(parcial: {
    topeGB?: number;
    alLlegar?: 'preguntar' | 'liberar';
    porDisco?: Record<string, number | null>;
  }) {
    return this.fetchWithErrorHandling<ApiResponse<{ ajustes: ProxiesAjustes; estado: ProxiesEstado }>>(
      `${API_BASE_URL}/proxies/ajustes`,
      { method: 'PATCH', body: JSON.stringify(parcial) },
    );
  }

  /** Cuánto tardaría preparar todos (mide el equipo con unas muestras; no prepara nada). */
  async estimarProxies() {
    return this.fetchWithErrorHandling<ApiResponse<ProxiesEstimacion>>(
      `${API_BASE_URL}/proxies/estimar`,
      { method: 'POST' },
    );
  }

  /** Prepara de una vez todos los que ganarían fluidez en ese disco (sin raiz: todos). */
  async prepararProxies(raiz?: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ total: number; estado: ProxiesEstado }>>(
      `${API_BASE_URL}/proxies/preparar`,
      { method: 'POST', body: JSON.stringify({ raiz }) },
    );
  }

  /** Para la preparación en marcha. Lo ya preparado se queda. */
  async cancelarPreparacion() {
    return this.fetchWithErrorHandling<ApiResponse<{ estado: ProxiesEstado }>>(
      `${API_BASE_URL}/proxies/preparar/cancelar`,
      { method: 'POST' },
    );
  }

  /** Borra los menos vistos de ese disco hasta bajar de su tope. Regenerables. */
  async liberarProxies(raiz: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ liberados: number; estado: ProxiesEstado }>>(
      `${API_BASE_URL}/proxies/liberar`,
      { method: 'POST', body: JSON.stringify({ raiz }) },
    );
  }

  // La carta de la semana: prosa corta que el archivo escribe sobre si mismo.
  // Todas las cartas guardadas, de la mas nueva a la mas vieja.
  async getCartas() {
    return this.fetchWithErrorHandling<ApiResponse<Array<{
      semana: string; texto: string; tipo: string; fileIds: string[]; redactadaPor: string;
    }>>>(`${API_BASE_URL}/cartas`);
  }

  async getCarta() {
    return this.fetchWithErrorHandling<ApiResponse<{
      semana: string; texto: string; tipo: string; fileIds: string[]; redactadaPor: string;
    } | null>>(`${API_BASE_URL}/carta`);
  }

  // Tomas gemelas: grupos de material casi identico dentro de una misma
  // carpeta, calculados con los embeddings que ya dejo el escaneo.
  async getDuplicates(umbral?: number) {
    const q = typeof umbral === 'number' ? `?umbral=${umbral}` : '';
    return this.fetchWithErrorHandling<ApiResponse<{
      grupos: Array<{ id: string; carpeta: string; etiqueta: string; fileIds: string[]; similitudMin: number }>;
      stats: Record<string, number>;
    }>>(`${API_BASE_URL}/duplicates${q}`);
  }

  // Descartes: fileIds apartados de la galeria (nada se borra en disco).
  async getDescartes() {
    return this.fetchWithErrorHandling<ApiResponse<string[]>>(`${API_BASE_URL}/descartes`);
  }

  async setDescartes(fileIds: string[], descartar: boolean) {
    return this.fetchWithErrorHandling<ApiResponse<string[]>>(`${API_BASE_URL}/descartes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds, descartar }),
    });
  }

  // ── Copias exactas ─────────────────────────────────────────────────────
  // El mismo archivo en dos sitios. Nada se borra: solo se decide cual se ve.
  async getCopiasResumen() {
    return this.fetchWithErrorHandling<ApiResponse<CopiasResumen>>(`${API_BASE_URL}/copias/resumen`);
  }

  async getCopias(opts: { solo?: 'pendientes' | 'todas'; desde?: number; limite?: number } = {}) {
    const q = new URLSearchParams({
      solo: opts.solo || 'pendientes',
      desde: String(opts.desde || 0),
      limite: String(opts.limite || 60),
    });
    return this.fetchWithErrorHandling<ApiResponse<{
      resumen: CopiasResumen;
      total: number;
      grupos: CopiaGrupo[];
      pares: CopiasPar[];
    }>>(`${API_BASE_URL}/copias?${q}`);
  }

  async limpiarCopias() {
    return this.fetchWithErrorHandling<ApiResponse<{
      grupos: number; escondidas: number; huellas: string[]; lote: string; resumen: CopiasResumen;
    }>>(`${API_BASE_URL}/copias/limpiar`, { method: 'POST' });
  }

  async decidirCopia(huella: string, quedan: string[]) {
    return this.fetchWithErrorHandling<ApiResponse<{ resumen: CopiasResumen }>>(`${API_BASE_URL}/copias/decidir`, {
      method: 'POST',
      body: JSON.stringify({ huella, quedan }),
    });
  }

  /** Devuelve grupos a pendiente. Con `lote`, solo lo que decidio esa limpieza. */
  async olvidarCopias(huellas: string[], lote?: string) {
    return this.fetchWithErrorHandling<ApiResponse<CopiasResumen & { quitadas: number }>>(`${API_BASE_URL}/copias/olvidar`, {
      method: 'POST',
      body: JSON.stringify({ huellas, lote }),
    });
  }

  async buscarCopias() {
    return this.fetchWithErrorHandling<ApiResponse<CopiasResumen>>(`${API_BASE_URL}/copias/buscar`, { method: 'POST' });
  }

  // Disco de copia de seguridad: sus copias exactas se esconden solas.
  async setCopiaSeguridadRuta(pathId: string, copiaSeguridad: boolean) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths/${pathId}`, {
      method: 'PATCH',
      body: JSON.stringify({ copiaSeguridad }),
    });
  }

  // ── Material oculto (candado) ──────────────────────────────────────────
  // Ocultar no pide clave; ver o liberar si. La llave va en cabecera, nunca
  // en la URL, para que no quede en el historial.
  async getOcultosEstado() {
    return this.fetchWithErrorHandling<ApiResponse<{ total: number }>>(`${API_BASE_URL}/ocultos/estado`);
  }

  async ocultar(ids: string[]) {
    return this.fetchWithErrorHandling<ApiResponse<{ ocultados: number; deshacer: string | null; total: number }>>(`${API_BASE_URL}/ocultos/ocultar`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  // ── Los archivos de una persona ────────────────────────────────────────
  async getArchivosPersona(personId: string, alcance: 'todos' | 'sin_otros') {
    return this.fetchWithErrorHandling<ApiResponse<ArchivosPersona>>(
      `${API_BASE_URL}/personas/${encodeURIComponent(personId)}/archivos?alcance=${alcance}`,
    );
  }

  async ocultarArchivosPersona(personId: string, alcance: 'todos' | 'sin_otros') {
    return this.fetchWithErrorHandling<ApiResponse<{ ocultados: number; yaEstaban: number; deshacer: string | null }>>(
      `${API_BASE_URL}/personas/${encodeURIComponent(personId)}/ocultar`,
      { method: 'POST', body: JSON.stringify({ alcance }) },
    );
  }

  /** Mueve sus archivos a la papelera de Pensadero. `confirmacion`: su nombre, escrito. */
  async papeleraArchivosPersona(personId: string, alcance: 'todos' | 'sin_otros', confirmacion: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ lote: string | null; movidos: number; bytes: number; fallidos: Array<{ ruta: string; motivo: string }> }>>(
      `${API_BASE_URL}/personas/${encodeURIComponent(personId)}/papelera`,
      { method: 'POST', body: JSON.stringify({ alcance, confirmacion }) },
    );
  }

  async getOlvidadas() {
    return this.fetchWithErrorHandling<ApiResponse<{ total: number }>>(`${API_BASE_URL}/persons/olvidadas`);
  }

  /** Las caras olvidadas vuelven a proponerse como desconocidas. */
  async vaciarOlvidadas() {
    return this.fetchWithErrorHandling<ApiResponse<{ vaciadas: number }>>(`${API_BASE_URL}/persons/olvidadas`, { method: 'DELETE' });
  }

  // ── Papelera ───────────────────────────────────────────────────────────
  async getPapelera() {
    return this.fetchWithErrorHandling<ApiResponse<LotePapelera[]>>(`${API_BASE_URL}/papelera`);
  }

  async restaurarLote(lote: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ restaurados: number; pendientes: number; conflictos: string[] }>>(
      `${API_BASE_URL}/papelera/${encodeURIComponent(lote)}/restaurar`, { method: 'POST' },
    );
  }

  /** Borra de verdad. `confirmacion`: la palabra «vaciar», escrita. */
  async vaciarLote(lote: string, confirmacion: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ borrados: number; bytes: number; quedan: number }>>(
      `${API_BASE_URL}/papelera/${encodeURIComponent(lote)}/vaciar`,
      { method: 'POST', body: JSON.stringify({ confirmacion }) },
    );
  }

  async deshacerOcultado(token: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ mostrados: number; total: number }>>(`${API_BASE_URL}/ocultos/deshacer`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  async abrirOcultos(clave: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ llave: string; caduca: number }>>(`${API_BASE_URL}/ocultos/abrir`, {
      method: 'POST',
      body: JSON.stringify({ clave }),
    });
  }

  async cerrarOcultos(llave: string) {
    return this.fetchWithErrorHandling<ApiResponse<unknown>>(`${API_BASE_URL}/ocultos/cerrar`, {
      method: 'POST',
      headers: { 'x-llave-ocultos': llave },
    });
  }

  async listarOcultos(llave: string) {
    return this.fetchWithErrorHandling<ApiResponse<{
      files: MediaFile[];
      ausentes: Array<{ clave: string; nombre: string; desde: string }>;
      total: number;
    }>>(`${API_BASE_URL}/ocultos`, { headers: { 'x-llave-ocultos': llave } });
  }

  async mostrarOcultos(llave: string, ids: string[]) {
    return this.fetchWithErrorHandling<ApiResponse<{ mostrados: number; total: number }>>(`${API_BASE_URL}/ocultos/mostrar`, {
      method: 'POST',
      headers: { 'x-llave-ocultos': llave },
      body: JSON.stringify({ ids }),
    });
  }

  async cambiarClaveOcultos(actual: string, nueva: string) {
    return this.fetchWithErrorHandling<ApiResponse<unknown>>(`${API_BASE_URL}/ocultos/clave`, {
      method: 'POST',
      body: JSON.stringify({ actual, nueva }),
    });
  }

  // Personas agregadas (person_id, display_name, count, avatar_url). Mismo
  // endpoint que consume PersonBubbles; lo usa el grafo de personas.
  async getPersons() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/persons`);
  }

  // Paleta global de color: [{ color: hex, frequency, usage }] ordenada.
  async getColors() {
    return this.fetchWithErrorHandling<ApiResponse<{
      totalFiles: number;
      filesWithColors: number;
      globalPalette: Array<{ color: string; frequency: number; usage: number }>;
      dominantColors: Array<{ color: string; frequency: number; usage: number }>;
    }>>(`${API_BASE_URL}/colors`);
  }

  // =====================
  // Gestión de Rutas de Escaneo
  // =====================

  // Obtener todas las rutas configuradas
  async getScanPaths() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/scan-paths`);
  }

  // Añadir nueva ruta de escaneo
  async addScanPath(path: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  // Sincronizar una ruta específica
  async syncPath(pathId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths/${pathId}/sync`, {
      method: 'POST',
    });
  }

  // Cambiar la ubicacion de una biblioteca (otra letra de unidad, otra carpeta)
  // conservando su identidad: favoritos, notas y colecciones siguen con ella.
  async cambiarUbicacionRuta(pathId: string, path: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths/${pathId}`, {
      method: 'PATCH',
      body: JSON.stringify({ path }),
    });
  }

  // Cambiar estado activo/inactivo de una ruta
  async togglePath(pathId: string, isActive: boolean) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths/${pathId}/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  }

  // Trabajos del escaneo propios de una ruta: { caras: false } apaga solo aqui,
  // { caras: null } vuelve a heredar del global.
  async setEscaneoRuta(pathId: string, escaneo: Partial<Record<CapacidadEscaneo, boolean | null>>) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths/${pathId}`, {
      method: 'PATCH',
      body: JSON.stringify({ escaneo }),
    });
  }

  // Que trabajos hace un escaneo: catalogo, global y efectivas por ruta.
  async getCapacidades() {
    return this.fetchWithErrorHandling<ApiResponse<{
      catalogo: CapacidadInfo[];
      global: Record<CapacidadEscaneo, boolean>;
      rutas: Array<{ id: string; sobrescribe: Partial<Record<CapacidadEscaneo, boolean>>; efectivas: Record<CapacidadEscaneo, boolean> }>;
    }>>(`${API_BASE_URL}/scan/capacidades`);
  }

  async setCapacidadesGlobal(parcial: Partial<Record<CapacidadEscaneo, boolean>>) {
    return this.fetchWithErrorHandling<ApiResponse<{ global: Record<CapacidadEscaneo, boolean> }>>(`${API_BASE_URL}/scan/capacidades`, {
      method: 'PATCH',
      body: JSON.stringify({ global: parcial }),
    });
  }

  // Eliminar una ruta
  async removeScanPath(pathId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan-paths/${pathId}`, {
      method: 'DELETE',
    });
  }

  // Tag Management
  async updateTagCache(tagMapping: Record<string, string>) {
    // Guardar mapeo de etiquetas en cache local
    const existingCache = localStorage.getItem('tagCache') || '{}';
    const cache = JSON.parse(existingCache);
    const updatedCache = { ...cache, ...tagMapping };
    localStorage.setItem('tagCache', JSON.stringify(updatedCache));

    // Intentar sincronizar con el backend si está disponible
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/tags/cache`, {
        method: 'POST',
        body: JSON.stringify({ mapping: tagMapping }),
      });
    } catch (error) {
      // Si el backend no está disponible, solo usar cache local
      console.log('Tag cache saved locally');
      return { success: true, data: updatedCache };
    }
  }

  async getTagHistory() {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/tags/history`);
    } catch (error) {
      // Si el backend no está disponible, usar historial local
      const localHistory = localStorage.getItem('tagHistory');
      return { success: true, data: localHistory ? JSON.parse(localHistory) : [] };
    }
  }

  async bulkUpdateTags(updates: { fileIds: string[], addTags?: string[], removeTags?: string[] }) {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/tags/bulk-update`, {
        method: 'POST',
        body: JSON.stringify(updates),
      });
    } catch (error) {
      console.error('Error updating tags:', error);
      return { success: false, message: 'Error updating tags' };
    }
  }

  async updateCollection(collectionId: string, updates: { name?: string; description?: string; rules?: any[]; rule_combinator?: 'AND' | 'OR'; type?: 'static' | 'smart' }): Promise<ApiResponse<any>> {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections/${collectionId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
    } catch (error) {
      console.error('Error updating collection:', error);
      return { success: false, message: 'Error updating collection' };
    }
  }

  async deleteCollection(collectionId: string): Promise<ApiResponse<void>> {
    return this.fetchWithErrorHandling<ApiResponse<void>>(`${API_BASE_URL}/collections/${collectionId}`, {
      method: 'DELETE',
    });
  }

  async reorderCollections(orderedIds: string[]): Promise<ApiResponse<any>> {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/collections/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds }),
      });
    } catch (error) {
      console.error('Error reordering collections:', error);
      return { success: false, message: 'Error reordering collections' };
    }
  }

  // AI Search - Búsqueda con lenguaje natural
  async aiSearch(query: string): Promise<ApiResponse<any>> {
    try {
      console.log('🤖 AI Search request:', query);
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/ai/search`, {
        method: 'POST',
        body: JSON.stringify({ query }),
      });
    } catch (error) {
      console.error('❌ Error en AI Search:', error);
      throw error;
    }
  }

  // Health check del servicio de IA
  async aiHealthCheck(): Promise<ApiResponse<any>> {
    try {
      return await this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/ai/health`);
    } catch (error) {
      console.error('❌ Error en AI Health Check:', error);
      throw error;
    }
  }

  // Modelos de texto disponibles para "Natural" (lenguaje natural). Filtra
  // VLM y embedders.
  async aiModels() {
    return this.fetchWithErrorHandling<ApiResponse<{ models: string[]; current: string; filtered: boolean }>>(`${API_BASE_URL}/ai/models`);
  }

  // Cambia el modelo activo del buscador natural en runtime.
  async setAiModel(model: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ model: string }>>(`${API_BASE_URL}/ai/model`, {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    });
  }

  // ============================================
  // ESCANEO VISUAL CON VLM (NODO Visión B)
  // ============================================

  async scanHealth() {
    return this.fetchWithErrorHandling<ApiResponse<{ ollamaRunning: boolean; modelAvailable: boolean; model: string; error?: string }>>(`${API_BASE_URL}/scan/health`);
  }

  async clipHealth() {
    return this.fetchWithErrorHandling<ApiResponse<{ ready: boolean; inCooldown: boolean; cooldownUntil: number; consecutiveFailures: number; lastError: string | null; embeddingDim: number }>>(`${API_BASE_URL}/clip/health`);
  }

  async clipWarmup() {
    return this.fetchWithErrorHandling<ApiResponse<{ ok: boolean; error?: string; dim?: number }>>(`${API_BASE_URL}/clip/warmup`, {
      method: 'POST',
    });
  }

  async startScan(path: string, force: boolean = false) {
    return this.fetchWithErrorHandling<ApiResponse<any> & { jobId?: string }>(`${API_BASE_URL}/scan/start`, {
      method: 'POST',
      body: JSON.stringify({ path, force }),
    });
  }

  async listScanJobs() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/scan/jobs`);
  }

  // Escanea visualmente UN solo archivo (boton de la tarjeta). Sincrono: la
  // respuesta llega cuando el escaneo ha terminado y la memoria esta refrescada.
  async scanFile(path: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ written: number; done: number }>>(
      `${API_BASE_URL}/scan/file`,
      { method: 'POST', body: JSON.stringify({ path }) }
    );
  }

  async scanStatus(jobId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan/status/${jobId}`);
  }

  async cancelScan(jobId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan/cancel/${jobId}`, {
      method: 'POST',
    });
  }

  async startScanAll(force: boolean = false) {
    // `items` casa cada jobId con SU ruta (casarlos por posicion fallaba).
    return this.fetchWithErrorHandling<ApiResponse<any> & { jobIds?: string[]; items?: Array<{ pathId: string; path: string; jobId: string }>; count?: number; force?: boolean }>(
      `${API_BASE_URL}/scan/start-all`,
      { method: 'POST', body: JSON.stringify({ force }) }
    );
  }

  async cancelScanAll() {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan/cancel-all`, {
      method: 'POST',
    });
  }

  async scanBatchStatus() {
    return this.fetchWithErrorHandling<ApiResponse<{ running: boolean; aborted: boolean; total: number; processed: number; currentPathId: string | null; currentJobId: string | null; force: boolean; startedAt: string | null }>>(`${API_BASE_URL}/scan/batch-status`);
  }

  async scanModels() {
    return this.fetchWithErrorHandling<ApiResponse<{ models: VlmModel[]; current: string; filtered: boolean }>>(`${API_BASE_URL}/scan/models`);
  }

  async setScanModel(model: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ model: string }>>(`${API_BASE_URL}/scan/model`, {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    });
  }

  /**
   * Lista las subcarpetas con material bajo `path`, junto con el estado del
   * `_contexto.md` de cada una. Alimenta el modal de contexto previo al scan.
   */
  async scanInventory(folderPath: string) {
    const qs = new URLSearchParams({ path: folderPath }).toString();
    return this.fetchWithErrorHandling<ApiResponse<{
      root: string;
      rootContext: { meta: Record<string, any>; body: string } | null;
      folders: Array<{
        dir: string;
        relPath: string;
        mediaCount: number;
        imageCount: number;
        videoCount: number;
        hasContext: boolean;
        context: { meta: Record<string, any>; body: string } | null;
        folderName: string | null;
        // Cobertura de escaneo visual de los archivos DIRECTOS de la carpeta.
        visualTotal: number;
        visualScanned: number;
        // A cuantos les falta algun trabajo encendido ahora (no solo descripcion).
        pendientes?: number;
      }>;
    }>>(`${API_BASE_URL}/scan/inventory?${qs}`);
  }

  /**
   * Asigna el nombre de presentacion de una carpeta (display name). Todos sus
   * archivos lo heredan, con enumeracion "_NNN" si hay mas de uno. El archivo
   * fisico no se modifica. `displayName` vacio/null restaura el original.
   */
  async setFolderName(folderPath: string, displayName: string | null) {
    return this.fetchWithErrorHandling<ApiResponse<{ displayName: string | null }>>(`${API_BASE_URL}/folders/name`, {
      method: 'POST',
      body: JSON.stringify({ folderPath, displayName }),
    });
  }

  /**
   * Guarda (o sobrescribe, o borra si todo viene vacío) el `_contexto.md`
   * de la carpeta indicada.
   */
  async saveScanContext(folderPath: string, context: Record<string, any> | null) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/scan/context`, {
      method: 'POST',
      body: JSON.stringify({ folderPath, context }),
    });
  }

  // ============================================
  // GESTIÓN DE PERSONAS (registry CRUD + fotos)
  // ============================================

  async listPersonsRegistry() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/persons/registry`);
  }

  async upsertPerson(person: { person_id: string; display_name?: string; aliases?: string[]; avatar_path?: string }) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/registry`, {
      method: 'POST',
      body: JSON.stringify(person),
    });
  }

  // ── Grupos de personas ("Familia"...) ────────────────────────────────────
  async getGrupos() {
    return this.fetchWithErrorHandling<ApiResponse<GrupoPersonas[]>>(`${API_BASE_URL}/grupos`);
  }

  async crearGrupo(datos: { nombre: string; miembros: string[] }) {
    return this.fetchWithErrorHandling<ApiResponse<GrupoPersonas>>(`${API_BASE_URL}/grupos`, {
      method: 'POST',
      body: JSON.stringify(datos),
    });
  }

  async actualizarGrupo(id: string, parcial: Partial<Pick<GrupoPersonas, 'nombre' | 'miembros' | 'minimo' | 'modo'>>) {
    return this.fetchWithErrorHandling<ApiResponse<GrupoPersonas>>(`${API_BASE_URL}/grupos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(parcial),
    });
  }

  async borrarGrupo(id: string) {
    return this.fetchWithErrorHandling<ApiResponse<unknown>>(`${API_BASE_URL}/grupos/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /**
   * olvidar: ademas de borrar la ficha, guarda su huella para que el
   * descubrimiento de caras no la vuelva a proponer como desconocida.
   */
  async deletePerson(personId: string, olvidar = false) {
    return this.fetchWithErrorHandling<ApiResponse<any> & { olvidada?: boolean }>(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}${olvidar ? '?olvidar=1' : ''}`, {
      method: 'DELETE',
    });
  }

  async listPersonPhotos(personId: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ filename: string; url: string }[]>>(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/photos`);
  }

  /**
   * Sube una foto de referencia para una persona. El backend devuelve el
   * filename asignado y la URL pública.
   */
  async uploadPersonPhoto(personId: string, file: File) {
    const formData = new FormData();
    formData.append('photo', file);
    const response = await fetch(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/photos`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      try { const j = await response.json(); if (j.error) errMsg = j.error; } catch {}
      throw new Error(errMsg);
    }
    return response.json();
  }

  async deletePersonPhoto(personId: string, filename: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/photos/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
    });
  }

  async setPersonAvatar(personId: string, filename: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/avatar`, {
      method: 'POST',
      body: JSON.stringify({ filename }),
    });
  }

  async trainPerson(personId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/train`, {
      method: 'POST',
    });
  }

  async assignFace(personId: string, payload: { folder: string; basename: string; face_index: number }) {
    return this.fetchWithErrorHandling<ApiResponse<{ person_id: string; display_name: string }>>(
      `${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/assign-face`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  }

  /**
   * Fusiona dos personas: `loserId` se funde en `survivorId` (mezcla centroides,
   * copia fotos, reasigna caras en catalogos, borra el perdedor).
   */
  async mergePersons(survivorId: string, loserId: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ survivor_id: string; loser_id: string; photos_copied: number }>>(
      `${API_BASE_URL}/persons/registry/merge`,
      {
        method: 'POST',
        body: JSON.stringify({ survivor_id: survivorId, loser_id: loserId }),
      }
    );
  }

  /**
   * Fija el avatar de una persona recortando una deteccion concreta de la
   * biblioteca (cualquier aparicion visible), sin subir foto de referencia.
   */
  async setPersonAvatarFromDetection(personId: string, payload: { folder: string; basename: string; face_index: number }) {
    return this.fetchWithErrorHandling<ApiResponse<{ avatar_path: string }>>(
      `${API_BASE_URL}/persons/registry/${encodeURIComponent(personId)}/avatar-from-detection`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  }

  async faceServiceStatus() {
    return this.fetchWithErrorHandling<ApiResponse<{ ready: boolean; unavailable: boolean; lastError: string | null; threshold: number; trainedPersons: number }>>(`${API_BASE_URL}/persons/face-service/status`);
  }

  // ============================================
  // GESTION DE ESPACIOS (registry CRUD + fotos + training CLIP)
  // ============================================

  async listSpacesRegistry() {
    return this.fetchWithErrorHandling<ApiResponse<any[]>>(`${API_BASE_URL}/spaces/registry`);
  }

  async upsertSpace(space: { space_id: string; display_name?: string; aliases?: string[]; cover_image_path?: string }) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/spaces/registry`, {
      method: 'POST',
      body: JSON.stringify(space),
    });
  }

  async deleteSpace(spaceId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/spaces/registry/${encodeURIComponent(spaceId)}`, {
      method: 'DELETE',
    });
  }

  async listSpacePhotos(spaceId: string) {
    return this.fetchWithErrorHandling<ApiResponse<{ filename: string; url: string }[]>>(`${API_BASE_URL}/spaces/registry/${encodeURIComponent(spaceId)}/photos`);
  }

  async uploadSpacePhoto(spaceId: string, file: File) {
    const formData = new FormData();
    formData.append('photo', file);
    const response = await fetch(`${API_BASE_URL}/spaces/registry/${encodeURIComponent(spaceId)}/photos`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      try { const j = await response.json(); if (j.error) errMsg = j.error; } catch {}
      throw new Error(errMsg);
    }
    return response.json();
  }

  async deleteSpacePhoto(spaceId: string, filename: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/spaces/registry/${encodeURIComponent(spaceId)}/photos/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
    });
  }

  async setSpaceCover(spaceId: string, filename: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/spaces/registry/${encodeURIComponent(spaceId)}/cover`, {
      method: 'POST',
      body: JSON.stringify({ filename }),
    });
  }

  async trainSpace(spaceId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/spaces/registry/${encodeURIComponent(spaceId)}/train`, {
      method: 'POST',
    });
  }

  async clipServiceStatus() {
    return this.fetchWithErrorHandling<ApiResponse<{ ready: boolean; unavailable: boolean; lastError: string | null; embeddingDim: number; trainedSpaces: number }>>(`${API_BASE_URL}/spaces/clip-service/status`);
  }

  async getSpacesSettings() {
    return this.fetchWithErrorHandling<ApiResponse<{ match_threshold: number; default_threshold: number }>>(`${API_BASE_URL}/spaces/settings`);
  }

  async setSpacesThreshold(value: number) {
    return this.fetchWithErrorHandling<ApiResponse<{ match_threshold: number }>>(`${API_BASE_URL}/spaces/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ match_threshold: value }),
    });
  }

  async reidentifySpaces() {
    return this.fetchWithErrorHandling<ApiResponse<any> & { jobId?: string }>(`${API_BASE_URL}/spaces/reidentify`, {
      method: 'POST',
    });
  }

  async reidentifyAll() {
    return this.fetchWithErrorHandling<ApiResponse<any> & { jobId?: string }>(`${API_BASE_URL}/persons/reidentify`, {
      method: 'POST',
    });
  }

  async reidentifyStatus(jobId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/reidentify/status/${jobId}`);
  }

  async cancelReidentify(jobId: string) {
    return this.fetchWithErrorHandling<ApiResponse<any>>(`${API_BASE_URL}/persons/reidentify/cancel/${jobId}`, {
      method: 'POST',
    });
  }

  // ============================================
  // BUSQUEDA POR COLOR — alimenta la rueda HSL del frontend
  // ============================================

  // ============================================
  // SINONIMOS — alias table para expandir queries
  // ============================================

  async getAllCorpusTags() {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ tag: string; count: number }>> & { count: number }>(
      `${API_BASE_URL}/tags/all`
    );
  }

  async getAliasGroups() {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ canonical: string; aliases: string[] }>>>(
      `${API_BASE_URL}/tags/aliases`
    );
  }

  async proposeAliases(tags?: string[]) {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ canonical: string; aliases: string[] }>> & { count: number }>(
      `${API_BASE_URL}/tags/aliases/propose`,
      {
        method: 'POST',
        body: JSON.stringify(tags ? { tags } : {}),
      }
    );
  }

  async saveAliasGroups(groups: Array<{ canonical: string; aliases: string[] }>) {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ canonical: string; aliases: string[] }>>>(
      `${API_BASE_URL}/tags/aliases/save`,
      {
        method: 'POST',
        body: JSON.stringify({ groups }),
      }
    );
  }

  async upsertAliasGroup(group: { canonical: string; aliases: string[] }) {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ canonical: string; aliases: string[] }>>>(
      `${API_BASE_URL}/tags/aliases/upsert`,
      {
        method: 'POST',
        body: JSON.stringify(group),
      }
    );
  }

  async deleteAliasGroup(canonical: string) {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ canonical: string; aliases: string[] }>>>(
      `${API_BASE_URL}/tags/aliases/${encodeURIComponent(canonical)}`,
      { method: 'DELETE' }
    );
  }

  // ============================================
  // SMART FOLDERS — preview de reglas
  // ============================================

  async previewCollectionRules(rules: any[], rule_combinator: 'AND' | 'OR' = 'AND') {
    return this.fetchWithErrorHandling<{ count: number; total: number; sample: string[] }>(
      `${API_BASE_URL}/collections/preview-rules`,
      {
        method: 'POST',
        body: JSON.stringify({ rules, rule_combinator }),
      }
    );
  }

  /**
   * Sube una imagen o un video y devuelve los archivos visibles mas parecidos
   * (CLIP). De un video se miran varios momentos. Threshold de similitud
   * opcional (0-1, cosine). max=N limita resultados. `signal` la cancela.
   */
  async searchByImage(file: File, max: number = 100, minSimilarity: number = 0, signal?: AbortSignal) {
    const formData = new FormData();
    formData.append('image', file);
    const params = new URLSearchParams({ max: String(max), minSimilarity: String(minSimilarity) });
    const response = await fetch(`${API_BASE_URL}/search/by-image?${params.toString()}`, {
      method: 'POST',
      body: formData,
      signal,
    });
    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      try { const j = await response.json(); if (j.error) errMsg = j.error; } catch {}
      throw new Error(errMsg);
    }
    return response.json() as Promise<{
      success: boolean;
      data: Array<{ fileId: string; similarity: number; name: string; type: string }>;
      count: number;
      totalIndexed: number;
      consulta?: { tipo: 'imagen' | 'video'; fotogramas: number };
    }>;
  }

  /**
   * Busca archivos por descripcion en lenguaje natural (SigLIP-2 multilingue).
   * El texto se codifica al mismo espacio que los embeddings de imagenes.
   */
  async searchByText(query: string, max: number = 100, minSimilarity: number = 0) {
    return this.fetchWithErrorHandling<ApiResponse<Array<{ fileId: string; similarity: number; name: string; type: string }>> & { count: number; totalIndexed: number; query: string }>(
      `${API_BASE_URL}/search/by-text`,
      {
        method: 'POST',
        body: JSON.stringify({ query, max, minSimilarity }),
      }
    );
  }

  async searchByColor(hex: string, threshold: number = 30, max: number = 500) {
    const params = new URLSearchParams({
      hex,
      threshold: String(threshold),
      max: String(max),
    });
    return this.fetchWithErrorHandling<ApiResponse<Array<{
      fileId: string;
      name: string;
      distance: number;
      matchedHex: string;
      matchedName: string;
    }>> & { count: number; totalMatched: number; threshold: number; targetHex: string }>(
      `${API_BASE_URL}/search/by-color?${params.toString()}`
    );
  }

  // ============================================
  // CLUSTERING DE CARAS DESCONOCIDAS
  // ============================================

  async listFaceClusters() {
    return this.fetchWithErrorHandling<ApiResponse<{ clusters: any[]; computedAt: number; fromCache: boolean }> & { jobId?: string; status?: string }>(`${API_BASE_URL}/persons/clusters`);
  }

  async refreshFaceClusters() {
    return this.fetchWithErrorHandling<ApiResponse<any> & { jobId?: string }>(`${API_BASE_URL}/persons/clusters/refresh`, {
      method: 'POST',
    });
  }

  faceClusterSampleUrl(clusterId: string, index: number): string {
    return `${API_BASE_URL}/persons/clusters/${encodeURIComponent(clusterId)}/sample/${index}`;
  }

  async promoteFaceCluster(clusterId: string, payload: {
    person_id: string;
    display_name?: string;
    aliases?: string[];
    excluded_sample_indices?: number[];
    avatar_sample_index?: number;     // sample elegido como avatar
    attach_to_existing?: boolean;     // adjuntar a persona ya registrada
  }) {
    return this.fetchWithErrorHandling<ApiResponse<{ person_id: string; display_name: string; face_count: number; avatar_path: string | null; attached?: boolean }>>(
      `${API_BASE_URL}/persons/clusters/${encodeURIComponent(clusterId)}/promote`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  }

  async seedFaceCluster(payload: { folder: string; basename: string; face_index: number; threshold?: number }) {
    return this.fetchWithErrorHandling<ApiResponse<{
      cluster_id: string;
      face_count: number;
      avg_score: number;
      dominant_age: string | null;
      dominant_gender: string | null;
      sample_count: number;
      samples_meta?: Array<{ folder: string; basename: string; det_score: number }>;
    }>>(
      `${API_BASE_URL}/persons/clusters/seed-from-face`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  }

  async listClusterSimilarityGroups(threshold?: number) {
    const qs = typeof threshold === 'number' ? `?threshold=${threshold}` : '';
    return this.fetchWithErrorHandling<ApiResponse<{
      groups: Array<{ group_id: string; cluster_ids: string[]; max_similarity: number }>;
      ungrouped: string[];
    }>>(
      `${API_BASE_URL}/persons/clusters/similarity${qs}`,
      { method: 'GET' }
    );
  }

  async mergeFaceClusters(clusterIds: string[]) {
    return this.fetchWithErrorHandling<ApiResponse<{
      cluster_id: string;
      face_count: number;
      avg_score: number;
      dominant_age: string | null;
      dominant_gender: string | null;
      sample_count: number;
    }>>(
      `${API_BASE_URL}/persons/clusters/merge`,
      {
        method: 'POST',
        body: JSON.stringify({ cluster_ids: clusterIds }),
      }
    );
  }
}

export const api = new ApiService();

/**
 * =====================================================================
 * FAVORITOS Y COLECCIONES — Backend Node local (single-user, sin auth)
 * =====================================================================
 *
 * Estas funciones reemplazan el antiguo cliente Supabase. Llaman al
 * backend Node a través de los endpoints REST locales.
 *
 * Endpoints asumidos (deben existir en el backend; si faltan, hay que
 * implementarlos en favoritesManager.js / collectionsManager.js):
 *
 *   FAVORITOS
 *     GET    /api/favorites                       → array de favoritos
 *     POST   /api/favorites/toggle  body {fileId} → toggle de un fileId
 *
 *   COLECCIONES
 *     GET    /api/collections                              → array
 *     POST   /api/collections        body {name, coverImage?, files?}  → created
 *     PATCH  /api/collections/:id    body {name?, coverImage?}         → updated
 *     DELETE /api/collections/:id                                       → ok
 *     POST   /api/collections/:id/files     body {fileIds}              → add
 *     DELETE /api/collections/:id/files     body {fileIds}              → remove
 *
 * NOTA: las firmas exportadas se conservan para no romper a los
 * consumidores (App.tsx). Los parámetros `user_id` que existían se
 * ignoran — single-user.
 */

import { normalizePath } from '../utils/formatData';

const FAVORITES_BASE = `${API_BASE_URL}/favorites`;
const COLLECTIONS_BASE = `${API_BASE_URL}/collections`;

// Helper interno para llamadas JSON al backend con manejo uniforme.
async function backendFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const errorData = await response.json();
      message = errorData.message || errorData.error || message;
    } catch {
      // sin body JSON
    }
    const err: any = new Error(message);
    err.status = response.status;
    throw err;
  }
  // Algunos endpoints DELETE pueden devolver vacío
  const text = await response.text();
  return (text ? JSON.parse(text) : ({} as T)) as T;
}

/**
 * Obtiene los favoritos del usuario.
 * En single-user no hay user_id real: el parámetro se ignora.
 * Devuelve la misma forma que antes: { success, data: any[] | null }.
 *
 * El backend puede devolver bien un array de strings (paths/ids) o un
 * array de objetos con `photo_url`. Normalizamos la salida a objetos
 * con `photo_url` para mantener compatibilidad con App.tsx.
 */
export const getFavouritesByUser = async (_user_id?: string) => {
  try {
    const data = await backendFetch<any>(FAVORITES_BASE);

    // Acepta varias formas de respuesta del backend
    let raw: any[] = [];
    if (Array.isArray(data)) {
      raw = data;
    } else if (Array.isArray(data?.data)) {
      raw = data.data;
    } else if (Array.isArray(data?.favorites)) {
      raw = data.favorites;
    }

    const normalized = raw.map((item: any) => {
      if (typeof item === 'string') {
        return { photo_url: item, access_url: item };
      }
      return {
        ...item,
        photo_url: item.photo_url ?? item.fileId ?? item.path ?? '',
        access_url: item.access_url ?? item.path ?? item.photo_url ?? '',
      };
    });

    return { success: true, data: normalized };
  } catch (error) {
    console.error('Error obteniendo los favoritos del backend:', error);
    return { success: false, data: null };
  }
};

/**
 * Alterna el favorito de un archivo en el servidor, identificado por su ruta
 * normalizada (el `fullPath` que ya tiene el frontend).
 *
 * `_user_id` se ignora (single-user); se conserva la firma.
 * Devuelve la lista actualizada de favoritos.
 */
export const alternarFavorito = async (
  file: string,
  _user_id: string,
  userFavs: any[]
) => {
  try {
    const normalized = normalizePath(file);

    await backendFetch(`${FAVORITES_BASE}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ fileId: normalized }),
    });

    // Actualización local optimista a partir de la lista previa
    const newFavs = [...userFavs];
    const idx = newFavs.findIndex(
      (f) => normalizePath(f.photo_url) === normalized
    );
    if (idx !== -1) {
      newFavs.splice(idx, 1);
    } else {
      newFavs.push({ photo_url: normalized, access_url: file });
    }

    return newFavs;
  } catch (error) {
    console.error('Error al actualizar favorito en backend:', error);
    return userFavs;
  }
};

/**
 * Crea una colección en el backend.
 * Mantiene la firma original con (newCollection, user_id) — user_id se ignora.
 */
export const createCollection = async (newCollection: any, _user_id?: string) => {
  try {
    const body: any = {
      name: newCollection.name,
      coverImage: newCollection.coverImage,
      coverType: newCollection.coverType,
    };
    if (Array.isArray(newCollection.mediaFiles) && newCollection.mediaFiles.length > 0) {
      body.files = newCollection.mediaFiles;
    }
    // Smart Folder: incluir type/rules/rule_combinator si vienen
    if (newCollection.type === 'smart' && Array.isArray(newCollection.rules)) {
      body.type = 'smart';
      body.rules = newCollection.rules;
      body.rule_combinator = newCollection.rule_combinator || 'AND';
    }

    const data = await backendFetch<any>(COLLECTIONS_BASE, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return { success: true, data: data?.data ?? data };
  } catch (error) {
    console.error('Error en createCollection:', error);
    // El motivo del servidor ("Ya existe una colección con ese nombre") viaja
    // con el fallo: la pantalla lo enseña en vez de callarlo.
    return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Lista todas las colecciones (single-user).
 * Mantiene la firma original; user_id se ignora.
 * Cada colección incluye `mediaFiles` como array de identificadores.
 */
export const getCollectionsByUser = async (_user_id?: string) => {
  try {
    const data = await backendFetch<any>(COLLECTIONS_BASE);

    let raw: any[] = [];
    if (Array.isArray(data)) {
      raw = data;
    } else if (Array.isArray(data?.data)) {
      raw = data.data;
    } else if (Array.isArray(data?.collections)) {
      raw = data.collections;
    }

    // Normalizamos: si el backend devuelve `collections_content`, lo
    // aplanamos a `mediaFiles` como hacía el cliente Supabase.
    const collections = raw.map((c: any) => {
      let mediaFiles = c.mediaFiles ?? c.files ?? [];
      if (!mediaFiles.length && Array.isArray(c.collections_content)) {
        mediaFiles = c.collections_content.map((cc: any) => cc.mediaFile);
      }
      return { ...c, mediaFiles };
    });

    return { success: true, data: collections };
  } catch (error) {
    console.error('Error obteniendo colecciones del backend:', error);
    return { success: false, data: null };
  }
};

/**
 * Añade archivos a una colección. Acepta lista de IDs (o paths normalizados).
 */
export const addFilesToCollection = async (collectionId: string, fileIds: string[]) => {
  try {
    const data = await backendFetch<any>(
      `${COLLECTIONS_BASE}/${collectionId}/files`,
      {
        method: 'POST',
        body: JSON.stringify({ fileIds }),
      }
    );
    return { success: true, data: data?.data ?? data };
  } catch (error) {
    console.error('Error al añadir archivos a la colección:', error);
    return { success: false, data: null };
  }
};

/**
 * Actualiza la imagen de portada de una colección.
 */
export const updateCoverCollection = async (collectionId: string, coverImage: string) => {
  try {
    const data = await backendFetch<any>(`${COLLECTIONS_BASE}/${collectionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ coverImage }),
    });
    return { success: true, data: data?.data ?? data };
  } catch (error) {
    console.error('Error al actualizar la portada de la colección:', error);
    return { success: false, data: null };
  }
};

/**
 * Renombra una colección.
 */
export const updateNameCollection = async (collectionId: string, name: string) => {
  try {
    const data = await backendFetch<any>(`${COLLECTIONS_BASE}/${collectionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    return { success: true, data: data?.data ?? data };
  } catch (error) {
    console.error('Error al actualizar el nombre de la colección:', error);
    return { success: false, data: null };
  }
};

/**
 * Elimina un archivo concreto de una colección.
 * Acepta el mismo `mediaFile` (path o id) que se almacenó al añadirlo.
 */
export const deleteFromCollection = async (collectionId: string, mediaFile: string) => {
  const normalizedPath = normalizePath(mediaFile);
  try {
    await backendFetch(`${COLLECTIONS_BASE}/${collectionId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ fileIds: [normalizedPath] }),
    });
    return { success: true };
  } catch (error) {
    console.error('Error al eliminar el archivo de la colección:', error);
    return { success: false };
  }
};

/**
 * Elimina por completo una colección (y todo su contenido).
 */
export const deleteCollection = async (collectionId: string) => {
  try {
    await backendFetch(`${COLLECTIONS_BASE}/${collectionId}`, {
      method: 'DELETE',
    });
    return { success: true };
  } catch (error) {
    console.error('Error al eliminar la colección:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
};