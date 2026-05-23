# Mejoras futuras — Pensadero

> **Nota previa**: este documento son **solo ideas exploratorias**. No hay
> compromiso de implementarlas, ni un orden obligatorio, ni siquiera la
> necesidad de aplicarlas. Es un cuaderno abierto para volver más adelante
> cuando una pieza concreta resuene con una fricción real de uso.
>
> Si lees esto en una sesión futura: trátalo como inspiración, no como
> backlog priorizado. El backlog real vive en las memorias del proyecto
> (`project_pensadero_backlog`, `project_nodo_pending`).
>
> Fecha de generación: 2026-05-23.

---

## Contexto

Pensadero ya cubre lo esencial:
- Indexación + búsqueda natural (Stage 1 + Stage 2 LLM).
- Escaneo visual con VLM (qwen2.5vl).
- Reconocimiento facial (InsightFace).
- Búsqueda por imagen + place recognition (CLIP).
- Colecciones, favoritos, color search, smart folders.

Las ideas de abajo son **funcionalidades nuevas** orientadas a cerrar el
flujo end-to-end del creador audiovisual (descubrir → seleccionar → editar)
y a hacer la app más densa en valor sin convertirla en otra cosa.

---

## 1. Export a Premiere Pro / After Effects

**Idea**: seleccionas archivos en Pensadero → botón "Export bin" → genera
`.xml` (Premiere Pro Project) o `.fcpxml` (Final Cut / DaVinci) con los
clips ya organizados (carpetas por tag, marcadores con descripciones,
in/out points si existen en la metadata).

**Por qué redondo**: cierra el círculo. Buscas con IA, encuentras los
clips correctos, **importas a Premiere de un click** sin arrastrar archivo
a archivo. Hoy mismo es el cuello de botella obvio del flujo: la app
encuentra material, pero el puente al editor es manual.

**Tradeoff**: el formato XML Premiere es verboso pero documentado.
Tiempo estimado: 2-3 días. Riesgo bajo (formato estable, sólo lectura
externa).

**Variante mínima**: copiar rutas absolutas al portapapeles en formato
que Premiere acepte por drag-and-drop. 1 hora de trabajo, 80% del valor.

---

## 2. Vista calendario / línea temporal

**Idea**: modo de visualización tipo Apple Photos / Google Photos.
Año → mes → día, agrupado por EXIF `DateTimeOriginal` (o `mtime` si falta
EXIF). Scroll vertical por años, miniaturas adaptativas.

**Por qué redondo**: la grid actual es plana. Tu archivo crecerá a
decenas de miles de archivos. Sin eje temporal, navegar por contexto
("aquel verano", "noviembre 2023") es imposible.

**Tradeoff**: solo necesita parsear EXIF (ya lo haces en el scan) + un
componente UI. Tiempo: 1-2 días. Riesgo bajo. Encaja con la arquitectura
actual sin tocar backend.

---

## 3. Detección de duplicados perceptuales

**Idea**: hash perceptual (pHash) por imagen + comparación de frames
clave de vídeos. Encuentra archivos "casi iguales" (mismas fotos a
resoluciones distintas, recortes, exports duplicados, copias entre
LaCie 10TB y NVMe).

**Por qué redondo**: el archivo personal acumula basura con los años.
Función real de **limpieza sin riesgo**, especialmente útil para decidir
qué borrar del NVMe sin perder lo que está sólo allí.

**Tradeoff**: ImageHash es trivial de calcular. El coste real está en el
UI de comparación lado-a-lado y la decisión de "con cuál me quedo".
Tiempo: ~2 días.

---

## 4. Transcripción de audio (Whisper local)

**Idea**: ya tienes la carpeta `MODELS/whisper/` esperando. Botón sobre
vídeos (o archivos de audio): transcribe → texto buscable indexado.
Subtítulos `.srt` exportables para Premiere.

**Por qué redondo**: el archivo personal tiene entrevistas, vlogs, takes
con diálogo. Sin transcripción, la búsqueda natural ignora **todo lo
dicho**. Hoy, "cuando hablo de mi padre" devuelve 0 resultados aunque
exista el vídeo. Multiplica la utilidad del archivo.

**Tradeoff**: Whisper large-v3 corre bien en RTX 5070 Ti (cabe en VRAM).
Ya estaba en el roadmap; merece subir prioridad porque la inversión
(modelo + integración) es baja para el retorno.

**Tiempo estimado**: 1 día integrar + UX (1 día más para `.srt` export).

---

## 5. Proyectos (vincular archivos a un proyecto editorial)

**Idea**: nueva entidad **Proyecto** distinta de Colección. Ejemplos:
"boda Ester", "viaje Pirineos", "documental corto X". Cada proyecto
contiene:
- Lista de archivos asociados.
- Ruta del Premiere project (`.prproj`) vinculado.
- Notas, intención, estado (en curso / parado / finalizado), deadline.
- Vínculo con Chronos (tracker de tiempo): horas dedicadas al proyecto.

**Por qué redondo**: hoy Pensadero es "archivo navegable". Con esto pasa
a ser "archivo + workspace de edición". Cierra la pinza con Chronos:
un proyecto vincula tiempo + material + entregable.

**Tradeoff**: scope grande. ~1 semana real. **Cuidado** de no convertirlo
en un Trello/Notion mal hecho. Mantenerlo minimalista: cinco campos,
no veinte.

---

## 6. Modo chat sobre tu archivo

**Idea**: caja de chat en lugar de búsqueda one-shot. El LLM
(qwen2.5:14b) mantiene contexto a través de turnos:
- "muéstrame fotos de Ester sonriendo"
- → "ahora filtra las del verano"
- → "haz una colección con esas"
- → "exporta a Premiere"

**Por qué redondo**: el search bar actual es **transaccional**. El chat
es **exploratorio**. Replica cómo realmente piensas cuando revisas tu
archivo: vas refinando, no formulas la query perfecta de entrada.

**Tradeoff**: ya tienes el LLM corriendo. Sólo añadir gestor de contexto
+ tool-calling (filter, collection-create, scan, export). Tiempo: 3-4
días. Riesgo: latencia perceptible si cada turn re-rankea sobre 10.000
candidatos.

**Mitigación**: cachear el conjunto activo entre turnos. Cada turn
filtra sobre el anterior, no sobre el corpus completo.

---

## 7. Verificación de integridad NVMe ↔ LaCie

**Idea**: tarea programada (mensual o manual): hash de muestras
aleatorias (o completo si hay tiempo), comparar con la copia en el otro
disco. Reporta diffs en la UI con un badge: "1 archivo corrupto detectado
en LaCie 10TB".

**Por qué redondo**: el principio NODO es local-first sin nube → la
integridad de los archivos es **tu** responsabilidad. Hoy no hay forma de
saber si un bitrot silencioso (degradación de bits en disco) te ha
comido un máster en LaCie.

**Tradeoff**: requiere LaCie conectada periódicamente. Tiempo: 2-3 días.
Riesgo: ninguno (solo lectura + comparación de hashes).

**Variante**: en lugar de comparar contra otra copia, comparar contra
un hash guardado previamente en el sidecar `_pensadero.json`. Más
ligero, no necesita ambas copias presentes simultáneamente.

---

## Cómo escoger (si llega el momento)

No todas tienen sentido a la vez. Algunas heurísticas si vuelves a este
documento dentro de meses:

- **Si el cuello de botella está en "ya tengo los clips pero llevarlos a
  Premiere es manual"** → idea 1 (Export Premiere) o variante mínima.
- **Si el archivo ha crecido y la grid plana se ha vuelto incómoda** →
  idea 2 (calendario).
- **Si te has dado cuenta de que tienes mucha basura duplicada** →
  idea 3 (duplicados).
- **Si echas en falta búsqueda por contenido hablado** → idea 4 (Whisper).
- **Si Pensadero + Chronos empiezan a parecer dos apps desconectadas
  haciendo el mismo trabajo** → idea 5 (Proyectos).
- **Si formular queries perfectas se siente forzado** → idea 6 (chat).
- **Si has tenido un susto con un archivo corrupto** → idea 7 (integridad).

Si ninguna fricción aprieta de verdad, **no implementes ninguna**.
Pensadero ya es una herramienta completa. Añadir features sin demanda
real es ruido.

---

## Histórico

| Fecha | Acción |
|---|---|
| 2026-05-23 | Documento creado tras brainstorm exploratorio |
