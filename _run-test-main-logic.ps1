# _run-test-main-logic.ps1
# Versão robusta contra mojibake: UTF-8 de ponta a ponta, sem janelas extras.

param (
    [string]$FinalLogFile
)

# ====== UTF-8 de ponta a ponta ======
# 1) Console/host e pipeline
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = New-Object System.Text.UTF8Encoding($false)  # influencia redirecionamento de PS->exe

# 2) Code page do conhost herdado por processos CMD
#    (executamos um 'chcp 65001' válido para a sessão atual)
cmd.exe /d /c "chcp 65001 >nul" | Out-Null

# 3) Maven/Java sempre em UTF-8
$env:JAVA_TOOL_OPTIONS = "-Dfile.encoding=UTF-8"
$env:MAVEN_OPTS        = "-Dfile.encoding=UTF-8"

# 4) Abrimos o arquivo com UTF-8 COM BOM (Notepad adora BOM; evita detecção ambígua)
$Utf8WithBom = New-Object System.Text.UTF8Encoding($true)
# Cria/zera o arquivo com BOM
$fs = [System.IO.File]::Open($FinalLogFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
$sw = New-Object System.IO.StreamWriter($fs, $Utf8WithBom)

function Close-Log {
    try { $sw.Flush() } catch {}
    try { $sw.Close() } catch {}
    try { $fs.Close() } catch {}
}

function WLog([string]$msg) {
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
    $line = "$ts $msg"
    try { $sw.WriteLine($line); $sw.Flush() } catch {}
    Write-Host $line
}

# Executa comando externo sob 'cmd /c chcp 65001 & <comando>', capturando stdout+stderr
function Run-CmdUTF8 {
    param(
        [Parameter(Mandatory=$true)][string]$Title,
        [Parameter(Mandatory=$true)][string]$CommandLine,  # string única a ser interpretada pelo cmd.exe
        [switch]$IgnoreExitCode
    )
    WLog "[CMD] $Title"
    # Garante code page 65001 dentro do cmd, depois executa o comando
    $cmd = 'chcp 65001 >nul & ' + $CommandLine
    & cmd.exe /d /c $cmd 2>&1 | ForEach-Object {
        # Cada linha que chega já foi decodificada com OutputEncoding=UTF8
        $sw.WriteLine($_)
        Write-Host $_
    }
    $exit = $LASTEXITCODE
    $sw.Flush()
    if (-not $IgnoreExitCode -and $exit -ne 0) {
        throw "Comando falhou (exit $exit): $Title"
    }
    return $exit
}

try {
    WLog "[PASSO 1/5] Parando e removendo containers antigos (a ignorar falhas)..."
    Run-CmdUTF8 -Title "docker-compose down -v" -CommandLine 'docker-compose down -v' -IgnoreExitCode

    WLog "`n[PASSO 2/5] Construindo e subindo novos containers (a ignorar falhas)..."
    Run-CmdUTF8 -Title "docker-compose up -d --build" -CommandLine 'docker-compose --compatibility up -d --build' -IgnoreExitCode

    WLog "`n[PASSO 3/5] Verificação de Saúde dos Containers..."
    $timeoutSeconds = 90
    $services = "postgres", "app1", "app2"
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    $healthyServices = 0
    while ($stopwatch.Elapsed.TotalSeconds -lt $timeoutSeconds) {
        # Capturamos 'ps' também por cmd para manter o caminho UTF-8 consistente
        $tmpFile = [System.IO.Path]::GetTempFileName()
        # Redireciona para arquivo temporário para evitar buffering da pipeline
        Run-CmdUTF8 -Title "docker-compose ps" -CommandLine "docker-compose ps > `"$tmpFile`"" -IgnoreExitCode
        $statuses = Get-Content -LiteralPath $tmpFile -Encoding UTF8
        Remove-Item $tmpFile -ErrorAction SilentlyContinue

        $healthyServices = 0
        foreach ($service in $services) {
            $serviceLines = $statuses | Where-Object { $_ -match "\b$([Regex]::Escape($service))\b" }
            if ($serviceLines -and ($serviceLines -match 'healthy' -or $serviceLines -match '\bUp\b')) {
                $healthyServices++
            }
        }

        WLog "Aguardando... ($healthyServices de $($services.Length) serviços prontos)"
        if ($healthyServices -eq $services.Length) {
            WLog "Todos os serviços essenciais estão prontos! A continuar."
            break
        }
        Start-Sleep -Seconds 5
    }
    $stopwatch.Stop()

    if ($healthyServices -ne $services.Length) {
        # Loga o estado atual com caminho 100% UTF-8
        $tmpFile = [System.IO.Path]::GetTempFileName()
        Run-CmdUTF8 -Title "docker-compose ps (final)" -CommandLine "docker-compose ps > `"$tmpFile`"" -IgnoreExitCode
        $statusLog = Get-Content -LiteralPath $tmpFile -Encoding UTF8 | Out-String
        Remove-Item $tmpFile -ErrorAction SilentlyContinue
        WLog "`n--- ESTADO ATUAL DOS CONTAINERS ---`n$statusLog"
        throw "Timeout: Nem todos os containers ficaram prontos em $timeoutSeconds segundos."
    }

    WLog "`n[PASSO 4/5] Limpando o banco de dados..."
    Run-CmdUTF8 -Title "docker exec postgres psql reset" -CommandLine `
        'docker exec postgres psql -U postgres -d postgres_api_db -v ON_ERROR_STOP=1 -c "TRUNCATE TABLE transactions" -c "UPDATE accounts SET balance = 0"'

    WLog "`n[PASSO 5/5] Executando o teste de carga com Gatling..."
    Push-Location "gatling"
    # Refazemos envs dentro da sessão cmd chamada:
    $gatlingExit = Run-CmdUTF8 -Title "mvnw gatling:test" -CommandLine `
        'set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8" & set "MAVEN_OPTS=-Dfile.encoding=UTF-8" & mvnw.cmd gatling:test -Dgatling.simulationClass=simulations.RinhaBackendCrebitosSimulation' `
        -IgnoreExitCode
    Pop-Location
    if ($gatlingExit -ne 0) { throw "Falha ao executar o teste do Gatling. Exit=$gatlingExit" }

    WLog "Teste concluído com sucesso."

} catch {
    WLog ""
    WLog ("ERRO DETALHADO: " + $_.ToString())
} finally {
    Close-Log
    Write-Host "`nProcesso terminado. Pressione ENTER para fechar esta janela."
    Read-Host | Out-Null
}
