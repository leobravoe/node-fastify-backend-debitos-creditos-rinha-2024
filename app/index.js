'use strict';

// main.js — minimal + otimizações estáveis (sem logs)

const fastify = require('fastify')({
  logger: false,
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
  min: PG_MIN
});

/* Definições de sessão no PG (por conexão) */
pool.on('connect', (client) => {
  client.query([
    "SET synchronous_commit = 'off'"
  ].join('; '));
});

/* Evita crash do processo em erros assíncronos do pool */
pool.on('error', () => {});

/* Ajustes HTTP */
fastify.after(() => {
  fastify.server.on('connection', (socket) => socket.setNoDelay(true));
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

/* Prepared statements */
const STMT_GET_EXTRATO = {
  name: 'get-extrato-text',
  text: 'SELECT get_extrato($1)::text AS extrato_json',
};
const STMT_PROCESS_TX = {
  name: 'process-transaction-text',
  text: 'SELECT process_transaction($1, $2, $3, $4)::text AS response_json',
};
const qGetExtrato = (id) => ({ ...STMT_GET_EXTRATO, values: [id] });
const qProcessTx  = (id, v, t, d) => ({ ...STMT_PROCESS_TX, values: [id, v, t, d] });

/* Rotas */
fastify.get('/clientes/:id/extrato', async (request, reply) => {
  const id = Number(request.params.id);
  if ((id | 0) !== id || id < ID_MIN || id > ID_MAX) {
    return reply.code(404).send();
  }

  try {
    const result = await pool.query(qGetExtrato(id));
    const extratoText = result.rows[0]?.extrato_json;
    if (extratoText === null || extratoText === 'null') return reply.code(404).send();
    if (typeof extratoText !== 'string' || !extratoText.startsWith('{') || !extratoText.includes('"saldo"')) {
      return reply.code(500).send();
    }
    return reply.type(CT_JSON).send(extratoText);
  } catch {
    return reply.code(500).send();
  }
});

fastify.post('/clientes/:id/transacoes', async (request, reply) => {
  const ct = request.headers['content-type'];
  if (typeof ct !== 'string' || !ct.toLowerCase().startsWith('application/json')) {
    return reply.code(415).send();
  }

  const id = Number(request.params.id);
  const body = request.body || {};

  if ((id | 0) !== id || id < ID_MIN || id > ID_MAX) return reply.code(422).send();

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
    const respText = result.rows[0]?.response_json || '';
    if (respText.includes('"error"')) return reply.code(422).send();
    if (!respText.startsWith('{') || !respText.includes('"limite"') || !respText.includes('"saldo"')) {
      return reply.code(500).send();
    }
    return reply.type(CT_JSON).send(respText);
  } catch {
    return reply.code(500).send();
  }
});

/* Bootstrap */
(async () => {
  try {
    await pool.query(CREATE_INDEX_SQL);
    await pool.query(CREATE_EXTRACT_FUNCTION_SQL);
    await pool.query(CREATE_TRANSACTION_FUNCTION_SQL);

    const port = Number(process.env.PORT) || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
  } catch {
    process.exit(1);
  }
})();

/* Graceful shutdown */
function shutdown() {
  Promise.allSettled([fastify.close(), pool.end()]).finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
