'use strict';

/**
 * ============================================================================
 *  index.js — API Fastify + PostgreSQL (com comentários detalhados)
 * ============================================================================
 *  O QUE ESTE SERVIDOR FAZ
 *  - Expõe duas rotas:
 *      GET  /clientes/:id/extrato      -> retorna saldo/limite e últimas 10 transações
 *      POST /clientes/:id/transacoes   -> cria crédito ('c') ou débito ('d') com verificação de limite
 *  - Usa 'pg' (driver nativo) com Pool de conexões para conversar com o PostgreSQL
 *  - Na inicialização, garante a existência da função SQL process_transaction(...)
 *
 *  DICAS RÁPIDAS
 *  - Variáveis de ambiente esperadas (ver docker-compose):
 *      DB_HOST, DB_USER, DB_PASSWORD, DB_DATABASE, PORT, PG_MAX (opcional)
 *  - Subida local sem Docker (exemplo):
 *      DB_HOST=localhost DB_USER=postgres DB_PASSWORD=postgres DB_DATABASE=postgres_api_db node index.js
 *  - Testes rápidos (exemplos):
 *      curl -s http://localhost:3000/clientes/1/extrato
 *      curl -s -X POST http://localhost:3000/clientes/1/transacoes \
 *           -H 'Content-Type: application/json' \
 *           -d '{"valor": 1000, "tipo": "c", "descricao": "bonus" }'
 *
 *  NOTAS DE PERFORMANCE/ESTABILIDADE
 *  - O pool tem um limite reduzido (PG_MAX) para caber em ambientes com pouca RAM.
 *  - A função process_transaction usa SELECT ... FOR UPDATE para evitar condições de corrida
 *    ao debitar/creditar a mesma conta simultaneamente.
 *  - keepAliveTimeout do Node foi ajustado para alinhar com o proxy (ex.: NGINX) e reduzir
 *    fechamentos prematuros de conexão.
 * ============================================================================
 */

const fastify = require('fastify')({ logger: false });  // Fastify com logger desativado (reduz IO/CPU em benchmarks).
// Se precisar depurar, mude para { logger: true } temporariamente.

const { native } = require('pg');       // Usa o binding nativo (libpq) do 'pg', mais performático que o JS puro.
const Pool = native.Pool;

// ---------------------------------------------------------------------------
// POOL DE CONEXÕES COM O POSTGRES
// - PG_MAX: número máximo de conexões simultâneas no pool (default 30).
// - idleTimeoutMillis: tempo para encerrar conexões ociosas (20s) e controlar uso de recursos.
// - IMPORTANTE: Cada instância do app cria seu próprio pool. Em ambientes com múltiplas
//   instâncias (app1, app2), garanta que a soma de pools caiba no limite do Postgres.
// ---------------------------------------------------------------------------
const PG_MAX = Number(process.env.PG_MAX ?? 30);
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    max: PG_MAX,
    idleTimeoutMillis: 20000,
    // Dica: se precisar, adicione 'connectionTimeoutMillis' para controlar tempo de espera ao pegar conexão.
});

// ---------------------------------------------------------------------------
/**
 * Ajuste fino do servidor HTTP do Node criado internamente pelo Fastify.
 * - keepAliveTimeout define quanto tempo a conexão do *cliente* (ex.: NGINX -> Node)
 *   pode ficar ociosa antes do servidor fechá-la.
 * - Manter esse valor compatível com o proxy evita 'Premature close' e 502 intermitentes.
 *   Ex.: se o NGINX reutiliza upstream connections, garanta que o Node não encerre cedo demais.
 */
// ---------------------------------------------------------------------------
fastify.after(() => {
    fastify.server.keepAliveTimeout = 60000; // 60s — valor seguro para a maioria dos proxies.
    // Dica: também existe headersTimeout (padrão ~60s no Node moderno). Ajuste se receber cabeçalhos muito lentos.
});

// ---------------------------------------------------------------------------
// FUNÇÃO SQL: process_transaction(...)
// - Encapsula a lógica de débito/crédito com locking de linha e verificação de limite.
// - Executa como uma única operação do ponto de vista do cliente (SELECT * FROM process_transaction(...)).
//   No PostgreSQL, a função roda dentro de uma transação criada pelo statement, o que garante atomicidade.
// - Retorna códigos padronizados:
//      0  -> sucesso
//     -1  -> cliente não encontrado
//     -2  -> limite excedido (débito que ultrapassa o limite negativo da conta)
// ---------------------------------------------------------------------------
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
    -- Lock pessimista da linha da conta para evitar corridas em crédito/débito concorrentes.
    SELECT account_limit, balance INTO v_limit, v_balance
    FROM accounts WHERE id = p_account_id FOR UPDATE;

    IF NOT FOUND THEN
        -- Conta inexistente
        RETURN QUERY SELECT -1, 0, 0;
        RETURN;
    END IF;

    -- Recalcula o novo saldo conforme o tipo de operação
    IF p_type = 'd' THEN
        v_new_balance := v_balance - p_amount;
        IF v_new_balance < -v_limit THEN
            -- Tentativa de débito que estoura o limite de crédito disponível
            RETURN QUERY SELECT -2, v_balance, v_limit;
            RETURN;
        END IF;
    ELSE
        -- Crédito
        v_new_balance := v_balance + p_amount;
    END IF;

    -- Aplica o novo saldo
    UPDATE accounts SET balance = v_new_balance WHERE id = p_account_id;

    -- Registra a transação (auditoria/rastrabilidade). 'created_at' deve ser DEFAULT NOW() na tabela.
    INSERT INTO transactions (account_id, amount, type, description)
    VALUES (p_account_id, p_amount, p_type, p_description);

    -- Retorno padronizado
    RETURN QUERY SELECT 0, v_new_balance, v_limit;
END;
$$ LANGUAGE plpgsql;
`;

// ---------------------------------------------------------------------------
// GET /clientes/:id/extrato
// - Retorna o saldo atual, limite e as últimas 10 transações da conta.
// - Validações mínimas do parâmetro ':id' para evitar queries inválidas (404 para id não numérico ou <= 0).
// - Usa client dedicado do pool (pool.connect) e sempre 'release' em finally (evita vazamento de conexões).
// ---------------------------------------------------------------------------
fastify.get('/clientes/:id/extrato', async (request, reply) => {
    const id = Number(request.params.id);

    // Validação básica do path param
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send();

    let client;
    try {
        client = await pool.connect(); // Pega uma conexão do pool (importante dar 'release' no finally)

        // Busca saldo/limite da conta
        const accountResult = await client.query(
            'SELECT balance, account_limit FROM accounts WHERE id = $1',
            [id]
        );
        if (accountResult.rowCount === 0) {
            client.release();
            return reply.code(404).send(); // Conta inexistente
        }

        // Últimas 10 transações (ordenadas por id desc para performance simples)
        const transactionsResult = await client.query(
            'SELECT amount, type, description, created_at FROM transactions WHERE account_id = $1 ORDER BY id DESC LIMIT 10',
            [id]
        );

        const account = accountResult.rows[0];

        // Resposta no formato esperado pelo desafio/cliente
        return reply.code(200).send({
            saldo: {
                total: account.balance,
                data_extrato: new Date().toISOString(), // Momento da geração (lado app). Alternativa: usar NOW() do banco.
                limite: account.account_limit
            },
            ultimas_transacoes: transactionsResult.rows.map(t => ({
                valor: t.amount,
                tipo: t.type,
                descricao: t.description,
                realizada_em: t.created_at
            }))
        });
    } catch (e) {
        // Evita vazar detalhes internos. Em debug, logue 'e' (ou ative logger do Fastify).
        return reply.code(500).send();
    } finally {
        if (client) client.release(); // SEMPRE devolver a conexão ao pool
    }
});

// ---------------------------------------------------------------------------
// POST /clientes/:id/transacoes
// - Cria uma transação de crédito ('c') ou débito ('d') para a conta informada.
// - Valida o corpo da requisição rapidamente (sem libs externas, por economia de CPU).
// - Delegamos a consistência de saldo/limite à função process_transaction no banco.
// ---------------------------------------------------------------------------
fastify.post('/clientes/:id/transacoes', async (request, reply) => {
    const id = Number(request.params.id);
    const { valor, tipo, descricao } = request.body;

    // Validação "barata" e suficiente para o contrato atual
    if (
        !Number.isInteger(id) || id <= 0 ||
        !Number.isInteger(valor) || valor <= 0 ||
        (tipo !== 'c' && tipo !== 'd') ||
        typeof descricao !== 'string' || descricao.length === 0 || descricao.length > 10
    ) {
        return reply.code(422).send(); // Unprocessable Entity
    }

    let client;
    try {
        client = await pool.connect();

        // Chama a função SQL que encapsula verificação de saldo/limite e gravação
        const result = await client.query(
            'SELECT * FROM process_transaction($1, $2, $3, $4)',
            [id, valor, tipo, descricao]
        );

        const { result_code, current_balance, current_limit } = result.rows[0];

        // Mapeia códigos de retorno para HTTP
        if (result_code === 0)   return reply.code(200).send({ saldo: current_balance, limite: current_limit });
        if (result_code === -1)  return reply.code(404).send();   // Conta não existe
        return reply.code(422).send();                            // Limite excedido
    } catch (e) {
        return reply.code(500).send();
    } finally {
        if (client) client.release();
    }
});

// ---------------------------------------------------------------------------
// BOOTSTRAP DA APLICAÇÃO
// - Antes de iniciar o servidor, garante que a função process_transaction exista.
// - 'fastify.listen' usa host 0.0.0.0 para aceitar conexões dentro do container.
// ---------------------------------------------------------------------------
const start = async () => {
    try {
        const client = await pool.connect();
        await client.query(CREATE_TRANSACTION_FUNCTION_SQL); // Idempotente por causa do CREATE OR REPLACE
        client.release();

        // Porta vinda do ambiente (Docker Compose define 3001/3002 em cada instância).
        const port = Number(process.env.PORT) || 3000;
        await fastify.listen({ port, host: '0.0.0.0' });
    } catch (err) {
        console.error("Erro ao iniciar a aplicação:", err);
        process.exit(1);
    }
};

start();
