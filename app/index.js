const fastify = require('fastify')({ logger: true });
const { Pool } = require('pg');
const dotenv = require("dotenv");

// Configura as variáveis de ambiente
dotenv.config();

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

//Só para testar os endpoints
fastify.get('/accounts', async (request, reply) => {
    try {
        const result = await pool.query('SELECT * from accounts');
        return {
            "result.rows": result.rows,
            "port": process.env.PORT,
            "container": process.env.HOSTNAME,
            "DB_PORT": process.env.DB_PORT
        };
    } catch (error) {
        console.error('Error:', error);
    }
});

//Só para testar os endpoints
fastify.get('/transactions', async (request, reply) => {
    try {
        const result = await pool.query('SELECT * from transactions');
        return {
            "result.rows": result.rows,
            "port": process.env.PORT,
            "container": process.env.HOSTNAME,
            "DB_PORT": process.env.DB_PORT
        };
    } catch (error) {
        console.error('Error:', error);
    }
});

fastify.get('/clientes/:id/extrato', async (request, reply) => {
    // Conversão rápida pra inteiro
    const clientId = request.params.id | 0;

    // Verifica se é inteiro válido
    if (!Number.isInteger(clientId)) {
        return reply.status(422).send({ erro: 'ID inválido' });
    }

    const client = await pool.connect();

    try {
        // Começa transação se quiser garantir leitura consistente
        await client.query('BEGIN');

        // Busca o cliente com saldo e limite
        const { rows: accountRows } = await client.query(
            'SELECT account_limit, balance FROM accounts WHERE id = $1',
            [clientId]
        );

        if (accountRows.length === 0) {
            await client.query('ROLLBACK');
            return reply.status(404).send({ erro: 'Cliente não encontrado' });
        }

        const { account_limit, balance } = accountRows[0];

        // Busca as 10 últimas transações ordenadas por data (desc)
        const { rows: transactions } = await client.query(
            `SELECT amount, type, description, created_at
             FROM transactions
             WHERE account_id = $1
             ORDER BY created_at DESC
             LIMIT 10`,
            [clientId]
        );

        await client.query('COMMIT');

        // Monta a resposta
        const extrato = {
            saldo: {
                total: balance,
                data_extrato: new Date().toISOString(),
                limite: account_limit
            },
            ultimas_transacoes: transactions
        };

        return reply.status(200).send(extrato);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro no extrato:', err);
        return reply.status(500).send({ erro: 'Erro interno' });
    } finally {
        client.release();
    }
});

//Post
fastify.post('/clientes/:id/transacoes', async (request, reply) => {
    const clientId = Number(request.params.id);

    const { valor, tipo, descricao } = request.body;

    // Validação dos campos
    if (
        !Number.isInteger(clientId) ||
        !Number.isInteger(valor) || valor <= 0 ||
        (tipo !== 'c' && tipo !== 'd') ||
        typeof descricao !== 'string' ||
        descricao.length < 1 || descricao.length > 10
    ) {
        return reply.status(422).send({ erro: 'Payload inválido' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            'SELECT account_limit, balance FROM accounts WHERE id = $1 FOR UPDATE',
            [clientId]
        );

        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.status(404).send({ erro: 'Cliente não encontrado' });
        }

        const { account_limit, balance } = rows[0];
        let new_balance = balance;

        if (tipo === 'c') {
            new_balance += valor;
        } else {
            new_balance -= valor;
            if (new_balance < -account_limit) {
                await client.query('ROLLBACK');
                return reply.status(422).send({ erro: 'Limite excedido' });
            }
        }

        await client.query(
            'UPDATE accounts SET balance = $1 WHERE id = $2',
            [new_balance, clientId]
        );

        await client.query(
            `INSERT INTO transactions (amount, type, description, created_at, account_id)
             VALUES ($1, $2, $3, NOW(), $4)`,
            [valor, tipo, descricao, clientId]
        );

        await client.query('COMMIT');

        return reply.status(200).send({
            limite: account_limit,
            saldo: new_balance
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro na transação:', err);
        return reply.status(500).send({ erro: 'Erro interno' });
    } finally {
        client.release();
    }
});


const start = async () => {
    try {
        await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
        console.log(`🚀 Server running on port ${process.env.PORT || 3000}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
