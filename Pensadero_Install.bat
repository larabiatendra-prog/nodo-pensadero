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

if not exist "%NODE_DIR%\node.exe" (
    echo [ERROR] Falta el Node portable en tools\node\
    echo         Asegurate de que la carpeta tools\node\ esta dentro
    echo         del proyecto antes de ejecutar este instalador.
    pause
    exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"
echo [OK] Usando Node portable embebido:
"%NODE_DIR%\node.exe" --version
"%NODE_DIR%\npm.cmd" --version
echo.

echo ==============================================================
echo  [1/3] Instalando dependencias del frontend...
echo ==============================================================
cd /d "%ROOT%"
call "%NODE_DIR%\npm.cmd" install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install (frontend) ha fallado.
    pause
    exit /b 1
)

echo.
echo ==============================================================
echo  [2/3] Instalando dependencias del backend...
echo ==============================================================
cd /d "%ROOT%backend"
call "%NODE_DIR%\npm.cmd" install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install (backend) ha fallado.
    pause
    exit /b 1
)

echo.
echo ==============================================================
echo  [3/3] Construyendo build de produccion del frontend...
echo ==============================================================
cd /d "%ROOT%"
call "%NODE_DIR%\npm.cmd" run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build del frontend ha fallado.
    pause
    exit /b 1
)

echo.
echo ==============================================================
echo                    INSTALACION COMPLETA
echo ==============================================================
echo.
echo  Ya puedes arrancar Pensadero con doble click en:
echo  Pensadero_Start.bat
echo.
pause
