const { createServerFromDisk } = require("../dist/server/index.js");

const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Некорректный JSON от ${url}: ${text}`);
  }
  return { response, data };
};

const run = async () => {
  const app = await createServerFromDisk({});
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = address.startsWith("http")
    ? address
    : `http://127.0.0.1:${app.server.address().port}`;

  try {
    const { response: toolsResponse, data: toolsPayload } = await fetchJson(
      `${baseUrl}/tools`,
    );
    if (!toolsResponse.ok || !toolsPayload || !Array.isArray(toolsPayload.tools)) {
      throw new Error(`Некорректный ответ /tools: ${toolsResponse.status}`);
    }

    const toolName =
      toolsPayload.tools.find((tool) => tool.name === "example-workflow")?.name ??
      toolsPayload.tools[0]?.name;

    if (!toolName) {
      throw new Error("Список инструментов пуст.");
    }

    const { response: invokeResponse, data: invokePayload } = await fetchJson(
      `${baseUrl}/invoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: toolName, params: {} }),
      },
    );

    if (!invokeResponse.ok || !invokePayload) {
      throw new Error(`Некорректный ответ /invoke: ${invokeResponse.status}`);
    }

    console.log("Smoke test OK");
  } finally {
    await app.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
