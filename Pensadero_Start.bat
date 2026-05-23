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

if exist "%NODE_DIR%\node.exe" goto :use_portable

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :no_node
goto :node_ready

:use_portable
set "PATH=%NODE_DIR%;%PATH%"
goto :node_ready

:no_node
echo [ERROR] No se encontro Node.js.
echo         Ejecuta Pensadero_Install.bat o instala Node.js desde https://nodejs.org/
pause
exit /b 1

:node_ready

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
    call npm run build
    if %ERRORLEVEL% NEQ 0 ( pause & exit /b 1 )
)

REM Asegurar que Ollama corre (si esta instalado). Sin Ollama, la IA local no funciona.
where ollama >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri http://localhost:11434/ -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
    if %ERRORLEVEL% NEQ 0 (
        echo Arrancando servicio Ollama...
        start "" /B ollama serve >nul 2>&1
        timeout /t 3 /nobreak >nul
    )
) else (
    echo [AVISO] Ollama no instalado. Busqueda natural y escaneo visual no funcionaran.
    echo         Ejecuta Pensadero_Doctor.bat para diagnostico.
)

echo Arrancando backend en puerto 5000...
start "Pensadero Backend" /min cmd /c "cd /d %ROOT%backend && node server.js"

timeout /t 3 /nobreak >nul

echo Arrancando frontend (preview)...
start "Pensadero Frontend" /min cmd /c "cd /d %ROOT% && npm run start"

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
