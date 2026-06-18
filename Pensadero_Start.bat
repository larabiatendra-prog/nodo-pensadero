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

REM ============================================================
REM  PREFLIGHT: Start es el unico entrypoint. Comprueba lo minimo
REM  y repara o delega en Install. Idempotente: si todo esta bien,
REM  no toca nada y arranca.
REM ============================================================

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

REM Guard defensivo: si backend\.env no existe, crearlo desde la plantilla NODO.
REM Nunca pisa un .env existente. Si tampoco hay .env.nodo, avisa sin inventar valores.
if not exist "%ROOT%backend\.env" (
    if exist "%ROOT%backend\.env.nodo" (
        copy /Y "%ROOT%backend\.env.nodo" "%ROOT%backend\.env" >nul
        echo [OK] backend\.env creado desde .env.nodo
    ) else (
        echo [AVISO] Falta backend\.env y backend\.env.nodo. Pensadero usara defaults de codigo.
    )
)

REM Validar que el entorno Python ARRANCA, no solo que existe (un .venv copiado
REM entre PCs puede tener rutas absolutas rotas: code 103). No bloquea el
REM arranque: caras/CLIP quedan degradados pero el resto de Pensadero funciona.
if exist "%ROOT%backend\python\.venv\Scripts\python.exe" (
    call "%ROOT%backend\python\.venv\Scripts\python.exe" --version >nul 2>&1
    if errorlevel 1 (
        echo [AVISO] El entorno Python .venv no arranca; probable copia entre PCs.
        echo         Reparalo con Pensadero_Install.bat o Pensadero_Doctor.bat.
        echo         Caras y busqueda visual no funcionaran hasta repararlo.
    )
) else (
    echo [AVISO] Falta backend\python\.venv. Caras y busqueda visual no funcionaran.
    echo         Ejecuta Pensadero_Install.bat para instalarlo.
)

REM Build CONDICIONAL: solo construir si falta dist. Tras cambiar codigo,
REM reconstruye a mano con: npm run build
if not exist "%ROOT%dist\index.html" (
    echo Construyendo build de produccion porque no existe dist...
    cd /d "%ROOT%"
    call npm run build
    if errorlevel 1 (
        echo.
        echo [ERROR] El build fallo. Pensadero NO se arrancara.
        echo         Revisa los errores de arriba y vuelve a ejecutar Pensadero_Start.bat.
        pause
        exit /b 1
    )
) else (
    echo [OK] Build existente en dist. Para reconstruir tras cambios: npm run build
)

REM Asegurar que Ollama corre (si esta instalado). Sin Ollama, la IA local no funciona.
where ollama >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri http://localhost:11434/ -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
    if errorlevel 1 (
        echo Arrancando servicio Ollama...
        start "" /B ollama serve >nul 2>&1
        timeout /t 3 /nobreak >nul
    )
) else (
    echo [AVISO] Ollama no instalado. Busqueda natural y escaneo visual no funcionaran.
    echo         Ejecuta Pensadero_Doctor.bat para diagnostico.
)

REM Comprobar que el puerto 5000 esta libre. Si lo ocupa otro proceso, avisar
REM (no matamos a ciegas un PID que podria no ser nuestro). NO se mata por
REM titulo de ventana aqui: esta misma ventana se llama Pensadero y se
REM autodestruiria. El taskkill solo se hace al cerrar (al final del script).
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if %ERRORLEVEL% NEQ 0 (
    echo [AVISO] El puerto 5000 esta ocupado por otro proceso.
    echo         Cierra la aplicacion que lo use. Pensadero intentara arrancar igual.
)

REM Origen unico: el backend Node sirve el bundle (dist/) Y la API en el mismo
REM puerto 5000. Ya no hace falta arrancar vite preview por separado.
echo Arrancando Pensadero en puerto 5000 (frontend + API)...
start "Pensadero" /min cmd /c "cd /d %ROOT%backend && node server.js"

timeout /t 4 /nobreak >nul

start http://localhost:5000

echo.
echo  Pensadero: http://localhost:5000
echo  Para el nombre http://pensadero:5000 anade el alias en hosts (ver README).
echo.
echo  Cierra esta ventana para detener Pensadero.
pause >nul

echo.
echo Deteniendo Pensadero...
taskkill /FI "WINDOWTITLE eq Pensadero*" /T /F >nul 2>&1
exit
