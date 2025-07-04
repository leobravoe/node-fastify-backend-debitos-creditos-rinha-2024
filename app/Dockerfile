# ------------------------------------------------------------
# Um Dockerfile é um arquivo de texto com instruções para o Docker
# construir uma imagem de container. Ele especifica, em etapas claras,
# qual sistema operacional base usar, quais dependências instalar,
# quais arquivos da aplicação copiar para dentro da imagem
# e qual comando rodar ao iniciar o container.
# Em essência, ele automatiza e padroniza a criação de um ambiente pronto
# para executar a aplicação, garantindo que funcione da mesma forma
# em qualquer lugar que use Docker.
# ------------------------------------------------------------



# ------------------------------------------------------------
# Usamos uma imagem oficial do Node.js versão 18 como base.
# Essa imagem já vem com o Node.js e o NPM instalados,
# e é baseada no Debian (ou similar), permitindo o uso de apt-get.
# ------------------------------------------------------------
FROM node:18

# ------------------------------------------------------------
# Instala o cliente de linha de comando do PostgreSQL.
# Isso é útil para rodar comandos psql para testes ou scripts,
# mesmo que a aplicação use um driver NPM para se conectar.
#
# - apt-get update: atualiza a lista de pacotes
# - apt-get install: instala o postgresql-client
# - rm -rf /var/lib/apt/lists/*: limpa o cache para reduzir o tamanho da imagem
# ------------------------------------------------------------
RUN apt-get update && apt-get install -y postgresql-client && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# Define o diretório de trabalho no container.
# Todos os comandos seguintes são executados relativos a /app.
# ------------------------------------------------------------
WORKDIR /app

# ------------------------------------------------------------
# Copia apenas os arquivos de manifesto de dependências.
# - package.json
# - package-lock.json (ou yarn.lock)
#
# Isso permite aproveitar o cache do Docker para o npm install
# evitando reinstalar pacotes se apenas o código mudar.
# ------------------------------------------------------------
COPY package*.json ./

# ------------------------------------------------------------
# Atualiza as dependências do projeto para as versões mais recentes
# permitidas pelo package.json.
#
# Observação importante:
# - npm update não é o mesmo que npm install
# - Em produção, geralmente se prefere npm install para builds mais previsíveis.
# ------------------------------------------------------------
RUN npm update --save

# ------------------------------------------------------------
# Copia todos os outros arquivos da aplicação para o container.
# Isso inclui o código-fonte, scripts, assets e outros recursos necessários.
# ------------------------------------------------------------
COPY . .

# ------------------------------------------------------------
# Torna o script wait-for-it.sh executável.
# Este script é usado para "esperar" até outro serviço (como o banco de dados)
# estar pronto para conexões antes de iniciar a aplicação.
#
# Em seguida, move o script para um local no PATH (/usr/local/bin)
# permitindo chamá-lo de qualquer lugar sem precisar do caminho relativo.
# ------------------------------------------------------------
RUN chmod +x wait-for-it.sh && mv wait-for-it.sh /usr/local/bin/wait-for-it.sh

# ------------------------------------------------------------
# Expõe a porta 3000 no container, que é onde o servidor Node.js escutará.
# Essa instrução é apenas informativa para o Docker, o mapeamento real é feito no docker run ou compose.
# ------------------------------------------------------------
EXPOSE 3000

# ------------------------------------------------------------
# Define o comando padrão para quando o container iniciar.
#
# Usa bash para executar o wait-for-it.sh, passando o host do banco de dados "postgres".
# O script espera o banco ficar pronto antes de rodar "npm run start" para iniciar o servidor.
# Isso previne erros de conexão por tentar acessar o banco antes dele estar disponível.
# ------------------------------------------------------------
CMD ["bash", "/usr/local/bin/wait-for-it.sh", "postgres", "--", "npm", "run", "start"]
