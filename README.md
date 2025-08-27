# Guia de Comandos — `node-fastfly-backend-2025`

> Cole este conteúdo no seu **README.md**. Ele reúne os comandos essenciais com explicações curtas, variações por sistema operacional e alertas úteis.

---

## Sumário
1. [Clonar o repositório](#1-clonar-o-repositório)
2. [Ajustar portas efêmeras TCP (Windows)](#2-ajustar-portas-efêmeras-tcp-windows)
3. [Derrubar containers, redes e volumes](#3-derrubar-containers-redes-e-volumes)
4. [Subir a stack com Docker Compose](#4-subir-a-stack-com-docker-compose)
5. [Monitorar uso de recursos](#5-monitorar-uso-de-recursos)
6. [Entrar na pasta do Gatling](#6-entrar-na-pasta-do-gatling)
7. [Resetar o banco e rodar a simulação (Gatling)](#7-resetar-o-banco-e-rodar-a-simulação-gatling)
8. [Atualizar o projeto (sincronizar com o remoto)](#8-atualizar-o-projeto-sincronizar-com-o-remoto)
9. [Notas importantes](#9-notas-importantes)

---

## 1) Clonar o repositório
Cria uma **cópia completa** do repositório (histórico, branches, tags) em uma pasta com o mesmo nome do repo.

```bash
git clone https://github.com/leobravoe/node-fastfly-backend-2025.git
```

**Dicas**
```bash
# Clonar apenas a branch principal
git clone --branch main --single-branch https://github.com/leobravoe/node-fastfly-backend-2025.git

# Clonar raso (mais rápido)
git clone --depth=1 https://github.com/leobravoe/node-fastfly-backend-2025.git
```

---

## 2) Ajustar portas efêmeras TCP (Windows)
Redefine a **faixa de portas efêmeras** (usadas para conexões de saída). Útil em cargas com muitas conexões (Gatling/NGINX) para evitar “exhaustion”.> Execute **CMD como Administrador**.

```cmd
netsh int ipv4 set dynamicport tcp start=10000 num=55535
```
Verifique a configuração atual:
```cmd
netsh int ipv4 show dynamicport tcp
```

---

## 3) Derrubar containers, redes e volumes
Para e remove **containers, redes e volumes** da composição (atenção: apaga dados dos volumes).

```bash
# Docker Compose v1 (legado)
docker-compose down -v

# Docker Compose v2 (recomendado)
docker compose down -v
```
> 💡 Use `--remove-orphans` para remover serviços “sobrando” de composições antigas.

---

## 4) Subir a stack com Docker Compose
Sobe os serviços em **modo detached** e recompila imagens quando necessário.

```bash
# v1 (legado)
docker-compose up -d --build

# v2 (recomendado) — aplica limites definidos em deploy.resources com compatibilidade
docker compose --compatibility up -d --build
```
> 💡 `--compatibility` faz o Compose traduzir os limites do bloco `deploy:` para flags de runtime.

---

## 5) Monitorar uso de recursos
Acompanha CPU, memória, rede e I/O em tempo real por container.

```bash
docker stats                # streaming contínuo
docker stats --no-stream    # apenas um snapshot
docker stats postgres app1  # filtra por nome
```

---

## 6) Entrar na pasta do Gatling
```bash
cd gatling
# Windows PowerShell: cd .\gatling
```

---

## 7) Resetar o banco e rodar a simulação (Gatling)
**Windows (CMD):** reseta tabelas via `psql` no container `postgres` e, se der certo, executa a simulação.

```cmd
docker exec postgres psql -U postgres -d postgres_api_db -v ON_ERROR_STOP=1 ^
  -c "TRUNCATE TABLE transactions" ^
  -c "UPDATE accounts SET balance = 0" ^
  && .\mvnw.cmd gatling:test -Dgatling.simulationClass=simulations.RinhaBackendCrebitosSimulation
```

**PowerShell (use crase para quebra de linha):**
```powershell
docker exec postgres psql -U postgres -d postgres_api_db -v ON_ERROR_STOP=1 `
  -c "TRUNCATE TABLE transactions" `
  -c "UPDATE accounts SET balance = 0" `
  ; if ($LASTEXITCODE -eq 0) { ./mvnw.cmd gatling:test -Dgatling.simulationClass=simulations.RinhaBackendCrebitosSimulation }
```

**Linux/macOS (bash):** agrupe em transação para atomicidade.
```bash
docker exec postgres psql -U postgres -d postgres_api_db -v ON_ERROR_STOP=1   -c "BEGIN; TRUNCATE TABLE transactions; UPDATE accounts SET balance = 0; COMMIT;" && ./mvnw gatling:test -Dgatling.simulationClass=simulations.RinhaBackendCrebitosSimulation
```

---

## 8) Atualizar o projeto (sincronizar com o remoto)
Sequência **determinística** (deixa seu repositório idêntico ao remoto, descartando mudanças locais):

```bash
git fetch --all
git switch main            # ou: git checkout main
git reset --hard origin/main
git clean -fdx             # cuidado: remove também arquivos ignorados
```

Comandos individuais (explicação rápida):

**`git reset --hard`** — reposiciona o branch atual para um commit e **descarta TODAS** as mudanças locais no working tree e no index.
```bash
git reset --hard           # para o último commit local
git reset --hard origin/main
```

**`git clean -fd`** — remove **arquivos e pastas não rastreados**.
```bash
git clean -fd              # força remoção
git clean -fdn             # "dry run" (mostra o que seria removido)
git clean -fdx             # inclui arquivos ignorados (ex.: node_modules, builds)
```

**`git pull`** — baixa e integra alterações do remoto ao branch atual.
```bash
git pull                   # estratégia padrão (merge)
git pull --rebase          # mantém histórico linear (recomendado)
git pull origin main       # especifica remoto e branch
```

---

## 9) Notas importantes
- **Compose v2**: prefira `docker compose` (sem hífen). `docker-compose` é o binário v1 (legado).
- Para que **limites de CPU/memória** do bloco `deploy:` funcionem fora do Swarm, rode com `--compatibility`:
  ```bash
  docker compose --compatibility up -d --build
  ```
- **Cuidado ao usar `-v` no down**: remove volumes e **apaga dados persistidos** (ex.: `pgdata` do Postgres).
- Se estiver em **Windows**, execute terminais como **Administrador** quando alterar portas efêmeras (`netsh`).

---

> Em caso de erros de performance (502, timeouts, “Premature close”), verifique `docker stats`, logs do NGINX/app e o banco (locks/conexões). Ajustes típicos: aumentar memória dos apps, habilitar keep-alive no NGINX para upstreams e dimensionar o pool de conexões do Postgres.
