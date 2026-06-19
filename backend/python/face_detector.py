"""
Face detector & trainer — Pensadero NODO

Detecta caras y calcula embeddings con InsightFace (ArcFace). Se invoca
desde Node.js de dos formas:

1) Modo CLI one-shot (para tests):
   python face_detector.py detect <image_path>
   python face_detector.py train <person_dir>

2) Modo stream (daemon, preferido para batch desde Node):
   python face_detector.py --stream
   stdin: una línea JSON por petición
     {"op":"detect","path":"..."}
     {"op":"train","dir":"..."}
     {"op":"exit"}
   stdout: una línea JSON por respuesta
     {"ok":true,"result":{...}}
     {"ok":false,"error":"..."}

El modelo se carga una sola vez al arrancar. Usa CUDA si onnxruntime-gpu
está instalado y hay GPU disponible; si no, cae a CPU.
"""

import json
import os
import sys
import argparse
import traceback
from pathlib import Path

import numpy as np


def _register_nvidia_dll_directories():
    """
    En Windows sin CUDA Toolkit instalado de sistema (caso típico cuando el
    usuario no tiene admin), las DLLs de CUDA se instalan vía pip en paquetes
    `nvidia-cublas-cu12`, `nvidia-cudnn-cu12`, etc.

    onnxruntime carga `onnxruntime_providers_cuda.dll` que a su vez depende
    transitivamente de `cublasLt64_12.dll`, `cudart64_12.dll`, `cudnn64_9.dll`.
    Windows resuelve esas dependencias buscando en PATH (no en
    `os.add_dll_directory`, que solo afecta cargas directas).

    Por eso necesitamos:
    1) `os.add_dll_directory(d)` — para cargas directas desde Python.
    2) `os.environ["PATH"] = d + ";" + os.environ["PATH"]` — para dependencias
       transitivas que Windows resuelve internamente.

    Si los paquetes nvidia-* no están instalados, se ignora silenciosamente
    y onnxruntime cae a CPU.
    """
    if sys.platform != "win32":
        return
    try:
        # Localizar carpetas bin de los paquetes nvidia/* en el venv actual.
        nvidia_bin_dirs = []
        candidates_roots = []
        try:
            import site
            candidates_roots.extend(site.getsitepackages())
        except Exception:
            pass
        # En venvs, getsitepackages a veces no devuelve el correcto. Usar también sys.prefix.
        candidates_roots.append(str(Path(sys.prefix) / "Lib" / "site-packages"))
        # Y la ubicación canónica del módulo nvidia (si está instalado)
        try:
            import nvidia  # noqa
            mod_path = getattr(nvidia, "__path__", None)
            if mod_path:
                for p in mod_path:
                    candidates_roots.append(str(Path(p).parent))
        except ImportError:
            pass

        seen_roots = set()
        for root in candidates_roots:
            if root in seen_roots:
                continue
            seen_roots.add(root)
            nvidia_root = Path(root) / "nvidia"
            if not nvidia_root.is_dir():
                continue
            for sub in nvidia_root.iterdir():
                bin_dir = sub / "bin"
                if bin_dir.is_dir() and str(bin_dir) not in nvidia_bin_dirs:
                    nvidia_bin_dirs.append(str(bin_dir))

        if not nvidia_bin_dirs:
            return

        # 1) DLL directory para cargas directas (Python 3.8+).
        if hasattr(os, "add_dll_directory"):
            for d in nvidia_bin_dirs:
                try:
                    os.add_dll_directory(d)
                except (OSError, FileNotFoundError):
                    pass

        # 2) PATH prepend para dependencias transitivas (cuando Windows
        # resuelve una dependencia desde otra DLL ya cargada).
        cur_path = os.environ.get("PATH", "")
        new_path = ";".join(nvidia_bin_dirs) + (";" + cur_path if cur_path else "")
        os.environ["PATH"] = new_path

        sys.stderr.write(f"[face_detector] {len(nvidia_bin_dirs)} carpetas DLL NVIDIA en PATH\n")
    except Exception as e:
        sys.stderr.write(f"[face_detector] aviso: no se pudieron registrar DLLs NVIDIA: {e}\n")


# Registrar las DLLs de CUDA ANTES de importar onnxruntime/insightface
_register_nvidia_dll_directories()


# Importar InsightFace con manejo de error claro
try:
    from insightface.app import FaceAnalysis
except Exception as e:
    sys.stderr.write(f"ERROR: No se pudo importar insightface: {e}\n")
    sys.exit(1)


# ----- Configuración global del modelo -----

_app = None


def get_app():
    """Carga lazy del modelo. Se invoca una sola vez por proceso."""
    global _app
    if _app is not None:
        return _app

    providers = []
    # FACE_PROVIDER=cpu fuerza CPU (útil en Dell cuando el VLM necesita toda la VRAM).
    # Cualquier otro valor o ausencia → GPU con fallback automático a CPU.
    if os.environ.get("FACE_PROVIDER", "gpu").lower() != "cpu":
        try:
            import onnxruntime as ort
            available = ort.get_available_providers()
            if "CUDAExecutionProvider" in available:
                providers.append("CUDAExecutionProvider")
        except Exception:
            pass
    providers.append("CPUExecutionProvider")

    # InsightFace y onnxruntime imprimen mucho en stdout durante el load
    # ("Applied providers...", "find model...", "set det-size..."). Eso
    # ensucia nuestro protocolo JSON sobre stdout. Lo redirigimos a stderr
    # mientras se carga el modelo.
    import contextlib
    with contextlib.redirect_stdout(sys.stderr):
        _app = FaceAnalysis(name="buffalo_l", providers=providers)
        _app.prepare(ctx_id=0 if "CUDAExecutionProvider" in providers else -1, det_size=(640, 640))
    sys.stderr.write(f"[face_detector] InsightFace cargado con providers={providers}\n")
    sys.stderr.flush()
    return _app


# ----- Operaciones -----

def _load_image_bgr(path: str):
    """
    Carga una imagen como array BGR (formato que espera InsightFace/cv2).

    Estrategia en cascada:
      1) cv2.imread — camino rapido para jpg/png/etc.
      2) cv2.imdecode de bytes crudos — rutas con caracteres no ASCII
         (Windows / acentos / eñes) que imread no abre.
      3) Pillow + pillow-heif — HEIC/HEIF (fotos de iPhone) que opencv NO
         decodifica. Si pillow-heif no esta instalado, este paso falla y se
         lanza el error claro (mismo comportamiento que antes, sin regresion).
    """
    import cv2

    img = cv2.imread(path)
    if img is not None:
        return img

    # 2) Rutas no ASCII: leer bytes y decodificar.
    try:
        with open(path, "rb") as f:
            data = np.frombuffer(f.read(), dtype=np.uint8)
        img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    except Exception:
        img = None
    if img is not None:
        return img

    # 3) HEIC/HEIF via Pillow + pillow-heif. opencv no trae soporte HEIF.
    try:
        from PIL import Image, ImageOps
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except Exception:
            # pillow-heif no instalado: si el archivo es HEIC fallara abajo en
            # Image.open con un error claro. Para formatos que Pillow ya soporta
            # (jpg/png/tiff) seguimos pudiendo abrirlos.
            pass
        with Image.open(path) as im:
            # cv2.imread/imdecode auto-rotan por EXIF; Pillow NO. Aplicar
            # exif_transpose para que las bbox de HEIC queden en el MISMO espacio
            # orientado que el resto, y el recorte (sharp con .rotate()) cuadre.
            im = ImageOps.exif_transpose(im)
            rgb = np.array(im.convert("RGB"))
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    except Exception as e:
        raise RuntimeError(f"No se pudo leer la imagen ({e})")


def detect_in_image(path: str) -> dict:
    """
    Detecta todas las caras en una imagen y devuelve sus embeddings + bbox.
    """
    import cv2  # noqa: F401  (se usa dentro de _load_image_bgr)
    img = _load_image_bgr(path)
    if img is None:
        raise RuntimeError("Imagen ilegible o formato no soportado")

    app = get_app()
    faces = app.get(img)

    # Dims de la imagen orientada (mismo espacio que las bbox). Se adjuntan a
    # cada cara para que el consumidor (shot_type) calcule la ratio cara/frame
    # sin releer la imagen y sobreviva a la agregacion multi-frame de video.
    img_h, img_w = int(img.shape[0]), int(img.shape[1])

    out = []
    for f in faces:
        bbox = f.bbox.astype(float).tolist()  # [x1, y1, x2, y2]
        embedding = f.normed_embedding.tolist()  # 512-d L2-normalized
        det_score = float(f.det_score)
        out.append({
            "bbox": bbox,
            "embedding": embedding,
            "det_score": det_score,
            "age": float(getattr(f, "age", 0)) if hasattr(f, "age") else None,
            "gender": int(getattr(f, "gender", -1)) if hasattr(f, "gender") else None,
            "img_h": img_h,
            "img_w": img_w,
        })
    return {"faces": out, "count": len(out)}


def train_person(person_dir: str) -> dict:
    """
    Procesa todas las fotos de referencia de una persona y devuelve el
    embedding promedio (centroid) + estadísticas.
    """
    p = Path(person_dir)
    if not p.is_dir():
        raise RuntimeError(f"No es una carpeta: {person_dir}")

    exts = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
    # Excluir 'avatar.jpg': es el recorte de cara DERIVADO (visual), no una foto
    # de referencia. Entrenar sobre el sesgaria el centroide hacia un solo crop.
    photos = sorted([f for f in p.iterdir()
                     if f.is_file() and f.suffix.lower() in exts and f.name.lower() != "avatar.jpg"])

    if not photos:
        return {
            "person_id": p.name,
            "ok": False,
            "error": "no_photos",
            "centroid": None,
            "count": 0,
            "photos_used": [],
        }

    embeddings = []
    used = []
    skipped = []
    for photo in photos:
        try:
            r = detect_in_image(str(photo))
            faces = r["faces"]
            if not faces:
                skipped.append({"file": photo.name, "reason": "no_face"})
                continue
            # Si hay varias caras, quedarse con la más grande (probablemente la principal)
            faces_sorted = sorted(faces, key=lambda f: (f["bbox"][2] - f["bbox"][0]) * (f["bbox"][3] - f["bbox"][1]), reverse=True)
            embeddings.append(np.array(faces_sorted[0]["embedding"], dtype=np.float32))
            used.append(photo.name)
        except Exception as e:
            skipped.append({"file": photo.name, "reason": str(e)})

    if not embeddings:
        return {
            "person_id": p.name,
            "ok": False,
            "error": "no_faces_detected",
            "centroid": None,
            "count": 0,
            "photos_used": [],
            "skipped": skipped,
        }

    arr = np.stack(embeddings, axis=0)
    centroid = arr.mean(axis=0)
    # Re-normalizar para coseno consistente
    norm = np.linalg.norm(centroid)
    if norm > 0:
        centroid = centroid / norm

    # Calcular dispersión interna (diagnóstico de calidad del set)
    similarities = arr @ centroid  # cada embedding ya está L2-normalized
    return {
        "person_id": p.name,
        "ok": True,
        "centroid": centroid.tolist(),
        "count": len(embeddings),
        "photos_used": used,
        "skipped": skipped,
        "mean_similarity_to_centroid": float(similarities.mean()),
        "min_similarity_to_centroid": float(similarities.min()),
    }


# ----- Modos de invocación -----

def cli_main():
    parser = argparse.ArgumentParser(description="Pensadero face detector / trainer")
    sub = parser.add_subparsers(dest="op")

    sub_detect = sub.add_parser("detect", help="Detectar caras en una imagen")
    sub_detect.add_argument("path", type=str)

    sub_train = sub.add_parser("train", help="Entrenar persona desde carpeta de fotos")
    sub_train.add_argument("dir", type=str)

    parser.add_argument("--stream", action="store_true", help="Modo daemon: leer comandos por stdin")

    args = parser.parse_args()

    if args.stream:
        stream_loop()
        return

    if args.op == "detect":
        try:
            r = detect_in_image(args.path)
            print(json.dumps({"ok": True, "result": r}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
    elif args.op == "train":
        try:
            r = train_person(args.dir)
            print(json.dumps({"ok": True, "result": r}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
    else:
        parser.print_help()
        sys.exit(2)


def stream_loop():
    """
    Bucle daemon: lee líneas JSON de stdin, escribe respuestas JSON en stdout.
    Carga el modelo una sola vez. Termina con {"op":"exit"} o EOF.
    """
    sys.stderr.write("[face_detector] Stream mode listo\n")
    sys.stderr.flush()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"json_parse: {e}"}), flush=True)
            continue

        op = req.get("op")
        # Eco del id de correlacion: Node lo usa para descartar respuestas
        # tardias de peticiones que ya expiraron por timeout y evitar asi
        # emparejar una respuesta con la peticion equivocada.
        req_id = req.get("id")

        def emit(payload):
            if req_id is not None:
                payload["id"] = req_id
            print(json.dumps(payload), flush=True)

        try:
            if op == "exit":
                emit({"ok": True, "result": "bye"})
                break
            elif op == "detect":
                path = req.get("path")
                r = detect_in_image(path)
                emit({"ok": True, "result": r})
            elif op == "train":
                d = req.get("dir")
                r = train_person(d)
                emit({"ok": True, "result": r})
            elif op == "convert":
                # Transcodifica cualquier imagen (incl. HEIC via pillow-heif) a
                # JPEG orientado. No necesita el modelo InsightFace: solo carga y
                # escribe. Lo usa Node porque sharp 0.32.x no decodifica HEIC.
                import cv2
                src = req.get("src"); dst = req.get("dst")
                img = _load_image_bgr(src)  # ya orientado (cv2 auto / exif_transpose)
                if img is None:
                    raise RuntimeError("imagen ilegible")
                if not cv2.imwrite(dst, img, [cv2.IMWRITE_JPEG_QUALITY, 92]):
                    raise RuntimeError("no se pudo escribir jpeg")
                emit({"ok": True, "result": {"dst": dst}})
            elif op == "ping":
                emit({"ok": True, "result": "pong"})
            else:
                emit({"ok": False, "error": f"unknown op: {op}"})
        except Exception as e:
            tb = traceback.format_exc(limit=3)
            emit({"ok": False, "error": str(e), "trace": tb})


if __name__ == "__main__":
    cli_main()
