# Pensadero — Backend

Servidor backend single-user (sin auth) para Pensadero, gestor personal de
biblioteca multimedia.

## Arranque

```bash
cd backend
npm install
npm run dev      # con nodemon
# o
npm start
```

Por defecto escucha en `http://localhost:5000` y WebSocket en `ws://localhost:5000/ws`.

## Variables de entorno (`backend/.env`)

```env
PORT=5000
CONTENT_DIR=C:\WORK\Pensadero
SERVER_URL=http://localhost:5000
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
PERSONS_REGISTRY=
PERSONS_AVATARS_BASE=
```

| Variable               | Descripción                                                      |
|------------------------|------------------------------------------------------------------|
| `PORT`                 | Puerto HTTP/WebSocket                                            |
| `CONTENT_DIR`          | Carpeta raíz a escanear si `scan_paths.json` está vacío          |
| `SERVER_URL`           | URL pública (sin barra final) usada en URLs de thumbnails/stream |
| `OLLAMA_HOST`          | Host de Ollama (búsqueda en lenguaje natural)                    |
| `OLLAMA_MODEL`         | Modelo LLM para parsear consultas                                |
| `PERSONS_REGISTRY`     | Ruta absoluta a `people_registry.json` (vacío = sin registry)    |
| `PERSONS_AVATARS_BASE` | Carpeta base para `avatar_path` relativos (vacío = `dirname(PERSONS_REGISTRY)`) |

`scan_paths.json` (en la raíz del backend) guarda rutas adicionales que el
usuario añade desde la UI. Empieza vacío `[]`. Cada entrada tiene la forma:

```json
{
  "id": "abc123",
  "path": "E:\\Mi Biblioteca",
  "isActive": true,
  "lastScan": "2026-05-04T...",
  "fileCount": 0,
  "status": "connected"
}
```

## Catalog y sidecars

El backend lee opcionalmente metadatos enriquecidos de la herramienta
externa **Marina Video Batch personal**. Soporta dos formatos:

1. **Catálogo por carpeta**: `_marina.json` o `_pensadero.json` con
   estructura `{ clips | photos | audios: { <basename>: {...} } }`. La
   clave de envoltorio depende del tipo de media; el primer match gana
   sin merge. Si están los dos archivos en la misma carpeta, prevalece
   `_marina.json`.
2. **Sidecar individual** junto al archivo: `<archivo.ext>.json` o
   `<archivo>.json`. Mismo schema (puede ser un clip directo sin envoltorio
   `{ clips: {...} }`, en cuyo caso se trata como tal).

Para cada `MediaFile`, el lookup es:
1. catálogo por carpeta (`_marina.json` → `_pensadero.json`)
2. sidecar `<archivo.ext>.json`
3. sidecar `<archivo>.json`

**Primer match gana, sin merge entre fuentes** (evita ambigüedad).

### Ubicación

Para una carpeta `D:\Brutos\BatchX\` que contiene clips, el backend busca
primero `D:\Brutos\BatchX\_marina.json` (no recursivo hacia arriba). Cada
clip físico se busca en `catalog.clips` por su **basename** exacto.

### Formato real

```json
{
  "version": 1,
  "batch": "EDEM_Alumni - Triple A - 260423_Reencuentro, 15x15",
  "processed": "2026-04-28T10:31:50",
  "clips": {
    "EDEM_Alumni - Triple A - 260423_Reencuentro, 15x15_0001.mp4": {
      "description": "a close up of a table with many business cards on it",
      "technical": {
        "duration": 3.37,
        "resolution": "3840x2160",
        "fps": 29.97,
        "codec": "h264",
        "aspect_ratio": "16:9",
        "slowmo_applied": false,
        "movement_type": "static",
        "avg_focus": 0.0,
        "avg_shake": 0.0,
        "exposure": "under"
      },
      "identity": {
        "faces": [],
        "face_count": 0,
        "spaces": [{ "id": "Auditorio", "name": "Auditorio", "confidence": 0.0 }]
      },
      "demographics": { "age_ranges": [], "genders": [], "attire": "" },
      "composition": { "shot_type": "plano_general", "people_framing": "ninguno" },
      "semantics": {
        "objects": ["libro"],
        "expressions": [],
        "actions": [],
        "dominant_colors": [],
        "text": ["to", "Rcardo", "savodor"]
      }
    }
  }
}
```

### Mapeo a `MediaFile`

| Origen en el clip                                      | Destino en MediaFile        |
|--------------------------------------------------------|-----------------------------|
| `description`                                          | `visual_description`        |
| `semantics.objects + actions + expressions`            | concatenado a `tags[]`      |
| `composition.shot_type`                                | `tags[]` y `composition`    |
| `composition.people_framing`                           | `tags[]` y `composition`    |
| `demographics.age_ranges[]`                            | `tags[]` y `demographics`   |
| `demographics.genders[]`                               | `tags[]` y `demographics`   |
| `demographics.attire`                                  | `tags[]` y `demographics`   |
| `semantics.text[]`                                     | `ocr_text` (string)         |
| `semantics.dominant_colors[]`                          | `dominant_colors[]` (+ `dominant_color` legacy con el primero) |
| `identity.faces`                                       | `faces` (normalizadas a `{person_id, display_name, confidence}`) |
| `identity.spaces[]`                                    | `spaces` (normalizadas a `{space_id, display_name, confidence}`) |
| `demographics`                                         | `demographics` (objeto)     |
| `composition`                                          | `composition` (objeto)      |
| `technical`                                            | `technical` (objeto, sobreescribe `duration`/`resolution`/`fps`) |
| —                                                      | `has_catalog: true`         |
| `batch` / `processed` (raíz del catalog)               | `catalog_batch` / `catalog_processed` |

Los `tags[]` del nombre/ruta se preservan; solo se añaden los nuevos
deduplicados. **Las personas (`faces[]`) NO entran en `tags[]`**: son su
propia dimensión y se exponen en el endpoint `/api/persons`.

### Schema canónico de `face` y `space`

El backend acepta dos versiones del pipeline (compat ambas):

```js
// Para face:
const personId   = face.person_id ?? face.id
const displayNm  = registry.display_name ?? face.display_name ?? face.name ?? personId
// Para space (mismo patrón):
const spaceId    = space.space_id ?? space.id
const displaySp  = space.display_name ?? space.name ?? spaceId
```

Al servirse al frontend en el `MediaFile`:
- `file.faces  = [{person_id, display_name, confidence}]`
- `file.spaces = [{space_id, display_name, confidence}]`

### Comportamiento

- **No es bloqueante**: si no existe ni catálogo ni sidecar, los archivos
  se sirven con sus tags inferidos del nombre. NO se rompe nada.
- **Cacheado en memoria por carpeta y por sidecar**: `dirPath → { mtime,
  catalog }` y `sidecarPath → { mtime, clip }`. Se recarga sólo cuando
  cambia el `mtime` del JSON.
- **Se mergea al vuelo, no se persiste** en `media_cache.json`. Cada vez
  que la API devuelve un MediaFile, vuelve a aplicarse el catalog. Así
  el frontend siempre ve la última versión sin reindexar.
- **Watcher**: el watcher de filesystem ignora la mayoría de `.json` salvo
  `_marina.json`. Cuando este último cambia, **no dispara un resync
  completo** — sólo invalida la entrada de cache de esa carpeta y refresca
  los `MediaFile` en memoria que pertenecen a ella.

Implementación: `backend/catalogReader.js`.

## Personas y registry

El backend mantiene una **dimensión propia para personas** (no son tags).
Las identidades vienen del pipeline externo (Marina Video Batch) en
`identity.faces[]` y se cruzan con un registry local opcional.

### Archivo `people_registry.json`

```json
{
  "version": 1,
  "people": [
    {
      "person_id": "ester",
      "display_name": "Ester García",
      "avatar_path": "people/ester/avatar.jpg",
      "aliases": ["Ester"]
    },
    {
      "person_id": "javi42",
      "display_name": "Javi",
      "avatar_path": "people/javi42/avatar.jpg",
      "aliases": []
    }
  ]
}
```

Configuración (`.env`):

- `PERSONS_REGISTRY`: ruta absoluta al `people_registry.json`. Si está
  vacía, no se resuelven `display_name` ni avatares.
- `PERSONS_AVATARS_BASE`: carpeta base para `avatar_path` relativos. Si
  está vacía, se deriva de `dirname(PERSONS_REGISTRY)`.

### Reglas de validación

- `avatar_path` **siempre relativo**: se rechaza si empieza por `/`, `\` o
  letra de unidad (`X:`).
- Tras `path.normalize`, el resultado de `path.resolve(base, p)` debe
  seguir dentro de `base` (anti-traversal `..`).
- Si la imagen no existe en disco → `avatar_url: null`. Sin warnings
  ruidosos.
- Si el JSON no parsea o no tiene array `people` → warning una vez y se
  opera como si no hubiera registry.

### Servicio de avatares

`/persons-avatars/*` sirve estático desde `PERSONS_AVATARS_BASE` (o
`dirname(PERSONS_REGISTRY)`). Cache 1 día con etag. Si la carpeta no
existe al arrancar, no se monta el endpoint (un 404 explícito en lugar
de un 500 silencioso).

### Memoización

El agregado de personas se calcula UNA vez:
- al terminar `syncFiles()` (tras cada sincronización),
- al cargar `media_cache.json` al arrancar (vía el primer sync),
- al cambiar `people_registry.json` (vigilado por chokidar),
- a petición vía `POST /api/persons/refresh`.

Sin I/O por request: `getAvatarUrl` chequea `fs.existsSync` solo durante
el recálculo, no al servir cada respuesta.

Implementación: `backend/peopleRegistry.js` y `backend/personsAggregator.js`.

## Endpoints REST

### Archivos
- `GET /api/files` — lista completa de archivos
- `GET /api/files/:id` — un archivo
- `PATCH /api/files/:id` — actualiza tags/favorito/descripción
- `POST /api/files/:id/open-path` — abre el explorador del SO en el archivo
- `GET /api/stream/:id` — streaming con range requests
- `GET /api/download/:id` — descarga directa
- `POST /api/download/zip` body `{fileIds}` — descarga múltiple en ZIP
- `POST /api/sync` — fuerza una sincronización
- `GET /api/tags` — taxonomía de tags
- `POST /api/tags/bulk-update` body `{fileIds, addTags, removeTags}`

### Búsqueda
- `GET /api/search` — búsqueda con filtros (`q`, `type`, `tags`, `year`, `month`, `dateFrom`, `dateTo`, `person_ids`)
- `POST /api/ai/search` body `{query}` — búsqueda en lenguaje natural (Ollama)
- `GET /api/ai/health` — estado del LLM

#### Filtro `person_ids`

`GET /api/search?person_ids=ester,javi42` filtra los MediaFile que
contengan al menos uno de los `person_id` listados (OR entre ellos, AND
con el resto de filtros como `q`, `tags`, `type`, fechas).

El parámetro `q` también busca en `face.display_name`, `face.person_id`
y `aliases` resueltos cruzando con el registry.

### Personas
- `GET /api/persons` — agregado memoizado de personas presentes en MediaFile

  ```json
  {
    "success": true,
    "data": [
      { "person_id": "ester", "display_name": "Ester García", "count": 23,
        "avatar_url": "/persons-avatars/people/ester/avatar.jpg" },
      { "person_id": "javi42", "display_name": "Javi", "count": 4,
        "avatar_url": null }
    ]
  }
  ```

  - `count` = nº de MediaFile distintos (presencia, no detecciones).
  - Solo personas con `count > 0`.
  - Orden: `count` desc, desempate `display_name` ASC.
  - Personas sin entrada en registry → `display_name = person_id`,
    `avatar_url = null` (no se ocultan).

- `POST /api/persons/refresh` — fuerza recálculo del agregado sin resync
  de archivos. Útil tras editar el registry o añadir un avatar manualmente.
  Devuelve `{ success: true, count: N }`.

#### AI Search (lenguaje natural)

El endpoint `POST /api/ai/search` orquesta:

1. **Intent extraction** con Ollama. El LLM devuelve un JSON con `type`,
   `dateFilter`, `searchTerms`, `shotFilter`, `peopleFraming`, `colorTerms`,
   `movementType`, `exposure`.
2. **Scoring local** sobre los `MediaFile` en memoria (con catalog ya
   mergeado), sumando puntos por matches en distintos campos.

Pesos del scoring (ver `aiSearchService.js`):

| Campo                         | Peso | Tipo                |
|-------------------------------|------|---------------------|
| `faces`                       | 15   | match por término   |
| `tags`                        | 10   | match por término   |
| `spaces`                      | 10   | match por término   |
| `visual_description`          |  8   | match por término   |
| `composition.shot_type`       |  8   | bonus de filtro     |
| `ocr_text`                    |  6   | match por término   |
| `composition.people_framing`  |  6   | bonus de filtro     |
| `dominant_color` / `dominant_colors[]` | 5 | match por término o color |
| `technical.movement_type`     |  5   | bonus de filtro     |
| `name`                        |  5   | match por término   |
| `demographics.attire`         |  4   | bonus de filtro     |
| `technical.exposure`          |  4   | bonus de filtro     |
| (bonus por tipo correcto)     |  3   | flat                |

Los filtros visuales (shot/framing/movement/exposure/colors) son **bonus
no estrictos**: una query como "primer plano azul" no descarta resultados
que matcheen sólo uno de los dos.

**Corte de relevancia en dos tramos.** Cada resultado se etiqueta con un
campo `tier`:

- `primary`   → score >= `max(topScore * 0.5, 5)` — resultados claros.
- `secondary` → score < primaryCutoff pero score >= `max(topScore * 0.2, 2)`
                — resultados menos probables, mostrados bajo separador.
- descartado  → score por debajo del secondaryCutoff (no se devuelven).

El array `results` viene ordenado: primero todos los `primary` (rank desc),
después todos los `secondary` (rank desc). El frontend usa `metadata.primaryCount`
para saber dónde insertar el separador visual.

El `metadata` incluye `topScore`, `primaryCutoff`, `secondaryCutoff`,
`primaryCount`, `secondaryCount` y `totalCandidates` para diagnóstico y
calibración. Constantes `PRIMARY_RATIO`, `PRIMARY_FLOOR`, `SECONDARY_RATIO`,
`SECONDARY_FLOOR` y `SECONDARY_CAP` aisladas al principio del método.

Respuesta:

```json
{
  "success": true,
  "results": [
    { "fileId": "...", "score": 23, "matchedIn": ["tags","ocr_text"] }
  ],
  "intent": { "type": null, "shotFilter": "primer_plano", ... },
  "metadata": { "model": "...", "processingTime": 312, "originalQuery": "...", "totalScanned": 79 },
  "data": { "results": [...con el `file` embebido...], "intent": ..., "metadata": ... }
}
```

Variables de entorno relevantes: `OLLAMA_HOST`, `OLLAMA_MODEL`. Si Ollama
no está disponible, el endpoint devuelve **503**.

### Favoritos
- `GET /api/favorites` — array de fileIds
- `POST /api/favorites/toggle` body `{fileId}` — toggle, devuelve `{fileId, isFavorite}`

### Colecciones
- `GET /api/collections` — array de Collection
- `POST /api/collections` body `{name, files?, coverImage?, description?}` — crea
- `PATCH /api/collections/:id` body `{name?, coverImage?, description?, coverType?}`
- `DELETE /api/collections/:id`
- `DELETE /api/collections` — limpia todas (mantenimiento)
- `PATCH /api/collections/reorder` body `{orderedIds}` — reordena
- `POST /api/collections/:id/files` body `{fileIds: [...]}` — añade archivos
- `DELETE /api/collections/:id/files` body `{fileIds: [...]}` — quita archivos
- `POST /api/collections/:id/files/bulk` body `{fileIds}` — alias compat
- `DELETE /api/collections/:id/files/:fileId` — quita uno (compat)

### Sistema
- `GET /api/system/info` — info de directorios y diagnóstico
- `GET /api/statistics` — estadísticas globales
- `GET /api/colors` — paleta global de colores
- `GET /api/scan-paths` — rutas configuradas
- `POST /api/scan-paths` body `{path}` — añade ruta (queda **inactiva** por defecto)
- `POST /api/scan-paths/:id/sync` — sincroniza una ruta
- `PATCH /api/scan-paths/:id/toggle` body `{isActive}` — activa/desactiva
- `DELETE /api/scan-paths/:id` — elimina ruta

> **Deuda UX conocida**: `POST /api/scan-paths` añade la ruta con `isActive: false`
> y requiere un `PATCH /toggle` posterior. Es contraintuitivo para un usuario
> poco técnico. Mejora pendiente: aceptar `isActive` directamente en el body
> del POST y crear como activa por defecto. No bloquea el uso (la UI ya
> dispara el toggle al añadir).

### WebSocket
- `ws://localhost:5000/ws` — eventos de progreso de sync, scan, etc.

## Persistencia

| Archivo                          | Contenido                                |
|----------------------------------|------------------------------------------|
| `backend/scan_paths.json`        | Rutas adicionales añadidas desde la UI   |
| `backend/media_cache.json`       | Cache de hashes y metadatos por archivo  |
| `backend/favorites_persistent.json` | Favoritos                             |
| `backend/collections_persistent.json` | Colecciones                         |
| `backend/thumbnails/`            | Thumbnails generados                     |

## Notas

- **Sin auth**: este backend asume que solo tú lo usas. CORS abierto a localhost.
- **Sin Supabase, sin embeddings, sin background removal**: la versión personal
  delega el análisis visual a la herramienta externa (Marina Video Batch personal),
  que vuelca el resultado como sidecar JSON.
- **Compresión gzip** activada para respuestas API.
- **Cache headers** largos para `/thumbnails` y moderados para `/media`.
