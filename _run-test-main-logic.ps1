# _run-test-main-logic.ps1
# Versão que mantém sua lógica e permite ver o log em tempo real:
#  - Abre um "tail" do arquivo em outra janela (Get-Content -Wait -Tail 50)
#  - Tudo que antes ia só para o arquivo agora também aparece no console (Tee-Object)

param (
    [string]$FinalLogFile
)

# --- Configs do viewer em tempo real ---
$LaunchTailViewer = $true   # coloque $false se não quiser abrir a janela de tail
$TailStartMinimized = $true

function Write-Log([string]$msg) {
    $ts = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fff")
    $line = "[$ts] $msg"
    # Escreve no arquivo e no console, em tempo real
    $line | Tee-Object -FilePath $FinalLogFile -Append | Out-Host
}

try {
    # --- PREPARAÇÃO DO AMBIENTE ---
    $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
    $PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $env:JAVA_TOOL_OPTIONS = "-Dfile.encoding=UTF-8"
    New-Item -Path $FinalLogFile -ItemType File -Force | Out-Null

    # Inicia o viewer ao vivo do log em outra janela
    if ($LaunchTailViewer -and $FinalLogFile) {
        $tailArgs = @(
            "-NoProfile","-ExecutionPolicy","Bypass",
            "-Command","Get-Content -LiteralPath '$FinalLogFile' -Wait -Tail 50"
        )
        $winStyle = if ($TailStartMinimized) { 'Minimized' } else { 'Normal' }
        $global:TailProc = Start-Process -FilePath "powershell" -ArgumentList $tailArgs -WindowStyle $winStyle -PassThru
        Write-Log "Tail em tempo real iniciado (PID=$($TailProc.Id))."
    }

    # --- EXECUÇÃO SEQUENCIAL ---

    Write-Log "[PASSO 1/5] Parando e removendo containers antigos (a ignorar falhas)..."
    docker-compose down -v *>&1 | Tee-Object -FilePath $FinalLogFile -Append | Out-Host

    Write-Log "`n[PASSO 2/5] Construindo e subindo novos containers (a ignorar falhas)..."
    docker-compose --compatibility up -d --build *>&1 | Tee-Object -FilePath $FinalLogFile -Append | Out-Host
    # (mantido: ignorar código de saída do 'up' e confiar no health check)

    # --- CORREÇÃO FINAL E DEFINITIVA ---
    Write-Log "`n[PASSO 3/5] Verificação de Saúde dos Containers..."
    $timeoutSeconds = 90
    $services = "postgres", "app1", "app2"
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    while ($stopwatch.Elapsed.TotalSeconds -lt $timeoutSeconds) {
        # Pegamos o status só em variável (não logamos a cada iteração para evitar ruído excessivo)
        $statuses = docker-compose ps
        $healthyServices = 0

        foreach ($service in $services) {
            # 'healthy' é melhor; se não há healthcheck, 'Up' serve como sinal mínimo.
            if (($statuses | Select-String $service | Select-String "healthy") -or
                ($statuses | Select-String $service | Select-String "Up")) {
                $healthyServices++
            }
        }

        Write-Log "Aguardando... ($healthyServices de $($services.Length) serviços prontos)"

        if ($healthyServices -eq $services.Length) {
            Write-Log "Todos os serviços essenciais estão prontos! A continuar."
            break
        }

        Start-Sleep -Seconds 5
    }

    $stopwatch.Stop()
    if ($healthyServices -ne $services.Length) {
        Write-Log "`n--- ESTADO ATUAL DOS CONTAINERS ---"
        ($statuses | Out-String) | Tee-Object -FilePath $FinalLogFile -Append | Out-Host
        throw "Timeout: Nem todos os containers ficaram prontos em $timeoutSeconds segundos."
    }

    Write-Log "`n[PASSO 4/5] Limpando o banco de dados..."
    docker exec postgres psql -U postgres -d postgres_api_db -v ON_ERROR_STOP=1 `
      -c "TRUNCATE TABLE transactions" `
      -c "UPDATE accounts SET balance = 0" *>&1 | Tee-Object -FilePath $FinalLogFile -Append | Out-Host
    if (-not $?) { throw "Falha ao limpar o banco de dados." }

    Write-Log "`n[PASSO 5/5] Executando o teste de carga com Gatling..."
    Push-Location "gatling"
    & ./mvnw.cmd "gatling:test" "-Dgatling.simulationClass=simulations.RinhaBackendCrebitosSimulation" *>&1 `
      | Tee-Object -FilePath $FinalLogFile -Append | Out-Host
    $gatlingOk = $?
    Pop-Location
    if (-not $gatlingOk) { throw "Falha ao executar o teste do Gatling." }

    Write-Log "Teste concluído com sucesso."

} catch {
    $errorMessage = "ERRO DETALHADO: $($_.ToString())"
    Write-Log ""
    Write-Log $errorMessage
} finally {
    Write-Host "`nProcesso terminado. Pressione ENTER para fechar esta janela."
    Read-Host | Out-Null

    # opcional: encerrar o tail quando a janela principal for fechada
    try {
        if ($TailProc -and -not $TailProc.HasExited) { $TailProc.CloseMainWindow() | Out-Null }
    } catch { }
}
