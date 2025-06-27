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
  const result = await pool.query('SELECT now()');
  console.log("-------------------------------");
  console.log(result);
  console.log("-------------------------------");
  return result.rows;
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
