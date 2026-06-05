# Pensadero

Archivo audiovisual personal de uso individual. Pensadero escanea carpetas locales (incluidos discos externos con letra fija) y construye una biblioteca navegable de fotos, vídeos y audio. No tiene autenticación ni multiusuario: es para una sola persona en un único PC. Los metadatos enriquecidos (etiquetas, descripción visual, paleta, caras, espacios) se leen desde ficheros sidecar JSON colocados junto a cada archivo, generados externamente por Marina Video Batch personal.

## Requisitos

- Windows 11
- Node.js 20 o superior — https://nodejs.org/
- Opcional: Ollama corriendo en `http://localhost:11434` con el modelo `llama3.1:8b` para búsqueda semántica con IA.

## Instalación

1. Copia o clona este repositorio en `C:\TOOLS\Pensadero\`.
2. Doble click en `Pensadero_Start.bat`.

La primera ejecución instala dependencias del frontend y del backend, construye el bundle de producción y abre el navegador en `http://localhost:5000`. El proceso completo tarda entre 3 y 5 minutos. Las ejecuciones posteriores arrancan en pocos segundos.

El backend Node sirve el frontend y la API en el **mismo origen** (puerto 5000). No hay un servidor de frontend aparte.

Para detener la app, cierra la ventana negra titulada "Pensadero".

## Configuración

### Frontend (`.env.development` / `.env.production`, raíz)

Pensadero usa **origen único**: en producción el backend sirve el frontend y la API en el mismo puerto, así que el frontend usa URLs **relativas** y un único build funciona desde cualquier host (`localhost`, `pensadero`, IP de LAN/VPN) sin reconstruir.

| Variable | Descripción | Desarrollo (`npm run dev`) | Producción (build) |
|---|---|---|---|
| `VITE_API_URL` | URL del backend Node | `http://localhost:5000` | (vacío → relativo) |
| `VITE_WS_URL` | URL del WebSocket de progreso | `ws://localhost:5000/ws` | (vacío → derivado de `window.location`) |

En desarrollo el frontend (vite, `:5173`) y el backend (`:5000`) son orígenes distintos; por eso `.env.development` apunta explícitamente al backend.

### `backend/.env`

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `PORT` | Puerto del servidor (frontend + API) | `5000` |
| `HOST` | Interfaz de escucha. `127.0.0.1` = solo local; `0.0.0.0` = accesible en LAN/VPN | `127.0.0.1` |
| `CONTENT_DIR` | Carpeta raíz por defecto para escaneos | (vacío) |
| `OLLAMA_HOST` | Host de Ollama si se usa búsqueda IA | `http://localhost:11434` |
| `OLLAMA_MODEL` | Modelo Ollama a utilizar | `qwen2.5:7b-instruct` |

## Acceso por nombre (`pensadero`) y desde otros dispositivos

Por defecto Pensadero solo escucha en `127.0.0.1` (este PC) y la URL es `http://localhost:5000`.

### Nombre `pensadero` en este PC

Añade un alias en el archivo `hosts` de Windows (requiere permisos de administrador):

1. Abre el **Bloc de notas como administrador**.
2. Abre `C:\Windows\System32\drivers\etc\hosts`.
3. Añade al final esta línea:
   ```
   127.0.0.1   pensadero
   ```
4. Guarda. Ya puedes usar `http://pensadero:5000`.

Para quitar el puerto (`http://pensadero` a secas) pon `PORT=80` en `backend/.env`. Aviso: el puerto 80 puede estar ocupado por otro servicio (IIS, etc.).

### Acceso desde otros dispositivos (LAN / VPN)

Pon `HOST=0.0.0.0` en `backend/.env` y reinicia. Pensadero quedará accesible desde otros equipos por la IP de este PC (`http://<IP>:5000`) o a través de la VPN.

> **Aviso de seguridad:** Pensadero no tiene autenticación. Con `HOST=0.0.0.0` cualquiera en tu red local ve todo el archivo. Hazlo solo en una red de confianza o detrás de una VPN. Para revertir, vuelve a `HOST=127.0.0.1`.

## Añadir bibliotecas

Las rutas de escaneo se gestionan desde la propia interfaz, en la pestaña **Rutas**. Puedes añadir cualquier carpeta local o de un disco externo. Para discos externos, asegúrate de que la letra de la unidad es fija en Windows (Administración de discos → Cambiar letra y rutas), de lo contrario las rutas se romperán al reconectar.

## Sidecar JSON de metadatos

Junto a cada archivo multimedia (`video.mp4`), Pensadero busca opcionalmente un sidecar con el mismo nombre y sufijo `.json` (`video.mp4.json`). Este sidecar lo genera **Marina Video Batch personal**: Pensadero solo lo consume.

Formato esperado (campos opcionales — Pensadero ignora los que no estén presentes):

```json
{
  "tags": ["interior", "noche", "primer plano"],
  "visual_description": "Plano corto sobre mesa de madera con vela encendida",
  "colors": [
    { "hex": "#1A1A1A", "weight": 0.42 },
    { "hex": "#C8B6FF", "weight": 0.31 }
  ],
  "faces": [
    { "person_id": "daniel", "confidence": 0.91 }
  ],
  "spaces": [
    { "space_id": "salon-casa", "confidence": 0.87 }
  ],
  "duration_s": 12.4,
  "fps": 24,
  "resolution": { "w": 3840, "h": 2160 }
}
```

> El contrato canónico vive en `backend/README.md`. Si difiere de lo de arriba, manda el `backend/README.md`.

## Limitaciones conocidas

- **Sin reconocimiento facial dentro de Pensadero.** El entrenamiento de caras y espacios se hace en **Marina Video Batch personal** y se entrega ya resuelto en los sidecar JSON. Pensadero solo lee los resultados; nunca entrena ni vuelve a calcular embeddings.
- **Single-user, sin auth.** No hay login: cualquiera con acceso al PC ve todo el archivo.
- **Sin sincronización en la nube.** Toda la persistencia (favoritos, colecciones, miniaturas) vive en `backend/` en disco local.

## Datos persistentes (no tocar a mano)

- `backend/favorites_persistent.json`
- `backend/collections_persistent.json`
- `backend/media_cache.json`
- `backend/scan_paths.json`
- `backend/thumbnails/`
