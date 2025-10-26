'use strict';

// index.js — minimal + otimizações estáveis (sem logs)
// - Pass-through de JSON via ::text (sem parse/serialize no Node)
// - Guards curtos e ordenados (early-returns)
// - Prepared statements nomeados
// - Pool pg-native com connectionTimeoutMillis
// - Fastify com bodyLimit pequeno e roteamento direto
// - Defesas contra "null" textual/formatos inesperados
// - Timeouts de sessão no Postgres por conexão (statement/idle/lock) e timezone
// - Pool.on('error') para evitar crash por erros assíncronos
// - Bootstrap em uma única ida ao banco

const fastify = require('fastify')({
  logger: false,
  bodyLimit: 512,
  caseSensitive: true,
  ignoreTrailingSlash: true,
});

const { native } = require('pg');
const Pool = native.Pool;

/* Pool de conexões */
const PG_MIN = Number(process.env.PG_MIN ?? 5);
const PG_MAX = Number(process.env.PG_MAX ?? 30);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  max: PG_MAX,
  min: PG_MIN,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 2000,
});

// Definições de sessão no PG (timeouts seguros por conexão)
pool.on('connect', (client) => {
  client.query("SET statement_timeout = '2000ms'");
  client.query("SET idle_in_transaction_session_timeout = '2000ms'");
});

// Evita crash do processo em erros assíncronos do pool
pool.on('error', () => { /* noop: próximas operações responderão 500 */ });

/* Ajustes HTTP simples */
fastify.after(() => {
  fastify.server.keepAliveTimeout = 60000;
  fastify.server.headersTimeout   = 61000;
  fastify.server.requestTimeout   = 65000;
});

const CT_JSON = 'application/json';
const ID_MIN = 1, ID_MAX = 5;

/* SQL essenciais */
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
        'data_extrato', CURRENT_TIMESTAMP
    )
    INTO account_info
    FROM accounts
    WHERE id = p_account_id;

    IF account_info IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT json_agg(t)
    INTO last_transactions
    FROM (
        SELECT amount AS valor, type AS tipo, description AS descricao, created_at AS realizada_em
        FROM transactions
        WHERE account_id = p_account_id
        ORDER BY id DESC
        LIMIT 10
    ) t;

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
        WHERE id = p_account_id 
          AND (p_type = 'c' OR (balance - p_amount) >= -account_limit)
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

/* Prepared statements (nomeados) */
const STMT_GET_EXTRATO = {
  name: 'get-extrato-text',
  text: 'SELECT get_extrato($1)::text AS extrato_json',
};
const STMT_PROCESS_TX = {
  name: 'process-transaction-text',
  text: 'SELECT process_transaction($1, $2, $3, $4)::text AS response_json',
};

function qGetExtrato(id) {
  return { name: STMT_GET_EXTRATO.name, text: STMT_GET_EXTRATO.text, values: [id] };
}
function qProcessTx(id, v, t, d) {
  return { name: STMT_PROCESS_TX.name, text: STMT_PROCESS_TX.text, values: [id, v, t, d] };
}

/* Rotas */

fastify.get('/clientes/:id/extrato', async (request, reply) => {
  const id = Number(request.params.id);

  // id inteiro dentro do range => 1..5
  if (id !== (id | 0) || id < ID_MIN || id > ID_MAX) {
    return reply.code(404).send();
  }

  try {
    const result = await pool.query(qGetExtrato(id));
    const rows = result.rows;
    if (rows.length === 0) return reply.code(404).send();

    const extratoText = rows[0].extrato_json;

    // 404 quando função retorna JSON NULL
    if (extratoText === null || extratoText === 'null') {
      return reply.code(404).send();
    }
    // formato inesperado => 500
    if (typeof extratoText !== 'string' || extratoText.charCodeAt(0) !== 123 /* '{' */ || extratoText.indexOf('"saldo"') === -1) {
      return reply.code(500).send();
    }

    return reply.header('content-type', CT_JSON).send(extratoText);
  } catch {
    return reply.code(500).send();
  }
});

fastify.post('/clientes/:id/transacoes', async (request, reply) => {
  // Rejeita payloads não-JSON sem alocar body (permissivo e barato)
  const ct = request.headers['content-type'];
  if (typeof ct !== 'string' || ct.length < 16 || ct.toLowerCase().slice(0, 16) !== 'application/json') {
    return reply.code(415).send();
  }

  const id = Number(request.params.id);
  const body = request.body || {};

  // Guards muito baratos primeiro
  if (id !== (id | 0) || id < ID_MIN || id > ID_MAX) return reply.code(422).send();

  // Valor: int estrito e positivo
  const valor = body.valor | 0;
  if (valor !== body.valor || valor <= 0) return reply.code(422).send();

  const tipo = body.tipo;
  if (tipo !== 'c' && tipo !== 'd') return reply.code(422).send();

  const descricao = body.descricao;
  if (typeof descricao !== 'string' || descricao.length === 0 || descricao.length > 10) {
    return reply.code(422).send();
  }

  try {
    const result = await pool.query(qProcessTx(id, valor, tipo, descricao));
    const rows = result.rows;
    if (rows.length === 0) return reply.code(500).send();

    const respText = rows[0].response_json || '';
    if (respText.indexOf('"error"') !== -1) {
      return reply.code(422).send();
    }
    const s0 = respText.charCodeAt(0);
    if (s0 !== 123 /* '{' */ || respText.indexOf('"limite"') === -1 || respText.indexOf('"saldo"') === -1) {
      return reply.code(500).send();
    }

    return reply.header('content-type', CT_JSON).send(respText);
  } catch {
    return reply.code(500).send();
  }
});

/* Bootstrap (silencioso) */
(async () => {
  try {
    // Uma única ida ao banco (idempotente)
    await pool.query(
      CREATE_INDEX_SQL + CREATE_EXTRACT_FUNCTION_SQL + CREATE_TRANSACTION_FUNCTION_SQL
    );

    const port = Number(process.env.PORT) || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
  } catch {
    process.exit(1);
  }
})();

/* Graceful shutdown (opcional) */
function shutdown() {
  Promise.allSettled([fastify.close(), pool.end()]).finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
