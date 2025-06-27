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
