# CLAUDE.md — Pensadero

Guía para futuras sesiones de Claude Code dentro de este repositorio.

## Identidad

**Pensadero** es la aplicacion principal de gestion, indexacion, busqueda y reproduccion del archivo audiovisual personal de Daniel Fernandez en el ecosistema NODO. Es un fork (refactor profundo) de **Marina Finder**, despojado de todo lo corporativo: sin auth, sin multiusuario.

**Rutas canonicas:**
- Desarrollo (Dell, espejo NODO): `D:\projects\Nuevo PC - NODO\DEV\pensadero`
- Destino final en NODO (PC fisico): `C:\DEV\pensadero` (desarrollo) -> `C:\TOOLS\Pensadero` (cuando estable)
- Repo GitHub: `larabiatendra-prog/nodo-pensadero` (privado)

**Direccion arquitectonica (Vision B):** Pensadero debe absorber progresivamente las capacidades de procesamiento (hoy en "Marina Video Batch personal"). La implementacion actual es de solo lectura de sidecars JSON; esto es transitorio. No añadir mas dependencias externas de generacion de metadata: el camino es traerlas aqui dentro cuando se desarrollen.

**Nombrar archivos brutos:** los archivos de camara (`P1246646.mp4`, `IMG_3421.JPG`) NO se renombran nunca. En Pensadero, cada archivo hereda el display name y los tags de su carpeta contenedora. La carpeta es la unidad atomica de significado.

## Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS.
- **Backend**: Node.js + Express + WebSocket (`ws`). Servidor en `backend/server.js`, rutas modulares en `backend/routes/`, servicios en `backend/services/`.
- **IA opcional**: Ollama local (`llama3.1:8b`) para búsqueda semántica.
- **Sin Electron, sin pkg, sin instaladores.** Stack deliberadamente simple: `npm install` + un `.bat`.

## Diseño

### Paleta (tokens semánticos en español, definidos en `tailwind.config.js`)

- Fondos: `noche` `#0F111A`, `tinta` `#151927`, `grafito` `#1C2033`, `pizarra` `#252A42`.
- Acentos: `lavanda` `#C8B6FF`, `lavanda-claro` `#DACDFF`, `lavanda-archivo` `#7C6BB2`.
- Complementarios: `melocoton`, `salvia`, `bruma` (este último para enlaces).
- Texto: `marfil` (principal), `niebla` (secundario), `humo` (terciario/metadatos).

### Tipografía

- Sans: **Geist** (con fallback a Inter / system-ui).
- Mono: **IBM Plex Mono**.

## Reglas no negociables

1. **Single-user, sin auth.** No introducir login, sesiones, ni Supabase. Cualquier referencia a `@supabase/supabase-js` es legado pendiente de borrar.
2. **Sin face/space recognition dentro de Pensadero por ahora.** La implementacion actual solo *lee* resultados desde sidecar JSON generados externamente. A futuro esto se absorbera (Vision B). No reintroducir `face-api.js` ni UI de entrenamiento de versiones anteriores; si se añade reconocimiento, sera una implementacion nueva y deliberada.
3. **Comments en español.** Los nombres de tokens semánticos (colores, espaciados, roles) también van en español.
4. **README y CLAUDE.md sin emojis.**
5. **Pensadero_Start.bat sin acentos en su contenido** (compatibilidad con cmd antigua).

## Datos persistentes

Todo en `backend/`, en disco local, formato JSON plano:

- `favorites_persistent.json` — lista de IDs favoritos.
- `collections_persistent.json` — colecciones de usuario con orden manual.
- `media_cache.json` — cache de metadatos de archivos escaneados (la fuente de verdad operativa).
- `scan_paths.json` — rutas de bibliotecas que el usuario ha añadido.
- `thumbnails/` — miniaturas generadas (regenerables).
- `embeddings_index.json` / `visual_search_data/` — índices de búsqueda vectorial (regenerables).

Ninguno de estos archivos debe versionarse en git (ver `.gitignore`).

## Bibliotecas típicas

Las rutas escaneadas son carpetas en discos externos del usuario, con letras fijas en Windows. Ejemplos esperables: `K:\Fotos`, `Y:\Brutos`, `D:\Proyectos`. La gestión es siempre desde la UI (pestaña **Rutas**), no por edición manual de `scan_paths.json`.

## Sidecar JSON

Para `archivo.mp4` Pensadero busca `archivo.mp4.json` con campos opcionales: `tags`, `visual_description`, `colors`, `faces` (con `person_id`), `spaces` (con `space_id`), `duration_s`, `fps`, `resolution`. El contrato canónico debe vivir en `backend/README.md`. Si difiere, ese README manda.

## Convenciones de código

- **Naming**: tokens semánticos en español (`fondo-noche`, `texto-marfil`, `acento-lavanda`); identificadores técnicos en inglés (`mediaFile`, `collectionId`, `scanPath`).
- **Comentarios**: en español, breves, solo cuando aclaran el "por qué".
- **TypeScript estricto** para todo el frontend.
- **Sin librerías de componentes** (no shadcn, no MUI). Componentes propios en `src/components/`.

## Comandos típicos

```
npm run dev           # Vite dev server (frontend, hot reload)
npm run build         # Build de produccion -> dist/
npm run start         # Sirve dist/ con vite preview
npm run lint          # ESLint

cd backend
node server.js        # Backend en puerto 5000
```

## Arranque para usuario final

`Pensadero_Start.bat` orquesta todo: comprueba Node, instala dependencias si faltan, construye el bundle si no existe `dist/`, levanta backend en `:5000` y frontend (`vite preview`) en `:5173`, y abre el navegador. Cuando el backend Node sirva `dist/` directamente en `/`, este `.bat` se simplificará a un solo proceso.
