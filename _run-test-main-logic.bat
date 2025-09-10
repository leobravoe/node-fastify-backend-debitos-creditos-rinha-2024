:: _run-test-main-logic.bat
:: Contém apenas a lógica de execução do teste. Será chamado pelo lançador.
@echo off
:: Altera a página de código para UTF-8. ESSENCIAL para o log principal.
chcp 65001 > nul

(
    echo [PASSO 1/4] Parando e removendo containers antigos...
    docker compose down -v
    if %errorlevel% neq 0 ( exit /b 1 )

    echo.
    echo [PASSO 2/4] Construindo e subindo novos containers...
    docker compose --compatibility up -d --build
    if %errorlevel% neq 0 ( exit /b 1 )

    echo.
    echo [PASSO 3/4] Limpando o banco de dados...
    docker exec postgres psql -U postgres -d postgres_api_db -v ON_ERROR_STOP=1 -c "TRUNCATE TABLE transactions" -c "UPDATE accounts SET balance = 0"
    if %errorlevel% neq 0 ( exit /b 1 )

    echo.
    echo [PASSO 4/4] Executando o teste de carga com Gatling...
    cd gatling
    call mvnw.cmd gatling:test -Dgatling.simulationClass=simulations.RinhaBackendCrebitosSimulation
    cd ..

) > "%1" 2>&1

exit /b 0