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

fastify.post('/clientes/:id/transacoes', async (request, reply) => {
    return {
        "id": request.params.id,
        "body": request.body,
        "port": process.env.PORT,
        "container": process.env.HOSTNAME,
        "DB_PORT": process.env.DB_PORT
    };
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
