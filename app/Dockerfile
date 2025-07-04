FROM node:18

# Instala cliente PostgreSQL
RUN apt-get update && apt-get install -y postgresql-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Torna o script executável e move para um local no PATH
RUN chmod +x wait-for-it.sh && mv wait-for-it.sh /usr/local/bin/wait-for-it.sh

EXPOSE 3000

# Força o uso do bash para rodar o script corretamente
CMD ["bash", "/usr/local/bin/wait-for-it.sh", "postgres", "--", "npm", "run", "start"]

