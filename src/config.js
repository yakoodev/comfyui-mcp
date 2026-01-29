const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
});

const config = configSchema.parse({
  PORT: process.env.PORT,
});

module.exports = {
  config,
};
