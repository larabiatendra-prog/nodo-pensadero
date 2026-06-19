# Validación manual — fix de concurrencia y escritura de catálogos

Prueba mínima para confirmar que el fix de locks (`withFileLock` + escritura
atómica con `.tmp` único) **no rompe el flujo normal** y que **los datos
persisten** tras reiniciar. No automatiza nada: se ejecuta a mano una vez.

Qué valida este fix (recordatorio):
- Escritura atómica de `_pensadero.json`, `people_registry.json` y
  `embeddings.json` con `.tmp` único + `rename` (sin corrupción ni `.tmp` huérfanos peligrosos).
- Serialización por ruta del ciclo leer→mutar→escribir (re-id, promote,
  assign-face, scan, re-id de espacios sobre la MISMA carpeta no se pisan).
- Sin pérdida de la asignación manual cuando el re-id de fondo corre a la vez.

---

## 0. Preparación

1. **Carpeta de prueba pequeña**: copia 5–10 fotos a una carpeta vacía bajo una
   biblioteca ya configurada (p. ej. `K:\Fotos\_TEST_concurrencia\`). Que al
   menos 3 fotos tengan **caras** y que 2 personas distintas aparezcan en varias
   fotos (para poder probar re-id, promote y merge).
2. **Arranca la app**: `Pensadero_Start.bat` (o `cd backend && node server.js` +
   `npm run dev` en otra consola). Backend en `:5000`, frontend en `:5173`.
3. **Snapshot inicial** de los ficheros de datos (para comparar después):
   - `backend/data/people_registry.json`
   - `backend/data/people/<id>/embeddings.json` (de las personas que toques)
   - `K:\Fotos\_TEST_concurrencia\_pensadero.json` (no existe aún; se crea al escanear)

> Truco: en esta sesión puedes inspeccionar ficheros con `! type "<ruta>"`
> (Windows) sin salir del chat.

---

## 1. Escaneo visual

- En la pestaña **Rutas**, lanza el escaneo de la carpeta de prueba (escaneo
  visual con VLM). Espera a que la barra llegue al 100 % (`scan_done`).
- **Verifica**:
  - [ ] Se ha creado `..\_TEST_concurrencia\_pensadero.json`.
  - [ ] Contiene `photos` (o `clips`) con una entrada por archivo y, en las fotos
        con cara, `identity.detections[]` con `embedding_b64`.
  - [ ] **NO** queda ningún `_pensadero.json.<pid>.<n>.tmp` suelto en la carpeta
        (el rename atómico limpió el temporal).
  - [ ] Las fotos aparecen en el home/galería.

## 2. Asignar cara manual

- Abre la pestaña **Personas** → sección de caras desconocidas (clusters /
  discovery). Elige una cara desconocida de la carpeta de prueba y **asígnala a
  una persona existente** (o crea una nueva y asígnala).
- **Verifica al instante** (sin reiniciar):
  - [ ] La cara aparece ya etiquetada en el home (refresh inmediato).
  - [ ] En `_pensadero.json`, esa detección tiene `person_id`, `display_name`,
        `confidence: 1` y `assigned_manually: true`.
  - [ ] `identity.faces[]` y `identity.face_count` recalculados.
  - [ ] `backend/data/people/<id>/embeddings.json`: `count` subió en 1 y
        `trained_at` se actualizó (blend del centroid). Existe su `.bak`.

## 3. Reidentificación (con solape — el caso del fix)

Este paso ejercita el **lock**: assign-face dispara un re-id de fondo; aquí
forzamos además un re-id manual para provocar solape sobre la misma carpeta.

- Inmediatamente tras un assign-face (paso 2), pulsa **Reidentificar** en la
  pestaña Personas (no esperes a que termine el re-id de fondo).
- **Verifica**:
  - [ ] El banner de re-id progresa y termina sin error.
  - [ ] La asignación manual del paso 2 **sigue presente** en `_pensadero.json`
        (no se perdió por lost-update). `assigned_manually: true` intacto.
  - [ ] Otras apariciones de esa persona en la carpeta quedaron etiquetadas con
        su `person_id`.
  - [ ] No hay `_pensadero.json.*.tmp` huérfano tras terminar.

## 4. Merge / promote (si aplica)

- **Promote**: si en discovery hay un cluster de caras frecuentes, promociónalo
  a persona nueva. Verifica que las caras del cluster reciben `person_id` en
  `_pensadero.json` y que se crea `backend/data/people/<nuevo-id>/embeddings.json`.
- **Merge**: si tienes 2 personas que son la misma, fusiónalas (loser → survivor).
  - [ ] `people_registry.json`: el loser desaparece; el survivor permanece.
  - [ ] `backend/data/people/<survivor>/embeddings.json`: `count` = suma de ambos,
        `source: "person_merge"`. Existe su `.bak`.
  - [ ] En `_pensadero.json`, las caras del loser quedan reasignadas al survivor.
  - [ ] La carpeta del loser (`backend/data/people/<loser>/`) se borró.

## 5. Reiniciar la app

- Cierra backend y frontend por completo. Vuelve a arrancar (`Pensadero_Start.bat`).
- Espera a que el backend cargue (log "People registry cargado: N personas").

## 6. Comprobar persistencia

Sin re-escanear ni re-asignar nada:
- [ ] La asignación manual del paso 2 **persiste** (cara sigue etiquetada en el home).
- [ ] El re-id del paso 3 **persiste** (apariciones siguen etiquetadas).
- [ ] El promote/merge del paso 4 **persiste** (registry y catálogo coherentes).
- [ ] `people_registry.json` refleja el estado final (personas correctas).
- [ ] Los `embeddings.json` tocados conservan `count`/`trained_at`/`source` del paso correspondiente.
- [ ] **Ningún** fichero quedó corrupto: todos los `_pensadero.json`,
      `people_registry.json` y `embeddings.json` parsean como JSON válido.
- [ ] No quedan `*.tmp` huérfanos en la carpeta de prueba ni en `backend/data/`.
      (Si aparece un `*.corrupt-*`, algo no parseó: investigar ese fichero.)

---

## Criterio de aceptación

PASA si tras el reinicio (paso 6) **todos** los datos de los pasos 2–4 siguen
presentes y coherentes, sin corrupción ni temporales huérfanos. Esto confirma
que la escritura atómica y los locks preservan los datos no regenerables.

## Limpieza

- Borra la carpeta de prueba `_TEST_concurrencia\` y, si creaste personas de
  prueba, elimínalas desde la pestaña Personas (o borra sus carpetas en
  `backend/data/people/` con la app parada).

## Notas

- Estática hasta aquí: este documento NO ejecuta la app; lo corre el usuario.
- Para estresar de verdad el lock (opcional), repite los pasos 2–3 **en ráfaga**
  sobre 2–3 caras seguidas mientras el re-id de fondo aún corre: ninguna
  asignación debe perderse.
