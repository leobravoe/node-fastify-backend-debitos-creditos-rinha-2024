:: _run-test-launcher.bat
:: Lançador principal que gerencia o logger e a janela de teste.
@echo off
:: Altera a página de código para UTF-8 para evitar caracteres corrompidos.
chcp 65001 > nul
setlocal

:: --- Configuração ---
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /format:list') do set DATETIME=%%I
set TIMESTAMP=%DATETIME:~0,8%-%DATETIME:~8,6%
set MAIN_LOG_FILE=main-run-logs-%TIMESTAMP%.txt
set STATS_LOG_FILE=stats-logs-%TIMESTAMP%.txt
set WINDOW_TITLE=RinhaTestRun-%TIMESTAMP%

echo.
echo ====================================================================
echo               INICIANDO TESTE DE CARGA E MONITORAMENTO
echo ====================================================================
echo.
echo Logs do processo principal serao salvos em: %MAIN_LOG_FILE%
echo Logs do Docker Stats serao salvos em:     %STATS_LOG_FILE%
echo.
echo UMA NOVA JANELA SERA ABERTA PARA EXECUTAR O TESTE.
echo PARA INTERROMPER TUDO, APENAS FECHE A NOVA JANELA OU USE CTRL+C NELA.
echo.

:: Garante que não existe um arquivo de sinalização de uma execução anterior.
if exist stop-logging.flg del stop-logging.flg

:: --- Inicia o Logger ---
echo Iniciando o logger do Docker Stats em segundo plano...
start /B cmd /c _run-test-stats-logger.bat "%STATS_LOG_FILE%" "%WINDOW_TITLE%"

:: --- Inicia a Lógica Principal ---
start "%WINDOW_TITLE%" /wait cmd /c _run-test-main-logic.bat "%MAIN_LOG_FILE%"

echo.
echo Janela de teste foi fechada. Finalizando o logger...

:cleanup_and_exit
:: --- Finalização ---
echo stop > stop-logging.flg
timeout /t 3 > nul
del stop-logging.flg

echo Processo concluido. Verifique os arquivos de log gerados.
endlocal