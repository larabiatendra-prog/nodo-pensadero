# Guía de instalación de Pensadero en NODO

> Versión actualizada para el instalador automático (2026-05-23).
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
- Descargar los modelos de IA (qwen2.5 14B y qwen2.5vl 7B).
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
[9/9] Modelos IA (15 GB)        ~20-40 minutos
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
| Botón ✨ (escaneo IA) deshabilitado | Falta `qwen2.5vl:7b` | Abre cmd: `ollama pull qwen2.5vl:7b` |
| Búsqueda natural devuelve error 503 | Falta `qwen2.5:14b-instruct` o Ollama no corre | Doctor dirá cuál es |
| Pensadero abre pero no detecta caras | Python o venv no instalados | Doctor lo dirá. Solución: relanza instalador |
| Pensadero no escanea vídeos | Falta ffmpeg | Doctor lo dirá. Solución: relanza instalador |
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
ollama pull qwen2.5:14b-instruct
ollama pull qwen2.5vl:7b
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

El instalador descarga `qwen2.5vl:7b` por defecto: cabe en cualquier GPU decente y funciona bien. Pero NODO tiene **16 GB VRAM** (RTX 5070 Ti) y puede correr modelos visión más potentes que dan descripciones más ricas, fieles y específicas.

### Modelos recomendados según VRAM

| Modelo | VRAM aprox. (q4) | Calidad | Notas |
|---|---|---|---|
| `qwen2.5vl:7b` | ~5 GB | Buena | Default. Rápido y multilingüe. |
| `minicpm-v:8b` | ~5 GB | Buena | Fuerte en detalle visual + OCR. |
| `gemma3:12b` | ~8 GB | Muy buena | Salto notable sobre 7b. |
| `internvl3:14b` | ~9 GB | Excelente | **Recomendado para NODO.** Top sin riesgo de OOM. |
| `gemma3:27b` | ~16 GB | Excelente | Al límite — riesgo de OOM con contexto largo. |
| `qwen2.5vl:32b` | ~18 GB | Excelente | **NO cabe en 16 GB VRAM.** No usar. |

### Cómo cambiar el modelo

1. Descarga el modelo elegido. Ejemplo recomendado:
   ```powershell
   ollama pull internvl3:14b
   ```
2. Abre Pensadero. Menú "..." → **Configuración del escaneo visual** (el selector lista solo modelos visión disponibles).
3. Selecciona el modelo nuevo y guarda. No necesitas reiniciar.

### Cuándo re-escanear

Tras cambiar a un modelo más potente, el corpus ya escaneado conserva la metadata vieja. Para aprovechar el modelo nuevo:

- **Carpeta concreta**: en la UI, botón "Re-escanear forzado" en el PathManager de esa biblioteca.
- **Todo el corpus**: ejecuta el re-scan biblioteca por biblioteca (es serie, ocupa la GPU mientras corre).

El re-scan respeta los `_pensadero.json` existentes hasta que termina cada archivo, por lo que es seguro interrumpir y reanudar.

### Variables opcionales en `backend/.env`

| Variable | Default | Para qué |
|---|---|---|
| `VLM_MODEL` | `qwen2.5vl:7b` | Modelo visión por defecto si no eliges desde la UI. |
| `VLM_IMAGE_MAX_SIDE` | `1568` | Píxeles del lado mayor al redimensionar antes de pasar al VLM. Bajar a `1024` acelera; subir a `2048` puede dar más detalle pero usa más VRAM y tiempo. |
| `VLM_VIDEO_FRAMES` | `3` | Frames muestreados por vídeo. Subir a `5-6` da mejor cobertura en vídeos largos. |
| `VLM_TIMEOUT_MS` | `180000` | Timeout por imagen (ms). 180s suele bastar; bajar a `60000` en NODO con GPU rápida si quieres detectar cuelgues antes. |
| `OLLAMA_HOST` | `http://localhost:11434` | Cambiar solo si Ollama corre en otra máquina. |

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
