#!/usr/bin/env bash
# ^ Shebang: diz ao sistema que este arquivo deve ser executado usando o interpretador "bash"
#   Em sistemas Linux, isso garante que o script rode com o Bash mesmo se /bin/bash
#   estiver em outro caminho. "/usr/bin/env" procura o bash no PATH atual.

# _linux_run-test-launcher.sh — Linux launcher
# Nome descritivo: este script é um "lançador" (launcher) que orquestra dois outros:
# 1) _linux_run-test-main-logic.sh   → executa o teste principal e grava um log "main"
# 2) _linux_run-test-stats-logger.sh → coleta métricas/estatísticas em paralelo e grava um log "stats"
# Ele também cuida de encerrar ambos corretamente quando o usuário interrompe (CTRL+C).

set -Eeuo pipefail
# set -E  → preserva o comportamento de ERR em funções e subshells
# set -e  → faz o script "parar" se qualquer comando retornar status ≠ 0 (falha)
# set -u  → trata o uso de variáveis não definidas como erro
# set -o pipefail → se houver "cmd1 | cmd2", o código de saída do pipeline falha se qualquer comando falhar
# Esses flags tornam o script mais seguro e previsível.

# Locale/encoding (UTF-8 end-to-end)
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
# As duas variáveis acima forçam o locale/encoding para UTF-8, evitando erros de acentuação/símbolos nos logs.

export JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8 ${JAVA_TOOL_OPTIONS:-}"
export MAVEN_OPTS="-Dfile.encoding=UTF-8 ${MAVEN_OPTS:-}"
# Se Java/Maven forem usados por processos chamados indiretamente, garantimos UTF-8 neles também.
# O padrão ${VAR:-} mantém valores existentes, apenas acrescentando o parâmetro de encoding.

# Descobre o diretório onde o script está (mesmo que chamado de outro lugar).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# Passos:
#  - dirname "${BASH_SOURCE[0]}" → pega a pasta do arquivo atual
#  - cd -- "essa_pasta"          → entra nela (o "--" evita que nomes com "-" sejam tratados como flags)
#  - >/dev/null 2>&1             → silencia saídas
#  - pwd                         → obtém o caminho absoluto final
# Resultado: SCRIPT_DIR contém o caminho absoluto deste script.

# Gera um timestamp compacto para nomear arquivos de log sem sobrescrever anteriores.
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

# Monta caminhos para os dois arquivos de log, usando o timestamp, na mesma pasta do script.
MAIN_LOG_FILE="${SCRIPT_DIR}/__${TIMESTAMP}-test_logs.txt"
STATS_LOG_FILE="${SCRIPT_DIR}/__${TIMESTAMP}-stats_logs.txt"

# Arquivo "flag" usado para sinalizar educadamente ao logger que é hora de parar.
STOP_FLAG="${SCRIPT_DIR}/stop-logging.flg"

# === Minimal addition: stop stats-logger when user interrupts ===
# Função chamada automaticamente quando sinais de interrupção chegam (CTRL+C = INT, ou TERM).
cleanup_interrupt() {
  # Se o processo principal (main) estiver ativo, tentamos encerrá-lo com escalonamento de sinais.
  # kill -0 apenas "testa" se o PID existe (não mata); útil para checar se está vivo.
  if [[ -n "${MAIN_PID:-}" ]] && kill -0 "${MAIN_PID}" 2>/dev/null; then
    # Envia SIGINT (equivalente a CTRL+C) para TODO o grupo de processos do main.
    # Notação "-- -PGID" significa "enviar para o grupo" cujo ID = PGID.
    kill -INT -- -"${MAIN_PGID}" 2>/dev/null || true
    sleep 1
    # Se ainda não saiu, envia SIGTERM (pedido gentil para terminar).
    kill -TERM -- -"${MAIN_PGID}" 2>/dev/null || true
    sleep 1
    # Último recurso: SIGKILL (encerra à força).
    kill -KILL -- -"${MAIN_PGID}" 2>/dev/null || true
  fi

  # Sinaliza ao logger (processo de métricas) para parar de forma silenciosa criando o STOP_FLAG.
  touch "${STOP_FLAG}" 2>/dev/null || true

  # Se o logger existir, tenta terminá-lo também (primeiro normal, depois forçado).
  if [[ -n "${LOGGER_PID:-}" ]] && kill -0 "${LOGGER_PID}" 2>/dev/null; then
    kill "${LOGGER_PID}" 2>/dev/null || true
    sleep 1
    kill -9 "${LOGGER_PID}" 2>/dev/null || true
  fi

  # Remove a flag (limpeza) — útil caso alguém rode novamente logo em seguida.
  rm -f "${STOP_FLAG}" 2>/dev/null || true

  exit 130
  # Código 130 é convenção para "script terminado por sinal SIGINT".
}
# "trap" conecta sinais a uma função de limpeza. Se usuário pressionar CTRL+C (INT) ou
# se o sistema pedir término (TERM), chamamos cleanup_interrupt para desligar tudo com ordem.
trap cleanup_interrupt INT TERM
# === End minimal addition ===

# Saída informativa para o usuário: mostra início e aonde os logs serão gravados.
echo "===================================================================="
echo " Iniciando teste — ${TIMESTAMP}"
echo "  Logs:"
echo "    Main : ${MAIN_LOG_FILE}"
echo "    Stats: ${STATS_LOG_FILE}"
echo "===================================================================="

# Inicia a lógica principal em sua PRÓPRIA sessão/grupo de processos.
# "setsid" cria uma nova sessão, fazendo com que o processo filho tenha um novo PGID (process group id).
# Vantagem: depois conseguimos enviar sinais para o GRUPO inteiro com "kill -- -PGID".
setsid bash "${SCRIPT_DIR}/_linux_run-test-main-logic.sh" "${MAIN_LOG_FILE}" &
# O "&" coloca em segundo plano; $! logo abaixo captura o PID do último comando background.

MAIN_PID=$!  # Captura o PID do processo principal recém-lançado.

# Em uma nova sessão, por padrão PGID == PID do líder de sessão. Usamos isso como "fallback".
MAIN_PGID="${MAIN_PID}"

# Se "ps" existir, confirmamos/ajustamos o PGID real perguntando ao sistema (mais robusto).
if command -v ps >/dev/null 2>&1; then
  MAIN_PGID_PS="$(ps -o pgid= -p "${MAIN_PID}" 2>/dev/null | tr -d " ")" || true
  # ps -o pgid= -p <pid> → imprime somente o PGID
  # tr -d " " → remove espaços em branco que alguns "ps" colocam
  if [[ -n "${MAIN_PGID_PS}" ]]; then MAIN_PGID="${MAIN_PGID_PS}"; fi
fi

# Inicia o coletor de estatísticas (logger) em background.
# Parâmetros:
#   1) caminho do log de stats
#   2) PID do processo principal (para o logger saber quando parar)
#   3) caminho do STOP_FLAG (arquivo cuja presença indica: "pare agora")
bash "${SCRIPT_DIR}/_linux_run-test-stats-logger.sh" "${STATS_LOG_FILE}" "${MAIN_PID}" "${STOP_FLAG}" &
LOGGER_PID=$!  # Guarda o PID do logger para possível encerramento posterior.

# Aguarda o término do processo principal (main). "wait" retorna o status dele.
# O "|| true" impede que o set -e finalize o launcher caso o main falhe;
# preferimos continuar para poder parar o logger com elegância e imprimir a mensagem final.
wait "${MAIN_PID}" || true

# Sinaliza ao logger para encerrar criando o STOP_FLAG, e dá um tempinho para sair sozinho.
touch "${STOP_FLAG}" || true
sleep 2
rm -f "${STOP_FLAG}" || true  # Limpa a flag após esse "grace period".

# Garante que o logger realmente terminou; se ainda estiver rodando, pede para sair.
if kill -0 "${LOGGER_PID}" 2>/dev/null; then
  kill "${LOGGER_PID}" 2>/dev/null || true
fi

# Mensagem final para o usuário: indica que o processo terminou e onde procurar os logs.
echo "[OK] Concluído. Veja os logs gerados."
