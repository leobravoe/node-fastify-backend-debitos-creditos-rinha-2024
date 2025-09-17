# ======================================================================
# Dockerfile — Aplicação Node.js com dependências nativas (pg-native)
# ======================================================================
# Objetivo:
# - Build de uma imagem minimalista baseada em Debian slim com Node.js;
# - Instalar toolchain para compilar addons nativos (node-gyp) e libpq
#   para o driver PostgreSQL nativo;
# - Instalar dependências de produção e rodar a app.
#
# Observações importantes (não alteram o Dockerfile, apenas orientam):
# - Versões: em pipelines estáveis, prefira fixar uma tag precisa
#   (ex.: node:21.7-slim ou LTS como node:22-slim) para evitar surpresas.
# - Cache: manter COPY package*.json antes do COPY do código melhora cache
#   do 'npm install' quando apenas o código muda.
# - .dockerignore: certifique-se de ignorar node_modules, logs, testes, etc.
# - Multistage: caso queira reduzir ainda mais, você pode compilar em um
#   estágio builder e copiar apenas o que precisa para a imagem final.
# ======================================================================

# Use a imagem base do Node.js (a versão pode variar)
FROM node:21-slim

# ----------------------------------------------------------------------
# Instala as dependências necessárias para compilar addons nativos
# - build-essential: compilador C/C++, make, etc. (usado por node-gyp)
# - python3: requisito do node-gyp (scripts de build)
# - libpq-dev: headers/bibliotecas de desenvolvimento do PostgreSQL
#              (pg-native precisa para linkar contra libpq)
#
# Notas:
# - Mantemos tudo em uma única camada RUN para reduzir o número de layers.
# - Limpamos /var/lib/apt/lists para reduzir o tamanho final da imagem.
# - Em ambientes que prezam por imagens menores ainda, considere
#   '--no-install-recommends' no apt-get install.
# ----------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------
# Define o diretório de trabalho dentro do container.
# - Todas as instruções subsequentes (COPY, RUN, CMD) ocorrem relativas aqui.
# - Boas práticas: escolha um caminho estável e não muito profundo.
# ----------------------------------------------------------------------
WORKDIR /usr/src/app

# ----------------------------------------------------------------------
# Copia apenas os manifests do NPM primeiro para maximizar o cache do Docker.
# - Se apenas o código mudar (e não as dependências), o passo de 'npm install'
#   será reutilizado do cache, acelerando o build.
# - Mantemos o padrão 'package*.json' para cobrir tanto package.json quanto
#   package-lock.json.
# ----------------------------------------------------------------------
# Copia o package.json e package-lock.json
COPY package*.json ./

# ----------------------------------------------------------------------
# Instala as dependências de produção.
# - '--omit=dev' evita instalar devDependencies, reduzindo o tamanho da imagem.
# - Se você usa package-lock.json, 'npm ci --omit=dev' garante builds mais
#   determinísticos (mas exige lockfile compatível com a versão do npm).
# - Este passo também compila os módulos nativos (ex.: pg-native) usando
#   as toolchains instaladas acima.
# ----------------------------------------------------------------------
# Instala as dependências, incluindo o pg-native que seria compilado aqui
RUN npm install --omit=dev

# ----------------------------------------------------------------------
# Copia o restante do código da aplicação.
# - Garanta que seu .dockerignore exclua arquivos não necessários (ex.: .git,
#   node_modules, caches, testes) para diminuir o contexto de build.
# ----------------------------------------------------------------------
# Copia o resto do código da aplicação
COPY . .

# ----------------------------------------------------------------------
# Define o comando padrão do container.
# - Mantemos 'node index.js' simples, delegando configuração (PORT, etc.)
#   a variáveis de ambiente e ao orquestrador (Compose/K8s).
# - Em produção, é comum definir 'NODE_ENV=production' (via ENV ou no runtime).
# ----------------------------------------------------------------------
# Use o caminho relativo ao WORKDIR
CMD [ "node", "index.js" ]
