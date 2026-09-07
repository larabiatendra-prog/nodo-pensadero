@echo off
title Pensadero
setlocal enabledelayedexpansion

REM ============================================================
REM  Supervisor del backend de Pensadero.
REM
REM  Existe porque el backend podia morir sin dejar rastro: se
REM  lanzaba en una ventana minimizada, sin log y sin nadie que
REM  lo relanzara. El 07/09/2026 murio a mitad de un lote y no
REM  se supo hasta dos horas despues, con el trabajo perdido.
REM
REM  Ahora: relanza, registra con hora, y espera cada vez mas si
REM  el fallo se repite (5s, 15s, 60s) para no entrar en bucle
REM  cerrado. Si aguanta 2 minutos en pie, el contador se
REM  reinicia: una caida aislada no penaliza a la siguiente.
REM
REM  Sin acentos (regla 5 de CLAUDE.md): compatibilidad con cmd.
REM ============================================================

set "ROOT=%~dp0"
set "LOGDIR=%ROOT%backend\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM Purgar logs de mas de 14 dias para que no crezcan sin fin.
forfiles /p "%LOGDIR%" /m backend-*.log /d -14 /c "cmd /c del @path" >nul 2>&1

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "HOY=%%i"
set "LOG=%LOGDIR%\backend-%HOY%.log"

REM Node portable del propio proyecto si existe.
if exist "%ROOT%tools\node\node.exe" set "PATH=%ROOT%tools\node;%PATH%"

REM --report-on-fatalerror: un OOM deja un informe JSON en logs\ en vez de
REM   morir mudo. Era justo lo que faltaba para diagnosticar la caida.
REM --max-old-space-size: el tope por defecto (4288 MB) se queda corto en
REM   tandas largas de escaneo.
set "NODE_FLAGS=--report-on-fatalerror --report-directory=%LOGDIR% --max-old-space-size=8192"

set /a INTENTOS=0

:loop
for /f %%s in ('powershell -NoProfile -Command "[DateTimeOffset]::Now.ToUnixTimeSeconds()"') do set "T0=%%s"

echo.>> "%LOG%"
echo ============================================================>> "%LOG%"
echo [%DATE% %TIME%] Arrancando backend (reinicios seguidos: !INTENTOS!)>> "%LOG%"
echo ============================================================>> "%LOG%"

cd /d "%ROOT%backend"
node %NODE_FLAGS% server.js >> "%LOG%" 2>&1
set "CODIGO=!ERRORLEVEL!"

for /f %%s in ('powershell -NoProfile -Command "[DateTimeOffset]::Now.ToUnixTimeSeconds()"') do set "T1=%%s"
set /a DURACION=!T1!-!T0!

echo [%DATE% %TIME%] El backend termino con codigo !CODIGO! tras !DURACION!s>> "%LOG%"

REM Salida limpia (parada pedida): no relanzar.
if "!CODIGO!"=="0" (
    echo [%DATE% %TIME%] Salida limpia. Supervisor terminado.>> "%LOG%"
    goto :fin
)

REM Si aguanto en pie un rato largo, la caida es aislada: contador a cero.
if !DURACION! GEQ 120 set /a INTENTOS=0

set /a INTENTOS+=1
if !INTENTOS! GEQ 10 (
    echo [%DATE% %TIME%] 10 caidas seguidas. El supervisor se detiene.>> "%LOG%"
    echo.
    echo  [ERROR] El backend ha caido 10 veces seguidas sin llegar a
    echo          sostenerse. Algo esta roto de verdad. Revisa:
    echo          %LOG%
    echo.
    pause
    goto :fin
)

if !INTENTOS! LEQ 3 (
    set "ESPERA=5"
) else (
    if !INTENTOS! LEQ 6 (set "ESPERA=15") else (set "ESPERA=60")
)

echo [%DATE% %TIME%] Reintentando en !ESPERA!s...>> "%LOG%"
timeout /t !ESPERA! /nobreak >nul
goto :loop

:fin
endlocal
exit /b
