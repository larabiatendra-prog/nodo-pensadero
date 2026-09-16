# CLAUDE.md — Pensadero

Guía para futuras sesiones de Claude Code dentro de este repositorio.

## Contexto (leer primero)

Este proyecto pertenece al ecosistema NODO, cuya capa de contexto es
`C:\DEV\contexto` (empezar por su `INDICE.md`). Antes de decisiones de diseno,
arquitectura o filosofia, consultarla: `manifiesto.md` para el porque,
`patrones-stack.md` / `patrones-datos.md` / `patrones-experiencia.md` para el
como, y `puntos-debiles.md` para lo que suele torcerse. El estado de este
proyecto esta en `contexto\herramientas.md`. Si algo de este repo la
contradice, senalarlo en vez de resolverlo en silencio.

## Identidad

**Pensadero** es la aplicacion principal de gestion, indexacion, busqueda y reproduccion del archivo audiovisual personal de Daniel Fernandez en el ecosistema NODO. Es una aplicacion single-user, despojada de todo lo corporativo: sin auth, sin multiusuario.

**Rutas canonicas:**
- Desarrollo (Dell, espejo NODO): `D:\projects\Nuevo PC - NODO\DEV\pensadero`
- Destino final en NODO (PC fisico): `C:\DEV\pensadero` (desarrollo) -> `C:\TOOLS\Pensadero` (cuando estable)
- Repo GitHub: `larabiatendra-prog/nodo-pensadero` (privado)

**Direccion arquitectonica (Vision B):** Pensadero absorbe progresivamente las capacidades de procesamiento que antes vivian en generadores externos, trayendolas aqui dentro. Face recognition ya esta integrado (ver regla 2). Space recognition y otras capacidades pendientes siguen el mismo camino en vez de depender de pipelines externas.

**Nombrar archivos brutos:** los archivos de camara (`P1246646.mp4`, `IMG_3421.JPG`) NO se renombran nunca. En Pensadero, cada archivo hereda el display name y los tags de su carpeta contenedora. La carpeta es la unidad atomica de significado.

## Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS.
- **Backend**: Node.js + Express + WebSocket (`ws`). Servidor en `backend/server.js`, rutas modulares en `backend/routes/`, servicios en `backend/services/`.
- **IA opcional**: Ollama local. Búsqueda en lenguaje natural con `qwen2.5:7b-instruct` (NODO) o `qwen2.5:14b-instruct`. VLM de escaneo seleccionable desde la UI; cambio siempre manual, sin automatismo. Catálogo curado en `visualScanService.js` por tiers:
  - `produccion`: `gemma4:12b` (principal). `legacy`: `gemma3:12b` (**el activo en NODO ahora mismo**).
  - `experimento`: `huihui_ai/gemma-4-abliterated:12b`, `qwen2.5vl:7b`, `huihui_ai/qwen2.5-vl-abliterated:7b`. Los "abliterated" están porque los VLM estándar esquivan o edulcoran descripciones de personas, y este archivo es sobre todo personas.
  - `no_cabe`: 27B/31B/32B. Se ofrecen avisando, no en igualdad: no entran en los 16 GB de la 5070 Ti junto a CLIP e InsightFace, se desbordan a RAM y el escaneo pasa de segundos a minutos por clip.

  El modelo activo se persiste en `config/runtime.json`, que gana al `VLM_MODEL` del `.env` (ver `backend/.env.nodo`). **Ojo con la deriva**: `.env` dice `gemma3:12b` y `.env.nodo` dice `gemma4:12b`, y el `.bat` regenera `.env` desde la plantilla si falta.
- **Sin Electron, sin pkg, sin instaladores.** Stack deliberadamente simple: `npm install` + un `.bat`.

## Diseño

Nota: esta paleta noche/lavanda es **temporal**; no ampliarla con colores nuevos. La linea grafica del ecosistema esta **sin decidir** (El Paramo se retiro el 30/08/2026). No aplicar ninguna linea todavia; el encargo y las cuatro direcciones candidatas estan en `C:\DEV\contexto\linea-grafica-encargo.md`.

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
2. **Face recognition integrado, space recognition todavia no.**
   - **Caras:** InsightFace via daemon Python (ArcFace, embeddings 512-dim L2-normalizados). Stack:
     - `backend/services/faceService.js` — wrapper del daemon, detection + identificacion por cosine similarity.
     - `backend/services/faceReidentifier.js` — re-id retroactiva sobre catalogos ya escaneados.
     - `backend/services/faceClusterer.js` — descubrimiento de caras frecuentes desconocidas via greedy clustering.
     - `backend/routes/personsManageRoutes.js` — CRUD registry + clustering + promote + merge.
     - `src/components/PersonsManager.tsx` — UI completa (registry, fotos, entrenamiento, re-id, discovery, merge).
   - **Persistencia:** `<avatarsBase>/people/<id>/embeddings.json` (centroid + meta) + `people_registry.json`. Embeddings de detecciones se guardan en `_pensadero.json` por carpeta (campo `identity.detections[].embedding_b64`).
   - **No reintroducir** `face-api.js` (legacy de la version anterior). Cualquier UI nueva de personas/caras debe integrarse con el daemon InsightFace existente.
   - **Spaces (lugares):** todavia se *leen* desde sidecar; siguen el camino de absorcion (Vision B) cuando se aborde.
3. **Comments en español.** Los nombres de tokens semánticos (colores, espaciados, roles) también van en español.
4. **README y CLAUDE.md sin emojis.**
5. **Pensadero_Start.bat sin acentos en su contenido** (compatibilidad con cmd antigua).

## Datos persistentes

Todo en `backend/`, en disco local, formato JSON plano:

- `favorites_persistent.json` — lista de IDs favoritos.
- `collections_persistent.json` — colecciones de usuario con orden manual.
- `notes_persistent.json` — notas humanas por archivo (`fileId`) y por sesion colapsada (session key). No regenerable.
- `ocultos_persistent.json` — material bajo candado (`ocultosManager.js`): claves `mediaKey` (o id) y la clave de acceso derivada con scrypt (`null` = `1234` de fabrica). No regenerable. **Se filtra en el servidor**: las rutas que entregan material (galeria, busquedas, carta, colecciones, gemelas, color, etiquetas) reciben `mediaFilesVisibles`; escaneo, sincronizacion, limpieza de huerfanos y el agregado de personas siguen viendo el catalogo entero (si no, la limpieza de fichas vacias borraria a quien solo sale en material oculto). Stream, miniatura y descarga resuelven cualquier id: la caja de `/ocultos` los usa con la llave en la cabecera `x-llave-ocultos`.
- `media_cache.json` — cache de metadatos de archivos escaneados (la fuente de verdad operativa).
- `scan_paths.json` — rutas de bibliotecas que el usuario ha añadido. El campo `status` refleja la accesibilidad real comprobada en la última sincronización (`connected` / `disconnected`), no el último estado bueno conocido. Cada ruta puede llevar `escaneo` con los trabajos que sobrescribe respecto al global. Una sincronizacion guarda su estado con `guardarEstadoDeRutas`, SOBRE lo releido: guardar las rutas tal como se cargaron al empezar pisaba lo que el usuario cambiara durante la pasada.
- `config/runtime.json` — preferencias que el usuario cambia desde la UI y deben sobrevivir al reinicio (hoy: `vlmModel` y `escaneo`). **Gana al `.env`**, que pasa a ser el valor de fábrica. Sin esto, el selector de modelo volvía al `.env` en cada arranque sin avisar.
- `<carpeta-del-archivo>/.pensadero/thumbnails/` — miniaturas (regenerables), junto al archivo en el `.pensadero` de su carpeta contenedora, igual que el sidecar `_pensadero.json`. Es el destino principal; se sirven por `GET /api/thumbnails/:fileId`. `backend/thumbnails/` queda como fallback legacy (disco de solo lectura).
- `<carpeta-del-archivo>/.pensadero/proxies/<fileId>.mp4` — proxies de reproducción web-compatibles (regenerables, NVENC) para vídeos cuyo códec/contenedor el navegador no reproduce. Se sirven por `GET /api/media/:fileId/proxy`; el estado y la URL reproducible los da `GET /api/media/:fileId/playable`. `backend/proxies/` es el fallback legacy.
- **Trabajos del escaneo** (`services/escaneoConfig.js`): `descripcion`, `caras`, `busquedaVisual`, `movimiento`, `proxies`, encendibles en global (`runtime.json`) y por ruta. Cada entrada de `_pensadero.json` apunta en `escaneo` que trabajos tiene hechos; un escaneo sin forzar re-encola lo que tenga un trabajo encendido marcado `false` y hace **solo ese** (no vuelve a describir). Lo que una pasada no rehace se hereda de la entrada en disco (`heredarYMarcar`), asi que re-describir con la busqueda visual apagada no tira los embeddings. Las entradas anteriores a los interruptores no llevan `escaneo` y cuentan como completas.
- `clip_index.json` — índice de embeddings CLIP/SigLIP-2 para búsqueda visual (regenerable desde los `_pensadero.json` por carpeta). Indexado por `mediaId` (md5 de la ruta, mismo que el `id` de runtime).

Ninguno de estos archivos debe versionarse en git (ver `.gitignore`).

**Identidad portable (`backend/utils/mediaIdentity.js`):** la identidad persistente de un archivo es la `mediaKey = "<libraryId>:<relativePathNorm>"`, no su ruta absoluta. `libraryId` = el `id` estable de `scan_paths.json` (hex aleatorio, no depende de la ruta). El `id = md5(rutaAbsoluta)` se conserva solo como token de runtime para URLs de stream/thumbnail. Las bibliotecas se remapean (cambio de letra de unidad) con `PATCH /api/scan-paths/:id` conservando el `id`. Migrador de estado: `backend/tools/migrate-portable-state.js` (dry-run + `--apply`, con backup). Diagnóstico: `backend/tools/portability-report.js` (lo invoca Doctor). Detalle en `GUIA_INSTALACION_NODO.md` → "Portabilidad real".

**Favoritos y notas ya se guardan por `mediaKey`** (2026-09-11). Ambos leen también la clave antigua (ruta absoluta en favoritos, md5 en notas), así que lo guardado antes sigue funcionando sin migrar; al volver a tocarlo, la entrada pasa a portable y el duplicado viejo se retira. `mediaIdentity.isMediaKey()` es la ÚNICA definición de "esto es una clave portable y no una ruta" — no reimplementarla: el `libraryId` son 16 hex, no 32, y asumirlo mal hace que el chequeo no case con nada.

**Los huérfanos solo se borran si se puede demostrar que faltan.** `cleanupOrphanedFavorites` y `cleanupOrphanedFiles` reciben qué bibliotecas se pudieron leer en ese sync y conservan todo lo que venga de una que no se recorrió. Antes bastaba con que la clave no apareciera en el sync para borrarla: sincronizar con el disco externo desenchufado **borraba todos los favoritos de esa biblioteca**, sin aviso y sin vuelta atrás.

## Nada falla en silencio (invariantes)

Tres reglas que existen por incidentes reales y no hay que deshacer sin sustituirlas por algo mejor:

1. **El catálogo se vuelca durante el escaneo, no al final.** `scanFolder` llama a `flushCatalogs()` cada `SCAN_FLUSH_EVERY` archivos (10 por defecto) y al cambiar de carpeta. Antes solo escribía al terminar el bucle y una caída a mitad se llevaba por delante horas de VLM. El coste de un corte es como mucho 10 archivos.
2. **Un escaneo degradado lo dice.** Si caras, CLIP o motion no levantan, el escaneo sigue (correcto) pero emite `capabilities` y `degraded` en `scan_start`/`scan_done`, y la UI lo pinta. Antes solo había un `console.warn` que no leía nadie: se podían escanear 153 vídeos sin reconocimiento facial y no enterarse hasta meses después.
3. **La UI dice cuándo el backend no está.** `ConnectionBanner` (en `App.tsx`, global) usa el `isConnected` de `useWebSocket`. Antes ese valor se extraía y no se pintaba en ningún sitio, así que una caída se veía como una pantalla congelada indistinguible de "está trabajando".
4. **Todo fallo tiene una causa y sale a la superficie.** `backend/utils/failureReason.js` traduce cualquier error a `{ code, reason, hint }` en español, probando de la causa más probable a la menos (disco lleno, unidad desconectada, permisos, archivo ocupado, E/S, límites del SO, JSON corrupto, timeout, memoria, Python/modelo/Ollama) y, si no reconoce nada, devuelve igualmente "no se pudo X" con el mensaje crudo del sistema: **nunca** un fallo sin explicación. `record(operacion, err, { path })` además lo apunta agregado por causa, así que 9.378 errores idénticos son una incidencia con `veces: 9378`, no 9.378 líneas.

   **Regla de uso: si escribes un `catch`, o relanzas, o llamas a `record()`. No hay tercera opción.**

   Sale por cuatro sitios: la respuesta HTTP de la ruta, el evento WebSocket del job (`escriturasFallidas`, `causaPrincipal`, `incidencias`), el bloque `incidencias` de `/api/health`, y un banner rojo propio en la pestaña Rutas — separado del de "degradado", porque no poder guardar es peor que ir incompleto: el trabajo se ha hecho y se está tirando. Un job que no ha podido escribir termina en `done_con_fallos`, no en `done`.

   Existe por el incidente del 09/09/2026: el disco `F:` se llenó y el backend siguió como si nada. 9.460 escrituras fallaron (9.378 de un escaneo, 54 de un re-id, 22 de un promote), cada una con su `console.warn` que no leyó nadie. El escaneo dijo "completado", el promote dijo "persona guardada", y el usuario lo descubrió días después al ver que una persona recién creada (con un centroide bueno, que casaba con 197 caras) no aparecía en ningún archivo.

   Las incidencias viven en memoria y se borran al reiniciar: es un registro de lo que ha pasado en esta vida del proceso, no un histórico.

**`GET /api/health`** responde por el circuito entero de una sola llamada: Ollama y modelo activo, CLIP (con sus providers), caras, ffmpeg, accesibilidad real de cada biblioteca, pendientes de describir, memoria del proceso y el bloque **`incidencias`** (qué ha fallado, por qué y cuántas veces). Lo consumen `Pensadero_Doctor.bat` y la UI. Es el sitio al que ir antes de investigar nada.

**Herramientas de diagnóstico** (`backend/tools/`, dry-run por defecto y `--apply` para escribir, como `migrate-portable-state.js`):
- `orphan-face-tags.js` — etiquetas de cara que apuntan a personas que ya no están en el registry, entradas sin `detections` y bibliotecas inaccesibles. Sale con código 1 si hay pendientes.

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

`Pensadero_Start.bat` orquesta todo: comprueba Node, instala dependencias si faltan, construye el bundle **si falta `dist/` o si `src/` es más nuevo que el bundle**, y lanza `Pensadero_Server.bat`, que sirve frontend y API en `:5000` (origen único).

**`Pensadero_Server.bat` es el supervisor del backend.** No lanza `node server.js` a pelo: lo envuelve en un bucle que lo relanza si cae, con espera creciente (5 s, 15 s, 60 s) y corte a las 10 caídas seguidas. Si el proceso aguanta 2 minutos en pie, el contador se reinicia. Existe porque el 07/09/2026 el backend murió a mitad de un lote sin dejar rastro y no se supo hasta dos horas después. Arranca Node con `--report-on-fatalerror` (un OOM deja informe JSON en `backend/logs/`) y `--max-old-space-size=8192` (el tope por defecto, 4288 MB, se queda corto en tandas largas).

**Logs**: `backend/logs/backend-YYYYMMDD.log`, uno por día, purga automática a los 14 días. Antes no había ninguno: stdout iba a una ventana minimizada y se perdía.
