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
# Aqui pegamos Node.js em Alpine Linux (imagem minúscula, inicialização rápida e menos CVEs).
# Manter a base enxuta reduz download, tempo de build e consumo de disco.
FROM node:25-alpine

# [ETAPA 2/7] FERRAMENTAS PARA COMPILAR DEPENDÊNCIAS NATIVAS
# Alguns pacotes do ecossistema Node (ex.: `pg-native`) contêm trechos em C/C++.
# Para que eles funcionem, a imagem precisa ter compiladores e headers disponíveis no build.
# `apk` é o gerenciador do Alpine; `--no-cache` evita guardar metadados, mantendo a camada pequena.
# - build-base: compilações C/C++ (gcc, g++, make)
# - python3: utilitário exigido pelo node-gyp durante o build
# - postgresql-dev: headers do Postgres necessários para bindings nativos
# - curl: útil em verificações e scripts (opcional, mas prático em pipelines)
RUN apk add --no-cache \
    build-base \
    python3 \
    postgresql-dev \
    curl

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
# Menos conteúdo = imagem menor e startup mais previsível em produção.
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