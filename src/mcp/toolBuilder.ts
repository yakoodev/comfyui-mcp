import fs from "fs/promises";
import path from "path";
import { z } from "zod";

export type ToolFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array";

export interface ToolFieldMapping {
  node: string | number;
  attribute: string;
}

export interface ToolFieldGenerator {
  type: "seed" | "random";
  options?: Record<string, unknown>;
}

export interface ToolFieldConfig {
  name: string;
  description?: string;
  type: ToolFieldType;
  mapping: ToolFieldMapping;
  generator?: ToolFieldGenerator;
}

export interface ToolConfig {
  name: string;
  description?: string;
  fields: ToolFieldConfig[];
  workflow?: string;
}

export interface ToolConfigFile {
  version?: string;
  tools: ToolConfig[];
}

export interface WorkflowGraph {
  nodes: Array<{ id: number; type: string } & Record<string, unknown>>;
  links?: unknown[];
  [key: string]: unknown;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  data: WorkflowGraph;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  fields: ToolFieldConfig[];
  workflowName?: string;
  source: "config" | "workflow";
}

export interface ToolBuilderOptions {
  toolConfigs: ToolConfig[];
  workflows: WorkflowDefinition[];
  includeUnconfiguredWorkflows?: boolean;
  resolveWorkflowName?: (tool: ToolConfig, workflows: WorkflowDefinition[]) => string | undefined;
}

const toolFieldSchema = z
  .object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
  mapping: z.object({
    node: z.union([z.string().min(1), z.number().int()]),
    attribute: z.string().min(1),
  }),
  generator: z
    .object({
      type: z.enum(["seed", "random"]),
      options: z.record(z.unknown()).optional(),
    })
    .optional(),
})
  .passthrough();

const toolConfigSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    fields: z.array(toolFieldSchema).min(1),
    workflow: z.string().min(1).optional(),
  })
  .passthrough();

const toolConfigFileSchema = z.union([
  z.array(toolConfigSchema).min(1),
  z.object({
    version: z.string().optional(),
    tools: z.array(toolConfigSchema).min(1),
  }),
]);

const workflowNodeSchema = z
  .object({
    id: z.number().int(),
    type: z.string().min(1),
  })
  .passthrough();

const workflowSchema = z
  .object({
    nodes: z.array(workflowNodeSchema),
    links: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const loadToolConfigFile = async (filePath: string): Promise<ToolConfigFile> => {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const validated = toolConfigFileSchema.parse(parsed);
  if (Array.isArray(validated)) {
    return { tools: validated };
  }
  return validated;
};

const normalizeWorkflowGraph = (payload: unknown): WorkflowGraph => {
  const parsed = workflowSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload) && !("nodes" in payload)) {
    const nodes = Object.entries(payload as Record<string, Record<string, unknown>>)
      .map(([key, node]) => {
        const id = Number(key);
        if (!Number.isFinite(id)) {
          return null;
        }
        const type =
          typeof node.class_type === "string"
            ? node.class_type
            : typeof node.type === "string"
              ? node.type
              : "Unknown";
        return {
          id,
          type,
          ...node,
        };
      })
      .filter((node): node is { id: number; type: string } & Record<string, unknown> =>
        Boolean(node),
      );

    return workflowSchema.parse({
      nodes,
      links: [],
    });
  }

  throw new Error("Неподдерживаемый формат workflow.");
};

export const loadWorkflowsFromDir = async (dirPath: string): Promise<WorkflowDefinition[]> => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const workflows: WorkflowDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const workflowName = entry.name.replace(/\.json$/i, "");
    const filePath = path.join(dirPath, entry.name);

    try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const data = normalizeWorkflowGraph(parsed);

      workflows.push({
        name: workflowName,
        data,
      });
    } catch (error) {
      console.error(
        `Ошибка загрузки workflow ${workflowName} из ${filePath}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return workflows;
};

export const buildTools = ({
  toolConfigs,
  workflows,
  includeUnconfiguredWorkflows = true,
  resolveWorkflowName,
}: ToolBuilderOptions): ToolDefinition[] => {
  const workflowMap = new Map(workflows.map((workflow) => [workflow.name, workflow]));
  const resolveName =
    resolveWorkflowName ??
    ((tool: ToolConfig) => {
      if (tool.workflow) {
        return tool.workflow;
      }
      if (workflowMap.has(tool.name)) {
        return tool.name;
      }
      return undefined;
    });

  const toolsFromConfigs = toolConfigs.map((tool) => {
    const workflowName = resolveName(tool, workflows);
    return {
      name: tool.name,
      description: tool.description,
      fields: tool.fields,
      workflowName,
      source: "config",
    } satisfies ToolDefinition;
  });

  if (!includeUnconfiguredWorkflows) {
    return toolsFromConfigs;
  }

  const configuredNames = new Set(toolsFromConfigs.map((tool) => tool.name));
  const toolsFromWorkflows = workflows
    .filter((workflow) => !configuredNames.has(workflow.name))
    .map((workflow) => ({
      name: workflow.name,
      description: workflow.description ?? `Workflow ${workflow.name}`,
      fields: [],
      workflowName: workflow.name,
      source: "workflow",
    } satisfies ToolDefinition));

  return [...toolsFromConfigs, ...toolsFromWorkflows];
};

export const loadToolConfigsFromFile = async (filePath: string): Promise<ToolConfig[]> => {
  const configFile = await loadToolConfigFile(filePath);
  return configFile.tools;
};

export const resolveDefaultConfigPath = () =>
  path.resolve(process.cwd(), "config", "tools.json");

export const resolveDefaultWorkflowsDir = () =>
  path.resolve(process.cwd(), "workflows");
