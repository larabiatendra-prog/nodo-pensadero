@echo off
title Pensadero
color 0D
cls

echo ==============================================================
echo                          PENSADERO
echo                Archivo audiovisual personal
echo ==============================================================
echo.

set "ROOT=%~dp0"
set "NODE_DIR=%ROOT%tools\node"

if not exist "%NODE_DIR%\node.exe" (
    echo [ERROR] Falta el Node portable en tools\node\
    echo         Reinstala el paquete de Pensadero o ejecuta primero
    echo         Pensadero_Install.bat para preparar el entorno.
    pause
    exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"

if not exist "%ROOT%node_modules" (
    echo [AVISO] Faltan dependencias del frontend.
    echo         Lanzando Pensadero_Install.bat...
    call "%ROOT%Pensadero_Install.bat"
    if %ERRORLEVEL% NEQ 0 exit /b 1
)

if not exist "%ROOT%backend\node_modules" (
    echo [AVISO] Faltan dependencias del backend.
    echo         Lanzando Pensadero_Install.bat...
    call "%ROOT%Pensadero_Install.bat"
    if %ERRORLEVEL% NEQ 0 exit /b 1
)

if not exist "%ROOT%dist" (
    echo [AVISO] Falta el build de produccion. Construyendo...
    cd /d "%ROOT%"
    call "%NODE_DIR%\npm.cmd" run build
    if %ERRORLEVEL% NEQ 0 ( pause & exit /b 1 )
)

echo Arrancando backend en puerto 5000...
start "Pensadero Backend" /min cmd /c "cd /d %ROOT%backend && %NODE_DIR%\node.exe server.js"

timeout /t 3 /nobreak >nul

echo Arrancando frontend (preview)...
start "Pensadero Frontend" /min cmd /c "cd /d %ROOT% && %NODE_DIR%\npm.cmd run start"

timeout /t 4 /nobreak >nul

start http://localhost:5173

echo.
echo  Backend:  http://localhost:5000
echo  Frontend: http://localhost:5173
echo.
echo  Cierra esta ventana para detener Pensadero.
pause >nul

echo.
echo Deteniendo Pensadero...
taskkill /FI "WINDOWTITLE eq Pensadero Backend*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Pensadero Frontend*" /T /F >nul 2>&1
exit
