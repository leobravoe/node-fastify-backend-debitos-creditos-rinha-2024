# _run-test-stats-logger.ps1
# Monitoriza o processo principal através do seu PID.

param (
    [string]$LogFile,
    [int]$ProcessId
)

$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'

Add-Content -Path $LogFile -Value "[Logger] Iniciado. A monitorizar o Processo com ID: $ProcessId"

while ($true) {
    if (Test-Path "stop-logging.flg") {
        Add-Content -Path $LogFile -Value "[Logger] Sinal de parada recebido. Encerrando."
        exit 0
    }

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        Add-Content -Path $LogFile -Value "[Logger] Processo principal (PID: $ProcessId) foi fechado. Encerrando o logger."
        exit 0
    }

    $stats = docker stats --no-stream
    Add-Content -Path $LogFile -Value $stats
    Add-Content -Path $LogFile -Value ""

    Start-Sleep -Seconds 2
}