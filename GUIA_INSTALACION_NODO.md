# Guía de instalación de Pensadero en NODO

> Versión actualizada para el instalador automático (2026-06-06).
> Pensada para el PC NODO (Windows 11, RTX 5070 Ti).
> No requiere conocimientos técnicos. Si algo falla, ve al final.

---

## Idea general

Pensadero tiene **dos archivos** que vas a usar siempre:

| Archivo | Cuándo | Qué hace |
|---|---|---|
| `Pensadero_Install.bat` | **Solo la primera vez** (o cuando algo se rompa) | Instala todo lo necesario en NODO |
| `Pensadero_Start.bat` | **Cada vez que quieras usar Pensadero** | Arranca la app y abre el navegador |

Hay un tercero, `Pensadero_Doctor.bat`, que **no instala nada** pero te dice qué está roto si algo no funciona.

---

## Antes de empezar

### Requisitos mínimos en NODO

- Windows 10 o 11 (NODO tiene 11 — OK).
- ~30 GB libres en disco C: (modelos IA + dependencias).
- Conexión a internet (~16 GB de descarga la primera vez).
- Driver NVIDIA actualizado (RTX 5070 Ti ya debería tenerlo de fábrica).

### Lo que NO tienes que hacer manualmente

El instalador hace todo esto solo:
- Instalar Node.js, Python, Ollama, ffmpeg.
- Descargar los modelos de IA (gemma4:12b y qwen2.5:7b-instruct).
- Instalar las dependencias del proyecto (npm + pip).
- Crear el entorno Python (.venv) con InsightFace y SigLIP-2.
- Construir el bundle de producción.

---

## Instalación paso a paso

### 1. Copiar el proyecto a NODO

Dos opciones:

**A) Copia desde el Dell por disco externo:**
- Lleva la carpeta `pensadero/` entera a NODO. Ruta sugerida: `C:\DEV\pensadero\`.
- **IMPORTANTE**: antes de copiar, borra del Dell estas carpetas (se regeneran):
  - `node_modules/` (raíz y `backend/`)
  - `backend/python/.venv/`
  - `dist/`
  - `backend/thumbnails/`
  - `backend/media_cache.json`
  - `backend/scan_paths.json` (las letras de unidad cambian)

  Sin borrarlas, copias 2-3 GB de basura inútil.

**B) Clonar desde GitHub** (si NODO tiene Git):
```powershell
cd C:\DEV
git clone https://github.com/larabiatendra-prog/nodo-pensadero.git pensadero
```

### 2. Doble click en `Pensadero_Install.bat`

Se abre una ventana negra que va contando 9 pasos:

```
[1/9] winget                    ~5 segundos
[2/9] Node.js                   ~1 minuto
[3/9] Python 3.11               ~1 minuto
[4/9] Ollama                    ~2 minutos
[5/9] ffmpeg                    ~30 segundos
[6/9] Dependencias frontend     ~2 minutos
[7/9] Dependencias backend      ~2 minutos
[8/9] Módulo Python             ~3-8 minutos
[9/9] Modelos IA (~20 GB)       ~25-50 minutos
```

**Es probable que Windows te pida confirmación (UAC) varias veces** en los pasos 2-5. Pulsa "Sí" cada vez. No es opcional, Windows lo exige para instalar programas.

**Tiempo total**: 30-60 minutos según la velocidad de tu conexión. Puedes irte a tomar un café desde el paso 9.

### 3. Verificación al final

El instalador hace un chequeo final. Si todo está OK, verás:

```
==============================================================
                INSTALACION COMPLETA
==============================================================

 Todo listo. Arranca Pensadero con doble click en:
   Pensadero_Start.bat
```

Si ves "INSTALACION CON AVISOS" en lugar de "COMPLETA", lanza `Pensadero_Doctor.bat` para ver exactamente qué falta.

### 4. Doble click en `Pensadero_Start.bat`

A partir de ahora, **siempre** este. Abre el navegador en `http://localhost:5173`.

Para cerrar Pensadero: cierra la ventana negra que dice "Pensadero".

---

## Si algo falla

### Plan general

1. Ejecuta `Pensadero_Doctor.bat` — te dice exactamente qué pieza está rota.
2. Mira la tabla de abajo según el síntoma.
3. Si la solución sugerida es "relanza el instalador", ejecuta `Pensadero_Install.bat` otra vez. Es **idempotente**: salta lo que ya está bien y arregla lo que falta.

### Tabla de problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| Ventana negra cierra inmediatamente | Antivirus bloqueando el .bat | Excluye carpeta `pensadero/` en Windows Defender, relanza |
| `[ERROR] winget no encontrado` | Windows muy desactualizado | Actualiza "App Installer" desde Microsoft Store |
| Pide UAC repetidamente | Normal en primera instalación | Pulsa "Sí" cada vez |
| El paso 2-5 falla pero no rompe | PATH no refrescado en la sesión cmd | **Reinicia el PC** y relanza el instalador, completará lo que falte |
| Paso 6 o 7 (`npm install`) falla con EPERM | Antivirus bloqueando node_modules | Excluye carpeta `pensadero/` en Defender, relanza |
| Paso 8 (Python) falla con "no se pudo crear venv" | Python no quedó en PATH | Reinicia PC y relanza instalador |
| Paso 9 (ollama pull) muy lento o se cuelga | Conexión inestable | Cancela (Ctrl+C), relanza instalador — reanuda la descarga |
| Paso 9 falla con "model not found" | Servicio Ollama no arrancó | Abre cmd y ejecuta `ollama serve` en una ventana, deja abierta, relanza instalador |
| Doctor dice "Ollama no responde" | El servicio no arrancó al iniciar Windows | El `Start.bat` lo arranca solo ahora. Si persiste: `ollama serve` manual |
| Doctor dice "GPU NVIDIA no encontrada" | Driver NVIDIA no instalado | Descarga driver desde nvidia.com (no debería pasar en NODO) |
| Botón ✨ (escaneo IA) deshabilitado | Falta el VLM `VLM_MODEL` (NODO: `gemma4:12b`) | Abre cmd: `ollama pull gemma4:12b` |
| Búsqueda natural devuelve error 503 | Falta el modelo de `OLLAMA_MODEL` (NODO: `qwen2.5:7b-instruct`) o Ollama no corre | Doctor dirá cuál es |
| Escaneo visual falla / botón ✨ 503 | Falta el modelo de `VLM_MODEL` (NODO: `gemma4:12b`) | `ollama pull gemma4:12b` |
| Pensadero abre pero no detecta caras | Python o venv no instalados | Doctor lo dirá. Solución: relanza instalador |
| Pensadero no escanea vídeos | Falta ffmpeg | Doctor lo dirá. Solución: relanza instalador |
| InsightFace lento / CPU al 100% aunque haya GPU | `.venv` copiado de otro PC (rutas rotas) o onnxruntime sin CUDA | Doctor muestra `[WARN] onnxruntime sin CUDAExecutionProvider`. Solución: eliminar `backend/python/.venv/`, relanzar instalador. Si persiste: `backend\python\.venv\Scripts\python.exe -m pip install onnxruntime-gpu --upgrade` |
| Puerto 5000 o 5173 ocupado | Otra app usándolos | Cierra esa app, o edita `backend/.env` para cambiar PORT |
| El navegador abre pero pantalla blanca | Backend tarda en arrancar | Espera 10 segundos y refresca con F5 |
| "No se ven mis fotos de personas" | Carpeta `backend/data/people/<id>/` vacía | Sube fotos desde la UI → Personas |

### Comandos manuales útiles

Si Pensadero está abierto y quieres verificar la salud de la IA, abre PowerShell y prueba:

```powershell
# Comprobar que Ollama responde
Invoke-RestMethod -Uri "http://localhost:5000/api/ai/health"

# Comprobar que el escaneo visual está OK
Invoke-RestMethod -Uri "http://localhost:5000/api/scan/health"

# Listar modelos instalados
ollama list

# Si falta un modelo, descargarlo manualmente
ollama pull gemma4:12b              # VLM principal (default)
ollama pull qwen2.5:7b-instruct    # busqueda natural
# VLM opcionales del catalogo (cambio manual desde la UI):
ollama pull gemma4:27b             # experimento (riesgo OOM 16 GB)
ollama pull gemma3:12b             # legacy / fallback
```

Los `health` deben devolver `ollamaRunning: True` y `modelAvailable: True`.

---

## Cosas que SÍ tienes que tocar manualmente

Solo tres cosas no se pueden automatizar:

1. **Letras de unidad de discos externos.** Pensadero indexa carpetas (`E:\Biblioteca Brutos`, `K:\Fotos`, etc.). Si la letra cambia entre arranques, Pensadero pierde la referencia.
   - Solución: Windows → "Administración de discos" → asignar letra fija a cada disco externo.

2. **Confirmaciones UAC del instalador.** Pulsar "Sí" cuando Windows lo pida.

3. **Rutas a indexar.** Añadirlas desde la UI de Pensadero → menú "..." → "Administrar Rutas".

---

## Optimizar el escaneo visual en NODO

El instalador descarga `gemma4:12b` por defecto: el modelo principal recomendado, equilibrio calidad/velocidad/VRAM en los 16 GB de NODO (RTX 5070 Ti). El selector de la UI ofrece SIEMPRE un catalogo curado de tres modelos; los que no estes descargados aparecen como "pendiente de descarga" con su comando `ollama pull`.

### Catalogo VLM (selector de la UI)

| Modelo | Tier | VRAM aprox. (q4) | Notas |
|---|---|---|---|
| `gemma4:12b` | Producción | ~8 GB | **Default.** Escaneo diario. Deja VRAM para caras + CLIP. |
| `gemma4:27b` | Experimento | ~16 GB | Mayor calidad para reanálisis. Al límite — riesgo de OOM con contexto largo. Manual, nunca default. |
| `gemma3:12b` | Legacy | ~8 GB | Fallback manual mientras siga útil. |

Cualquier otro VLM instalado en Ollama (p.ej. `qwen2.5vl:7b`, `minicpm-v:8b`) también aparece en el selector bajo "Otros instalados". `qwen2.5vl:32b` (~18 GB) **NO cabe en 16 GB VRAM** — descartado para NODO.

### Cómo cambiar el modelo

1. Descarga el modelo elegido si aún no lo tienes. Default:
   ```powershell
   ollama pull gemma4:12b
   ```
2. Abre Pensadero → pestaña **Rutas**. El selector "Modelo que describe las fotos" lista el catalogo curado (agrupado por tier) más los VLM instalados.
3. Selecciona el modelo nuevo. El cambio es inmediato y manual (sin fallback automático). No necesitas reiniciar.

### Cuándo re-escanear

Tras cambiar a un modelo más potente, el corpus ya escaneado conserva la metadata vieja. Para aprovechar el modelo nuevo:

- **Carpeta concreta**: en la UI, botón "Re-escanear forzado" en el PathManager de esa biblioteca.
- **Todo el corpus**: ejecuta el re-scan biblioteca por biblioteca (es serie, ocupa la GPU mientras corre).

El re-scan respeta los `_pensadero.json` existentes hasta que termina cada archivo, por lo que es seguro interrumpir y reanudar.

### Variables en `backend/.env`

Para NODO hay un fichero listo: copia `backend/.env.nodo` como `backend/.env`
(`copy backend\.env.nodo backend\.env`). Valores objetivo NODO:

| Variable | NODO | Para qué |
|---|---|---|
| `VLM_MODEL` | `gemma4:12b` | VLM de escaneo (default del catalogo). Equilibrio calidad/velocidad/VRAM en 16 GB. Fallback **manual** (sin automatismo): si falla, cámbialo a `gemma3:12b` y re-escanea. |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Modelo de texto de la búsqueda natural. Prioriza velocidad. |
| `VLM_TIMEOUT_MS` | `300000` | Timeout por imagen (ms). Holgado por el cold-start del modelo 14b. |
| `VLM_VIDEO_FRAMES` | `3` | Frames por vídeo (inicio/medio/final). El vídeo es una **escena única**. No subir, no lógica adaptativa, no detección de escenas. |
| `VLM_VIDEO_NUM_PREDICT` | `1400` | Tokens de la llamada multi-imagen de vídeo. |
| `VLM_IMAGE_MAX_SIDE` | `1568` | Lado mayor (px) al redimensionar antes del VLM. |
| `OLLAMA_HOST` | `http://localhost:11434` | Cambiar solo si Ollama corre en otra máquina. |

> **Modelos del objetivo NODO** (el instalador ya los descarga en el paso 9; estos
> comandos solo hacen falta si quieres bajar alguno a mano):
> ```powershell
> ollama pull gemma4:12b        # VLM principal de escaneo (default)
> ollama pull qwen2.5:7b-instruct  # busqueda en lenguaje natural
> ```
> VLM opcionales del catalogo (descarga manual, cambio manual desde la UI):
> ```powershell
> ollama pull gemma4:27b        # experimento (riesgo OOM 16 GB)
> ollama pull gemma3:12b        # legacy / fallback manual
> ```

---

## Validación GPU en NODO (RTX 5070 Ti / Blackwell)

> Esto se valida **en el NODO real**, no en el equipo de desarrollo. La RTX 5070 Ti
> es arquitectura **Blackwell (SM_120)**. Algunas librerías necesitan versiones
> recientes para usar esa GPU; si no, caen a CPU (funciona, pero lento) o fallan.
> Pensadero está diseñado para **degradar de forma controlada**: si una pieza cae
> a CPU, el resto del escaneo sigue. Lo que NO queremos es no enterarnos.

Tras instalar en NODO, comprueba estas 6 cosas. Comandos desde la carpeta del
proyecto (`backend\python\.venv\Scripts\python.exe` es el Python del proyecto).

**1. Ollama usa GPU**
```powershell
# Con un modelo cargado (lanza un escaneo o una búsqueda), en otra ventana:
ollama ps
```
La columna `PROCESSOR` debe decir `100% GPU` (o mayoritariamente GPU). Si dice
`CPU`, Ollama no está usando la tarjeta → actualiza Ollama a la última versión.

**2. Torch ve CUDA** (lo usa SigLIP-2 / CLIP)
```powershell
backend\python\.venv\Scripts\python.exe -c "import torch; print('cuda', torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'sin GPU')"
```
Debe imprimir `cuda True` y el nombre de la 5070 Ti. Si `cuda False`: el wheel de
torch no soporta Blackwell → reinstalar torch con índice CUDA 12.8:
```powershell
backend\python\.venv\Scripts\python.exe -m pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu128
```

**3. onnxruntime ofrece `CUDAExecutionProvider`** (lo usa InsightFace)
```powershell
backend\python\.venv\Scripts\python.exe -c "import onnxruntime as ort; print(ort.get_available_providers())"
```
La lista debe incluir `CUDAExecutionProvider`. Si solo aparece
`CPUExecutionProvider`: actualizar onnxruntime-gpu (Blackwell necesita >= 1.20):
```powershell
backend\python\.venv\Scripts\python.exe -m pip install --upgrade onnxruntime-gpu
```

**4. InsightFace funciona en GPU (o cae controlado a CPU)**
```powershell
backend\python\.venv\Scripts\python.exe backend\python\face_detector.py detect "ruta\a\una\foto_con_cara.jpg"
```
En la salida de arranque (stderr) verás `providers=[...]`. Si incluye
`CUDAExecutionProvider`, va en GPU. Si solo `CPUExecutionProvider`, va en CPU
(funciona, ~8x más lento). Forzar CPU a propósito: `FACE_PROVIDER=cpu` en `.env`.

**5. CLIP/SigLIP no rompe el escaneo**
Lanza un escaneo de una carpeta pequeña con fotos. En el log del backend, al
arrancar el escaneo debe aparecer `[scan] CLIP/SigLIP-2 listo y validado`. Si
aparece `CLIP/SigLIP-2 no disponible`, el escaneo **continúa** (descripción VLM +
caras siguen), pero la búsqueda por imagen/texto no se indexa hasta arreglarlo
(normalmente es el punto 2: torch sin CUDA).

**6. Diagnóstico rápido**
```powershell
Pensadero_Doctor.bat
```
Avisa de `onnxruntime sin CUDAExecutionProvider` y de GPU infrautilizada.

### Qué hacer si algo cae a CPU o falla

| Pieza en CPU/fallo | Impacto | Acción |
|---|---|---|
| Ollama en CPU | Escaneo VLM y búsqueda **muy** lentos | Actualizar Ollama; reiniciar `ollama serve` |
| Torch sin CUDA | CLIP/SigLIP lento o no indexa búsqueda visual | Reinstalar torch con `cu128` (punto 2) |
| onnxruntime sin CUDA | InsightFace en CPU (~8x lento) | `pip install --upgrade onnxruntime-gpu` (punto 3) |
| InsightFace en CPU | Detección de caras lenta, no rompe nada | Aceptable temporalmente; el escaneo sigue |
| CLIP no carga | No hay búsqueda por imagen/texto | El escaneo de descripción + caras **sigue**; arreglar torch y re-escanear |

Regla general: **ninguna de estas caídas detiene el escaneo de metadata**. Puedes
escanear con lo que funcione y arreglar las piezas GPU después; los embeddings
(CLIP) se regeneran re-escaneando, las caras con "Re-escanear forzado".

---

## Migrar datos del Dell (opcional)

Si quieres llevarte cosas del entorno de pruebas del Dell a NODO:

| Archivo | ¿Conservar? | Por qué |
|---|---|---|
| `backend/favorites_persistent.json` | Sí, si quieres | Tus favoritos |
| `backend/collections_persistent.json` | Sí, si quieres | Colecciones manuales |
| `backend/data/people_registry.json` | **Sí** | Personas que has registrado |
| `backend/data/people/<id>/*.jpg` | **Sí** | Fotos de referencia de cada persona |
| `backend/scan_paths.json` | **NO** | Letras de unidad distintas |
| `backend/media_cache.json` | **NO** | Se reconstruye al escanear |
| `backend/thumbnails/` | **NO** | Se regenera |
| `node_modules/`, `dist/`, `.venv/` | **NO** | Los recrea el instalador |

Copia solo lo marcado "Sí" antes de lanzar el instalador en NODO. El resto, deja que se construya en limpio.

---

## Acceso directo en el escritorio

Para no ir a la carpeta del proyecto cada vez:

1. Click derecho sobre `Pensadero_Start.bat`.
2. "Crear acceso directo".
3. Mueve el `.lnk` al escritorio.
4. Renómbralo "Pensadero".
5. (Opcional) Click derecho → "Propiedades" → "Cambiar icono" → selecciona `Pensadero-Logo.png` convertido a `.ico`.

---

## Reinstalar desde cero (si nada funciona)

Plan nuclear:

1. Borra estas carpetas/archivos del proyecto:
   - `node_modules/` (raíz)
   - `backend/node_modules/`
   - `backend/python/.venv/`
   - `dist/`
2. Doble click en `Pensadero_Install.bat`.
3. Espera a que termine.
4. Doble click en `Pensadero_Start.bat`.

**No** borres:
- `backend/data/` (perderías personas registradas).
- `backend/favorites_persistent.json` y `backend/collections_persistent.json` (perderías colecciones).

---

## Estructura del proyecto (para referencia)

```
pensadero/
├── Pensadero_Install.bat   ← Doble click la primera vez
├── Pensadero_Start.bat     ← Doble click siempre
├── Pensadero_Doctor.bat    ← Diagnóstico cuando algo falla
├── GUIA_INSTALACION_NODO.md ← Este archivo
├── tools/node/             ← Node portable (opcional)
├── backend/
│   ├── server.js           ← API + WebSocket
│   ├── data/               ← Personas y embeddings (NO borrar)
│   ├── python/.venv/       ← Entorno Python (regenerable)
│   ├── routes/             ← Endpoints REST
│   └── services/           ← Orquestador escaneo, caras, CLIP
├── src/                    ← Frontend React + TS + Tailwind
└── dist/                   ← Build de producción (regenerable)
```

Todo lo que **no** se versiona en git está en `.gitignore`. Nada va a la nube.

---

## Si todo lo demás falla

1. Lanza `Pensadero_Doctor.bat` y haz captura de pantalla del resultado.
2. Lanza `Pensadero_Install.bat` y deja correr hasta el final (aunque vea errores).
3. Si tras eso sigue roto, abre una sesión nueva de Claude Code en la carpeta del proyecto y pega:
   - Captura del Doctor.
   - Síntoma exacto (qué hiciste, qué esperabas, qué pasó).
   - Si hay error en la UI: F12 en el navegador → pestaña "Consola" → captura.

---

## Historial de cambios

| Fecha | Cambio |
|---|---|
| 2026-05-06 | Versión inicial — instalación manual paso a paso |
| 2026-05-15 | NODO Visión B — escaneo visual, gestión personas, defaults sin config |
| 2026-05-15 | P1+P2+P5 — InsightFace, vídeo con ffmpeg, code-splitting |
| 2026-05-23 | Instalador unificado — Install.bat bootstrap completo (winget + ollama pull) + Doctor.bat de diagnóstico |
| 2026-05-23 | Mejoras prompt VLM — system role, format:json, few-shot, definiciones shot_type, pre-resize sharp, num_predict 900, agregador vídeo por densidad semántica. Selector front reconoce internvl3. Nueva sección "Optimizar el escaneo visual en NODO". |
| 2026-05-25 | Doctor.bat: check CUDAExecutionProvider en onnxruntime (detecta GPU infrautilizada por .venv roto o Blackwell SM_100). Install.bat: aviso CUDA post-paso 8. GUIA: fila troubleshooting CPU bottleneck. |
| 2026-06-01 | Config objetivo NODO: `backend/.env.nodo` (VLM `gemma3:12b`, búsqueda `qwen2.5:7b-instruct`, vídeo 3 frames). VLM sin fallback automático (fallback manual a `qwen2.5vl:7b`). Nueva sección "Validación GPU en NODO (Blackwell)". Drift corregido (`llama3.1:8b` ya no es modelo de búsqueda; tabla de vars no sugiere subir frames). |
| 2026-06-01 | VLM principal cambiado de `internvl3:14b` a `gemma3:12b`: `internvl3` NO existe en la library oficial de Ollama (registry da 404), el pull fallaría. `gemma3:12b` (~8 GB, verificado en registry) cabe holgado en 16 GB con caras+CLIP. Instalador queda plug-and-play. |
| 2026-06-06 | Catalogo VLM seleccionable: `gemma4:12b` (default/produccion), `gemma4:27b` (experimento), `gemma3:12b` (legacy/fallback). El selector de la UI muestra siempre los tres; los no instalados salen como "pendiente de descarga" con su `ollama pull`. Default `VLM_MODEL` movido a `gemma4:12b`. Regex de deteccion VLM ampliada `gemma3`→`gemma[3-9]`. Sin fallback automatico (cambio manual). `qwen2.5vl:32b` descartado (no cabe en 16 GB). |
