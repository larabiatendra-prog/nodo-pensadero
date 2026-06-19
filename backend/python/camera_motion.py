"""
Camera Motion — Pensadero NODO

Detecta el MOVIMIENTO DE CAMARA de un clip de video con optical-flow en CPU.
No usa GPU ni modelo de IA: features (goodFeaturesToTrack) + Lucas-Kanade flow +
estimateAffinePartial2D con RANSAC. El RANSAC se queda con el movimiento
DOMINANTE del cuadro (la camara) y descarta los outliers (gente que se mueve),
asi separa movimiento de camara de movimiento de sujetos.

Por que existe: un VLM (gemma3:12b) es ciego al zoom lento y a paneos sutiles —
los etiqueta "fijo". El flujo optico mide dx/dy/escala reales por frame, asi que
acierta donde el VLM falla. Y corre en CPU en paralelo a la GPU (que hace el
VLM), por lo que apenas suma tiempo de pared al escaneo.

Uso como daemon (lo arranca cameraMotionService.js):
   python camera_motion.py --stream
Protocolo: una linea JSON por peticion en stdin, una linea JSON por respuesta en
stdout. Ops: {"op":"analyze","path":...}, {"op":"ping"}, {"op":"exit"}.

Buckets de salida (gruesos a proposito — lo que un humano distingue de un vistazo
y lo que el flujo mide con fiabilidad). Tokens en español (convencion Pensadero):
   fijo | paneo | cabeceo | acercamiento | alejamiento | inestable | indeterminado
(paneo = pan horizontal; cabeceo = tilt vertical)
"""
import sys
import os
import json
import time
import math
import subprocess
import traceback

import cv2
import numpy as np

# --- Parametros de muestreo (validados sobre brutos EDEM/MdE) ---
PROC_W = 480            # ancho de proceso; downscale agresivo = rapido y robusto
PROC_H = 270            # 16:9
SAMPLE_FPS = 4.0        # frames/seg analizados; el zoom/paneo se ve de sobra a 4fps
MAX_PAIRS = 80          # tope de pares analizados: acota coste en clips largos
                        # (si el clip da mas frames, se baja el fps efectivo)

# --- Umbrales de clasificacion (de la calibracion sobre clips reales) ---
TH_ZOOM = 0.06          # |zoom_total - 1| > 6% = acercamiento/alejamiento
TH_PAN = 0.05           # desplazamiento acumulado > 5% del ancho = pan/tilt
TH_JITTER = 0.012       # std de traslacion > esto y sin deriva clara = inestable

# --- Gating por par de frames (descarta estimaciones poco fiables) ---
MIN_FEATURES = 12       # menos features rastreadas = frame sin textura (cielo, negro)
MIN_INLIERS = 8         # menos inliers RANSAC = ajuste afin no fiable
MIN_INLIER_RATIO = 0.30 # ratio bajo con muchas features = posible corte de escena
# Saltos por frame mayores que esto = corte o blur extremo: no acumular, contar corte
CLAMP_SCALE = 0.25      # |scale-1| por par
CLAMP_TRANS = 0.20      # |dx| o |dy| por par (fraccion del ancho)


def _read_frames_gray(clip_path):
    """
    Decodifica el clip UNA vez via ffmpeg con downscale + fps bajo y devuelve la
    lista de frames en gris (numpy uint8). ffmpeg decodifica mucho mas eficiente
    que cv2.VideoCapture leyendo todos los frames a resolucion nativa.

    En clips largos baja el fps efectivo para no pasar de MAX_PAIRS frames.
    """
    # Duracion para decidir fps efectivo
    try:
        dur = float(subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=nw=1:nk=1', clip_path],
            capture_output=True, text=True, timeout=30).stdout.strip() or '0')
    except Exception:
        dur = 0.0

    fps = SAMPLE_FPS
    if dur > 0 and dur * SAMPLE_FPS > MAX_PAIRS:
        # Bajar fps para que el total de frames <= MAX_PAIRS+1
        fps = max(0.5, MAX_PAIRS / dur)

    cmd = ['ffmpeg', '-v', 'error', '-i', clip_path,
           '-vf', f'fps={fps:.4f},scale={PROC_W}:{PROC_H}',
           '-f', 'rawvideo', '-pix_fmt', 'gray', '-']
    proc = subprocess.run(cmd, capture_output=True, timeout=120)
    buf = proc.stdout
    fsz = PROC_W * PROC_H
    nf = len(buf) // fsz
    return [np.frombuffer(buf, dtype=np.uint8, count=fsz, offset=i * fsz).reshape(PROC_H, PROC_W)
            for i in range(nf)]


def _estimate_pair(g0, g1):
    """
    Estima la transformada de camara entre dos frames grises.
    Devuelve dict con dx, dy (normalizados al ancho), scale, rot, inliers,
    features, o None si no hay datos suficientes (frame sin textura).
    El flag 'cut' indica corte de escena probable (matching colapsa).
    """
    p0 = cv2.goodFeaturesToTrack(g0, maxCorners=400, qualityLevel=0.01, minDistance=8)
    if p0 is None or len(p0) < MIN_FEATURES:
        return None
    p1, st, _err = cv2.calcOpticalFlowPyrLK(g0, g1, p0, None,
                                            winSize=(21, 21), maxLevel=3)
    if p1 is None:
        return None
    st = st.reshape(-1).astype(bool)
    a = p0.reshape(-1, 2)[st]
    b = p1.reshape(-1, 2)[st]
    n_tracked = len(a)
    if n_tracked < MIN_INLIERS:
        # Casi nada rastreado pese a tener features = cambio brusco = corte
        return {'cut': True}
    M, inl = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC,
                                         ransacReprojThreshold=2.0)
    if M is None:
        return {'cut': True}
    n_inl = int(inl.sum()) if inl is not None else 0
    ratio = n_inl / max(1, n_tracked)
    if n_inl < MIN_INLIERS or ratio < MIN_INLIER_RATIO:
        # Ajuste afin no encaja con la mayoria = no hay movimiento global
        # coherente = corte o caos (whip pan, blur de movimiento)
        return {'cut': True}
    sx = math.hypot(M[0, 0], M[0, 1])
    rot = math.degrees(math.atan2(M[1, 0], M[0, 0]))
    dx = M[0, 2] / PROC_W
    dy = M[1, 2] / PROC_W
    # Clamp: un salto enorme en un solo par es corte/blur, no movimiento de camara
    if abs(sx - 1.0) > CLAMP_SCALE or abs(dx) > CLAMP_TRANS or abs(dy) > CLAMP_TRANS:
        return {'cut': True}
    return {'dx': dx, 'dy': dy, 'scale': sx, 'rot': rot, 'inliers': n_inl, 'cut': False}


def analyze(clip_path):
    """
    Analiza el movimiento de camara de un clip. Devuelve buckets + metricas.
    """
    t0 = time.time()
    if not clip_path or not os.path.exists(clip_path):
        raise FileNotFoundError(f'clip no existe: {clip_path}')

    frames = _read_frames_gray(clip_path)
    if len(frames) < 2:
        return {'movement': 'indeterminado', 'movements': [], 'zoom': 1.0,
                'pan_x': 0.0, 'pan_y': 0.0, 'jitter': 0.0, 'scene_changes': False,
                'cuts': 0, 'frames_analyzed': len(frames), 'confidence': 'baja',
                'elapsed_s': round(time.time() - t0, 3)}

    good = []          # pares con estimacion fiable
    cuts = 0           # pares marcados como corte
    skipped = 0        # pares sin datos (sin textura)
    for i in range(len(frames) - 1):
        r = _estimate_pair(frames[i], frames[i + 1])
        if r is None:
            skipped += 1
        elif r.get('cut'):
            cuts += 1
        else:
            good.append(r)

    n_pairs = len(frames) - 1
    if not good:
        # Ningun par fiable: clip oscuro/sin textura o todo cortes
        conf = 'baja'
        movement = 'indeterminado'
        return {'movement': movement, 'movements': [], 'zoom': 1.0,
                'pan_x': 0.0, 'pan_y': 0.0, 'jitter': 0.0,
                'scene_changes': cuts >= 1, 'cuts': cuts,
                'frames_analyzed': len(frames), 'confidence': conf,
                'elapsed_s': round(time.time() - t0, 3)}

    dx = np.array([g['dx'] for g in good])
    dy = np.array([g['dy'] for g in good])
    sc = np.array([g['scale'] for g in good])

    zoom_total = float(np.prod(sc))
    pan_x = float(np.sum(dx))
    pan_y = float(np.sum(dy))
    jitter = float(np.std(dx) + np.std(dy))

    # --- Clasificacion: bucket DOMINANTE por magnitud normalizada al umbral ---
    mz = abs(zoom_total - 1.0)
    mpx = abs(pan_x)
    mpy = abs(pan_y)
    scores = {}
    if mz > TH_ZOOM:
        scores['acercamiento' if zoom_total > 1 else 'alejamiento'] = mz / TH_ZOOM
    if mpx > TH_PAN:
        scores['paneo'] = mpx / TH_PAN
    if mpy > TH_PAN:
        scores['cabeceo'] = mpy / TH_PAN
    # Jitter solo cuenta como 'inestable' si NO hay una deriva clara (si hay pan/
    # tilt/zoom dominante, el temblor es secundario, no define el plano)
    if jitter > TH_JITTER and not scores:
        scores['inestable'] = jitter / TH_JITTER

    if not scores:
        movement = 'fijo'
        movements = []
    else:
        # Orden por score; el primero es el dominante
        ordered = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        movement = ordered[0][0]
        # Secundarios: los que pasan el 60% del score del dominante (movimiento
        # compuesto real, p.ej. travelling lateral CON leve acercamiento)
        top = ordered[0][1]
        movements = [k for k, v in ordered if v >= 0.6 * top]

    # Confianza: baja si pocos pares fiables respecto al total
    good_ratio = len(good) / max(1, n_pairs)
    if good_ratio < 0.4 or len(good) < 3:
        confidence = 'baja'
    elif good_ratio < 0.75:
        confidence = 'media'
    else:
        confidence = 'alta'

    return {
        'movement': movement,
        'movements': movements,
        'zoom': round(zoom_total, 4),
        'pan_x': round(pan_x, 4),
        'pan_y': round(pan_y, 4),
        'jitter': round(jitter, 4),
        'scene_changes': cuts >= 1,
        'cuts': cuts,
        'frames_analyzed': len(frames),
        'confidence': confidence,
        'elapsed_s': round(time.time() - t0, 3),
    }


def stream_loop():
    sys.stderr.write('[camera_motion] Stream mode listo\n')
    sys.stderr.flush()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as e:
            print(json.dumps({'ok': False, 'error': f'json_parse: {e}'}), flush=True)
            continue
        op = req.get('op')
        req_id = req.get('id')

        def emit(payload):
            if req_id is not None:
                payload['id'] = req_id
            print(json.dumps(payload), flush=True)

        try:
            if op == 'exit':
                emit({'ok': True, 'result': 'bye'})
                break
            elif op == 'analyze':
                r = analyze(req.get('path'))
                emit({'ok': True, 'result': r})
            elif op == 'ping':
                emit({'ok': True, 'result': 'pong'})
            else:
                emit({'ok': False, 'error': f'unknown op: {op}'})
        except Exception as e:
            tb = traceback.format_exc(limit=3)
            emit({'ok': False, 'error': str(e), 'trace': tb})


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--stream', action='store_true')
    parser.add_argument('path', nargs='?', help='clip a analizar (modo one-shot)')
    args = parser.parse_args()
    if args.stream:
        stream_loop()
    elif args.path:
        print(json.dumps(analyze(args.path), ensure_ascii=False, indent=2))
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
