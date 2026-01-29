const fastify = require("fastify")({ logger: true });
const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
});

const config = configSchema.parse({
  PORT: process.env.PORT,
});

fastify.get("/health", async () => ({ status: "ok" }));

const start = async () => {
  try {
    await fastify.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
