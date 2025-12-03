# =====================================================================================
# DOCKERFILE — GUIA COMENTADO PARA INICIANTES (VERSÃO DIDÁTICA)
# -------------------------------------------------------------------------------------
# Este arquivo descreve, passo a passo, como construir uma imagem do seu app Node.js
# pronta para rodar em qualquer lugar. Leia os comentários ANTES de cada instrução:
# eles explicam o que cada linha faz, por que existe e como isso impacta performance,
# tamanho da imagem e previsibilidade do build.
# =====================================================================================

# [ETAPA 1/7] BASE DA IMAGEM
# A diretiva `FROM` escolhe um “sistema operacional + runtime” de partida.
# Aqui usamos Node.js 25.2.1 sobre Alpine 3.22 (`node:25.2.1-alpine3.22`), uma combinação
# enxuta que reduz o tamanho da imagem, acelera download e tende a ter menos CVEs.
FROM node:25.2.1-alpine3.22

# [ETAPA 2/7] FERRAMENTAS PARA COMPILAR DEPENDÊNCIAS NATIVAS
# Alguns pacotes do ecossistema Node (ex.: `pg-native`) contêm trechos em C/C++.
# Para que eles funcionem, a imagem precisa ter compiladores e headers disponíveis no build.
# `apk` é o gerenciador do Alpine; `--no-cache` evita guardar metadados, mantendo a camada pequena.
# As versões abaixo estão fixadas para garantir builds reprodutíveis sobre Alpine 3.22:
# - build-base=0.5-r3           → toolchain C/C++ (gcc, g++, make)
# - python3=3.12.12-r0          → exigido por node-gyp e scripts de build
# - postgresql17-dev=17.7-r0    → headers do PostgreSQL 17 para bindings nativos
# - curl=8.14.1-r2              → útil em verificações e scripts
# - pg_activity=3.5.1-r0        → ferramenta de monitoramento do PostgreSQL (útil para debug/benchmarks)
RUN apk add --no-cache \
    build-base=0.5-r3 \
    python3=3.12.12-r0 \
    postgresql17-dev=17.7-r0 \
    curl=8.14.1-r2 \
    pg_activity=3.5.1-r0

# [ETAPA 3/7] DIRETÓRIO DE TRABALHO
# `WORKDIR` cria (se não existir) e define a pasta onde os próximos comandos vão rodar.
# Pense como um “cd /usr/src/app”. Centralizar tudo aqui facilita copiar arquivos e rodar o app.
WORKDIR /usr/src/app

# [ETAPA 4/7] APROVEITANDO O CACHE DO DOCKER (DEPENDÊNCIAS PRIMEIRO)
# Copiar apenas `package.json`/`package-lock.json` primeiro é um padrão de ouro:
# se o código da aplicação mudar mas as dependências não, o Docker reutiliza a camada
# do `npm install` e o build fica MUITO mais rápido. Garanta também um `.dockerignore`
# que exclua `node_modules` e `.git` para não inflar a imagem.
COPY ./app/package*.json ./

# [ETAPA 5/7] INSTALAÇÃO DE DEPENDÊNCIAS DE PRODUÇÃO
# `npm install --omit=dev` traz só o que o app precisa para RODAR (sem ferramentas de dev).
# É aqui que as dependências nativas são compiladas usando os pacotes instalados acima.
# As versões das libs Node são controladas pelo `package-lock.json`, garantindo reprodutibilidade.
RUN npm install --omit=dev

# [ETAPA 6/7] CÓDIGO DA APLICAÇÃO
# Agora que as libs já estão instaladas (e cacheadas), copiamos o restante do código.
# Assim, mudanças em `*.js` não invalidam a camada custosa do `npm install`.
# Estrutura típica esperada: os arquivos da app estão em `./app` no host.
COPY ./app ./

# [ETAPA 7/7] COMANDO PADRÃO DE EXECUÇÃO
# `CMD` define o que o contêiner vai rodar quando “der play”.
# A forma em array evita que o shell interprete caracteres especiais (é mais segura).
# Como o `WORKDIR` já aponta para `/usr/src/app`, o Node encontra o `index.js` facilmente.
CMD [ "node", "index.js" ]
