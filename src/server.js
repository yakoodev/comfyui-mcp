const path = require("path");
const fs = require("fs");

const distEntry = path.resolve(__dirname, "..", "dist", "server", "index.js");

if (!fs.existsSync(distEntry)) {
  console.error(
    "Файл dist/server/index.js не найден. Сначала выполните `npm run build`.",
  );
  process.exit(1);
}

console.warn(
  "src/server.js устарел. Используйте `npm start` (dist/server/index.js).",
);

// eslint-disable-next-line import/no-dynamic-require, global-require
const { startServer } = require(distEntry);

startServer();
