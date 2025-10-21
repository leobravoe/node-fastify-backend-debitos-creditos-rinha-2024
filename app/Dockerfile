# ======================================================================
# Dockerfile — Aplicação Node.js com dependências nativas (pg-native)
# ======================================================================
#
# O QUE É ESTE ARQUIVO?
# Este é um "Dockerfile", um arquivo de texto com instruções, como uma
# receita de bolo. Ele ensina o Docker a "montar" uma imagem
# (uma "foto" do seu aplicativo) que pode ser executada em qualquer lugar.
#
# OBJETIVO DESTA "RECEITA":
# 1. Criar uma imagem (um "mini-computador") leve com Node.js.
# 2. Instalar ferramentas de construção (como martelo e serra).
# 3. Usar essas ferramentas para "montar" pacotes Node.js especiais
#    (chamados "addons nativos", como o 'pg-native' para Postgres).
# 4. Instalar somente os pacotes de produção e iniciar a aplicação.
#
# DICAS PARA INICIANTES:
# - Versões: Usar "node:22-alpine" é bom, mas em projetos sérios,
#   é melhor "travar" a versão (ex: "node:22.7.0-alpine") para
#   evitar que seu build quebre quando uma nova versão do Node sair.
#
# - Cache (Velocidade): O Docker constrói em "camadas". Se uma camada
#   não muda, o Docker a reutiliza, tornando o build muito mais rápido.
#   Vamos usar isso a nosso favor copiando o 'package.json' primeiro.
#
# - .dockerignore: Crie um arquivo chamado ".dockerignore" na mesma
#   pasta do seu 'docker-compose.yml'. Coloque "node_modules" e ".git"
#   lá. Isso impede o Docker de copiar essas pastas para dentro da
#   imagem, o que a deixaria lenta e GIGANTE.
#
# ======================================================================

# PASSO 1: A BASE
# Todo Dockerfile começa com "FROM". Estamos dizendo ao Docker:
# "Comece com um 'mini-computador' que já tenha o Node.js instalado."
# A versão "alpine" é famosa por ser extremamente pequena e segura.
FROM node:22-alpine

# ----------------------------------------------------------------------
# PASSO 2: INSTALANDO FERRAMENTAS DE CONSTRUÇÃO
#
# Por que precisamos disso?
# Pacotes Node.js como 'pg-native' são "nativos". Eles não vêm
# prontos. Eles precisam ser "compilados" (construídos) dentro
# do container para funcionar corretamente.
#
# Para construir, precisamos de ferramentas:
# - 'build-base': Um pacote que inclui compiladores (C/C++) e 'make'.
# - 'python3': A ferramenta de build do Node ('node-gyp') precisa de Python.
# - 'postgresql-dev': Os "manuais de instrução" (headers) do PostgreSQL.
#   O 'pg-native' lê isso para saber como se comunicar com o Postgres.
#
# O Comando:
# 'apk' é o gerenciador de pacotes do Alpine (como apt-get no Ubuntu).
# '--no-cache' garante que a imagem final fique pequena, sem
# guardar arquivos temporários de instalação.
# ----------------------------------------------------------------------
RUN apk add --no-cache \
    build-base \
    python3 \
    postgresql-dev

# ----------------------------------------------------------------------
# PASSO 3: DEFININDO NOSSO ESPAÇO DE TRABALHO
#
# O 'WORKDIR' (Working Directory) faz duas coisas:
# 1. Cria a pasta '/usr/src/app' dentro do container (se ela não existir).
# 2. Define essa pasta como o nosso diretório padrão.
#
# Pense nisso como: "crie a pasta e dê 'cd /usr/src/app'".
# Todos os comandos 'COPY', 'RUN', etc., a partir de agora,
# acontecerão dentro desta pasta.
# ----------------------------------------------------------------------
WORKDIR /usr/src/app

# ----------------------------------------------------------------------
# PASSO 4: O TRUQUE DO CACHE (COPIANDO O package.json)
#
# Este é o passo mais importante para um build rápido!
#
# Em vez de copiar todo o nosso código, copiamos *apenas* os arquivos
# 'package.json' e 'package-lock.json'.
#
# POR QUÊ?
# No próximo passo (npm install), o Docker criará uma camada de cache.
# Se no futuro você mudar seu 'index.js' (código) mas NÃO mudar
# o 'package.json' (dependências), o Docker vai pular o 'npm install'
# (que é super lento) e reutilizar a camada pronta.
#
# O CAMINHO:
# 'COPY ./app/package*.json ./' significa:
#   - De: './app/package.json' (no seu computador)
#   - Para: './' (que é o nosso WORKDIR, ou seja, '/usr/src/app/' no container)
#
# (Nota: O './app/' vem do 'context: .' no seu docker-compose.yml)
# ----------------------------------------------------------------------
COPY ./app/package*.json ./

# ----------------------------------------------------------------------
# PASSO 5: INSTALANDO AS DEPENDÊNCIAS
#
# Agora que o 'package.json' está lá, podemos instalar.
#
# '--omit=dev': Diz ao NPM: "Ignore as 'devDependencies'".
# Na imagem final, não precisamos de ferramentas de teste, lint, etc.
# Queremos apenas o necessário para a aplicação RODAR (produção).
#
# É AQUI que o 'pg-native' será compilado usando as ferramentas
# que instalamos no PASSO 2.
# ----------------------------------------------------------------------
RUN npm install --omit=dev

# ----------------------------------------------------------------------
# PASSO 6: COPIANDO O CÓDIGO DA APLICAÇÃO
#
# Agora que as dependências (a parte lenta) estão instaladas e cacheadas,
# finalmente copiamos o resto do código da nossa aplicação.
#
# O CAMINHO:
# 'COPY ./app ./' significa:
#   - De: './app/' (a pasta inteira no seu computador)
#   - Para: './' (o WORKDIR, '/usr/src/app/' no container)
#
# Isso copiará 'index.js' e qualquer outro arquivo de './app'
# para dentro de '/usr/src/app'.
# (Não se esqueça do .dockerignore para pular 'node_modules'!)
# ----------------------------------------------------------------------
COPY ./app ./

# ----------------------------------------------------------------------
# PASSO 7: O COMANDO FINAL
#
# 'CMD' define o comando padrão que o container executará
# assim que ele for iniciado.
#
# [ "node", "index.js" ] é a forma segura de dizer:
# "Execute o comando 'node index.js'"
#
# Como nosso WORKDIR é '/usr/src/app', ele encontrará o 'index.js'
# que acabamos de copiar. A aplicação vai iniciar!
# ----------------------------------------------------------------------
CMD [ "node", "index.js" ]