# Instala «Pensadero» en Premiere Pro (para el boton «Enviar a Premiere»).
# 1) Enlaza la carpeta extension\ dentro de las extensiones de Adobe (si se
#    cambia aqui, Premiere ve el cambio al reabrirse).
# 2) Permite extensiones sin firmar (PlayerDebugMode = 1), necesario para
#    extensiones caseras. Solo si no estaba ya.
# Despues: guardar, cerrar y volver a abrir Premiere.

$origen = Join-Path $PSScriptRoot 'extension'
$destino = Join-Path $env:APPDATA 'Adobe\CEP\extensions\pensadero-premiere'

New-Item -ItemType Directory -Force (Split-Path $destino) | Out-Null
if (Test-Path $destino) { Write-Host "Ya estaba instalada en $destino" }
else { New-Item -ItemType Junction -Path $destino -Target $origen | Out-Null; Write-Host "Extension enlazada en $destino" }

# CEP 9 (Premiere 2019-2020), 10 (2021), 11 (2022-2024), 12 (2025 en adelante).
foreach ($v in 9, 10, 11, 12) {
  $clave = "HKCU:\Software\Adobe\CSXS.$v"
  $actual = (Get-ItemProperty -Path $clave -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
  if ($actual -eq '1') { Write-Host "CSXS.$v ya permitia extensiones sin firmar." }
  else {
    New-Item -Path $clave -Force | Out-Null
    Set-ItemProperty -Path $clave -Name PlayerDebugMode -Value '1'
    Write-Host "Extensiones sin firmar permitidas (CSXS.$v PlayerDebugMode = 1)."
  }
}
Write-Host 'Ahora guarda, cierra y vuelve a abrir Premiere.'
