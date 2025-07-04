1. Clone o repositório:

   ```bash
   git clone https://github.com/leobravoe/node-fastfly-backend-2025.git
   ```

2. Crie o arquivo .env

   ```bash
   copy ./app/.env.example ./app/.env
   ```

3. Entre na pasta:

   ```bash
   cd node-fastfly-backend-2025/app
   ```

4. Utilize o comando para baixar os pacotes do composer.json:
   ```bash
   npm update --save
   ```

5. Levante os containers e construa a aplicação:
   ```bash
   docker-compose up --build
   ```

Com o projeto configurado, para atualizar:

1. Limpa para o commit mais atual

   ```bash
   git clean -fd
   ```

2. Reinicia para o commit mais atual

   ```bash
   git reset --hard
   ```

3. Baixe a atualização
   ```bash
   git pull
   ```
