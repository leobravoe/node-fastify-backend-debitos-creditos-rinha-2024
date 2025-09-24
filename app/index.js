'use strict'; 
// 👉 "use strict" ativa o "modo estrito" do JavaScript.
// Ele ajuda a capturar erros cedo (por exemplo, usar variáveis sem declarar)
// e impede alguns comportamentos confusos do JS. É uma boa prática em projetos Node.

// =================================================================================================
// index.js — Versão comentada, passo a passo, para iniciantes
// =================================================================================================
//
// O que este arquivo faz?
// - Sobe um servidor HTTP com Fastify (um framework web rápido para Node.js).
// - Conecta no PostgreSQL usando o driver nativo (pg-native) para ter mais performance.
// - Cria/atualiza um índice e duas funções no banco (PL/pgSQL) para centralizar a lógica de negócio.
// - Expõe duas rotas HTTP:
//     GET  /clientes/:id/extrato     -> retorna saldo/limite e últimas 10 transações de um cliente
//     POST /clientes/:id/transacoes  -> registra crédito ("c") ou débito ("d") na conta do cliente
//
// Filosofia do projeto:
// - O Node aqui é uma “casca fina”: valida dados, chama UMA função no banco e devolve a resposta.
// - A lógica pesada (regras de saldo/limite, montar extrato) está no PostgreSQL.
//   Isso reduz idas/voltas de rede e melhora a consistência (o banco resolve tudo de forma atômica).
// =================================================================================================


/* 1) Importações e setup básico do servidor */
const fastify = require('fastify')({ logger: false });
// ^ Cria uma instância do servidor Fastify. Aqui desligamos o logger interno para ganhar desempenho.
//   (Se quiser ver logs em desenvolvimento, mude para { logger: true }).

const { native } = require('pg');
// ^ O pacote 'pg' é o cliente de PostgreSQL para Node. 'native' tenta usar a versão nativa (libpq),
//   que costuma ser mais rápida que a versão JS pura em cenários intensos.

const Pool = native.Pool;
// ^ Pool de conexões: mantém um conjunto de conexões abertas com o banco para reuso,
//   evitando o custo de abrir/fechar conexão a cada requisição.


/* 2) Configuração do Pool de Conexões */
// Lemos a quantidade máxima de conexões do ambiente (ou usamos 30 por padrão).
const PG_MAX = Number(process.env.PG_MAX ?? 30);

const pool = new Pool({
    // DICA: se a aplicação e o banco rodam na MESMA MÁQUINA, Unix Sockets podem ser mais rápidos
    // que TCP/IP. Ex.: host: '/var/run/postgresql'
    host: process.env.DB_HOST,         // endereço do banco (ex.: 'localhost' ou IP/hostname)
    user: process.env.DB_USER,         // usuário do banco
    password: process.env.DB_PASSWORD, // senha do usuário
    database: process.env.DB_DATABASE, // nome do banco
    max: PG_MAX,                       // máximo de conexões simultâneas no pool
    idleTimeoutMillis: 20000,          // após 20s ocioso, a conexão pode ser reciclada
});

// Ajustes finos do servidor HTTP após ele estar criado.
fastify.after(() => {
    // keepAliveTimeout controla quanto tempo a conexão HTTP fica aberta reaproveitável.
    // Aumentar pode ajudar em cenários de muitas requisições do mesmo cliente/load balancer.
    fastify.server.keepAliveTimeout = 60000; // 60 segundos
});


/* 3) SQL de inicialização (criado uma vez no start) */
// Por que fazer isso no start?
// - Garantimos que o índice e as funções do banco existem na inicialização da aplicação.
// - Em ambientes imutáveis/ephemerais (containers), isso poupa uma etapa manual.

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_account_id_id_desc ON transactions (account_id, id DESC);
`;
// ^ Índice composto para acelerar consultas das últimas transações de um cliente.
//   "IF NOT EXISTS" evita erro caso o índice já exista.
//   Ordenar por id DESC ajuda quando buscamos "as mais recentes primeiro".

const CREATE_EXTRACT_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION get_extrato(p_account_id INT)
RETURNS JSON AS $$
DECLARE
    account_info JSON;
    last_transactions JSON;
BEGIN
    -- Busca saldo, limite e data do extrato para o cliente informado.
    SELECT json_build_object(
        'total', balance,
        'limite', account_limit,
        'data_extrato', NOW()
    )
    INTO account_info
    FROM accounts
    WHERE id = p_account_id;

    -- Se não existe a conta, retorna NULL (a API traduzirá isso em 404).
    IF account_info IS NULL THEN
        RETURN NULL;
    END IF;

    -- Monta um array JSON com as 10 últimas transações do cliente (ordenadas da mais recente).
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

    -- Monta o JSON final do extrato: um objeto com "saldo" (outro objeto) e "ultimas_transacoes" (array).
    RETURN json_build_object(
        'saldo', account_info,
        'ultimas_transacoes', COALESCE(last_transactions, '[]'::json)
    );
END;
$$ LANGUAGE plpgsql;
`;
// ^ Função PL/pgSQL que devolve TUDO pronto em JSON.
//   Vantagem: a aplicação Node não precisa juntar pedacinhos; só repassa o JSON retornado.


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
    -- ATENÇÃO: toda a operação (atualizar saldo + inserir transação) é feita de forma atômica.
    -- Usamos CTEs (WITH ...) para encadear passos e só inserir se o UPDATE foi possível.

    WITH updated_account AS (
        UPDATE accounts
        SET balance = balance + CASE WHEN p_type = 'c' THEN p_amount ELSE -p_amount END
        -- Regras:
        -- - Crédito ('c'): soma no saldo.
        -- - Débito  ('d'): subtrai do saldo, mas só permite se NÃO estourar o limite.
        WHERE id = p_account_id AND (p_type = 'c' OR (balance - p_amount) >= -account_limit)
        RETURNING balance, account_limit
    ),
    inserted_transaction AS (
        -- Só insere a transação se o UPDATE acima aconteceu (ou seja, se a conta existia
        -- e se não estourou o limite em caso de débito).
        INSERT INTO transactions (account_id, amount, type, description)
        SELECT p_account_id, p_amount, p_type, p_description
        FROM updated_account
        RETURNING 1
    )
    SELECT json_build_object('saldo', ua.balance, 'limite', ua.account_limit)
    INTO response
    FROM updated_account ua;

    -- Se response ficou NULL, nada foi atualizado (conta inexistente ou débito inválido).
    IF response IS NULL THEN
        RETURN '{"error": 1}'::json; -- A aplicação interpretará isso como erro 422 (Unprocessable Entity).
    END IF;

    RETURN response; -- Caso ok, devolve saldo/limite atualizados.
END;
$$ LANGUAGE plpgsql;
`;
// ^ Essa função concentra a regra de negócio de crédito/débito.
//   Como roda no banco, evitamos "corridas" de concorrência do lado do app
//   e simplificamos MUITO a API (uma chamada = uma decisão consistente).


/* 4) Definição de esquema de resposta (Fastify) */
// Por que ter um "schema"?
// - O Fastify pode pré-compilar um serializador de JSON super rápido (fast-json-stringify).
// - Em cenários de alta carga, isso reduz trabalho do Garbage Collector e acelera respostas.
const transactionReplySchema = {
    schema: {
        response: {
            200: {
                type: 'object',
                properties: {
                    limite: { type: 'integer' },
                    saldo: { type: 'integer' },
                }
                // Dica: poderíamos marcar "required: ['limite','saldo']" para ser mais rigoroso.
            }
        }
    }
};


/* 5) Rota: GET /clientes/:id/extrato
   - Objetivo: retornar o extrato de um cliente (saldo/limite + últimas 10 transações).
   - Fluxo:
       1) Validar "id" (tem que ser inteiro de 1 a 5, conforme regra do desafio).
       2) Pegar uma conexão do pool.
       3) Executar a função get_extrato($1) com prepared statement (name: 'get-extrato').
       4) Se vier NULL -> 404 (não encontrado). Caso contrário, retorna o JSON.
*/
fastify.get('/clientes/:id/extrato', async (request, reply) => {
    const id = Number(request.params.id); // params sempre são strings -> convertemos para número.

    // Validações simples e baratas para evitar chamadas desnecessárias ao banco.
    if (!Number.isInteger(id) || id <= 0 || id > 5) {
        // 404: no contexto do desafio, IDs válidos são 1..5. Fora disso, "não existe".
        return reply.code(404).send();
    }

    let client;
    try {
        client = await pool.connect(); // pega uma conexão emprestada do pool

        // Usamos prepared statement (name/text/values):
        // - "name" identifica a consulta para o PostgreSQL poder reutilizar o plano de execução.
        // - "text" é a SQL com placeholders ($1, $2 ...).
        // - "values" é o array de parâmetros. Isso evita SQL Injection.
        const result = await client.query({
            name: 'get-extrato',
            text: 'SELECT get_extrato($1) as extrato_json',
            values: [id]
        });

        const extrato = result.rows[0].extrato_json; // a função já retorna JSON pronto
        if (extrato === null) {
            // Conta não encontrada -> 404
            return reply.code(404).send();
        }
        
        // Sucesso -> devolvemos o JSON do próprio banco.
        return reply.send(extrato);
    } catch (e) {
        // Qualquer falha inesperada (erro de banco, etc.) -> 500 (erro do servidor)
        return reply.code(500).send();
    } finally {
        // MUITO IMPORTANTE: sempre liberar a conexão (senão o pool esgota).
        if (client) client.release();
    }
});


/* 6) Rota: POST /clientes/:id/transacoes
   - Objetivo: registrar uma transação (crédito 'c' ou débito 'd') para um cliente.
   - Entrada esperada (JSON no body):
       {
         "valor": 123,           // inteiro > 0
         "tipo": "c" | "d",      // 'c' = crédito, 'd' = débito
         "descricao": "texto"    // string 1..10 caracteres
       }
   - Saída (200):
       { "limite": <int>, "saldo": <int> }
   - Possíveis status:
       422 -> validação falhou OU débito estouraria limite (regra de negócio)
       404 -> id fora do intervalo permitido (aqui usamos 422 para body inválido e 404 para id inválido na GET; na POST preferimos 422 para qualquer validação de entrada fora do contrato)
       500 -> erro inesperado (banco caiu, etc.)
*/
fastify.post('/clientes/:id/transacoes', transactionReplySchema, async (request, reply) => {
    const id = Number(request.params.id);
    const { valor, tipo, descricao } = request.body ?? {};
    // ^ Usamos "?? {}" para evitar erro caso body seja undefined.

    // Validações de entrada (baratas e rápidas, antes de tocar no banco).
    // Isso ajuda performance e retorna códigos HTTP claros.
    if (
        !Number.isInteger(id) || id <= 0 || id > 5 ||         // id válido (1..5)
        !Number.isInteger(valor) || valor <= 0 ||             // "valor" precisa ser inteiro e positivo
        (tipo !== 'c' && tipo !== 'd') ||                     // "tipo" só pode ser 'c' ou 'd'
        !descricao || typeof descricao !== 'string' ||        // "descricao" precisa existir e ser string
        descricao.length === 0 || descricao.length > 10       // tamanho 1..10
    ) {
        // 422 (Unprocessable Entity): o servidor entendeu a requisição, mas os dados não atendem o contrato.
        return reply.code(422).send();
    }

    let client;
    try {
        client = await pool.connect();

        // Chamamos a função de negócio no banco. Ela decide se o débito é permitido
        // e atualiza/inserir tudo de forma consistente (ou falha e retorna "error").
        const result = await client.query({
            name: 'process-transaction', // prepared statement para reuso do plano
            text: 'SELECT process_transaction($1, $2, $3, $4) as response_json',
            values: [id, valor, tipo, descricao]
        });

        const response = result.rows[0].response_json;

        if (response.error) {
            // Regra de negócio negou (ex.: débito que estouraria o limite) -> 422
            return reply.code(422).send();
        }

        // Sucesso: devolvemos { limite, saldo } já no formato certo (bate com o schema).
        return reply.send(response);
    } catch (e) {
        // Falha inesperada -> 500
        return reply.code(500).send();
    } finally {
        // Sempre liberar a conexão!
        if (client) client.release();
    }
});


/* 7) Inicialização do servidor
   - Passos:
       a) Conectar no banco e garantir índice/funções (idempotente graças a IF NOT EXISTS / OR REPLACE).
       b) Iniciar o servidor HTTP escutando em 0.0.0.0 (todas interfaces) na porta PORT (ou 3000).
*/
const start = async () => {
    try {
        const client = await pool.connect();
        console.log("Conectado ao banco de dados, preparando funções e índices...");

        // Cria/atualiza os objetos necessários no banco ANTES de aceitar requisições.
        await client.query(CREATE_INDEX_SQL);
        await client.query(CREATE_EXTRACT_FUNCTION_SQL);
        await client.query(CREATE_TRANSACTION_FUNCTION_SQL);

        client.release();
        console.log("Banco de dados pronto.");

        // Lê a porta do ambiente (ex.: Render, Railway, Docker) ou usa 3000 localmente.
        const port = Number(process.env.PORT) || 3000;

        // host: '0.0.0.0' é importante em containers para aceitar conexões externas.
        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`Servidor rodando na porta ${port}`);
    } catch (err) {
        // Se algo der MUITO errado na inicialização, mostramos o erro e encerramos o processo.
        console.error("Erro fatal ao iniciar a aplicação:", err);
        process.exit(1);
    }
};

// Chama a função de inicialização.
start();


// ================================================================================================
// DICAS FINAIS PARA INICIANTES
// --------------------------------------------------------------------------------
// 1) Sobre prepared statements:
//    - Aqui usamos a propriedade "name" nas queries. O PostgreSQL compila/planeja a consulta uma vez,
//      depois só reusa com novos parâmetros. Isso reduz latência em cenários de alta repetição.
// 2) Sobre validação:
//    - Validar o mais cedo possível evita chamadas desnecessárias ao banco e ajuda a devolver códigos
//      HTTP corretos (422 para dados inválidos conforme contrato; 404 quando o recurso não existe).
// 3) Sobre JSON direto do banco:
//    - Retornar JSON pronto do PostgreSQL (com json_build_object/json_agg) simplifica a aplicação e
//      garante um formato consistente, mesmo com concorrência alta.
// 4) Sobre pool.release():
//    - SEMPRE libere a conexão no "finally". Se esquecer, o pool vai esgotar e a API "congela".
// 5) Sobre erros 500:
//    - Use para falhas inesperadas (ex.: banco indisponível). Evite expor detalhes sensíveis no corpo.
// 6) Sobre índices:
//    - Índices aceleram leituras, mas inserções/updates podem ficar um pouco mais caros. Aqui a consulta
//      de "últimas transações" é crítica, por isso o índice composto (account_id, id DESC).
// ================================================================================================
