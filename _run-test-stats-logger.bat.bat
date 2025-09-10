:: _run-test-stats-logger.bat
:: Coleta 'docker stats' e monitora o processo pai pelo título da janela.
@echo off
:: Altera a página de código para UTF-8 para o log de stats.
chcp 65001 > nul

set LOG_FILE=%1
set PARENT_WINDOW_TITLE=%2

:loop
    :: Condição de parada 1: Fim normal do script principal.
    if exist stop-logging.flg (
        exit
    )

    :: Condição de parada 2: Script principal foi interrompido (Ctrl+C).
    tasklist /v /fi "WINDOWTITLE eq %PARENT_WINDOW_TITLE%" | find "cmd.exe" > nul
    if errorlevel 1 (
        echo Janela principal ('%PARENT_WINDOW_TITLE%') foi fechada. Encerrando o logger.
        exit
    )

    docker stats --no-stream >> "%LOG_FILE%"
    timeout /t 2 /nobreak > nul
goto loop