const { buildApp } = require("./app");
const { config } = require("./config");

const app = buildApp();

const start = async () => {
  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
