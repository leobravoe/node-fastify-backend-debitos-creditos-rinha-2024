1. O comando git clone https://github.com/leobravoe/node-fastfly-backend-2025.git cria uma cópia local completa do repositório remoto hospedado no GitHub no endereço especificado, incluindo todo o histórico de commits, branches e arquivos, permitindo ao usuário trabalhar no projeto em sua máquina:
   ```bash
   git clone https://github.com/leobravoe/node-fastfly-backend-2025.git
   ```

2. O comando copy .\app\.env.example .\app\.env no Windows copia o arquivo .env.example localizado na pasta app para um novo arquivo chamado .env na mesma pasta, geralmente usado para criar rapidamente um arquivo de configuração com variáveis de ambiente a partir de um modelo de exemplo:
   ```bash
   copy .\app\.env.example .\app\.env
   ```

3. O comando docker-compose down -v para e remove todos os containers e redes definidos no docker-compose.yml, além de remover também os volumes associados (incluindo os dados persistentes neles), ao contrário de docker-compose down sem -v, que mantém os volumes intactos:

   ```bash
   docker-compose down -v
   ```

4. O comando docker-compose up --build cria e inicia os containers definidos no docker-compose.yml, forçando a reconstrução das imagens mesmo que já existam em cache, garantindo que quaisquer alterações no Dockerfile ou no contexto de build sejam aplicadas antes de subir os serviços:
   ```bash
   docker-compose up -d --build
   ```

Com o projeto configurado, para atualizar:

1. O comando git reset --hard move o ponteiro do branch atual para um commit específico (ou para o último commit se nenhum for especificado) e descarta todas as alterações locais no diretório de trabalho e no índice (staging area), revertendo completamente os arquivos para o estado exato do commit alvo, apagando modificações não commitadas de forma irreversível:

   ```bash
   git reset --hard
   ```

2. O comando git clean -fd força a remoção de todos os arquivos e diretórios não rastreados no repositório local, ou seja, apaga itens que não estão versionados pelo Git, como arquivos temporários ou pastas criadas manualmente, deixando o diretório de trabalho limpo apenas com os arquivos rastreados:

   ```bash
   git clean -fd
   ```

3. O comando git pull baixa as alterações mais recentes do branch correspondente em um repositório remoto e as integra automaticamente ao branch atual local, atualizando os arquivos e o histórico para refletir o estado mais recente do projeto compartilhado:
   ```bash
   git pull
   ```
