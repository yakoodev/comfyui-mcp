const fastifyFactory = require("fastify");

const buildApp = () => {
  const fastify = fastifyFactory({ logger: true });

  fastify.get("/health", async () => ({ status: "ok" }));

  return fastify;
};

module.exports = {
  buildApp,
};
