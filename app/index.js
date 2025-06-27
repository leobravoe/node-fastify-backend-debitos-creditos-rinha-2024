const fastify = require('fastify')({ logger: true });
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,         // Porta do servidor PostgreSQL
  user: 'postgres',
  password: 'postgres',
  database: 'postgres_api_db'
});

fastify.get('/', async (request, reply) => {
  const result = await pool.query('SELECT NOW()');
  return {
    instancia: process.env.HOSTNAME,
    horario_db: result.rows[0].now
  };
});

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
