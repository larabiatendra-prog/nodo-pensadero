@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Pensadero - Diagnostico
color 0E
cls

echo ==============================================================
echo                  PENSADERO - DIAGNOSTICO
echo ==============================================================
echo.
echo  Comprueba que todas las piezas necesarias estan listas.
echo  No instala nada. Si algo falla, ejecuta Pensadero_Install.bat.
echo.

set "ROOT=%~dp0"
set "PROBLEMS=0"

REM --- Node ---
echo --------------------------------------------------------------
echo  Node.js
echo --------------------------------------------------------------
if exist "%ROOT%tools\node\node.exe" (
    set "PATH=%ROOT%tools\node;%PATH%"
    echo [OK] Node portable detectado.
) else (
    where node >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo [OK] Node del sistema.
    ) else (
        echo [FAIL] Node.js no instalado.
        set /a PROBLEMS+=1
    )
)
node --version 2>nul

REM --- Python ---
echo.
echo --------------------------------------------------------------
echo  Python
echo --------------------------------------------------------------
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] Python en PATH.
    python --version
) else (
    echo [FAIL] Python no instalado o no en PATH. Reconocimiento facial deshabilitado.
    set /a PROBLEMS+=1
)

REM --- venv Python ---
REM No basta con que exista el archivo: el shim python.exe lee pyvenv.cfg y
REM localiza el Python base por ruta ABSOLUTA. Un venv copiado de otro PC
REM conserva el archivo pero el shim sale con codigo 103 ("No Python at ...").
REM Por eso lo ejecutamos de verdad para distinguir "valido" de "roto".
if exist "%ROOT%backend\python\.venv\Scripts\python.exe" (
    "%ROOT%backend\python\.venv\Scripts\python.exe" --version >nul 2>&1
    if errorlevel 1 (
        echo [FAIL] venv Python ROTO ^(probablemente copiado de otro PC: pyvenv.cfg
        echo        apunta a un Python que no existe aqui^).
        echo        Solucion: borra backend\python\.venv y ejecuta Pensadero_Install.bat.
        set /a PROBLEMS+=1
    ) else (
        echo [OK] venv Python valido en backend\python\.venv
    )
) else (
    echo [FAIL] venv Python no creado. Ejecuta Pensadero_Install.bat.
    set /a PROBLEMS+=1
)

REM --- ffmpeg ---
echo.
echo --------------------------------------------------------------
echo  ffmpeg
echo --------------------------------------------------------------
where ffmpeg >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] ffmpeg en PATH.
    ffmpeg -version 2>nul | findstr /i "ffmpeg version"
) else (
    echo [FAIL] ffmpeg no en PATH. Escaneo de video deshabilitado.
    set /a PROBLEMS+=1
)

REM --- Ollama instalado ---
echo.
echo --------------------------------------------------------------
echo  Ollama
echo --------------------------------------------------------------
where ollama >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] Ollama no instalado.
    set /a PROBLEMS+=1
    goto :skip_ollama
)
echo [OK] Ollama instalado.
ollama --version 2>nul

REM --- Ollama corriendo ---
echo [...] Comprobando si el servicio Ollama corre en localhost:11434...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri http://localhost:11434/ -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %ERRORLEVEL% EQU 0 (
    echo [OK] Ollama servicio corriendo.
) else (
    echo [WARN] Ollama no responde. Arrancando...
    start "" /B ollama serve >nul 2>&1
    timeout /t 3 /nobreak >nul
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri http://localhost:11434/ -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
    if %ERRORLEVEL% EQU 0 (
        echo [OK] Ollama arrancado.
    ) else (
        echo [FAIL] Ollama no arranca. Reinicia el equipo.
        set /a PROBLEMS+=1
    )
)

REM --- Modelos ---
echo.
echo --------------------------------------------------------------
echo  Modelos IA
echo --------------------------------------------------------------
ollama list 2>nul | findstr /i "gemma4:12b" >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] gemma4:12b  ^(VLM principal de escaneo - default^)
) else (
    echo [FAIL] gemma4:12b NO descargado.
    echo        Ejecuta: ollama pull gemma4:12b
    set /a PROBLEMS+=1
)
ollama list 2>nul | findstr /i "qwen2.5:7b-instruct" >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] qwen2.5:7b-instruct  ^(LLM busqueda natural^)
) else (
    echo [FAIL] qwen2.5:7b-instruct NO descargado.
    echo        Ejecuta: ollama pull qwen2.5:7b-instruct
    set /a PROBLEMS+=1
)
REM VLM opcionales del catalogo (no cuentan como problema si faltan).
ollama list 2>nul | findstr /i "gemma4:27b" >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] gemma4:27b  ^(VLM experimento, opcional^)
) else (
    echo [..] gemma4:27b no descargado ^(opcional: ollama pull gemma4:27b^)
)
ollama list 2>nul | findstr /i "gemma3:12b" >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] gemma3:12b  ^(VLM legacy/fallback, opcional^)
) else (
    echo [..] gemma3:12b no descargado ^(opcional: ollama pull gemma3:12b^)
)

:skip_ollama

REM --- Dependencias proyecto ---
echo.
echo --------------------------------------------------------------
echo  Dependencias del proyecto
echo --------------------------------------------------------------
if exist "%ROOT%node_modules" (
    echo [OK] node_modules frontend.
) else (
    echo [FAIL] Falta node_modules frontend. Ejecuta Pensadero_Install.bat.
    set /a PROBLEMS+=1
)
if exist "%ROOT%backend\node_modules" (
    echo [OK] node_modules backend.
) else (
    echo [FAIL] Falta node_modules backend. Ejecuta Pensadero_Install.bat.
    set /a PROBLEMS+=1
)
if exist "%ROOT%dist\index.html" (
    echo [OK] Build de produccion presente.
) else (
    echo [WARN] Falta dist\. Pensadero_Start.bat lo construira al arrancar.
)

REM --- GPU NVIDIA ---
echo.
echo --------------------------------------------------------------
echo  GPU NVIDIA ^(opcional pero recomendado^)
echo --------------------------------------------------------------
where nvidia-smi >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    for /f "tokens=*" %%G in ('nvidia-smi --query-gpu^=name^,memory.total --format^=csv^,noheader 2^>nul') do echo [OK] %%G
) else (
    echo [WARN] nvidia-smi no encontrado. IA correra en CPU ^(mas lento^).
)

REM --- CUDA / onnxruntime ---
echo.
echo --------------------------------------------------------------
echo  CUDA / onnxruntime ^(InsightFace en GPU^)
echo --------------------------------------------------------------
if not exist "%ROOT%backend\python\.venv\Scripts\python.exe" (
    echo [SKIP] venv no existe, saltando check CUDA.
    goto :skip_cuda
)
"%ROOT%backend\python\.venv\Scripts\python.exe" -c "import onnxruntime" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] onnxruntime no instalado en venv. Relanza Pensadero_Install.bat.
    set /a PROBLEMS+=1
    goto :skip_cuda
)
for /f "delims=" %%P in ('"%ROOT%backend\python\.venv\Scripts\python.exe" -c "import onnxruntime as o; print('CUDA' if 'CUDAExecutionProvider' in o.get_available_providers() else 'CPU')" 2^>nul') do set "ORT_PROVIDER=%%P"
if "%ORT_PROVIDER%"=="CUDA" (
    echo [OK] CUDAExecutionProvider disponible. InsightFace usara GPU.
) else (
    echo [WARN] onnxruntime sin CUDAExecutionProvider. InsightFace correra en CPU.
    echo        Causa probable: GPU nueva ^(Blackwell/RTX 50xx^) + onnxruntime no actualizado.
    echo        Solucion: backend\python\.venv\Scripts\python.exe -m pip install onnxruntime-gpu --upgrade
)
:skip_cuda

REM --- Resumen ---
echo.
echo ==============================================================
if "%PROBLEMS%"=="0" (
    echo                  TODO OK - Pensadero listo
    echo ==============================================================
    echo.
    echo  Arranca con Pensadero_Start.bat
) else (
    echo  %PROBLEMS% problema^(s^) detectado^(s^)
    echo ==============================================================
    echo.
    echo  Ejecuta Pensadero_Install.bat para resolver.
)
echo.
pause
endlocal
exit /b 0
