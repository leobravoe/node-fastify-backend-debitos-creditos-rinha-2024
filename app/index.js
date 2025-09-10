'use strict';

const fastify = require('fastify')({ logger: false });
const { native } = require('pg');
const Pool = native.Pool;

// MUDANÇA 1: Pool de conexões drasticamente reduzido para caber no limite de 125MB de RAM.
const PG_MAX = Number(process.env.PG_MAX ?? 30);
const pool = new Pool({
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

const CREATE_TRANSACTION_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION process_transaction(
    p_account_id INT,
    p_amount INT,
    p_type CHAR,
    p_description VARCHAR(10)
)
RETURNS TABLE (
    result_code INT, -- 0: sucesso, -1: cliente não encontrado, -2: limite excedido
    current_balance INT,
    current_limit INT
) AS $$
DECLARE
    v_limit INT;
    v_balance INT;
    v_new_balance INT;
BEGIN
    SELECT account_limit, balance INTO v_limit, v_balance
    FROM accounts WHERE id = p_account_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT -1, 0, 0;
        RETURN;
    END IF;
    IF p_type = 'd' THEN
        v_new_balance := v_balance - p_amount;
        IF v_new_balance < -v_limit THEN
            RETURN QUERY SELECT -2, v_balance, v_limit;
            RETURN;
        END IF;
    ELSE
        v_new_balance := v_balance + p_amount;
    END IF;
    UPDATE accounts SET balance = v_new_balance WHERE id = p_account_id;
    INSERT INTO transactions (account_id, amount, type, description)
    VALUES (p_account_id, p_amount, p_type, p_description);
    RETURN QUERY SELECT 0, v_new_balance, v_limit;
END;
$$ LANGUAGE plpgsql;
`;

// MUDANÇA 2: Rota de extrato simplificada para ser mais estável em consumo de memória.
fastify.get('/clientes/:id/extrato', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send();
    let client;
    try {
        client = await pool.connect();
        const accountResult = await client.query('SELECT balance, account_limit FROM accounts WHERE id = $1', [id]);
        if (accountResult.rowCount === 0) {
            client.release();
            return reply.code(404).send();
        }

        const transactionsResult = await client.query('SELECT amount, type, description, created_at FROM transactions WHERE account_id = $1 ORDER BY id DESC LIMIT 10', [id]);
        
        const account = accountResult.rows[0];
        return reply.code(200).send({
            saldo: { total: account.balance, data_extrato: new Date().toISOString(), limite: account.account_limit },
            ultimas_transacoes: transactionsResult.rows.map(t => ({ valor: t.amount, tipo: t.type, descricao: t.description, realizada_em: t.created_at }))
        });
    } catch (e) {
        return reply.code(500).send();
    } finally {
        if (client) client.release();
    }
});

fastify.post('/clientes/:id/transacoes', async (request, reply) => {
    const id = Number(request.params.id);
    const { valor, tipo, descricao } = request.body;
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(valor) || valor <= 0 || (tipo !== 'c' && tipo !== 'd') || typeof descricao !== 'string' || descricao.length === 0 || descricao.length > 10) {
        return reply.code(422).send();
    }
    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT * FROM process_transaction($1, $2, $3, $4)', [id, valor, tipo, descricao]);
        const { result_code, current_balance, current_limit } = result.rows[0];
        if (result_code === 0) return reply.code(200).send({ saldo: current_balance, limite: current_limit });
        if (result_code === -1) return reply.code(404).send();
        return reply.code(422).send();
    } catch (e) {
        return reply.code(500).send();
    } finally {
        if (client) client.release();
    }
});

const start = async () => {
    try {
        const client = await pool.connect();
        await client.query(CREATE_TRANSACTION_FUNCTION_SQL);
        client.release();
        // O docker-compose vai fornecer a porta correta (3001 ou 3002)
        const port = Number(process.env.PORT) || 3000;
        await fastify.listen({ port, host: '0.0.0.0' });
    } catch (err) {
        console.error("Erro ao iniciar a aplicação:", err);
        process.exit(1);
    }
};
start();