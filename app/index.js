'use strict';

// ==================================================================================================
// VISÃO GERAL DO ARQUIVO (LEITURA RÁPIDA PARA INICIANTES)
// --------------------------------------------------------------------------------------------------
// Este programa cria uma API HTTP usando Fastify (um servidor web para Node.js) e um banco PostgreSQL.
// O fluxo é: iniciar servidor → preparar SQL no banco → expor duas rotas:
//   GET  /clientes/:id/extrato     → devolve saldo atual e últimas transações do cliente
//   POST /clientes/:id/transacoes  → registra crédito/debito e retorna novo saldo/limite
// As validações são simples e objetivas para manter o desempenho estável em testes de carga.
// Comentários longos explicam a intenção de cada parte, mas o CÓDIGO EM SI NÃO FOI ALTERADO.
// ==================================================================================================

// Ativa o modo estrito do JavaScript, que ajuda a evitar erros silenciosos e práticas inseguras.
const fastify = require('fastify')({
    // Cria uma instância do servidor Fastify; desligamos o logger para reduzir I/O durante benchmarks.
    logger: false,
    // Trata caminhos de forma sensível a maiúsculas/minúsculas ("/A" é diferente de "/a").
    caseSensitive: true,
    // Ignora uma barra final extra na URL ("/rota" e "/rota/" são aceitas do mesmo jeito).
    ignoreTrailingSlash: true,
});

// Carrega o cliente nativo (C/C++) do PostgreSQL para obter menor overhead de CPU/GC.
const { native } = require('pg');
const Pool = native.Pool;

// ==================================================================================================
// CONFIGURAÇÃO DO POOL DE CONEXÕES COM O POSTGRES
// --------------------------------------------------------------------------------------------------
// "Pool" = conjunto de conexões reaproveitáveis. Em APIs de alta concorrência isso evita o custo
// de abrir/fechar TCP a cada requisição. Os limites abaixo vêm de variáveis de ambiente ou caem
// em valores padrão seguros para testes.
// ==================================================================================================
const PG_MIN = Number(process.env.PG_MIN ?? 5);   // número mínimo de conexões abertas e quentes
const PG_MAX = Number(process.env.PG_MAX ?? 30);  // número máximo de conexões simultâneas no pool

const pool = new Pool({
    // Parâmetros de conexão lidos do ambiente — assim o mesmo binário roda em qualquer lugar.
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    max: PG_MAX,  // teto do pool (para não saturar o banco)
    min: PG_MIN   // piso do pool (para reduzir “cold starts” sob carga)
});

// ==================================================================================================
// AJUSTES POR CONEXÃO NO POSTGRES
// --------------------------------------------------------------------------------------------------
// O evento 'connect' dispara quando o pool cria uma NOVA conexão física. Aqui definimos opções
// de sessão que impactam desempenho/semântica de durabilidade. 'synchronous_commit = off' devolve
// o COMMIT antes do fsync do WAL; é ótimo para testes de throughput, mas não deve ser usado
// em dados críticos de produção.
// ==================================================================================================
pool.on('connect', (client) => {
    client.query([
        "SET synchronous_commit = 'off'"
    ].join('; '));
});

// Captura erros inesperados do pool (ex.: reset de conexão) sem derrubar o processo inteiro.
pool.on('error', () => { });

// ==================================================================================================
// AJUSTES DE REDE NO SERVIDOR HTTP
// --------------------------------------------------------------------------------------------------
// Após o Fastify estar pronto, aplicamos TCP_NODELAY nos sockets. Isso reduz latência de envio
// de pequenos pacotes (não espera “preencher” buffers). Útil quando as respostas são enxutas.
// ==================================================================================================
fastify.after(() => {
    fastify.server.keepAliveTimeout = 60000;
    fastify.server.headersTimeout = 61000;  // sempre maior que o keepAliveTimeout
    fastify.server.requestTimeout = 0;      // sem deadline que gere K.O. no teste
    fastify.server.on('connection', (socket) => socket.setNoDelay(true));
});

// ==================================================================================================
// CONSTANTES DE USO GERAL
// --------------------------------------------------------------------------------------------------
// Mantemos em um só lugar valores repetidos para evitar “strings mágicas” espalhadas no código.
// ==================================================================================================
const CT_JSON = 'application/json';  // Content-Type para respostas JSON
const ID_MIN = 1, ID_MAX = 5;        // intervalo permitido de IDs de clientes (regra do desafio)

// ==================================================================================================
// DEFINIÇÕES SQL (CRIADAS UMA VEZ AO SUBIR O SERVIÇO)
// --------------------------------------------------------------------------------------------------
// Abaixo criamos índice e duas funções PL/pgSQL no banco. Colocamos tudo em strings para enviar
// via pool.query() durante o bootstrap. O índice acelera consultas, e as funções encapsulam a
// lógica de extrato e de processamento de transações para reduzir ida/volta entre app e banco.
// ==================================================================================================
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

// ==================================================================================================
// PREPARED STATEMENTS (SQL PARAMETRIZADO)
// --------------------------------------------------------------------------------------------------
// “Prepared” evita recompilar o plano de execução repetidamente e protege contra SQL injection.
// Com rowMode: 'array', cada linha vem como array e a 1ª coluna é lida via rows[0][0].
// ==================================================================================================
const STMT_GET_EXTRATO = {
    name: 'get-extrato-text',
    text: 'SELECT get_extrato($1)::text AS extrato_json',
    rowMode: 'array' // <<< habilita entrega como array
};
const STMT_PROCESS_TX = {
    name: 'process-transaction-text',
    text: 'SELECT process_transaction($1, $2, $3, $4)::text AS response_json',
    rowMode: 'array' // <<< habilita entrega como array
};
const qGetExtrato = (id) => ({ ...STMT_GET_EXTRATO, values: [id] });
const qProcessTx = (id, v, t, d) => ({ ...STMT_PROCESS_TX, values: [id, v, t, d] });

// ==================================================================================================
// ROTAS HTTP
// --------------------------------------------------------------------------------------------------
// Cada rota valida a entrada de forma barata e direta, chama a função SQL correspondente e traduz
// o resultado em um HTTP status coerente (200/404/415/422/500). Isso mantém o servidor previsível
// sob carga: regras simples, poucos ramos, pouca alocação de objetos.
// ==================================================================================================

fastify.get('/health', (_req, reply) => {
    return reply.code(200).send();
});

fastify.get('/clientes/:id/extrato', async (request, reply) => {
    // Converte o parâmetro para inteiro rápido (bitwise OR com 0) e valida o intervalo permitido.
    const id = (request.params.id | 0);
    if (id < ID_MIN || id > ID_MAX || id !== Number(request.params.id)) {
        return reply.code(404).send();  // cliente inexistente → 404
    }

    try {
        // Executa o prepared statement; o Postgres já retorna um JSON como string.
        const result = await pool.query(qGetExtrato(id));
        const extratoText = result.rows[0]?.[0]; // <<< lê a 1ª coluna (rowMode: 'array')

        // Se a função no banco devolveu NULL (ou string 'null'), não há extrato para esse id.
        if (extratoText == null || extratoText === 'null') return reply.code(404).send();

        // Sanidade mínima do payload (deve parecer um JSON com a chave "saldo").
        if (typeof extratoText !== 'string' || !extratoText.startsWith('{') || !extratoText.includes('"saldo"')) {
            return reply.code(500).send(); // algo inesperado na camada SQL
        }

        // Retorna o JSON “como veio” do banco (sem reparsear) com o cabeçalho correto.
        return reply.type(CT_JSON).send(extratoText);
    } catch {
        // Falhas de banco/conexão geram 500 (erro interno).
        return reply.code(500).send();
    }
});

fastify.post('/clientes/:id/transacoes', async (request, reply) => {

    // Valida o id do cliente no mesmo padrão da rota GET.
    const id = (request.params.id | 0);
    if (id < ID_MIN || id > ID_MAX || id !== Number(request.params.id)) {
        return reply.code(404).send();
    }

    // Validações de payload baratas e determinísticas:
    // - valor: inteiro positivo
    const b = request.body;
    const valor = b?.valor | 0;
    if (valor !== b?.valor || valor <= 0) {
        return reply.code(422).send();  // dados inválidos
    }

    // - tipo: 'c' (crédito) ou 'd' (débito)
    const tipo = b?.tipo;
    if (tipo !== 'c' && tipo !== 'd') {
        return reply.code(422).send();
    }

    // - descricao: 1..=10 bytes em UTF-8 (limite por BYTES, não por caracteres)
    const desc = b?.descricao;
    const dlen = (typeof desc === 'string') ? Buffer.byteLength(desc, 'utf8') : 0;
    if (dlen === 0 || dlen > 10) {
        return reply.code(422).send();
    }

    try {
        // Chama a função de processamento de transação no banco; resposta já vem em JSON-texto.
        const result = await pool.query(qProcessTx(id, valor, tipo, desc));
        const respText = result.rows[0]?.[0] || ''; // <<< lê a 1ª coluna (rowMode: 'array')

        // Se o banco sinalizou erro com {"error":1}, traduzimos para 422 (ex.: sem saldo para débito).
        if (respText.includes('"error"')) return reply.code(422).send();

        // Caso OK, devolvemos o JSON com saldo/limite atualizados.
        return reply.type(CT_JSON).send(respText);
    } catch {
        // Qualquer falha não prevista na comunicação com o banco → 500.
        return reply.code(500).send();
    }
});

// ==================================================================================================
// BOOTSTRAP (SUBIDA DO SERVIDOR)
// --------------------------------------------------------------------------------------------------
// Na inicialização: criamos índice e funções no banco (idempotente), depois “ouvimos” na porta
// informada pela variável PORT (ou 3000). Qualquer erro fatal encerra o processo com exit 1.
// ==================================================================================================
(async () => {
    try {
        await pool.query(CREATE_INDEX_SQL);             // garante índice essencial para extratos
        await pool.query(CREATE_EXTRACT_FUNCTION_SQL);  // cria/atualiza a função de extrato
        await pool.query(CREATE_TRANSACTION_FUNCTION_SQL); // cria/atualiza a função de transação

        const port = Number(process.env.PORT) || 3000;  // porta de escuta HTTP
        await fastify.listen({ port, host: '0.0.0.0' }); // 0.0.0.0 expõe para a rede/container
    } catch {
        process.exit(1); // falha no bootstrap (ex.: banco inacessível) → encerra para orquestrador reiniciar
    }
})();

// ==================================================================================================
// DESLIGAMENTO ELEGANTE (GRACEFUL SHUTDOWN)
// --------------------------------------------------------------------------------------------------
// Ao receber sinais do sistema (SIGTERM/SIGINT), paramos o servidor HTTP e fechamos o pool de
// conexões. Promises “settled” evitam travamentos até que tudo tenha sido liberado; depois saímos.
// ==================================================================================================
function shutdown() {
    Promise.allSettled([fastify.close(), pool.end()]).finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
