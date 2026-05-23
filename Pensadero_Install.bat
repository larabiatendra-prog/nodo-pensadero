@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Pensadero - Instalacion
color 0D
cls

echo ==============================================================
echo                    PENSADERO - INSTALACION
echo            Archivo audiovisual personal (single user)
echo ==============================================================
echo.
echo  Este instalador deja Pensadero listo para usar.
echo  Tiempo estimado primera vez: 30-60 minutos.
echo  Necesita conexion a internet (~16 GB de descargas).
echo.
echo  Despues de esto, abrir Pensadero con: Pensadero_Start.bat
echo.
pause

set "ROOT=%~dp0"
set "NODE_DIR=%ROOT%tools\node"
set "FAILED=0"

REM ================================================================
REM  [1/9] Comprobar winget (gestor de paquetes Windows)
REM ================================================================
echo.
echo ==============================================================
echo  [1/9] Comprobando winget (gestor de paquetes Windows)
echo ==============================================================
where winget >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] winget no encontrado. Es estandar en Windows 11.
    echo         Actualiza "App Installer" desde Microsoft Store y reintenta.
    pause
    exit /b 1
)
echo [OK] winget disponible.

REM ================================================================
REM  [2/9] Node.js
REM ================================================================
echo.
echo ==============================================================
echo  [2/9] Node.js
echo ==============================================================
if exist "%NODE_DIR%\node.exe" (
    set "PATH=%NODE_DIR%;%PATH%"
    echo [OK] Node portable detectado en tools\node\
    goto :node_ready
)
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] Node del sistema detectado.
    goto :node_ready
)
echo [...] Instalando Node.js LTS via winget...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
call :refresh_path
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js no quedo en el PATH. Reinicia el equipo y vuelve a ejecutar.
    set "FAILED=1"
    goto :end
)
echo [OK] Node.js instalado.
:node_ready
call node --version
call npm --version

REM ================================================================
REM  [3/9] Python 3.11 (para reconocimiento facial)
REM ================================================================
echo.
echo ==============================================================
echo  [3/9] Python 3.11
echo ==============================================================
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] Python ya instalado.
    goto :python_ready
)
echo [...] Instalando Python 3.11 via winget...
winget install -e --id Python.Python.3.11 --accept-source-agreements --accept-package-agreements --silent
call :refresh_path
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\Python\Python311;%LOCALAPPDATA%\Programs\Python\Python311\Scripts;%PATH%"
    )
)
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [AVISO] Python no quedo en el PATH. Modulo facial se saltara.
    echo         Tras terminar, reinicia el equipo y relanza este instalador.
    set "SKIP_PYTHON=1"
) else (
    echo [OK] Python instalado.
    call python --version
)

:python_ready

REM ================================================================
REM  [4/9] Ollama (LLM + VLM)
REM ================================================================
echo.
echo ==============================================================
echo  [4/9] Ollama
echo ==============================================================
where ollama >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] Ollama ya instalado.
    goto :ollama_ready
)
echo [...] Instalando Ollama via winget (~700 MB)...
winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements --silent
call :refresh_path
where ollama >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
    )
)
where ollama >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Ollama no quedo en el PATH. Reinicia el equipo y relanza.
    set "FAILED=1"
    goto :end
)
echo [OK] Ollama instalado.

:ollama_ready
echo [...] Asegurando que el servicio Ollama corre...
start "" /B ollama serve >nul 2>&1
timeout /t 3 /nobreak >nul

REM ================================================================
REM  [5/9] ffmpeg (para escaneo de video)
REM ================================================================
echo.
echo ==============================================================
echo  [5/9] ffmpeg
echo ==============================================================
where ffmpeg >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] ffmpeg ya instalado.
    goto :ffmpeg_ready
)
echo [...] Instalando ffmpeg via winget (~100 MB)...
winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements --silent
call :refresh_path
where ffmpeg >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [AVISO] ffmpeg no quedo en el PATH. Video se saltara hasta reiniciar.
) else (
    echo [OK] ffmpeg instalado.
)

:ffmpeg_ready

REM ================================================================
REM  [6/9] Dependencias frontend
REM ================================================================
echo.
echo ==============================================================
echo  [6/9] Dependencias frontend (npm install)
echo ==============================================================
cd /d "%ROOT%"
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install frontend ha fallado.
    set "FAILED=1"
    goto :end
)
echo [OK] Frontend listo.

REM ================================================================
REM  [7/9] Dependencias backend + build
REM ================================================================
echo.
echo ==============================================================
echo  [7/9] Dependencias backend + build
echo ==============================================================
cd /d "%ROOT%backend"
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install backend ha fallado.
    set "FAILED=1"
    goto :end
)
cd /d "%ROOT%"
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build del frontend ha fallado.
    set "FAILED=1"
    goto :end
)
echo [OK] Backend y build listos.

REM ================================================================
REM  [8/9] venv Python + InsightFace + SigLIP-2
REM ================================================================
echo.
echo ==============================================================
echo  [8/9] Modulo Python (InsightFace + SigLIP-2)
echo ==============================================================
if defined SKIP_PYTHON (
    echo [SKIP] Python no disponible. Saltando.
    goto :models
)
cd /d "%ROOT%backend\python"
if not exist ".venv\Scripts\python.exe" (
    echo Creando venv en backend\python\.venv...
    python -m venv .venv
    if %ERRORLEVEL% NEQ 0 (
        echo [AVISO] No se pudo crear el venv. Modulo facial deshabilitado.
        goto :models
    )
)
echo Instalando dependencias Python (tarda 3-8 min, descarga ~2-3 GB)...
call .venv\Scripts\python.exe -m pip install --upgrade pip --quiet
call .venv\Scripts\python.exe -m pip install -r requirements.txt
if %ERRORLEVEL% NEQ 0 (
    echo [AVISO] pip install ha fallado. Modulo facial deshabilitado.
) else (
    echo [OK] Modulo Python instalado.
)

:models
cd /d "%ROOT%"

REM ================================================================
REM  [9/9] Modelos Ollama (qwen2.5 + qwen2.5vl)
REM ================================================================
echo.
echo ==============================================================
echo  [9/9] Modelos IA (descarga ~15 GB, 20-40 min segun red)
echo ==============================================================
echo.
echo  Esto descarga los "cerebros" de la IA local. Solo primera vez.
echo  Si se interrumpe, puedes relanzar este instalador y reanudara.
echo.

call :pull_model qwen2.5:14b-instruct
call :pull_model qwen2.5vl:7b

REM ================================================================
REM  Health check final
REM ================================================================
echo.
echo ==============================================================
echo  Verificacion final
echo ==============================================================
set "CHECK_FAIL=0"

call :check_cmd node "Node.js"
call :check_cmd npm "npm"
call :check_cmd ollama "Ollama"
call :check_cmd python "Python" optional
call :check_cmd ffmpeg "ffmpeg" optional

echo [...] Verificando modelos Ollama...
ollama list 2>nul | findstr /i "qwen2.5:14b-instruct" >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] qwen2.5:14b-instruct descargado.
) else (
    echo [FAIL] qwen2.5:14b-instruct NO descargado.
    set "CHECK_FAIL=1"
)
ollama list 2>nul | findstr /i "qwen2.5vl:7b" >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] qwen2.5vl:7b descargado.
) else (
    echo [FAIL] qwen2.5vl:7b NO descargado.
    set "CHECK_FAIL=1"
)

echo.
echo ==============================================================
if "%CHECK_FAIL%"=="0" if "%FAILED%"=="0" (
    echo                    INSTALACION COMPLETA
    echo ==============================================================
    echo.
    echo  Todo listo. Arranca Pensadero con doble click en:
    echo    Pensadero_Start.bat
    echo.
) else (
    echo               INSTALACION CON AVISOS
    echo ==============================================================
    echo.
    echo  Algunas piezas no quedaron OK. Ejecuta Pensadero_Doctor.bat
    echo  para ver el diagnostico detallado.
    echo.
)

:end
pause
endlocal
exit /b 0


REM ================================================================
REM  Subrutinas
REM ================================================================

:refresh_path
REM Recarga PATH desde el registro (necesario tras winget install
REM porque cmd no ve cambios al PATH sin reabrir terminal).
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul ^| findstr /i "Path"') do set "SYS_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul ^| findstr /i "Path"') do set "USR_PATH=%%B"
set "PATH=%SYS_PATH%;%USR_PATH%"
exit /b 0

:pull_model
set "MODEL=%~1"
echo.
echo [...] Descargando %MODEL% ...
ollama list 2>nul | findstr /i "%MODEL%" >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] %MODEL% ya descargado, saltando.
    exit /b 0
)
ollama pull %MODEL%
if %ERRORLEVEL% NEQ 0 (
    echo [AVISO] Fallo descarga de %MODEL%. Reintenta relanzando el instalador.
)
exit /b 0

:check_cmd
set "CMD_NAME=%~1"
set "DISPLAY=%~2"
set "OPTIONAL=%~3"
where %CMD_NAME% >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] %DISPLAY%
) else (
    if "%OPTIONAL%"=="optional" (
        echo [WARN] %DISPLAY% no en PATH ^(opcional^)
    ) else (
        echo [FAIL] %DISPLAY% no en PATH
        set "CHECK_FAIL=1"
    )
)
exit /b 0
