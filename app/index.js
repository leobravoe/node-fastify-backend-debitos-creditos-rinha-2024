'use strict';

/**
 * =================================================================================================
 * index.js — Versão Final e Documentada para a Rinha de Backend
 * =================================================================================================
 *
 * ARQUITETURA E FILOSOFIA DE OTIMIZAÇÃO:
 *
 * 1.  **Mover a Lógica para o Banco de Dados:** A estratégia central é minimizar a comunicação
 * de rede entre a aplicação e o banco. Toda lógica de negócio (validação de limite,
 * cálculo de extrato) foi movida para Stored Functions no PostgreSQL. Cada rota da API
 * executa exatamente UMA chamada ao banco.
 *
 * 2.  **Node.js como um Roteador Leve:** A aplicação Node.js atua como uma camada fina,
 * cuja única responsabilidade é validar a sintaxe da requisição e atuar como um proxy
 * para as funções do PostgreSQL. O framework 'fastify' e o driver 'pg-native' foram
 * escolhidos por sua performance bruta e baixo overhead.
 *
 * 3.  **Otimizações a Nível de Banco de Dados:**
 * - **Índices Otimizados:** Um índice composto (`idx_account_id_id_desc`) foi criado para
 * que a busca das últimas transações seja uma operação de leitura quase instantânea.
 * - **Funções Atômicas:** As Stored Functions (`get_extrato`, `process_transaction`) são
 * atômicas e garantem a consistência dos dados sem a necessidade de transações explícitas
 * (BEGIN/COMMIT) controladas pela aplicação.
 * - **Declarações Preparadas (Prepared Statements):** Para eliminar a sobrecarga de
 * análise (parsing) da consulta a cada chamada, usamos Prepared Statements. A consulta
 * é planejada uma vez pelo PostgreSQL e depois apenas os parâmetros são enviados.
 *
 * 4.  **Micro-otimizações Finais (Aplicadas neste Código):**
 * - **Esquemas de Resposta do Fastify:** Ao definir um esquema para o JSON de resposta,
 * o Fastify usa uma função de serialização pré-compilada (`fast-json-stringify`), que é
 * a forma mais rápida de gerar a resposta JSON, reduzindo o trabalho do Garbage Collector.
 *
 * =================================================================================================
 */

const fastify = require('fastify')({ logger: false });
const { native } = require('pg');
const Pool = native.Pool;

// --- Configuração do Pool de Conexões ---
const PG_MAX = Number(process.env.PG_MAX ?? 30);
const pool = new Pool({
    // DICA DE OTIMIZAÇÃO DE AMBIENTE:
    // Para comunicação na mesma máquina, usar Unix Sockets (ex: host: '/var/run/postgresql')
    // é mais rápido que a pilha de rede TCP/IP.
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    max: PG_MAX,
    idleTimeoutMillis: 20000,
});

fastify.after(() => {
    fastify.server.keepAliveTimeout = 60000;
});

// -------------------------------------------------------------------------------------------------
// SQL DE INICIALIZAÇÃO E FUNÇÕES DE NEGÓCIO
// -------------------------------------------------------------------------------------------------

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_account_id_id_desc ON transactions (account_id, id DESC);
`;

const CREATE_EXTRACT_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION get_extrato(p_account_id INT)
RETURNS JSON AS $$
DECLARE
    account_info JSON;
    last_transactions JSON;
BEGIN
    SELECT json_build_object(
        'total', balance,
        'limite', account_limit,
        'data_extrato', NOW()
    )
    INTO account_info
    FROM accounts
    WHERE id = p_account_id;

    IF account_info IS NULL THEN
        RETURN NULL;
    END IF;

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

    RETURN json_build_object(
        'saldo', account_info,
        'ultimas_transacoes', COALESCE(last_transactions, '[]'::json)
    );
END;
$$ LANGUAGE plpgsql;
`;

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
    WITH updated_account AS (
        UPDATE accounts
        SET balance = balance + CASE WHEN p_type = 'c' THEN p_amount ELSE -p_amount END
        WHERE id = p_account_id AND (p_type = 'c' OR (balance - p_amount) >= -account_limit)
        RETURNING balance, account_limit
    ),
    inserted_transaction AS (
        INSERT INTO transactions (account_id, amount, type, description)
        SELECT p_account_id, p_amount, p_type, p_description
        FROM updated_account
        RETURNING 1
    )
    SELECT json_build_object('saldo', ua.balance, 'limite', ua.account_limit)
    INTO response
    FROM updated_account ua;

    IF response IS NULL THEN
        RETURN '{"error": 1}'::json;
    END IF;

    RETURN response;
END;
$$ LANGUAGE plpgsql;
`;

// -------------------------------------------------------------------------------------------------
// ROTAS DA API COM ESQUEMAS E PREPARED STATEMENTS
// -------------------------------------------------------------------------------------------------

// Definição do esquema de resposta para a rota de transações.
// Isso permite ao Fastify pré-compilar a função de serialização para máxima performance.
const transactionReplySchema = {
    schema: {
        response: {
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

fastify.get('/clientes/:id/extrato', async (request, reply) => {
    const id = Number(request.params.id);

    if (!Number.isInteger(id) || id <= 0 || id > 5) {
        return reply.code(404).send();
    }

    let client;
    try {
        client = await pool.connect();
        const result = await client.query({
            name: 'get-extrato',
            text: 'SELECT get_extrato($1) as extrato_json',
            values: [id]
        });

        const extrato = result.rows[0].extrato_json;
        if (extrato === null) {
            return reply.code(404).send();
        }
        
        return reply.send(extrato);
    } catch (e) {
        return reply.code(500).send();
    } finally {
        if (client) client.release();
    }
});

fastify.post('/clientes/:id/transacoes', transactionReplySchema, async (request, reply) => {
    const id = Number(request.params.id);
    const { valor, tipo, descricao } = request.body;

    if (
        !Number.isInteger(id) || id <= 0 || id > 5 ||
        !Number.isInteger(valor) || valor <= 0 ||
        (tipo !== 'c' && tipo !== 'd') ||
        !descricao || typeof descricao !== 'string' || descricao.length === 0 || descricao.length > 10
    ) {
        return reply.code(422).send();
    }

    let client;
    try {
        client = await pool.connect();
        const result = await client.query({
            name: 'process-transaction',
            text: 'SELECT process_transaction($1, $2, $3, $4) as response_json',
            values: [id, valor, tipo, descricao]
        });

        const response = result.rows[0].response_json;
        if (response.error) {
            return reply.code(422).send();
        }

        return reply.send(response);
    } catch (e) {
        return reply.code(500).send();
    } finally {
        if (client) client.release();
    }
});

// -------------------------------------------------------------------------------------------------
// INICIALIZAÇÃO DO SERVIDOR
// -------------------------------------------------------------------------------------------------
const start = async () => {
    try {
        const client = await pool.connect();
        console.log("Conectado ao banco de dados, preparando funções e índices...");
        await client.query(CREATE_INDEX_SQL);
        await client.query(CREATE_EXTRACT_FUNCTION_SQL);
        await client.query(CREATE_TRANSACTION_FUNCTION_SQL);
        client.release();
        console.log("Banco de dados pronto.");

        const port = Number(process.env.PORT) || 3000;
        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`Servidor rodando na porta ${port}`);
    } catch (err) {
        console.error("Erro fatal ao iniciar a aplicação:", err);
        process.exit(1);
    }
};

start();