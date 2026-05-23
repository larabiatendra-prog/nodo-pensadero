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
if exist "%ROOT%backend\python\.venv\Scripts\python.exe" (
    echo [OK] venv Python creado en backend\python\.venv
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
ollama list 2>nul | findstr /i "qwen2.5:14b-instruct" >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] qwen2.5:14b-instruct  ^(LLM busqueda natural^)
) else (
    echo [FAIL] qwen2.5:14b-instruct NO descargado.
    echo        Ejecuta: ollama pull qwen2.5:14b-instruct
    set /a PROBLEMS+=1
)
ollama list 2>nul | findstr /i "qwen2.5vl:7b" >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] qwen2.5vl:7b  ^(VLM escaneo visual^)
) else (
    echo [FAIL] qwen2.5vl:7b NO descargado.
    echo        Ejecuta: ollama pull qwen2.5vl:7b
    set /a PROBLEMS+=1
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
