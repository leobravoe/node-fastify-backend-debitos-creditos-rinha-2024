'use strict';

const fastify = require('fastify')({ logger: false, bodyLimit: 8 * 1024 });
const { Pool } = require('pg');

/* ===== NUNCA LOGAR NO CONSOLE ===== */
['log','error','warn','info','debug','trace'].forEach(k => { try { console[k] = () => {}; } catch {} });

/* ===== POOL POSTGRES ===== */
const PG_MAX = Number(process.env.PG_MAX ?? 20);
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  max: PG_MAX,
  connectionTimeoutMillis: Number(process.env.POOL_CONNECT_TIMEOUT_MS ?? 2000),
  idleTimeoutMillis: 5_000,
  maxUses: Number(process.env.PG_MAX_USES ?? 10_000),
});

/* ===== TIMEOUTS DO SERVIDOR NODE (Node > Nginx; sem requestTimeout) ===== */
fastify.after(() => {
  fastify.server.requestTimeout = 0; // não encerrar por timeout no Node
  fastify.server.keepAliveTimeout = Number(process.env.NODE_KEEPALIVE_TIMEOUT_MS ?? 15_000);
  fastify.server.headersTimeout    = Number(process.env.NODE_HEADERS_TIMEOUT_MS    ?? 20_000);
});

/* ===== HEALTH ===== */
fastify.get('/health', async () => ({ ok: true }));

/* ===== ÍNDICES IDEMPOTENTES ===== */
async function ensureIndexes() {
  const stmts = [
    `CREATE INDEX IF NOT EXISTS idx_transactions_account_created_at
       ON transactions (account_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_account_id
       ON transactions (account_id)`
  ];
  for (const sql of stmts) { try { await pool.query(sql); } catch {} }
}

/* ===== HELPERS ===== */
const isPosInt = n => Number.isInteger(n) && n > 0;
const sanitizeDesc = s => (typeof s === 'string' && s.length>=1 && s.length<=10 && !/[\r\n]/.test(s)) ? s : null;

/* ===== AQUISIÇÃO DE CONEXÃO COM TIMEOUT → 503 SE SATURAR ===== */
async function withClientOr503(reply, fn) {
  const acquireTimeout = Number(process.env.POOL_ACQUIRE_TIMEOUT_MS ?? 1500);
  let timer, client, timeoutErr;
  try {
    const pending = pool.connect();
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => { timeoutErr = new Error('acquire_timeout'); rej(timeoutErr); }, acquireTimeout);
    });
    client = await Promise.race([pending, timeout]);
    return await fn(client);
  } catch (e) {
    if (e && e.message === 'acquire_timeout') return reply.code(503).send({ error: 'sobrecarga' });
    throw e;
  } finally {
    clearTimeout(timer);
    if (client) client.release();
  }
}

/* ===== BACKPRESSURE (ligado ao tamanho do pool) ===== */
const MAX_INFLIGHT_TX   = Number(process.env.MAX_INFLIGHT_TX   ?? Math.max(10, PG_MAX * 2));
const MAX_INFLIGHT_READ = Number(process.env.MAX_INFLIGHT_READ ?? Math.max(10, PG_MAX * 2));
let inflightTx = 0;
let inflightRead = 0;

/* ===== ROTAS ===== */

// Extrato
fastify.get('/clientes/:id/extrato', async (req, reply) => {
  if (inflightRead >= MAX_INFLIGHT_READ) return reply.code(503).send({ error: 'sobrecarga' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id inválido' });

  inflightRead++;
  try {
    return await withClientOr503(reply, async (client) => {
      const acc = await client.query({
        name: 'sel_acc',
        text: 'SELECT balance, account_limit FROM accounts WHERE id=$1',
        values: [id]
      });
      if (acc.rowCount === 0) return reply.code(404).send({ error: 'cliente não encontrado' });

      const txs = await client.query({
        name: 'sel_last10',
        text: `SELECT amount, type, description, created_at
                 FROM transactions
                WHERE account_id=$1
                ORDER BY created_at DESC, id DESC
                LIMIT 10`,
        values: [id]
      });

      return reply.code(200).send({
        saldo: {
          total: acc.rows[0].balance,
          data_extrato: new Date().toISOString(),
          limite: acc.rows[0].account_limit
        },
        ultimas_transacoes: txs.rows.map(r => ({
          valor: r.amount,
          tipo: r.type,
          descricao: r.description,
          realizada_em: r.created_at.toISOString()
        }))
      });
    });
  } catch {
    return reply.code(500).send({ error: 'erro interno' });
  } finally {
    inflightRead--;
  }
});

// Transações (crédito/débito) — resposta no TOPO: { limite, saldo }
fastify.post('/clientes/:id/transacoes', async (req, reply) => {
  if (inflightTx >= MAX_INFLIGHT_TX) return reply.code(503).send({ error: 'sobrecarga' });

  const id = Number(req.params.id);
  const { valor, tipo, descricao } = req.body ?? {};
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id inválido' });
  if (!isPosInt(valor)) return reply.code(400).send({ error: 'valor inválido' });
  if (tipo !== 'c' && tipo !== 'd') return reply.code(400).send({ error: 'tipo inválido' });
  const desc = sanitizeDesc(descricao);
  if (!desc) return reply.code(400).send({ error: 'descricao inválida' });

  inflightTx++;
  try {
    return await withClientOr503(reply, async (client) => {
      await client.query('BEGIN');
      if ((process.env.PG_SYNC_COMMIT || '').toLowerCase() === 'off') {
        await client.query('SET LOCAL synchronous_commit = off');
      }

      const delta = (tipo === 'c') ? valor : -valor;
      const upd = await client.query({
        name: 'upd_balance',
        text: `UPDATE accounts
                  SET balance = balance + $1
                WHERE id = $2
                  AND (balance + $1) >= -account_limit
                RETURNING balance, account_limit`,
        values: [delta, id]
      });

      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        return reply.code(422).send({ error: 'limite excedido' });
      }

      await client.query({
        name: 'ins_tx',
        text: `INSERT INTO transactions (amount, type, description, created_at, account_id)
               VALUES ($1, $2, $3, NOW(), $4)`,
        values: [valor, tipo, desc, id]
      });

      await client.query('COMMIT');

      return reply.code(200).send({
        limite: upd.rows[0].account_limit,
        saldo:  upd.rows[0].balance
      });
    });
  } catch {
    try { await pool.query('ROLLBACK'); } catch {}
    return reply.code(500).send({ error: 'erro interno' });
  } finally {
    inflightTx--;
  }
});

/* ===== START ===== */
(async function start() {
  try {
    await ensureIndexes();
    await fastify.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
  } catch {
    process.exit(1);
  }
})();
