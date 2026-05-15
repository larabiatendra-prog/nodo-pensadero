# Pensadero — Instalación en NODO (PC nuevo)

Guía paso a paso para dejar Pensadero operativo en una máquina Windows 11 limpia,
con búsqueda en lenguaje natural por LLM local y escaneo visual integrado.
Pensado para NODO (Ryzen 7 9800X3D + RTX 5070 Ti 16 GB) pero válido para
cualquier equipo equivalente con NVIDIA CUDA.

---

## Resumen en 7 pasos

1. Clonar el repo en `C:\DEV\pensadero\`.
2. Instalar Node.js 20+ (https://nodejs.org/).
3. Instalar Python 3.10+ (https://python.org/) — necesario para el módulo de reconocimiento facial. Opcional pero recomendado.
4. Instalar Ollama (https://ollama.com).
5. Descargar los modelos: `qwen2.5:14b-instruct` y `qwen2.5vl:7b`.
6. Doble click en `Pensadero_Install.bat` (la primera vez). Instala dependencias frontend + backend + Python venv con InsightFace.
7. Doble click en `Pensadero_Start.bat` para arrancar.

A partir de ahí: siempre `Pensadero_Start.bat`. Tiempo total primera vez:
~15-20 minutos (sin contar la descarga de modelos Ollama, que son ~15 GB
combinados).

---

## 1. Requisitos

### Lo que SÍ necesita la máquina

- **Windows 10/11.**
- **Node.js 20+** instalado. El bat detecta automáticamente si está en el PATH del sistema.
- **Python 3.10+** (opcional pero recomendado, para el módulo de reconocimiento facial).
- **ffmpeg** en el PATH (para escanear vídeos). En Windows: descargar de https://ffmpeg.org/ y añadir al PATH.
- **Ollama** corriendo como servicio en `localhost:11434`.
- **Modelos Ollama**:
  - `qwen2.5:14b-instruct` (~9 GB) — LLM multilingüe para extracción de intent y re-ranking semántico.
  - `qwen2.5vl:7b` (~6 GB) — VLM multimodal para describir imágenes y frames de vídeo (escaneo visual).
- **Letras de unidad fijas** para discos externos donde estén tus bibliotecas
  (Administración de discos → Cambiar letra y rutas) si los vas a indexar.

### Lo que NO necesita

- **Configuración manual de rutas o env vars**: Pensadero arranca con valores por defecto sensatos.
- **Visual C++ Redistributable**: ya viene con Python 3.10+ Windows installer en la mayoría de casos. Si InsightFace falla en el primer arranque, instálalo desde https://aka.ms/vs/17/release/vc_redist.x64.exe.

---

## 2. Clonar el repo

```powershell
cd C:\DEV
git clone https://github.com/larabiatendra-prog/nodo-pensadero.git pensadero
cd pensadero
```

Si todavía no tienes Git, instálalo desde https://git-scm.com/ y usa
GitHub Desktop o GitHub CLI con la cuenta `larabiatendra-prog`.

---

## 3. Ollama y modelos

Tras instalar Ollama, abrir terminal y descargar los dos modelos:

```powershell
ollama pull qwen2.5:14b-instruct
ollama pull qwen2.5vl:7b
```

Verificación:

```powershell
ollama list
```

Deben aparecer ambos. Tamaños aproximados: 9 GB y 6 GB.

> **Más adelante puedes cambiar los modelos** vía `backend/.env` editando
> `OLLAMA_MODEL` (LLM de búsqueda) o `VLM_MODEL` (VLM de escaneo). Cualquier
> modelo compatible con Ollama vale. Para equipos con menos VRAM,
> alternativas: `qwen2.5:7b-instruct` y mantener `qwen2.5vl:7b`.

---

## 4. Configuración por defecto (no hace falta tocar nada)

Si **no** creas un `backend/.env`, Pensadero arranca con estos defaults:

| Variable | Valor por defecto |
|---|---|
| `PORT` | `5000` |
| `OLLAMA_HOST` | `http://localhost:11434` |
| `OLLAMA_MODEL` | `qwen2.5:14b-instruct` |
| `VLM_MODEL` | `qwen2.5vl:7b` |
| `PERSONS_REGISTRY` | `backend/data/people_registry.json` (se crea al guardar primera persona) |
| `PERSONS_AVATARS_BASE` | `backend/data/` (fotos de personas en `backend/data/people/<id>/`) |
| `AI_RERANK_ENABLED` | `true` (Stage 2 con LLM activado) |
| `AI_RERANK_MIN_PRIMARY` | `5` (umbral para activar Stage 2) |

Si quieres ajustar algo, copia `backend/.env.example` a `backend/.env` y modifica.

---

## 5. Primer arranque

Doble click en `Pensadero_Install.bat`. Hace:

1. Detecta Node (portable en `tools/node/` o del sistema).
2. `npm install` en raíz (frontend).
3. `npm install` en `backend/`.
4. `npm run build` (genera `dist/`).

Tarda 3-5 minutos. Si falla: probablemente antivirus bloqueando archivos en
`node_modules`. Excluye la carpeta `pensadero/` en Windows Defender.

Cuando termine, doble click en `Pensadero_Start.bat`:

- Backend en `http://localhost:5000`.
- Frontend (Vite preview) en `http://localhost:5173`.
- Abre el navegador automáticamente.

Para detener todo: cerrar la ventana negra titulada "Pensadero".

---

## 6. Primer uso

### a) Añadir rutas a indexar

UI → menú "..." (arriba derecha) → **Administrar Rutas** → "Añadir Nueva Ruta".

Ejemplos:
- `C:\Biblioteca Proyectos\` (proyectos editables)
- `E:\Biblioteca Brutos\` (LaCie 10 TB con material)
- `K:\Fotos personales\`

Cada ruta se indexa al añadirla. Aparecen los archivos en la grid principal.

### b) Escanear con IA (generar metadata visual)

En la misma vista "Administrar Rutas", al lado del botón de sincronizar, el
botón ✨ (Sparkles) lanza el escaneo visual: el VLM describe cada imagen,
extrae composición, framing, objetos, expresiones, OCR, colores dominantes.

Genera `_pensadero.json` en cada carpeta procesada. Pensadero lo consume
automáticamente al terminar.

Tiempo aproximado: 2-4 segundos por imagen en RTX 5070 Ti (NODO). El proceso
es idempotente: si vuelves a pulsar, salta las que ya tengan metadata.

> **Importante**: el escaneo no toca los archivos originales. Solo escribe
> un `_pensadero.json` con la metadata. Si no quieres ese archivo en una
> carpeta concreta, simplemente bórralo.

### c) Registrar personas

UI → menú "..." → **Personas** → "Añadir persona".

Crea entradas con:
- `person_id` (interno, alfanumérico): ej. `ester`, `carlos99`, `sara_g`.
- Nombre a mostrar: ej. "Ester García".
- Aliases (opcional): "Ester, Esti".

Sube fotos de referencia (5-10 por persona, distintos ángulos). La primera
foto se marca como avatar automáticamente.

Las personas aparecen en las búsquedas en lenguaje natural ("fotos de Ester
en el cumpleaños") porque el LLM sabe qué `person_id` mapean al nombre.

**El reconocimiento facial es automático** desde la primera versión de NODO:
- Al subir fotos de referencia, Pensadero calcula embeddings con InsightFace
  ArcFace en background (verás "Entrenando embeddings faciales..." en la UI).
- Al escanear nuevo material con ✨, las caras detectadas se comparan contra
  las personas entrenadas. Si la similitud supera el umbral (default 0.5),
  el archivo queda asociado a esa persona.
- El umbral se ajusta vía env var `FACE_MATCH_THRESHOLD` (0.4 más permisivo,
  0.6 más estricto).

### d) Búsqueda en lenguaje natural

En la barra de búsqueda, cambia a modo "natural". Escribe consultas como:

- "fotos del viaje a Pirineos con amigos"
- "atardecer en la playa"
- "cumpleaños de Ester con tarta"
- "concierto de música en Valencia"

El sistema usa dos etapas:
- **Stage 1**: matching literal con scoring sobre tags, descripciones, fechas.
- **Stage 2** (cuando Stage 1 da pocos resultados): el LLM razona sobre las
  descripciones visuales y clasifica los candidatos en "claros" y "menos
  probables". El resultado se divide visualmente en dos tramos.

---

## 7. Salud del sistema

Con Pensadero arrancado, en una terminal:

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/ai/health" -Method GET
Invoke-RestMethod -Uri "http://localhost:5000/api/scan/health" -Method GET
```

Esperas:
```
ollamaRunning : True
modelAvailable : True
model : qwen2.5:14b-instruct  (o qwen2.5vl:7b para scan)
```

Si `ollamaRunning: False` → arranca Ollama o reinicia su servicio.
Si `modelAvailable: False` → falta el `ollama pull <modelo>`.

---

## 8. Migrar datos del Dell (opcional)

Si quieres conservar lo que tenías en el entorno de pruebas del Dell:

| Archivo | Qué guarda | Conservar? |
|---|---|---|
| `backend/favorites_persistent.json` | Favoritos | Sólo si quieres |
| `backend/collections_persistent.json` | Colecciones manuales | Sólo si quieres |
| `backend/scan_paths.json` | Rutas escaneadas | **NO** (las letras de unidad cambian) |
| `backend/media_cache.json` | Cache de metadatos | **NO** (se reconstruye) |
| `backend/thumbnails/` | Miniaturas | **NO** (se regeneran) |
| `backend/data/people_registry.json` | Personas | **Sí** si tienes registry de pruebas |
| `backend/data/people/<id>/*.jpg` | Fotos de referencia | **Sí** junto con el registry |

Las cosas marcadas "NO" se reconstruyen desde cero al escanear las rutas
del nuevo equipo. Es más limpio.

---

## 9. Acceso directo en el escritorio

Click derecho sobre `Pensadero_Start.bat` → **Crear acceso directo** → mueve
el `.lnk` al escritorio. Renómbralo "Pensadero".

Para el icono: `Pensadero-Logo.png` convertido a `.ico`.

---

## 10. Resolución de problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| El navegador abre `:5173` y no carga nada | El frontend aún construye o backend no responde | Espera 10 s y refresca |
| Búsqueda natural devuelve 503 | Ollama no corre o falta el modelo LLM | `ollama list` y `ollama pull qwen2.5:14b-instruct` |
| Botón ✨ deshabilitado en Rutas | Falta Ollama o `qwen2.5vl:7b` | `ollama pull qwen2.5vl:7b` |
| Escaneo IA tarda mucho | Cold-start del modelo (normal en la 1ª imagen) | Las siguientes son rápidas |
| Escaneo IA falla con timeout | Imagen muy grande o modelo lento | Reduce el modelo en `.env`, o procesa en lotes pequeños |
| `npm install` falla con `EPERM` | Antivirus bloqueando | Excluye carpeta `pensadero/` en Defender |
| Puerto 5000 o 5173 ocupado | Otra app usándolo | Cierra la app o cambia `PORT` en `backend/.env` |
| Las fotos de personas no se ven | Falta `backend/data/people/<id>/` | El backend lo crea al subir la primera foto |

---

## 11. Estructura del proyecto

```
pensadero/
├── tools/node/             → Node portable (opcional, fallback)
├── backend/                → API Node + Express + Ollama
│   ├── data/               → Registry de personas + avatares (NO se versiona)
│   ├── services/           → Orquestador de escaneo
│   ├── routes/             → Endpoints REST
│   └── *.js                → Servicios (visual scan, ai search, etc.)
├── src/                    → Frontend React + TS + Tailwind
│   └── components/         → UI (PathManager, PersonsManager, SearchBar...)
├── dist/                   → Build de producción (regenerable)
├── .env                    → Frontend config (opcional)
├── backend/.env            → Backend config (opcional)
├── Pensadero_Install.bat   → Primera vez
└── Pensadero_Start.bat     → Doble click siempre
```

Persistencia local en `backend/` y `backend/data/`. Nada va a la nube. Nada
se versiona en git (todos los archivos sensibles están en `.gitignore`).

---

## Historial de cambios

| Fecha | Descripción |
|---|---|
| 2026-05-06 | Versión inicial con LLM local (qwen2.5:14b) |
| 2026-05-15 | NODO Visión B: añadido escaneo visual integrado (qwen2.5vl:7b), gestión de personas con UI, Stage 2 re-ranking semántico, defaults out-of-the-box sin configuración manual |
| 2026-05-15 | P1+P2+P5: reconocimiento facial automático con InsightFace, soporte de vídeo (ffmpeg + frames + VLM), code-splitting del bundle (main 855→253 KB), indicador IA refinó en SearchBar |
