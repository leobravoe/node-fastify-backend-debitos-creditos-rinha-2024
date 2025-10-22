'use strict'; 
// 👉 'use strict'; ativa o "modo estrito" do JavaScript.
// É como dizer ao JavaScript: "Seja mais rigoroso comigo!".
// Ele ajuda a pegar erros comuns mais cedo (como usar uma variável
// sem declará-la) e torna o código mais seguro. É uma ótima prática!

// =================================================================================================
// index.js — Versão comentada, passo a passo, para iniciantes
// =================================================================================================
//
// O QUE ESTE ARQUIVO FAZ? (A VISÃO GERAL)
//
// 1. Inicia um servidor web (API) usando 'Fastify', um framework Node.js
//    famoso por ser muito rápido.
//
// 2. Conecta-se a um banco de dados PostgreSQL. Nós usamos o 'pg-native',
//    que é uma "ponte" direta e mais rápida para o Postgres.
//
// 3. Cadastra "funções inteligentes" (chamadas Stored Procedures) dentro
//    do próprio banco de dados.
//
// 4. Expõe duas "rotas" (endpoints) que o mundo exterior pode acessar:
//
//    - GET  /clientes/:id/extrato
//      (Pede ao banco: "Me dê o saldo e as 10 últimas transações deste cliente")
//
//    - POST /clientes/:id/transacoes
//      (Diz ao banco: "Execute esta transação de crédito ou débito para este cliente")
//
// FILOSOFIA DESTA ARQUITETURA (IMPORTANTE!)
//
// Pense no Node.js (este arquivo) como um "recepcionista" muito rápido.
// Ele não toma decisões de negócio complicadas.
//
// - O "recepcionista" (Node.js):
//   - Recebe o pedido (a requisição HTTP).
//   - Valida se o "formulário" do pedido está preenchido corretamente
//     (ex: o valor é um número? a descrição não é longa demais?).
//   - Se estiver tudo OK, ele passa o pedido para o "gerente" (o banco de dados).
//   - Pega a resposta do "gerente" e a entrega de volta ao cliente.
//
// - O "gerente" (Banco de Dados / PostgreSQL):
//   - Contém as "funções inteligentes" (PL/pgSQL) que nós criamos.
//   - É ele quem sabe a "regra de negócio" (ex: "um cliente não pode
//     ficar com saldo mais negativo que seu limite").
//   - Como ele faz tudo lá dentro, ele é muito rápido e garante que
//     ninguém "fure a fila" (evita problemas de concorrência).
//
// Esta arquitetura é ótima para performance!
// =================================================================================================


/* 1) IMPORTAÇÕES - AS "FERRAMENTAS" QUE VAMOS USAR */

// Importa o Fastify, nosso "motor" para o servidor web (API).
// { logger: false } desliga os logs automáticos de cada requisição.
// Em produção, isso economiza recursos. Para depurar, mude para 'true'.
const fastify = require('fastify')({ logger: false });

// Importa o cliente de PostgreSQL para Node.js.
// 'native' é a parte "nativa" do pacote 'pg'.
// Pense assim:
// - A versão normal ('pg') é escrita 100% em JavaScript.
// - A versão 'native' usa uma "ponte" (libpq) para falar com o Postgres
//   na linguagem C, o que é (geralmente) mais rápido em cenários de alta carga.
const { native } = require('pg');

// O 'Pool' é uma das ideias mais importantes aqui.
// Conectar ao banco de dados é uma operação LENTA (demora para "abrir a porta").
// Um "Pool" (Piscina) de Conexões é como um "chaveiro" que mantém
// várias "chaves" (conexões) já prontas.
// Quando precisamos falar com o banco, em vez de criar uma chave nova,
// nós "pegamos uma chave emprestada" do chaveiro.
// Quando terminamos, nós "devolvemos a chave". Isso é MUITO mais rápido.
const Pool = native.Pool;


/* 2) CONFIGURAÇÃO DO POOL (O "CHAVEIRO" DE CONEXÕES) */

// 'process.env' é como o Node.js lê "Variáveis de Ambiente".
// Pense nelas como "configurações" passadas de fora (ex: pelo Docker Compose).
// Aqui, definimos o número máximo de "chaves" no nosso chaveiro.
// Se a variável 'PG_MAX' não for definida, usamos 30 como padrão.
const PG_MAX = Number(process.env.PG_MAX ?? 30);

// Criamos a instância do nosso "chaveiro" (o Pool).
const pool = new Pool({
    // As credenciais para acessar o banco, lidas das variáveis de ambiente.
    host: process.env.DB_HOST,       // O endereço do servidor do banco (ex: 'postgres')
    user: process.env.DB_USER,       // O nome de usuário
    password: process.env.DB_PASSWORD, // A senha
    database: process.env.DB_DATABASE, // O nome do banco de dados específico

    // Configurações do "chaveiro":
    max: PG_MAX,                     // Quantas "chaves" (conexões) no máximo
    min: 5,
    idleTimeoutMillis: 20000,        // Se uma "chave" ficar 20s sem uso, ela é "reciclada"
});

// Ajustes finos no servidor HTTP do Fastify.
fastify.after(() => {
    // 'keepAliveTimeout' é quanto tempo o servidor espera por um novo
    // pedido do *mesmo cliente* na *mesma conexão* HTTP.
    // 60 segundos é um valor alto, bom para load balancers.
    fastify.server.keepAliveTimeout = 60000; // 60 segundos
});


/* 3) SQL DE INICIALIZAÇÃO (A "FUNDAÇÃO" DO NOSSO BANCO) */

// Por que rodar isso quando a aplicação inicia?
// Para garantir que a "fundação" (índices e funções) do nosso banco
// esteja exatamente como esperamos, antes de qualquer cliente usar a API.

// --- O ÍNDICE ---
// Pense em um índice de banco de dados como o índice de um livro.
// Sem índice, para achar um tópico, você teria que ler todas as páginas.
// Com índice, você vai direto para a página certa.
const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_account_id_id_desc ON transactions (account_id, id DESC);
`;
// O que isso faz?
// "IF NOT EXISTS": Não dá erro se o índice já existir.
// "ON transactions (account_id, id DESC)":
//   Cria um índice na tabela 'transactions' para acelerar buscas
//   filtrando por 'account_id' (um cliente) e ordenando por 'id DESC'
//   (da transação mais recente para a mais antiga).
//   Perfeito para a nossa rota de "extrato"!

// --- A FUNÇÃO DE BUSCAR EXTRATO ---
// 'PL/pgSQL' é uma linguagem que permite "programar" dentro do Postgres.
// Estamos criando uma "função inteligente" no banco.
const CREATE_EXTRACT_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION get_extrato(p_account_id INT)
RETURNS JSON AS $$
DECLARE
    account_info JSON;
    last_transactions JSON;
BEGIN
    -- 1. Busca as informações da conta (saldo, limite)
    --    e já formata como um objeto JSON.
    SELECT json_build_object(
        'total', balance,
        'limite', account_limit,
        'data_extrato', NOW()
    )
    INTO account_info
    FROM accounts
    WHERE id = p_account_id;

    -- 2. Se a conta não existir, 'account_info' será NULL.
    --    Nesse caso, paramos e retornamos NULL.
    IF account_info IS NULL THEN
        RETURN NULL;
    END IF;

    -- 3. Busca as 10 últimas transações e já as formata
    --    como um array JSON (usando 'json_agg').
    --    (Usamos o índice que criamos lá em cima!)
    SELECT json_agg(t_info)
    INTO last_transactions
    FROM (
        SELECT json_build_object(
            'valor', amount,
            'tipo', type,
            'descricao', description,
            'realizada_em', created_at
        ) as t_info
        FROM transactions
        WHERE account_id = p_account_id
        ORDER BY id DESC
        LIMIT 10
    ) sub;

    -- 4. Junta tudo em um único JSON de resposta.
    --    COALESCE(..., '[]'::json) é um truque para retornar um array
    --    vazio '[]' em vez de 'NULL' se o cliente não tiver transações.
    RETURN json_build_object(
        'saldo', account_info,
        'ultimas_transacoes', COALESCE(last_transactions, '[]'::json)
    );
END;
$$ LANGUAGE plpgsql;
`;
// VANTAGEM: O Node.js não precisa fazer duas queries separadas e
// "montar o quebra-cabeça". O banco já entrega o JSON pronto!

// --- A FUNÇÃO DE PROCESSAR TRANSAÇÃO ---
// Esta é a função mais importante. Ela é o "cérebro" do negócio.
const CREATE_TRANSACTION_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION process_transaction(
    p_account_id INT,
    p_amount INT,
    p_type CHAR,
    p_description VARCHAR(10)
)
RETURNS JSON AS $$
DECLARE
    response JSON;
BEGIN
    -- O 'WITH' (Common Table Expressions) nos permite criar "passos"
    -- que rodam em sequência.

    -- PASSO 1: Tentar ATUALIZAR o saldo da conta.
    WITH updated_account AS (
        UPDATE accounts
        -- Lógica de soma/subtração
        SET balance = balance + CASE WHEN p_type = 'c' THEN p_amount ELSE -p_amount END
        
        -- AQUI ESTÁ A REGRA DE NEGÓCIO CRÍTICA:
        WHERE id = p_account_id AND (
            p_type = 'c' OR -- Se for crédito ('c'), permite sempre.
            (balance - p_amount) >= -account_limit -- Se for débito ('d'), SÓ permite
                                                   -- se o novo saldo NÃO estourar o limite.
        )
        -- 'RETURNING' nos devolve os dados da linha que *acabou* de ser atualizada.
        RETURNING balance, account_limit
    ),
    -- PASSO 2: INSERIR a transação.
    inserted_transaction AS (
        -- Este INSERT SÓ VAI ACONTECER se o 'WITH updated_account'
        -- (Passo 1) tiver encontrado e atualizado uma linha.
        -- Se a conta não existiu ou se o limite estourou, o Passo 1
        -- não atualiza nada, e este INSERT é pulado.
        INSERT INTO transactions (account_id, amount, type, description)
        SELECT p_account_id, p_amount, p_type, p_description
        FROM updated_account -- A "mágica" está aqui!
        RETURNING 1
    )
    -- PASSO 3: Preparar a resposta.
    -- (Isto também só funciona se o 'updated_account' (Passo 1) funcionou)
    SELECT json_build_object('saldo', ua.balance, 'limite', ua.account_limit)
    INTO response
    FROM updated_account ua;

    -- Se 'response' for NULL, significa que o Passo 1 falhou
    -- (conta não existe ou limite estourou).
    IF response IS NULL THEN
        -- Retornamos um JSON de erro. O Node.js vai ler isso
        -- e saber que deve retornar um erro 422.
        RETURN '{"error": 1}'::json;
    END IF;

    -- Se deu tudo certo, 'response' contém o novo saldo e limite.
    RETURN response;
END;
$$ LANGUAGE plpgsql;
`;
// VANTAGEM: Esta função é "ATÔMICA" (Tudo ou Nada).
// Ou ela atualiza o saldo E insere a transação, ou ela não faz NADA.
// É impossível ficar em um estado "estranho" (ex: inserir a transação
// mas não atualizar o saldo). Fazer isso no banco é a forma mais
// segura de garantir consistência.


/* 4) ESQUEMA DE RESPOSTA (UMA OTIMIZAÇÃO DO FASTIFY) */

// O que é isso?
// É um "molde" que diz ao Fastify exatamente como a resposta JSON
// da rota de transação deve se parecer.
//
// Por que usar?
// O Fastify usa uma biblioteca super rápida (fast-json-stringify)
// que pré-compila uma função para transformar objetos JS em JSON.
// Se ele sabe o "molde" de antemão, ele consegue fazer isso
// de forma muito mais rápida do que o 'JSON.stringify()' padrão.
// Isso reduz o trabalho de "limpeza de memória" (Garbage Collector).
const transactionReplySchema = {
    schema: {
        response: {
            // Se o status for 200 (OK), a resposta DEVE ser
            // um objeto com 'limite' e 'saldo'.
            200: {
                type: 'object',
                properties: {
                    limite: { type: 'integer' },
                    saldo: { type: 'integer' },
                }
            }
        }
    }
};


/* 5) ROTA: GET /clientes/:id/extrato */
// ':id' é um parâmetro dinâmico na URL.

// 'async (request, reply)' é como o Fastify lida com rotas.
// 'request' tem os dados do pedido (parâmetros, body, headers).
// 'reply' é o objeto que usamos para enviar a resposta.
// 'async' nos permite usar 'await' para esperar operações
// demoradas (como falar com o banco).
fastify.get('/clientes/:id/extrato', async (request, reply) => {
    // request.params.id vem da URL (ex: /clientes/3 -> id é "3")
    // Parâmetros de URL são sempre strings, então convertemos para número.
    const id = Number(request.params.id);

    // --- VALIDAÇÃO "BARATA" (ANTES DE IR AO BANCO) ---
    // Checamos se o 'id' é um número inteiro válido (1 a 5,
    // conforme regra de negócio deste projeto).
    // Por que 1 a 5? É uma regra específica deste desafio de performance.
    // É uma "validação de sanidade" antes de gastar tempo de banco.
    if (!Number.isInteger(id) || id <= 0 || id > 5) {
        // Se for inválido, retornamos 404 (Não Encontrado).
        // Não adianta nem procurar no banco.
        return reply.code(404).send();
    }

    let client; // Variável para guardar a "chave" (conexão) do pool
    try {
        // --- Pegando a "chave" ---
        // 'await pool.connect()' pausa a função até que o "chaveiro"
        // nos entregue uma conexão livre.
        client = await pool.connect();

        // --- Executando a Query ---
        // Usamos um "Prepared Statement" (name/text/values).
        // Isso é CRUCIAL para segurança e performance.
        // - Segurança: Os 'values' (parâmetros) são enviados separados
        //   do 'text' (SQL), impedindo "SQL Injection".
        // - Performance: 'name: 'get-extrato'' diz ao Postgres: "Ei,
        //   lembre-se desta query. Se eu chamá-la de novo, você
        //   já sabe o plano de execução, só mude os valores."
        const result = await client.query({
            name: 'get-extrato',
            text: 'SELECT get_extrato($1) as extrato_json',
            values: [id] // $1 será substituído por 'id' de forma segura
        });

        // Pegamos o resultado. Nossa função retorna uma linha,
        // com uma coluna 'extrato_json' que já contém o JSON pronto.
        const extrato = result.rows[0].extrato_json;
        
        if (extrato === null) {
            // A função do banco retornou NULL (conta não existe).
            return reply.code(404).send();
        }
        
        // Sucesso! Enviamos o JSON que o banco nos deu.
        return reply.send(extrato);

    } catch (e) {
        // Se qualquer coisa der errado (ex: o banco caiu),
        // caímos no 'catch'.
        console.error("Erro no GET /extrato:", e);
        return reply.code(500).send(); // 500 = Erro Interno do Servidor

    } finally {
        // --- Devolvendo a "chave" ---
        // O bloco 'finally' SEMPRE executa, dando certo ou errado.
        // É CRÍTICO "devolver a chave" (conexão) para o "chaveiro" (pool).
        // Se esquecermos isso, as conexões vão acabar (vazamento de pool)
        // e a aplicação vai "congelar".
        if (client) client.release();
    }
});


/* 6) ROTA: POST /clientes/:id/transacoes */
// (Usamos 'transactionReplySchema' para otimizar a resposta)
fastify.post('/clientes/:id/transacoes', transactionReplySchema, async (request, reply) => {
    const id = Number(request.params.id);
    // 'request.body' é o JSON que o cliente enviou.
    // '?? {}' é um truque: se 'request.body' for nulo,
    // usamos um objeto vazio '{}' para evitar erros.
    const { valor, tipo, descricao } = request.body ?? {};

    // --- VALIDAÇÃO "BARATA" (ANTES DE IR AO BANCO) ---
    // Esta é a validação do "formulário" do nosso "recepcionista".
    // Verificamos se todos os campos vieram corretos.
    if (
        !Number.isInteger(id) || id <= 0 || id > 5 ||         // id válido (1..5)
        !Number.isInteger(valor) || valor <= 0 ||            // "valor" precisa ser inteiro e positivo
        (tipo !== 'c' && tipo !== 'd') ||                    // "tipo" só pode ser 'c' ou 'd'
        !descricao || typeof descricao !== 'string' ||       // "descricao" precisa existir e ser string
        descricao.length === 0 || descricao.length > 10      // "descricao" precisa ter de 1 a 10 chars
    ) {
        // 422 (Unprocessable Entity):
        // É o código HTTP para dizer: "Eu entendi seu pedido, mas
        // os dados que você me enviou (o 'body') estão errados
        // ou incompletos. Não posso processar."
        return reply.code(422).send();
    }

    let client;
    try {
        // Pegamos uma "chave" (conexão) do "chaveiro" (pool).
        client = await pool.connect();

        // --- Chamando o "Gerente" (a função do banco) ---
        // Nós não fazemos UPDATE ou INSERT aqui no Node.
        // Nós apenas chamamos a função 'process_transaction' que
        // criamos, e ela faz todo o trabalho pesado e seguro.
        const result = await client.query({
            name: 'process-transaction', // Reusa o plano de execução
            text: 'SELECT process_transaction($1, $2, $3, $4) as response_json',
            values: [id, valor, tipo, descricao] // Passa os dados
        });

        const response = result.rows[0].response_json;

        // Agora, verificamos a resposta do "gerente".
        if (response.error) {
            // A função do banco nos disse que deu erro (ex: limite estourado).
            // O banco já garantiu que NADA foi alterado (atomicidade).
            // Nós apenas repassamos o erro 422.
            return reply.code(422).send();
        }

        // Sucesso! A transação foi feita.
        // A 'response' já contém o JSON { limite, saldo }
        // que o banco nos mandou. O Fastify vai otimizar
        // o envio disso graças ao nosso 'transactionReplySchema'.
        return reply.send(response);

    } catch (e) {
        // Erro inesperado (banco caiu, etc.)
        console.error("Erro no POST /transacoes:", e);
        return reply.code(500).send();
    } finally {
        // CRÍTICO: Devolver a "chave" (conexão) ao "chaveiro" (pool).
        if (client) client.release();
    }
});


/* 7) INICIALIZAÇÃO DO SERVIDOR */

// Criamos uma função 'async' para poder usar 'await' nela.
const start = async () => {
    try {
        // --- 1. Preparar o Banco ---
        // Antes de qualquer coisa, vamos pegar UMA conexão
        // para rodar nossa "fundação" (SQLs de inicialização).
        const client = await pool.connect();
        console.log("Conectado ao banco de dados, preparando funções e índices...");

        // Rodamos os SQLs que definimos lá em cima.
        // 'IF NOT EXISTS' e 'OR REPLACE' garantem que isso
        // pode rodar várias vezes sem dar erro.
        await client.query(CREATE_INDEX_SQL);
        await client.query(CREATE_EXTRACT_FUNCTION_SQL);
        await client.query(CREATE_TRANSACTION_FUNCTION_SQL);

        // Devolvemos a conexão de setup.
        client.release();
        console.log("Banco de dados pronto.");

        // --- 2. Iniciar o Servidor Web ---
        // Só depois que o banco está PRONTO é que começamos
        // a "abrir a loja" (aceitar requisições HTTP).
        const port = Number(process.env.PORT) || 3000;

        // 'host: '0.0.0.0'' é importante.
        // Significa "escute em todas as interfaces de rede".
        // Em um container Docker, isso é essencial para que o
        // mundo exterior (o Nginx, por exemplo) possa se conectar.
        // Se usássemos 'localhost' (127.0.0.1), ele só aceitaria
        // conexões de *dentro* do próprio container.
        await fastify.listen({ port, host: '0.0.0.0' });
        
        console.log(`Servidor "recepcionista" rodando na porta ${port}`);

    } catch (err) {
        // Se algo der errado na INICIALIZAÇÃO (ex: não conseguiu
        // conectar no banco de jeito nenhum), não há o que fazer.
        console.error("Erro fatal ao iniciar a aplicação:", err);
        // 'process.exit(1)' encerra o programa com um código de erro.
        // Isso sinaliza ao Docker (ou outro orquestrador) que
        // a aplicação falhou em iniciar e precisa ser reiniciada.
        process.exit(1);
    }
};

// Finalmente, chamamos a função 'start' para ligar tudo.
start();