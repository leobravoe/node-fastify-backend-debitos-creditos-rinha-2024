# Use a imagem base do Node.js (a versão pode variar)
FROM node:21-slim

# Instala as dependências necessárias para compilar addons nativos
# - build-essential: Compilador C++, make, etc.
# - python3: Dependência do node-gyp, a ferramenta de build de addons do Node.
# - libpq-dev: Biblioteca de desenvolvimento do PostgreSQL, que o pg-native usa.
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copia o package.json e package-lock.json
COPY package*.json ./

# Instala as dependências, incluindo o pg-native que seria compilado aqui
RUN npm install --omit=dev

# Copia o resto do código da aplicação
COPY . .

# Porta padrão; pode ser sobrescrita por ENV PORT
ENV PORT=3000
EXPOSE 3000

# Use o caminho relativo ao WORKDIR
CMD [ "node", "index.js" ]