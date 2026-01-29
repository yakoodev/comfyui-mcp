import fastify, { FastifyInstance } from "fastify";
import { z } from "zod";
import dotenv from "dotenv";
import fs from "fs/promises";
import {
  buildTools,
  resolveDefaultConfigPath,
  resolveDefaultWorkflowsDir,
  ToolConfig,
  ToolDefinition,
  ToolFieldConfig,
  WorkflowDefinition,
  WorkflowGraph,
  loadToolConfigsFromFile,
  loadWorkflowsFromDir,
} from "../mcp/toolBuilder";
import { ComfyUiClient } from "../core/comfyUiClient";

export interface ToolRepository {
  list: () => Promise<ToolDefinition[]>;
  getByName: (name: string) => Promise<ToolDefinition | undefined>;
}

export interface WorkflowRepository {
  list: () => Promise<WorkflowDefinition[]>;
  getByName: (name: string) => Promise<WorkflowDefinition | undefined>;
}

export interface InvokeResult {
  status: "ok" | "error";
  tool?: string;
  params?: Record<string, unknown>;
  workflow?: WorkflowGraph;
  warnings?: string[];
  resultUrl?: string;
  message?: string;
}

export interface ToolInvoker {
  invoke: (tool: ToolDefinition, params: Record<string, unknown>) => Promise<InvokeResult>;
}

export interface TransportContext {
  tools: ToolRepository;
  workflows: WorkflowRepository;
  invoker: ToolInvoker;
}

export interface TransportAdapter {
  name: string;
  register: (app: FastifyInstance, context: TransportContext) => Promise<void> | void;
}

export interface ServerOptions {
  toolConfigs?: ToolConfig[];
  workflows?: WorkflowDefinition[];
  adapters?: TransportAdapter[];
  toolRepository?: ToolRepository;
  workflowRepository?: WorkflowRepository;
  invoker?: ToolInvoker;
}

interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: McpJsonRpcError;
}

const invokeRequestSchema = z.object({
  tool: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});

const serverConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  TOOL_CONFIG_PATH: z.string().optional(),
  WORKFLOWS_DIR: z.string().optional(),
  COMFYUI_URL: z.string().optional(),
  COMFYUI_POLL_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  COMFYUI_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});

class InMemoryToolRepository implements ToolRepository {
  constructor(private readonly tools: ToolDefinition[]) {}

  async list() {
    return this.tools;
  }

  async getByName(name: string) {
    return this.tools.find((tool) => tool.name === name);
  }
}

class InMemoryWorkflowRepository implements WorkflowRepository {
  constructor(private readonly workflows: WorkflowDefinition[]) {}

  async list() {
    return this.workflows;
  }

  async getByName(name: string) {
    return this.workflows.find((workflow) => workflow.name === name);
  }
}

const findWorkflowNode = (workflow: WorkflowGraph, nodeKey: string | number) => {
  const numericKey = Number(nodeKey);
  const matchById = Number.isFinite(numericKey)
    ? workflow.nodes.find((node) => node.id === numericKey)
    : undefined;

  if (matchById) {
    return matchById;
  }

  return workflow.nodes.find((node) => node.type === nodeKey);
};

const resolveFieldValue = (
  field: ToolFieldConfig,
  params: Record<string, unknown>,
): { value?: unknown; warning?: string } => {
  if (Object.prototype.hasOwnProperty.call(params, field.name)) {
    return { value: params[field.name] };
  }

  if (!field.generator) {
    return { warning: `Поле ${field.name} отсутствует во входных данных.` };
  }

  if (field.generator.type === "seed") {
    return { value: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) };
  }

  if (field.generator.type === "random") {
    return { value: Math.random() };
  }

  return { warning: `Генератор ${field.generator.type} пока не поддерживается.` };
};

const setNestedValue = (
  target: Record<string, unknown>,
  attributePath: string,
  value: unknown,
) => {
  const segments = attributePath.split(".").filter(Boolean);
  if (!segments.length) {
    return;
  }

  let current: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextValue = current[segment];
    if (!nextValue || typeof nextValue !== "object") {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  current[segments[segments.length - 1]] = value;
};

const applyToolParamsToWorkflow = (
  workflow: WorkflowGraph,
  tool: ToolDefinition,
  params: Record<string, unknown>,
): { workflow: WorkflowGraph; warnings: string[] } => {
  const clonedWorkflow = structuredClone(workflow) as WorkflowGraph;
  const warnings: string[] = [];

  for (const field of tool.fields) {
    const node = findWorkflowNode(clonedWorkflow, field.mapping.node);
    if (!node) {
      warnings.push(`Нода ${field.mapping.node} не найдена в workflow.`);
      continue;
    }

    const { value, warning } = resolveFieldValue(field, params);
    if (warning) {
      warnings.push(warning);
    }
    if (typeof value === "undefined") {
      continue;
    }

    const nodeRecord = node as Record<string, unknown>;
    if (field.mapping.attribute.includes(".")) {
      setNestedValue(nodeRecord, field.mapping.attribute, value);
      continue;
    }

    if (nodeRecord.inputs && typeof nodeRecord.inputs === "object") {
      (nodeRecord.inputs as Record<string, unknown>)[field.mapping.attribute] = value;
    } else if (nodeRecord.properties && typeof nodeRecord.properties === "object") {
      (nodeRecord.properties as Record<string, unknown>)[field.mapping.attribute] = value;
    } else {
      nodeRecord[field.mapping.attribute] = value;
    }
  }

  return { workflow: clonedWorkflow, warnings };
};

class DefaultToolInvoker implements ToolInvoker {
  constructor(private readonly workflows: WorkflowRepository) {}

  async invoke(tool: ToolDefinition, params: Record<string, unknown>): Promise<InvokeResult> {
    if (!tool.workflowName) {
      return {
        status: "error",
        tool: tool.name,
        params,
        message: `Для инструмента ${tool.name} не указан workflow.`,
      } satisfies InvokeResult;
    }

    const workflow = await this.workflows.getByName(tool.workflowName);
    if (!workflow) {
      return {
        status: "error",
        tool: tool.name,
        params,
        message: `Workflow ${tool.workflowName} не найден.`,
      } satisfies InvokeResult;
    }

    const { workflow: updatedWorkflow, warnings } = applyToolParamsToWorkflow(
      workflow.data,
      tool,
      params,
    );

    return {
      status: "ok",
      tool: tool.name,
      params,
      workflow: updatedWorkflow,
      warnings: warnings.length ? warnings : undefined,
    } satisfies InvokeResult;
  }
}

class ComfyUiToolInvoker implements ToolInvoker {
  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly client: ComfyUiClient,
  ) {}

  async invoke(tool: ToolDefinition, params: Record<string, unknown>): Promise<InvokeResult> {
    if (!tool.workflowName) {
      return {
        status: "error",
        tool: tool.name,
        params,
        message: `Для инструмента ${tool.name} не указан workflow.`,
      } satisfies InvokeResult;
    }

    const workflow = await this.workflows.getByName(tool.workflowName);
    if (!workflow) {
      return {
        status: "error",
        tool: tool.name,
        params,
        message: `Workflow ${tool.workflowName} не найден.`,
      } satisfies InvokeResult;
    }

    const { workflow: updatedWorkflow, warnings } = applyToolParamsToWorkflow(
      workflow.data,
      tool,
      params,
    );

    const promptId = await this.client.queuePrompt(updatedWorkflow);
    const resultUrl = await this.client.waitForCompletion(promptId);

    return {
      status: "ok",
      resultUrl,
    } satisfies InvokeResult;
  }
}

export class HttpTransportAdapter implements TransportAdapter {
  name = "http";

  register(app: FastifyInstance, context: TransportContext) {
    app.get("/tools", async () => ({ tools: await context.tools.list() }));

    app.post("/invoke", async (request, reply) => {
      const parsed = invokeRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return {
          status: "error",
          message: "Некорректный формат запроса.",
          issues: parsed.error.issues,
        };
      }

      const tool = await context.tools.getByName(parsed.data.tool);
      if (!tool) {
        reply.code(404);
        return {
          status: "error",
          message: `Инструмент ${parsed.data.tool} не найден.`,
        };
      }

      const result = await context.invoker.invoke(tool, parsed.data.params);
      if (result.status === "error") {
        reply.code(400);
      }
      return result;
    });
  }
}

const buildToolInputSchema = (fields: ToolFieldConfig[]) => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of fields) {
    const extra = field as ToolFieldConfig & { required?: boolean; default?: unknown };
    const schema: Record<string, unknown> = {
      type: field.type,
      description: field.description,
    };

    if (typeof extra.default !== "undefined") {
      schema.default = extra.default;
    }

    properties[field.name] = schema;

    const isRequired =
      extra.required === true ||
      (extra.required === undefined &&
        typeof extra.default === "undefined" &&
        !field.generator);
    if (isRequired) {
      required.push(field.name);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length ? required : undefined,
  };
};

const buildMcpTools = (tools: ToolDefinition[]) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: buildToolInputSchema(tool.fields),
  }));

const buildBaseUrl = (request: { headers: Record<string, string | string[] | undefined>; hostname: string; protocol?: string; }) => {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol =
    typeof forwardedProto === "string"
      ? forwardedProto
      : request.protocol ?? "http";
  return `${protocol}://${request.hostname}`;
};

const respondJsonRpc = (
  reply: { send: (payload: McpJsonRpcResponse) => void },
  response: McpJsonRpcResponse,
) => {
  reply.send(response);
};

export class McpTransportAdapter implements TransportAdapter {
  name = "mcp";

  register(app: FastifyInstance, context: TransportContext) {
    const wellKnownHandler = async (request: { hostname: string; protocol?: string; headers: Record<string, string | string[] | undefined>; }) => {
      const baseUrl = buildBaseUrl(request);
      return {
        resource: `${baseUrl}/mcp`,
        authorization_servers: [],
      };
    };

    app.get("/.well-known/oauth-protected-resource", wellKnownHandler);
    app.get("/.well-known/oauth-protected-resource/mcp", wellKnownHandler);

    app.head("/mcp", async (_request, reply) => {
      reply.code(204);
    });

    app.get("/mcp", async () => ({ status: "ok" }));

    app.post("/mcp", async (request, reply) => {
      const body = (request.body ?? {}) as McpJsonRpcRequest;
      if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
        respondJsonRpc(reply, {
          jsonrpc: "2.0",
          id: body?.id ?? null,
          error: {
            code: -32600,
            message: "Некорректный JSON-RPC запрос.",
          },
        });
        return;
      }

      const respond = (result?: unknown, error?: McpJsonRpcError) =>
        respondJsonRpc(reply, {
          jsonrpc: "2.0",
          id: body.id ?? null,
          result,
          error,
        });

      if (body.method === "initialize") {
        const protocolVersion =
          typeof body.params?.protocolVersion === "string"
            ? body.params.protocolVersion
            : "2024-11-05";
        respond({
          protocolVersion,
          serverInfo: {
            name: "comfyui-mcp",
            version: "1.0.0",
          },
          capabilities: {
            tools: {},
          },
        });
        return;
      }

      if (body.method === "tools/list") {
        const tools = await context.tools.list();
        respond({ tools: buildMcpTools(tools) });
        return;
      }

      if (body.method === "tools/call") {
        const toolName = body.params?.name;
        const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
        if (typeof toolName !== "string") {
          respond(undefined, {
            code: -32602,
            message: "Не указан инструмент для вызова.",
          });
          return;
        }

        const tool = await context.tools.getByName(toolName);
        if (!tool) {
          respond(undefined, {
            code: -32602,
            message: `Инструмент ${toolName} не найден.`,
          });
          return;
        }

        const result = await context.invoker.invoke(tool, args);
        respond({
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          isError: result.status === "error",
        });
        return;
      }

      if (body.method === "resources/list") {
        respond({ resources: [] });
        return;
      }

      respond(undefined, {
        code: -32601,
        message: `Метод ${body.method} не поддерживается.`,
      });
    });
  }
}

export class SseTransportAdapter implements TransportAdapter {
  name = "sse";

  register() {
    throw new Error("SSE адаптер не реализован. Создайте свой адаптер на базе TransportAdapter.");
  }
}

export class StreamableHttpTransportAdapter implements TransportAdapter {
  name = "streamable-http";

  register() {
    throw new Error(
      "Streamable HTTP адаптер не реализован. Создайте свой адаптер на базе TransportAdapter.",
    );
  }
}

export class OpenAiCompatibleTransportAdapter implements TransportAdapter {
  name = "openai-compatible";

  register() {
    throw new Error(
      "OpenAI-compatible адаптер не реализован. Создайте свой адаптер на базе TransportAdapter.",
    );
  }
}

export const createServer = async ({
  toolConfigs = [],
  workflows = [],
  adapters,
  toolRepository,
  workflowRepository,
  invoker,
}: ServerOptions) => {
  const tools = buildTools({
    toolConfigs,
    workflows,
  });

  const workflowRepo = workflowRepository ?? new InMemoryWorkflowRepository(workflows);
  const toolRepo = toolRepository ?? new InMemoryToolRepository(tools);
  const toolInvoker = invoker ?? new DefaultToolInvoker(workflowRepo);

  const app = fastify({ logger: true });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/health", async () => ({ status: "ok" }));
  const transportAdapters = adapters ?? [new HttpTransportAdapter(), new McpTransportAdapter()];

  for (const adapter of transportAdapters) {
    await adapter.register(app, {
      tools: toolRepo,
      workflows: workflowRepo,
      invoker: toolInvoker,
    });
  }

  return app;
};

export const createServerFromDisk = async (options: {
  toolConfigPath?: string;
  workflowsDir?: string;
  adapters?: TransportAdapter[];
  invokerFactory?: (workflows: WorkflowRepository) => ToolInvoker;
}) => {
  const toolConfigPath = options.toolConfigPath ?? resolveDefaultConfigPath();
  const workflowsDir = options.workflowsDir ?? resolveDefaultWorkflowsDir();
  const resolveExists = async (targetPath: string) => {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  };
  const toolConfigExists = await resolveExists(toolConfigPath);
  const workflowsDirExists = await resolveExists(workflowsDir);

  let toolConfigs: ToolConfig[] = [];
  if (!toolConfigExists) {
    console.error(`Файл tools.json не найден по пути: ${toolConfigPath}`);
  } else {
    try {
      toolConfigs = await loadToolConfigsFromFile(toolConfigPath);
    } catch (error) {
      console.error(
        `Ошибка чтения tools.json по пути ${toolConfigPath}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  let workflows: WorkflowDefinition[] = [];
  if (!workflowsDirExists) {
    console.error(`Директория workflows не найдена по пути: ${workflowsDir}`);
  } else {
    try {
      workflows = await loadWorkflowsFromDir(workflowsDir);
    } catch (error) {
      console.error(
        `Ошибка чтения workflows из директории ${workflowsDir}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const tools = buildTools({
    toolConfigs,
    workflows,
  });
  const workflowMap = new Map(workflows.map((workflow) => [workflow.name, workflow]));
  const logPrefix = "\x1b[1mTOOLS_BOOT\x1b[0m";
  console.log(
    `${logPrefix} config=${toolConfigPath} workflows=${workflowsDir} tools.json=${toolConfigExists ? "yes" : "no"} toolsConfigured=${toolConfigs.length} toolsLoaded=${tools.length} workflowsLoaded=${workflows.length}`,
  );

  const validTools: ToolDefinition[] = [];
  for (const tool of tools) {
    if (!tool.workflowName) {
      console.error(
        `Инструмент ${tool.name} пропущен: workflow не указан (source=${tool.source}).`,
      );
      continue;
    }

    const workflow = workflowMap.get(tool.workflowName);
    if (!workflow) {
      console.error(
        `Инструмент ${tool.name} пропущен: workflow ${tool.workflowName} не найден.`,
      );
      continue;
    }

    console.log(
      `Инструмент ${tool.name} связан с workflow ${tool.workflowName}; nodes=${workflow.data.nodes.length}.`,
    );
    validTools.push(tool);
  }

  const workflowRepository = new InMemoryWorkflowRepository(workflows);
  const toolRepository = new InMemoryToolRepository(validTools);

  return createServer({
    toolConfigs,
    workflows,
    adapters: options.adapters,
    toolRepository,
    workflowRepository,
    invoker: options.invokerFactory?.(workflowRepository),
  });
};

export const startServer = async () => {
  dotenv.config();
  const env = serverConfigSchema.parse(process.env);
  const comfyUiClient =
    env.COMFYUI_URL && env.COMFYUI_URL.length > 0
      ? new ComfyUiClient({
          baseUrl: env.COMFYUI_URL,
          pollIntervalMs: env.COMFYUI_POLL_INTERVAL_MS,
          timeoutMs: env.COMFYUI_TIMEOUT_MS,
        })
      : undefined;
  const app = await createServerFromDisk({
    toolConfigPath: env.TOOL_CONFIG_PATH,
    workflowsDir: env.WORKFLOWS_DIR,
    invokerFactory: comfyUiClient
      ? (workflowRepo) => new ComfyUiToolInvoker(workflowRepo, comfyUiClient)
      : undefined,
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  return app;
};

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
