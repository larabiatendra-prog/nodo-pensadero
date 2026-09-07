# Prompt para Claude Design — Rediseño integral de Pensadero

> Copiar desde aquí hacia abajo y entregarlo tal cual a Claude Design.

---

## Encargo

Quiero que rediseñes **desde cero** la experiencia completa de **Pensadero**, mi aplicación personal de archivo audiovisual. No quiero una iteración del diseño actual: quiero que lo trates como material de derribo. Conserva las capacidades, destruye la forma. El objetivo número uno es que la UX me **sorprenda**: que sea muy, muy original, que no se parezca a ningún gestor de fotos que exista (ni Google Photos, ni Lightroom, ni Plex, ni Immich). Abajo te doy el inventario exacto de lo que la app hace hoy, para que compares, y las restricciones que no puedes romper. Todo lo demás es tuyo.

## Qué es Pensadero

Pensadero es el archivo de memoria audiovisual de una sola persona: décadas de brutos de cámara, fotos, vídeos y exportaciones, en discos locales, indexados y enriquecidos con IA local. El nombre viene del pensadero de Harry Potter: una vasija donde viertes recuerdos y en la que te sumerges para revivirlos. La app actual **no honra esa metáfora**: es una galería con filtros, como cualquier otra. Esa es la distancia que quiero que cierres: no "gestionar archivos", sino **sumergirse en la memoria**.

Contexto de uso real:
- Un único usuario (yo), en un PC de sobremesa Windows con monitor grande. Sin auth, sin multiusuario, sin nube, sin móvil. 100% local y offline.
- Decenas de miles de archivos. Los archivos brutos de cámara (`P1246646.mp4`) nunca se renombran: **la carpeta es la unidad de significado** — cada archivo hereda el nombre de presentación y los tags de su carpeta contenedora, y los archivos de una misma carpeta forman una "sesión" (un evento, un rodaje, un día).
- Sesiones de uso largas y contemplativas: buscar un recuerdo concreto, pero también vagar sin rumbo y dejarse encontrar por el archivo.

## Inventario de la app actual (lo que existe y debe seguir existiendo como capacidad)

### Navegación y estructura
- SPA con rutas: `/` (galería), `/rutas`, `/personas`, `/espacios`, `/colecciones`, `/estadisticas`, `/atlas`, `/etiquetas`, `/sinonimos`, `/busqueda-imagen`, `/archivo/:id` (modal sobre la vista de fondo), `/persona/:id` y `/favoritos` (galería filtrada).
- Estructura clásica: barra de búsqueda arriba, grid infinito en el centro, barra de estado abajo, vistas secundarias como páginas aparte con botón "volver". Es exactamente el patrón que quiero abandonar.

### Galería (home)
- Grid/lista con scroll infinito y tarjetas con miniatura, hover-preview de vídeo, favorito, duración.
- **Agrupación por sesiones**: los archivos de una misma carpeta (5 o más) se colapsan en una tarjeta de sesión expandible; al abrir una sesión el resto del grid se atenúa.
- **TimelineWave**: una onda vertical en el margen derecho donde el eje Y es el tiempo (reciente arriba) y la amplitud es el volumen de archivos por mes; marca "estás aquí" según el scroll y permite saltar a un mes.
- Vista rápida (QuickPreview) tipo espacio de Finder, modo selección múltiple, paginación por scroll.

### Búsqueda y filtros
- Barra con dos modos: **etiquetas** (chips con autocompletado, sinónimos, exclusión con menos, menciones `@persona`) y **lenguaje natural** (un LLM local vía Ollama traduce "vídeos de María en la playa al atardecer de 2019" a un intent estructurado: tipo, año, mes, personas, espacios, tags, encuadre, movimiento, exposición, términos de color; devuelve resultados "claros" y "menos probables" separados).
- Filtros rápidos: tipo (imagen/vídeo/audio/export), favoritos, rango de fechas, y una **rueda de color HSL** que busca por color dominante con umbral Delta E ajustable (tono exacto ↔ familia cromática).
- **Búsqueda por imagen**: arrastras una imagen (incluso desde fuera de la app) y devuelve los archivos visualmente similares vía embeddings CLIP/SigLIP-2.

### Conocimiento del archivo (los datos ricos que casi no se explotan visualmente)
Cada archivo puede tener, gracias al escaneo con VLM e InsightFace locales:
- `visual_description` (descripción en prosa), `ocr_text`.
- `composition` (tipo de plano, encuadre de personas), `atmosphere` (mood, iluminación, tipo de espacio, hora del día, estilo).
- **Caras identificadas** con bounding boxes, edad y género estimados, ligadas a un registro de personas con avatares, entrenamiento, fusión, re-identificación retroactiva y descubrimiento de caras frecuentes desconocidas (clustering).
- **Espacios** (lugares recurrentes) con su propio registro.
- Colores dominantes, duración, fps, resolución, fecha extraída del nombre de archivo.
- **Notas humanas** por archivo y por sesión (lo único no regenerable: mi voz sobre el recuerdo).

### Vistas de exploración
- **Atlas** (`/atlas`): grafo D3 de "recuerdos" conectados por personas, lugares y tiempo, con lentes (explorar / centros / puentes / islas), colores por "mundos" (componentes conexos), modo **deriva** (paseo aleatorio guiado) y camino más corto entre dos recuerdos.
- **Grafo** de coocurrencia de tags y de personas (quién aparece con quién).
- **Estadísticas**: totales, distribución por año/tipo/tags.
- **Colecciones**: manuales (orden a mano, portada) y **carpetas inteligentes** (reglas campo/operador/valor con AND/OR resueltas al vuelo).
- **Modo presentación**: reproducción continua de vídeos a pantalla completa con doble buffer.

### Gestión (menos glamurosa pero necesaria)
- Rutas de bibliotecas (añadir/escanear discos), progreso de escaneo por WebSocket, selección de modelo VLM.
- Gestores de etiquetas, sinónimos, personas y espacios.
- Reproducción robusta: proxies MP4 para códecs no web (`/api/media/:id/playable` decide la URL).

### Lenguaje visual actual
- Modo oscuro único. Paleta "noche/lavanda" con tokens semánticos en español: fondos `noche #0F111A`, `tinta #151927`, `grafito #1C2033`, `pizarra #252A42`; acento `lavanda #C8B6FF` (+ claro y archivo); complementarios `melocoton`, `salvia`, `bruma` (enlaces); texto `marfil`/`niebla`/`humo`; estados éxito/aviso/error.
- Tipografía: Geist (sans) + IBM Plex Mono (metadatos).
- Esta paleta y tipografía **me gustan y puedes conservarlas o evolucionarlas**, pero no son sagradas: si tu concepto pide otra atmósfera cromática, proponla con la misma disciplina de tokens semánticos en español.

## Diagnóstico honesto (por qué rediseño)

1. **Es una galería genérica con extras.** Las joyas (Atlas, deriva, búsqueda natural, onda temporal, sesiones) están escondidas detrás de pestañas; la experiencia por defecto es "grid de miniaturas + filtros", indistinguible de cualquier DAM.
2. **Los datos ricos no se sienten.** Tengo mood, hora del día, iluminación, descripciones en prosa, quién aparece, dónde, colores dominantes... y todo eso se reduce a chips de filtro. El archivo *sabe* muchísimo y la interfaz lo *cuenta* poquísimo.
3. **La navegación es administrativa.** Once rutas planas con botón "volver". No hay sensación de profundidad, de sumergirse y emerger, que es la metáfora fundacional.
4. **Creció por acreción.** Cada función se añadió donde cupo (App.tsx tiene 3.900 líneas); el conjunto no tiene una idea rectora de UX.
5. **Lo contemplativo no existe.** No hay ningún modo en que el archivo me hable sin que yo pregunte: nada de resurgimientos, ecos, azar curado, "tal día como hoy".

## Restricciones duras (no negociables)

1. **El backend no se toca.** API REST existente en `localhost:5000` (`/api/files`, `/api/stream/:id`, `/api/thumbnails/:id`, `/api/media/:id/playable`, `/api/favorites`, `/api/collections`, `/api/persons`, `/api/search/by-color`, `/api/ai/search`, `/api/image-search`, `/api/scan-paths`, `/api/statistics`, WebSocket de progreso de escaneo). Diseña el frontend contra este contrato.
2. **Stack**: React 18 + TypeScript estricto + Vite + Tailwind CSS. **Sin librerías de componentes** (no shadcn, no MUI): todo componente es propio. D3 y canvas/WebGL están permitidos y son bienvenidos.
3. **Single-user, sin auth**, sin nube, sin telemetría. Todo local.
4. **Rendimiento primero**: decenas de miles de items; cualquier vista principal debe virtualizar; nada que degrade el scroll.
5. Tokens de diseño y comentarios **en español**; identificadores técnicos en inglés. UI íntegramente en español.
6. Modo oscuro como modo primario (es una app de cueva, de noche).
7. Los archivos nunca se renombran; la carpeta/sesión sigue siendo la unidad de significado.
8. Escritorio primero: ratón + teclado (los atajos de teclado importan), pantalla grande. Nada de patrones móviles trasplantados.

## Lo que espero de ti (la parte donde me sorprendes)

No me traigas "la misma app pero más bonita". Quiero **un concepto rector** — una idea de qué *es* explorar la propia memoria — y que toda la interfaz se deduzca de él. Algunas provocaciones, no prescripciones (si tienes una idea mejor, mátalas todas):

- ¿Y si la pantalla de inicio no fuera un grid sino una **superficie** — algo líquido, profundo — donde los recuerdos emergen y a la que te asomas, y "buscar" fuera literalmente sumergirse?
- ¿Y si el tiempo no fuera un filtro sino el **terreno**: navegar el archivo como quien recorre un territorio de años, con densidades, estaciones, zonas oscuras sin escanear?
- ¿Y si la atmósfera (mood, luz, hora del día, color dominante) tiñera físicamente la interfaz mientras navegas — que estar en los recuerdos de una noche de verano se *sienta* distinto a estar en una mañana de invierno?
- ¿Y si las personas y los lugares fueran **puertas**, no filtros: entrar en alguien y ver su vida atravesando tu archivo?
- ¿Y si hubiera un estado de reposo en el que el Pensadero **te ofrece** recuerdos (ecos, aniversarios, cadenas de similitud visual) sin que preguntes nada?
- ¿Qué interfaz tendría esto si la hubiera diseñado un escenógrafo o un documentalista en vez de un ingeniero?

Reglas del juego creativo:
- La originalidad no puede costar legibilidad ni control: cada gesto expresivo necesita una salida clara (deshacer, volver, escapar). Sorprendente en la forma, impecable en la operación.
- Las funciones administrativas (rutas, escaneo, gestores) no necesitan poesía: necesitan estar fuera del camino, en una "sala de máquinas" honesta y compacta.
- Toda capacidad del inventario debe tener un lugar en el nuevo diseño (puede cambiar radicalmente de forma, fusionarse con otra o quedar latente tras un gesto, pero no desaparecer).
- El texto de la interfaz es parte del diseño: en español, con voz propia, sin jerga de software ("archivos encontrados: 128" puede ser "128 recuerdos de aquel verano").

## Entregables

1. **Concepto rector** (una página): la metáfora, por qué, y cómo se deduce de ella cada zona de la app.
2. **Arquitectura de experiencia**: mapa de estados/espacios (no "páginas") y cómo se transita entre ellos; qué pasa en reposo, al buscar, al sumergirse en una sesión, al emerger.
3. **Sistema visual**: paleta con tokens semánticos en español, tipografía, movimiento (el motion es de primera clase: cómo entra, sale y respira cada cosa), densidades.
4. **Diseño detallado de las 5 zonas clave**: (a) el estado inicial/reposo, (b) buscar y filtrar, (c) la sesión/el recuerdo abierto (visor), (d) personas y lugares, (e) el atlas/la deriva.
5. **Prototipo HTML/CSS/JS navegable** de al menos el estado inicial y una inmersión completa (reposo → búsqueda → sesión → archivo → volver), con datos de ejemplo, respetando el stack visual (Tailwind o CSS equivalente exportable a tokens).
6. **Mapa de migración**: correspondencia capacidad actual → lugar en el nuevo diseño, marcando qué se fusiona y qué queda en la sala de máquinas.

Criterio de éxito: si alguien ve la pantalla diez segundos y dice "eso es un gestor de fotos", hemos fracasado. Si dice "¿qué es ESO?" y a los dos minutos ya está navegando sin manual, hemos ganado.
