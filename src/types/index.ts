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
  // Campos enriquecidos del catalog (_marina.json) — opcionales
  visual_description?: string;
  ocr_text?: string;
  composition?: {
    shot_type?: string;
    people_framing?: string;
    [key: string]: unknown;
  };
  faces?: MediaFace[];
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

