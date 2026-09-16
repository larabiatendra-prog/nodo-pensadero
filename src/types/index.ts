// Uso personal single-user: User queda como interfaz vacía con
// displayName opcional por compatibilidad con componentes legados
// (Sidebar, BottomBar, UserFloatingButton). Ya no se usa para auth.
export interface User {
  displayName?: string;
}


// Cara/persona detectada en un MediaFile (schema canónico del backend)
export interface MediaFace {
  person_id: string;
  display_name: string;
  confidence?: number;
}

// Bounding box de una cara fisica detectada en la imagen. Cuando person_id
// es null, la cara fue detectada pero no se ha identificado con nadie del
// registry todavia. Las coords del bbox son en pixeles de la imagen original.
export interface FaceBox {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  person_id: string | null;
  display_name: string | null;
  det_score: number | null;
  confidence: number | null;
  age: number | null;
  gender: number | null;
  frame_time?: number | null; // segundo del video de esta deteccion (multi-frame); null/ausente en fotos y catalogos antiguos
  face_index?: number; // posicion original en identity.detections[] del catalog
}

// Persona agregada devuelta por GET /api/persons
export interface Person {
  person_id: string;
  display_name: string;
  count: number;
  avatar_url: string | null;
}

export interface MediaFile {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio' | 'export';
  url: string;
  thumbnail: string;
  size: number;
  createdAt: Date;
  tags: string[];
  extractedDate?: Date; // Date extracted from filename (e.g., YY-MM-DD format)
  description?: string;
  duration?: number; // for video/audio
  dimensions?: { width: number; height: number }; // for images/videos
  isFavorite?: boolean;
  fullPath?:string
  // Nombre de presentacion heredado de la carpeta (folder_names.json). El
  // archivo fisico no se toca; esto es solo capa de presentacion. Cuando la
  // carpeta tiene >1 archivo lleva sufijo "_NNN". Dispara agrupacion en sesion.
  displayName?: string;
  folderIndex?: number;  // posicion 1..N dentro de la carpeta con override
  folderTotal?: number;  // total de archivos de la carpeta con override
  // Rastro de carpetas del archivo tal cual esta en disco ("260811_Ondara", o
  // "260811_Ondara / clips"), o el nombre propio si lo tiene. Lo rellena el
  // backend; hace buscable el material de camara por su evento, no por "P1248278".
  folderName?: string;
  // Identidad portable "<libraryId>:<ruta/relativa/normalizada>" (ver
  // backend/utils/mediaIdentity.js). El backend ya la enviaba; se declara aqui
  // porque la agrupacion en sesiones deriva de ella la clave de carpeta.
  mediaKey?: string;
  libraryId?: string;
  relativePath?: string;
  // Campos enriquecidos del catalog (_marina.json) — opcionales
  visual_description?: string;
  ocr_text?: string;
  composition?: {
    shot_type?: string;
    people_framing?: string;
    [key: string]: unknown;
  };
  atmosphere?: {
    mood?: string;
    lighting?: string;
    space_type?: string;
    time_of_day?: string;
    style?: string;
    [key: string]: unknown;
  };
  demographics?: Record<string, unknown>;
  technical?: Record<string, unknown>;
  faces?: MediaFace[];
  face_boxes?: FaceBox[];
  // Solo en videos: segundo del video donde se hizo la deteccion facial.
  // El visor muestra los bboxes solo cuando currentTime esta cerca de este valor.
  detection_frame_time?: number;
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  coverImage?: string; // URL to custom cover image or mediaFile ID for system image
  coverType?: 'system' | 'custom'; // Type of cover image
  isPublic: boolean;
  createdBy: string;
  mediaFiles: string[];
  createdAt: Date;
  updatedAt: Date;
  // Smart Folder: type='smart' indica que mediaFiles se resuelve al vuelo
  // desde rules + rule_combinator. type='static' o ausente = coleccion manual.
  type?: 'static' | 'smart';
  rules?: Array<{ field: string; op: string; value: any }>;
  rule_combinator?: 'AND' | 'OR';
}

export interface SearchFilters {
  type?: 'image' | 'video' | 'audio' | 'all';
  selectedTypes?: string[]; // For multiple type selection
  exports?: boolean; // Filter by files containing "Edit" in filename
  tags?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  year?: string; // Filter by year extracted from filename
  month?: string; // Filter by month extracted from filename
  favorites?: boolean;
  collection?: string;
  // Terminos de busqueda de texto libre (chips grises). Se combinan en AND
  // entre si y con los tags. Cada termino filtra por substring sobre
  // name/displayName/tags. Distinto de `tags` (coincidencia exacta).
  textTerms?: string[];
}

export type VideoItem = {
  id: string;
  name: string;
  url: string;        // URL del vídeo original
  thumbnail: string;  // Imagen estática
  duration?: number;
  width?: number;
  height?: number;
};

