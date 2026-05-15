# Pensadero — Instalación en PC nuevo

Guía paso a paso para dejar Pensadero operativo en una máquina Windows 11 limpia, incluyendo la búsqueda en lenguaje natural con LLM local. Pensado para el PC Locura (RTX 5070 Ti 16 GB) pero válido para cualquier equipo equivalente.

---

## Resumen en 4 pasos

1. Copiar la carpeta `pensadero/` al disco del PC nuevo.
2. Instalar Ollama y descargar `qwen2.5:14b-instruct`.
3. Doble click en `Pensadero_Install.bat` (la primera vez).
4. Doble click en `Pensadero_Start.bat`.

A partir de ahí: arrancar siempre con `Pensadero_Start.bat`. Tiempo total primera vez: ~10 minutos (sin contar la descarga del modelo Ollama).

---

## 1. Requisitos previos

### Lo que SÍ necesita la máquina

- **Windows 10/11.**
- **Ollama** instalado (https://ollama.com/download). Tras instalarlo, queda como servicio en segundo plano escuchando en `localhost:11434`.
- **Modelo `qwen2.5:14b-instruct`** descargado. ~9 GB en disco, cabe entero en VRAM de 16 GB.
- **Letras de unidad fijas** para los discos externos donde estén las bibliotecas (K:, Y:, etc.). Si en el PC nuevo se mapean con otras letras, hay que reasignarlas en *Administración de discos* o se rompen las rutas de `scan_paths.json`.

### Lo que NO necesita la máquina

- **Node.js no hace falta instalarlo aparte.** Pensadero trae su propio Node portable en `tools/node/` (ver `Pensadero_Install.bat`). Ese Node se usa para todo: `npm install`, build del frontend, arranque del backend.
- **Sin librerías de Python ni dependencias del sistema.** El reconocimiento facial y de espacios lo hace Marina Video Batch en otra máquina/proceso. Pensadero solo *lee* los sidecar JSON resultantes.

---

## 2. Copiar el proyecto

Ruta sugerida en el PC nuevo:

```
D:\projects\Personal\pensadero\
```

Copiar **toda** la carpeta excepto:

- `node_modules/` (raíz y `backend/node_modules/`) — se regeneran solos.
- `dist/` — se reconstruye en el primer arranque.

Si por velocidad quieres copiarlos también, no pasa nada; el `.bat` los detectará y los reutilizará.

---

## 3. Ollama y el modelo de IA

Una vez instalado Ollama, abrir una terminal:

```
ollama pull qwen2.5:14b-instruct
```

Verificar:

```
ollama list
```

Debe aparecer la línea con `qwen2.5:14b-instruct` y tamaño ~9 GB.

> Si en algún momento se quiere ir más rápido a costa de calidad: `ollama pull qwen2.5:7b-instruct` y cambiar `OLLAMA_MODEL` en `backend/.env`. El stack tolera cualquiera de los dos.

---

## 4. Configuración (`.env`)

Las dos `.env` del repo ya vienen rellenadas con valores válidos para arrancar en local. Solo se tocan si:

### `pensadero/.env` (frontend)

```
VITE_API_URL=http://localhost:5000
VITE_WS_URL=ws://localhost:5000/ws
```

Dejar como está salvo que se cambie el puerto del backend.

### `pensadero/backend/.env` (backend)

```
PORT=5000
CONTENT_DIR=
SERVER_URL=http://localhost:5000
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen2.5:14b-instruct

PERSONS_REGISTRY=
PERSONS_AVATARS_BASE=
```

Variables a revisar en el PC nuevo:

- `PERSONS_REGISTRY` — ruta absoluta al `people_registry.json` que genera Marina Video Batch. Si está vacío, la búsqueda funciona pero las caras aparecen sin nombre/avatar. Ejemplo: `D:\projects\Personal\pensadero\data\people_registry.json`.
- `CONTENT_DIR` — solo se usa como fallback si `scan_paths.json` está vacío. Lo normal es dejarlo vacío y añadir las rutas desde la UI.

---

## 5. Primer arranque

Doble click en `Pensadero_Install.bat`.

Hace lo siguiente:

1. Verifica Node portable en `tools/node/`.
2. `npm install` en la raíz (frontend).
3. `npm install` en `backend/` (backend).
4. `npm run build` (genera `dist/`).

Tarda 3–5 minutos. Si falla, lee el error en la consola; suelen ser problemas de permisos o de antivirus bloqueando archivos en `node_modules`.

Cuando termine, doble click en `Pensadero_Start.bat`:

- Levanta backend en `http://localhost:5000`.
- Levanta frontend (Vite preview) en `http://localhost:5173`.
- Abre el navegador automáticamente.

Para detener todo: cerrar la ventana negra principal titulada "Pensadero".

---

## 6. Añadir bibliotecas

Desde la UI, pestaña **Rutas**. Añadir las carpetas que se quieran indexar, por ejemplo:

```
K:\Fotos
Y:\Brutos
D:\Proyectos
```

El primer escaneo de cada ruta tarda en función del número de archivos. La barra de progreso usa el WebSocket en `:5000/ws`, no hay que recargar la página.

---

## 7. Migrar datos del PC anterior (opcional)

Si quieres conservar favoritos, colecciones y miniaturas del PC viejo, **antes del primer arranque** copia estos archivos sobre los del PC nuevo:

| Archivo | Qué guarda |
|---|---|
| `backend/favorites_persistent.json` | IDs de favoritos |
| `backend/collections_persistent.json` | Colecciones manuales y orden |
| `backend/scan_paths.json` | Rutas de bibliotecas (solo si las letras de unidad coinciden) |
| `backend/media_cache.json` | Cache de metadatos (acelera el primer arranque) |
| `backend/thumbnails/` | Miniaturas ya generadas |

Si las letras de unidad **no coinciden**, no copies `scan_paths.json` ni `media_cache.json`: añade las rutas desde la UI y deja que Pensadero reconstruya la cache. Es más limpio que perseguir paths rotos.

---

## 8. Acceso directo en el escritorio

Click derecho sobre `Pensadero_Start.bat` → **Crear acceso directo** → mover el `.lnk` al escritorio. Renombrarlo a "Pensadero". Cambiar icono opcionalmente con `Pensadero-Logo.png` (convertir a `.ico` si Windows lo pide).

---

## 9. Comprobación rápida de salud

Con Pensadero arrancado, en una terminal PowerShell:

```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/ai/health" -Method GET
```

Resultado esperado:

```
ollamaRunning: True
modelAvailable: True
model: qwen2.5:14b-instruct
```

Si `ollamaRunning: False` → arranca Ollama (`ollama serve` o reinicia el servicio de Windows).
Si `modelAvailable: False` → falta el `ollama pull qwen2.5:14b-instruct`.

---

## Resolución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| El navegador abre `:5173` y no carga nada | El frontend aún está construyendo o backend no responde | Espera 10 s y refresca. Si persiste, mira la ventana del backend |
| Búsqueda natural devuelve 503 | Ollama no corre o falta el modelo | `ollama list` y comprobar que está `qwen2.5:14b-instruct` |
| Escaneo no encuentra archivos | Letra de unidad cambió | Reasignar letras en *Administración de discos* o reañadir rutas desde la UI |
| Primera consulta IA tarda >20 s | Cold start del modelo (normal) | Las siguientes son rápidas. Si quieres tenerlo siempre caliente, lanza una query al arrancar |
| `npm install` falla con `EPERM` | Antivirus bloqueando | Excluir la carpeta `pensadero/` en Windows Defender |
| Puerto 5000 o 5173 ocupado | Otra app está usándolo | Cerrar la app o cambiar `PORT` en `backend/.env` y `VITE_API_URL` en `.env` |

---

## Estructura mental

```
pensadero/
├── tools/node/          → Node.js portable (no tocar)
├── backend/             → API Node + Express, datos persistentes
├── src/                 → Frontend React+TS
├── dist/                → Build de produccion (regenerable)
├── .env                 → Config frontend
├── backend/.env         → Config backend (puerto, Ollama, registry)
├── Pensadero_Install.bat
└── Pensadero_Start.bat  → Doble click aquí siempre
```

Persistencia local en `backend/`: nada se sube a la nube, nada se versiona en git.

---

## Historial de cambios

| Fecha | Descripción |
|---|---|
| 2026-05-06 | Documento creado tras verificar circuito completo de IA en local con `qwen2.5:14b-instruct` |
