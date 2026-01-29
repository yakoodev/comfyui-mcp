import fastify, { FastifyInstance } from "fastify";
import { z } from "zod";
import dotenv from "dotenv";
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
  tool: string;
  params: Record<string, unknown>;
  workflow?: WorkflowGraph;
  warnings?: string[];
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

const invokeRequestSchema = z.object({
  tool: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});

const serverConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  TOOL_CONFIG_PATH: z.string().optional(),
  WORKFLOWS_DIR: z.string().optional(),
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

const findWorkflowNode = (workflow: WorkflowGraph, nodeKey: string) => {
  const numericKey = Number(nodeKey);
  const matchById = workflow.nodes.find((node) => node.id === numericKey);

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
    if (nodeRecord.properties && typeof nodeRecord.properties === "object") {
      (nodeRecord.properties as Record<string, unknown>)[field.mapping.attribute] = value;
    } else {
      nodeRecord[field.mapping.attribute] = value;
    }
  }

  return { workflow: clonedWorkflow, warnings };
};

class DefaultToolInvoker implements ToolInvoker {
  constructor(private readonly workflows: WorkflowRepository) {}

  async invoke(tool: ToolDefinition, params: Record<string, unknown>) {
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
  const transportAdapters = adapters ?? [new HttpTransportAdapter()];

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
}) => {
  const toolConfigPath = options.toolConfigPath ?? resolveDefaultConfigPath();
  const workflowsDir = options.workflowsDir ?? resolveDefaultWorkflowsDir();

  const [toolConfigs, workflows] = await Promise.all([
    loadToolConfigsFromFile(toolConfigPath).catch(() => []),
    loadWorkflowsFromDir(workflowsDir).catch(() => []),
  ]);

  return createServer({
    toolConfigs,
    workflows,
    adapters: options.adapters,
  });
};

export const startServer = async () => {
  dotenv.config();
  const env = serverConfigSchema.parse(process.env);
  const app = await createServerFromDisk({
    toolConfigPath: env.TOOL_CONFIG_PATH,
    workflowsDir: env.WORKFLOWS_DIR,
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
