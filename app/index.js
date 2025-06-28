const fastify = require('fastify')({ logger: true });
const { Pool } = require('pg');
const dotenv = require("dotenv");
const os = require('os');

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
    try {
        const result = await pool.query('SELECT now()');
        return {
            "result.rows": result.rows,
            "port": process.env.PORT,
            "container": process.env.HOSTNAME
        };
    } catch (error) {
        console.error('Error:', error);
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
