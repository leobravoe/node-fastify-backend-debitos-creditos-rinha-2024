#!/usr/bin/env bash
# _linux_run-test-launcher.sh — Linux launcher
set -Eeuo pipefail

# Locale/encoding (UTF-8 end-to-end)
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8 ${JAVA_TOOL_OPTIONS:-}"
export MAVEN_OPTS="-Dfile.encoding=UTF-8 ${MAVEN_OPTS:-}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
MAIN_LOG_FILE="${SCRIPT_DIR}/__${TIMESTAMP}-test_logs.txt"
STATS_LOG_FILE="${SCRIPT_DIR}/__${TIMESTAMP}-stats_logs.txt"
STOP_FLAG="${SCRIPT_DIR}/stop-logging.flg"

# === Minimal addition: stop stats-logger when user interrupts ===
cleanup_interrupt() {
  # Forward signal to main process if running
  if [[ -n "${MAIN_PID:-}" ]] && kill -0 "${MAIN_PID}" 2>/dev/null; then
    kill -INT -- -"${MAIN_PGID}" 2>/dev/null || true
    sleep 1
    kill -TERM -- -"${MAIN_PGID}" 2>/dev/null || true
    sleep 1
    kill -KILL -- -"${MAIN_PGID}" 2>/dev/null || true
  fi

  # Signal logger to stop quietly
  touch "${STOP_FLAG}" 2>/dev/null || true
  if [[ -n "${LOGGER_PID:-}" ]] && kill -0 "${LOGGER_PID}" 2>/dev/null; then
    kill "${LOGGER_PID}" 2>/dev/null || true
    sleep 1
    kill -9 "${LOGGER_PID}" 2>/dev/null || true
  fi
  rm -f "${STOP_FLAG}" 2>/dev/null || true
  exit 130

}
trap cleanup_interrupt INT TERM
# === End minimal addition ===

echo "===================================================================="
echo " Iniciando teste — ${TIMESTAMP}"
echo "  Logs:"
echo "    Main : ${MAIN_LOG_FILE}"
echo "    Stats: ${STATS_LOG_FILE}"
echo "===================================================================="

# Start main logic in its own session/process group and capture PID
# Using setsid ensures we can signal the entire group with kill -- -PGID
setsid bash "${SCRIPT_DIR}/_linux_run-test-main-logic.sh" "${MAIN_LOG_FILE}" &
MAIN_PID=$!
# In a new session, PGID == PID (fallback to ps if available just in case)
MAIN_PGID="${MAIN_PID}"
if command -v ps >/dev/null 2>&1; then
  MAIN_PGID_PS="$(ps -o pgid= -p "${MAIN_PID}" 2>/dev/null | tr -d " ")" || true
  if [[ -n "${MAIN_PGID_PS}" ]]; then MAIN_PGID="${MAIN_PGID_PS}"; fi
fi

# Start stats logger in background; it will stop when MAIN_PID exits or STOP_FLAG appears
bash "${SCRIPT_DIR}/_linux_run-test-stats-logger.sh" "${STATS_LOG_FILE}" "${MAIN_PID}" "${STOP_FLAG}" &
LOGGER_PID=$!

# Wait for main to finish
wait "${MAIN_PID}" || true

# Signal logger to stop; give it a moment to exit
touch "${STOP_FLAG}" || true
sleep 2
rm -f "${STOP_FLAG}" || true

# Ensure logger exited
if kill -0 "${LOGGER_PID}" 2>/dev/null; then
  kill "${LOGGER_PID}" 2>/dev/null || true
fi

echo "[OK] Concluído. Veja os logs gerados."
