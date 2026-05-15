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
echo  [3/3] Construyendo build de produccion del frontend...
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
echo                    INSTALACION COMPLETA
echo ==============================================================
echo.
echo  Ya puedes arrancar Pensadero con doble click en:
echo  Pensadero_Start.bat
echo.
pause
