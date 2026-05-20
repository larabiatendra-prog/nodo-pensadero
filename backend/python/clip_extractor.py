"""
CLIP / M-CLIP Extractor — Pensadero NODO

Extrae embeddings visuales (CLIP ViT-B-32) y textuales (XLM-RoBERTa-Large
multilingue) en el mismo espacio de 512 dimensiones. Permite:

  - Place recognition: foto → embedding → match contra centroides de
    espacios registrados
  - Image search: foto query → top-N fotos similares
  - Text-to-image (en fase 2): "playa al atardecer" en español → fotos

Se invoca desde Node.js en modo stream (daemon), igual que face_detector.py.

Protocolo stdin/stdout:
  IN  {"op":"embed_image","path":"/ruta/a.jpg"}
  OUT {"ok":true,"result":{"embedding_b64":"<base64 float32[512]>","dim":512}}

  IN  {"op":"embed_text","text":"texto en español o ingles"}
  OUT {"ok":true,"result":{"embedding_b64":"...","dim":512}}

  IN  {"op":"ping"}  →  OUT {"ok":true,"result":"pong"}
  IN  {"op":"exit"}  →  OUT {"ok":true,"result":"bye"}  y cierra

Cold start ~10-20s (carga XLM-Roberta-Large + CLIP ViT-B-32 + cuDNN).
Imagenes ya cacheadas: ~50-80ms en GPU (RTX 3080), ~30ms en RTX 5070 Ti.
En CPU: ~500ms imagen, ~150ms texto. Util en Dell solo si la VRAM esta apretada.

Variables de entorno:
  CLIP_PROVIDER=gpu|cpu  — fuerza dispositivo (default: auto-detect, GPU si disponible)
"""

import json
import os
import sys
import base64
import traceback
from pathlib import Path

import numpy as np


def _register_nvidia_dll_directories():
    """Identico al de face_detector.py — necesario en Windows sin CUDA Toolkit."""
    if sys.platform != "win32":
        return
    try:
        nvidia_bin_dirs = []
        candidates_roots = []
        try:
            import site
            candidates_roots.extend(site.getsitepackages())
        except Exception:
            pass
        candidates_roots.append(str(Path(sys.prefix) / "Lib" / "site-packages"))
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

        if hasattr(os, "add_dll_directory"):
            for d in nvidia_bin_dirs:
                try:
                    os.add_dll_directory(d)
                except (OSError, FileNotFoundError):
                    pass
        cur_path = os.environ.get("PATH", "")
        new_path = ";".join(nvidia_bin_dirs) + (";" + cur_path if cur_path else "")
        os.environ["PATH"] = new_path
        sys.stderr.write(f"[clip] {len(nvidia_bin_dirs)} carpetas DLL NVIDIA en PATH\n")
    except Exception as e:
        sys.stderr.write(f"[clip] aviso: no se pudieron registrar DLLs NVIDIA: {e}\n")


_register_nvidia_dll_directories()


# Imports diferidos para evitar coste si solo se invoca el wrapper sin tareas
try:
    import torch
    from PIL import Image
    from transformers import CLIPModel, CLIPProcessor, AutoTokenizer
    from multilingual_clip import pt_multilingual_clip
except Exception as e:
    sys.stderr.write(f"ERROR cargando dependencias CLIP: {e}\n")
    sys.exit(1)


# ----- Configuracion -----

IMG_MODEL_NAME = 'openai/clip-vit-base-patch32'
TEXT_MODEL_NAME = 'M-CLIP/XLM-Roberta-Large-Vit-B-32'
EMBEDDING_DIM = 512


def _resolve_device():
    """Decide CUDA vs CPU segun CLIP_PROVIDER y disponibilidad real."""
    pref = (os.environ.get("CLIP_PROVIDER") or "gpu").lower()
    if pref == "cpu":
        return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


_device = None
_img_model = None
_img_processor = None
_text_model = None
_text_tokenizer = None


def _load_models():
    global _device, _img_model, _img_processor, _text_model, _text_tokenizer
    if _img_model is not None:
        return
    _device = _resolve_device()
    sys.stderr.write(f"[clip] device={_device.type}\n")

    sys.stderr.write(f"[clip] cargando image encoder {IMG_MODEL_NAME}...\n")
    _img_model = CLIPModel.from_pretrained(IMG_MODEL_NAME).to(_device).eval()
    _img_processor = CLIPProcessor.from_pretrained(IMG_MODEL_NAME)

    sys.stderr.write(f"[clip] cargando text encoder {TEXT_MODEL_NAME}...\n")
    _text_model = pt_multilingual_clip.MultilingualCLIP.from_pretrained(TEXT_MODEL_NAME).to(_device).eval()
    _text_tokenizer = AutoTokenizer.from_pretrained(TEXT_MODEL_NAME)

    sys.stderr.write(f"[clip] modelos cargados\n")


def _encode_image_to_b64(emb_tensor):
    """Tensor 1D float32 → base64."""
    if emb_tensor.dim() > 1:
        emb_tensor = emb_tensor.squeeze(0)
    arr = emb_tensor.detach().cpu().to(torch.float32).numpy()
    if arr.shape != (EMBEDDING_DIM,):
        raise RuntimeError(f"embedding con shape inesperada: {arr.shape}")
    return base64.b64encode(arr.tobytes()).decode("ascii")


def embed_image(path: str) -> dict:
    """Devuelve {embedding_b64, dim} para una imagen."""
    _load_models()
    if not os.path.isfile(path):
        raise RuntimeError(f"archivo no existe: {path}")
    try:
        with Image.open(path) as raw:
            img = raw.convert("RGB")
    except Exception as e:
        raise RuntimeError(f"imagen ilegible ({e})")

    with torch.no_grad():
        inputs = _img_processor(images=img, return_tensors="pt").to(_device)
        feats = _img_model.get_image_features(**inputs)
        # Normalizar L2 → comparacion via dot product = cosine similarity
        feats = feats / feats.norm(dim=-1, keepdim=True).clamp(min=1e-8)
    return {"embedding_b64": _encode_image_to_b64(feats), "dim": EMBEDDING_DIM}


def embed_text(text: str) -> dict:
    """Devuelve {embedding_b64, dim} para texto (en español, ingles u otro)."""
    _load_models()
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("texto vacio")

    with torch.no_grad():
        # pt_multilingual_clip.MultilingualCLIP.forward acepta lista de strings y tokenizer
        feats = _text_model.forward([text.strip()], _text_tokenizer)
        if hasattr(feats, 'to'):
            feats = feats.to(_device)
        feats = feats / feats.norm(dim=-1, keepdim=True).clamp(min=1e-8)
    return {"embedding_b64": _encode_image_to_b64(feats), "dim": EMBEDDING_DIM}


def stream_loop():
    """Lee JSON lineas por stdin, escribe respuestas por stdout."""
    sys.stderr.write("[clip] Stream mode listo\n")
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
        try:
            if op == "exit":
                print(json.dumps({"ok": True, "result": "bye"}), flush=True)
                break
            elif op == "ping":
                print(json.dumps({"ok": True, "result": "pong"}), flush=True)
            elif op == "embed_image":
                r = embed_image(req.get("path"))
                print(json.dumps({"ok": True, "result": r}), flush=True)
            elif op == "embed_text":
                r = embed_text(req.get("text"))
                print(json.dumps({"ok": True, "result": r}), flush=True)
            else:
                print(json.dumps({"ok": False, "error": f"unknown op: {op}"}), flush=True)
        except Exception as e:
            tb = traceback.format_exc(limit=3)
            print(json.dumps({"ok": False, "error": str(e), "trace": tb}), flush=True)


if __name__ == "__main__":
    if "--stream" in sys.argv:
        stream_loop()
    else:
        # CLI one-shot util para tests
        if len(sys.argv) >= 3 and sys.argv[1] == "image":
            print(json.dumps(embed_image(sys.argv[2])))
        elif len(sys.argv) >= 3 and sys.argv[1] == "text":
            print(json.dumps(embed_text(sys.argv[2])))
        else:
            print("Usage: python clip_extractor.py --stream")
            print("       python clip_extractor.py image <path>")
            print("       python clip_extractor.py text  <texto>")
            sys.exit(2)
