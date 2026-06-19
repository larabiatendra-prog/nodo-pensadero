# Routing por URL (Eje B) + dominio local — spec e implementación

Registro del trabajo: convertir Pensadero a navegación por URL real y permitir
abrirlo con un nombre amigable local. Local-first, single-user, sin cloud, sin
Electron, sin HashRouter.

## Decisiones clave (correcciones sobre el prompt original)

1. **Dominio: `pensadero.localhost`, NO `.local`.**
   - `*.localhost` lo resuelven los navegadores a `127.0.0.1` por RFC 6761: sin
     editar hosts, sin admin, sin mDNS. Cero configuración.
   - `.local` está reservado a mDNS/Bonjour (RFC 6762) → en Windows con Bonjour
     da resolución lenta/intermitente. Se descarta.
   - Alternativa documentada: `pensadero.test` (requiere 1 línea en hosts).

2. **Modal de archivo = ruta sobre *background location*.**
   - La galería home usa scroll infinito no virtualizado. Si `/archivo/:id`
     desmontara la galería, al cerrar se perdería scroll + páginas cargadas.
   - Se usa el patrón background-location de React Router: al abrir un archivo se
     navega a `/archivo/:id` con `state.backgroundLocation = location actual`. La
     vista/filtros se derivan de esa location de fondo, así la galería queda
     montada debajo. Al cerrar se vuelve a ella (scroll intacto). Sin fondo
     (refresh directo) el modal cae sobre home y al cerrar va a `/`.

3. **Backend / CORS: sin cambios.**
   - App y API comparten origen (`:5000`), así que el navegador no aplica CORS.
   - `config.API_URL = ''` → todas las URLs relativas; el WS se deriva de
     `window.location.host`. `pensadero.localhost:5000` funciona tal cual.
   - El fallback SPA de `server.js` ya servía rutas profundas (excluye
     `/api`, `/ws`, `/media`, `/thumbnails`, `/persons-avatars`, `/spaces-covers`;
     ninguna colisiona con `/personas`, `/colecciones`, `/archivo/...`).

## Arquitectura de la migración (bajo riesgo)

`activeView` deja de ser `useState` y pasa a **derivarse** de la URL
(`viewFromPath(displayLocation.pathname)`). `setActiveView` se mantiene como
**shim** que hace `navigate(VIEW_TO_PATH[view])`. Resultado: los ~50 call-sites
históricos (`setActiveView('home')`, etc.) siguen funcionando sin tocarlos, pero
la fuente de verdad es `location`/`navigate`. El `switch (activeView)` de
`renderMainContent` no cambia.

Rutas con parámetro → `home` filtrado, con efectos que sincronizan URL → estado:
- `/colecciones/:id` → `selectedCollectionId` (ciclo de vida atado 1:1 a la ruta).
- `/persona/:id` → `selectedPersonIds=[id]` (punto de entrada; filtro pegajoso).
- `/favoritos` → `showFavoritesOnly=true` (punto de entrada).
- `/archivo/:id` → modal (resuelve el archivo en `mediaFiles` o vía `api.getFile`
  con estados de carga/error).

## Mapa de rutas

| URL | Vista |
| --- | --- |
| `/` | home / galería |
| `/rutas` | PathManager |
| `/personas` | PersonsManager |
| `/espacios` | SpacesManager |
| `/colecciones` | CollectionsView |
| `/colecciones/:id` | home filtrado por colección |
| `/estadisticas` | Statistics / grafo |
| `/atlas` | AtlasView |
| `/etiquetas` | TagManager |
| `/sinonimos` | SynonymsManager |
| `/busqueda-imagen` | ImageSearchView |
| `/favoritos` | home filtrado por favoritos |
| `/persona/:id` | home filtrado por persona |
| `/archivo/:id` | MediaModal sobre la vista de fondo |
| `*` | NotFound |

## Archivos modificados

- `package.json` — `react-router-dom@^6`.
- `src/main.tsx` — envuelve `App` en `<BrowserRouter>`.
- `src/App.tsx` — derivación de vista, shim `setActiveView`, `openFile`, efectos
  de sincronización URL→estado, modal dirigido por ruta, NotFound, navegaciones
  por ruta en colecciones/personas/archivo, overlays de carga/error.
- `GUIA_INSTALACION_NODO.md` — sección de URLs y dominio `pensadero.localhost`.

## Verificación

- `npm run build` → OK.
- `npx tsc --noEmit` → exit 0, 0 errores.

Comprobaciones funcionales recomendadas (manual, navegador):
- `http://localhost:5000/`, `/personas`, `/archivo/:id` (incl. refresh directo).
- `http://pensadero.localhost:5000/` sin editar hosts.
- Cerrar el visor mantiene el scroll de la galería.
- Ctrl/Cmd+click = selección múltiple (no abre `/archivo/:id`).

## Deuda conocida

- Selección múltiple de personas (burbujas/@menciones) y el toggle de favoritos
  in-page no se reflejan en la URL; `/persona/:id` y `/favoritos` son puntos de
  entrada (deep-link), no espejo continuo.
- `vite preview` (`:5173`) bloquearía `pensadero.localhost` por `allowedHosts`;
  el dominio amigable aplica al backend `:5000`, que es el flujo recomendado.
