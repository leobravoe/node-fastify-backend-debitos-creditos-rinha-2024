# node-fastify-backend-2025

> Backend de alta performance com **Fastify + PostgreSQL + NGINX**, orquestrado por **Docker Compose** e com **Gatling** para testes de carga.

[![Docker](https://img.shields.io/badge/docker-ready-blue)](#)
[![Fastify](https://img.shields.io/badge/fastify-v5-black)](#)
[![PostgreSQL](https://img.shields.io/badge/postgres-16-blue)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## Sumário
- [Arquitetura](#arquitetura)
- [Stack & Pastas](#stack--pastas)
- [Pré-requisitos](#pré-requisitos)
- [Configuração (.env)](#configuração-env)
- [Primeiros passos](#primeiros-passos)
- [Comandos úteis](#comandos-úteis)
- [Testes de carga (Gatling)](#testes-de-carga-gatling)
- [Tuning & Troubleshooting](#tuning--troubleshooting)
- [Roadmap](#roadmap)
- [Contribuição](#contribuição)
- [Licença](#licença)

---

## Arquitetura

```
[ Client ] ⇄ [ NGINX (reverse proxy) ] ⇄ [ app1 | app2 ... ] ⇄ [ PostgreSQL ]
                         │
                         └──> Logs / Métricas / Healthchecks
```

- **NGINX** faz o balanceamento e mantém conexões keep-alive com os apps.
- **Apps** (Fastify) expõem endpoints REST com validação e schemas.
- **PostgreSQL** armazena os dados; migrations/seeds podem ser executados na subida.
- **Gatling** executa cenários de carga para validar throughput/latência.

> Dica: publique o OpenAPI (Swagger) para inspecionar e testar endpoints.

---

## Stack & Pastas

- **NGINX** (`/nginx`)
- **Aplicação** (`/app`)
- **Banco** (`/sql`)
- **Carga** (`/gatling`)
- **Infra/scripts**: `docker-compose.yml`, `_linux_*.sh`, `_win_*.ps1/.bat`

Estrutura sugerida em `app/`:
```
app/
  ├─ src/
  │   ├─ server.ts|js           # bootstrap do Fastify
  │   ├─ routes/                # definição das rotas
  │   ├─ controllers/handlers/  # lógica de entrada
  │   ├─ services/              # regras de negócio
  │   ├─ db/                    # conexão/queries, migrations
  │   └─ plugins/               # swagger, cors, helmet, env
  └─ package.json
```

---

## Pré-requisitos

- **Docker** e **Docker Compose v2**
- **Java 17+** (para Gatling via Maven Wrapper)
- **Node.js 20+** (apenas se for rodar a app fora de containers)

---

## Configuração (.env)

Crie um arquivo `.env` na raiz (ou em `app/`) usando este template:

```ini
# app
PORT=3000
NODE_ENV=development

# database
DB_HOST=postgres
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_DATABASE=postgres_api_db
PG_MAX=30            # pool máximo de conexões
```

> Recomenda-se validar o ambiente em runtime (ex.: `@fastify/env`/`env-schema`) e falhar cedo se algo estiver ausente.

---

## Primeiros passos

```bash
# 1) Subir toda a stack (NGINX, apps, Postgres)
docker compose --compatibility up -d --build

# 2) Ver logs (gerais ou filtrados)
docker compose logs -f
docker compose logs -f app1
docker compose logs -f postgres
```

**Parar e limpar volumes** (cuidado: apaga dados persistidos):
```bash
docker compose down -v
```

---

## Comandos úteis

**Estatísticas de consumo**:
```bash
docker stats                # streaming contínuo
docker stats --no-stream    # snapshot
docker stats postgres app1  # filtrar por nome
```

**Resetar banco + (opcional) rodar carga**:  
Linux/macOS (bash):
```bash
docker exec postgres psql -U postgres -d postgres_api_db -v ON_ERROR_STOP=1   -c "BEGIN; TRUNCATE TABLE transactions; UPDATE accounts SET balance = 0; COMMIT;"   && ./mvnw -q gatling:test -Dgatling.simulationClass=simulations.RinhaBackendCrebitosSimulation
```

Windows (PowerShell):
```powershell
docker exec postgres psql -U postgres -d postgres_api_db -v ON_ERROR_STOP=1 `
  -c "TRUNCATE TABLE transactions" `
  -c "UPDATE accounts SET balance = 0" `
; if ($LASTEXITCODE -eq 0) {
  ./mvnw.cmd -q gatling:test -Dgatling.simulationClass=simulations.RinhaBackendCrebitosSimulation
}
```

---

## Testes de carga (Gatling)

- Cenários em `/gatling` (Scala).  
- Executar via Maven Wrapper:
```bash
# Linux/macOS
./mvnw -q gatling:test -Dgatling.simulationClass=simulations.RinhaBackendCrebitosSimulation
# Windows
.\mvnw.cmd -q gatling:test -Dgatling.simulationClass=simulations.RinhaBackendCrebitosSimulation
```

Resultados: `gatling/target/gatling/**/index.html`

> Para evitar **exhaustion** de portas efêmeras no Windows, ajuste a faixa:
>
> ```cmd
> netsh int ipv4 set dynamicport tcp start=10000 num=55535
> ```

---

## Tuning & Troubleshooting

- **NGINX → Apps**: mantenha `keep-alive` e HTTP/1.1 para reuso de conexões.
- **Pool do Postgres** (`PG_MAX`): dimensione evitando over-subscription.
- **Healthchecks** no Compose: asseguram ordem de inicialização estável.
- **Erros 5xx / timeouts** sob carga:
  - verifique `docker stats` (CPU/memória/IO)
  - logs do NGINX e dos apps
  - locks/conexões no Postgres
- **Windows**: rode shell/terminais como Administrador ao alterar portas efêmeras.

---

## Roadmap

- [ ] Publicar OpenAPI (`@fastify/swagger` + UI)  
- [ ] Validar env e schemas de payload (Zod/JSON-Schema)  
- [ ] Healthchecks no `docker-compose.yml`  
- [ ] Observabilidade básica (Pino JSON + request-id + métricas)  
- [ ] CI (lint, build, testes, relatório de carga opcional)  
- [ ] LICENÇA e guia de contribuição

---

## Contribuição

1. Crie uma **issue** descrevendo a mudança.
2. Faça um **fork** e crie uma branch: `feat/nome-da-feature`.
3. **Commits** no padrão Conventional Commits.
4. Pull Request com descrição, screenshots (quando aplicável) e checklist.

---

## Licença

MIT — veja `LICENSE`.
