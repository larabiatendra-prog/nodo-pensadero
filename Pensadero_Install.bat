@echo off
title Pensadero - Instalacion
color 0D
cls

echo ==============================================================
echo                    PENSADERO - INSTALACION
echo            Archivo audiovisual personal (single user)
echo ==============================================================
echo.

set "ROOT=%~dp0"
set "NODE_DIR=%ROOT%tools\node"

if exist "%NODE_DIR%\node.exe" goto :use_portable

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :no_node
echo [OK] Usando Node del sistema
goto :node_ready

:use_portable
set "PATH=%NODE_DIR%;%PATH%"
echo [OK] Node portable detectado en tools\node\
goto :node_ready

:no_node
echo [ERROR] No se encontro Node.js.
echo         Opciones:
echo         A) Instala Node.js desde https://nodejs.org/
echo         B) Copia el Node portable en tools\node\
pause
exit /b 1

:node_ready
call node --version
call npm --version
echo.

echo ==============================================================
echo  [1/3] Instalando dependencias del frontend...
echo ==============================================================
cd /d "%ROOT%"
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install frontend ha fallado.
    pause
    exit /b 1
)

echo.
echo ==============================================================
echo  [2/3] Instalando dependencias del backend...
echo ==============================================================
cd /d "%ROOT%backend"
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install backend ha fallado.
    pause
    exit /b 1
)

echo.
echo ==============================================================
echo  [3/4] Construyendo build de produccion del frontend...
echo ==============================================================
cd /d "%ROOT%"
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build del frontend ha fallado.
    pause
    exit /b 1
)

echo.
echo ==============================================================
echo  [4/4] Modulo de reconocimiento facial (Python + InsightFace)
echo ==============================================================
echo  Opcional. Sin esto, Pensadero funciona pero NO reconoce caras
echo  en los escaneos. Necesitas Python 3.10+ en el PATH del sistema.
echo.

where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [AVISO] Python no encontrado. Salto el modulo de caras.
    echo         Instala Python 3.10+ desde https://python.org/ y vuelve a ejecutar
    echo         este instalador si quieres activar el reconocimiento facial.
    goto :install_done
)

cd /d "%ROOT%backend\python"
if not exist ".venv\Scripts\python.exe" (
    echo Creando venv local en backend\python\.venv...
    python -m venv .venv
    if %ERRORLEVEL% NEQ 0 (
        echo [AVISO] No se pudo crear el venv. Salto el modulo de caras.
        goto :install_done
    )
)
echo Instalando dependencias Python (insightface, onnxruntime...). Tarda 1-3 min.
call .venv\Scripts\python.exe -m pip install --upgrade pip --quiet
call .venv\Scripts\python.exe -m pip install -r requirements.txt --quiet
if %ERRORLEVEL% NEQ 0 (
    echo [AVISO] pip install ha fallado. El modulo de caras quedara deshabilitado.
    echo         Pensadero arrancara igualmente sin reconocimiento facial.
) else (
    echo [OK] Modulo de reconocimiento facial instalado.
    echo      El modelo de InsightFace (~270 MB) se descargara en la primera deteccion.
)

:install_done
cd /d "%ROOT%"
echo.
echo ==============================================================
echo                    INSTALACION COMPLETA
echo ==============================================================
echo.
echo  Ya puedes arrancar Pensadero con doble click en:
echo  Pensadero_Start.bat
echo.
pause
