import { setTimeout as delay } from "timers/promises";
import type { WorkflowGraph } from "../mcp/toolBuilder";

export interface ComfyUiImage {
  filename: string;
  subfolder?: string;
  type?: string;
  url: string;
}

export interface ComfyUiGeneration {
  resultUrl: string;
}

export interface ComfyUiClientOptions {
  baseUrl: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type ComfyUiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
type PromptContainer = { prompt?: ComfyUiPrompt };

const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

const buildImageUrl = (baseUrl: string, image: { filename: string; subfolder?: string; type?: string }) => {
  const params = new URLSearchParams({ filename: image.filename });
  if (image.subfolder) {
    params.set("subfolder", image.subfolder);
  }
  if (image.type) {
    params.set("type", image.type);
  }
  return `${baseUrl}/view?${params.toString()}`;
};

const extractImages = (baseUrl: string, outputs: Record<string, unknown>) => {
  const images: ComfyUiImage[] = [];
  for (const output of Object.values(outputs)) {
    if (!output || typeof output !== "object") {
      continue;
    }
    const outputImages = (output as { images?: unknown }).images;
    if (!Array.isArray(outputImages)) {
      continue;
    }
    for (const image of outputImages) {
      if (!image || typeof image !== "object") {
        continue;
      }
      const typed = image as { filename?: string; subfolder?: string; type?: string };
      if (!typed.filename) {
        continue;
      }
      const imageWithFilename = {
        filename: typed.filename,
        subfolder: typed.subfolder,
        type: typed.type,
      };
      images.push({
        ...imageWithFilename,
        url: buildImageUrl(baseUrl, imageWithFilename),
      });
    }
  }
  return images;
};

const isPromptLike = (value: unknown): value is ComfyUiPrompt => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((node) => {
    if (!node || typeof node !== "object") {
      return false;
    }
    const candidate = node as { class_type?: unknown; inputs?: unknown };
    return typeof candidate.class_type === "string" && candidate.inputs !== undefined;
  });
};

const coerceRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

const buildPromptFromWorkflow = (workflow: WorkflowGraph): ComfyUiPrompt => {
  const workflowPrompt = (workflow as unknown as PromptContainer).prompt;
  if (isPromptLike(workflowPrompt)) {
    return workflowPrompt;
  }

  if (!Array.isArray(workflow.nodes)) {
    throw new Error("Workflow должен содержать nodes или prompt для ComfyUI.");
  }

  const prompt: ComfyUiPrompt = {};
  for (const node of workflow.nodes) {
    const nodeRecord = node as {
      id?: number;
      type?: string;
      class_type?: string;
      inputs?: Record<string, unknown> | unknown;
      properties?: Record<string, unknown>;
    };
    const nodeId = nodeRecord.id ?? Number.NaN;
    if (!Number.isFinite(nodeId)) {
      continue;
    }
    const classType = nodeRecord.class_type ?? nodeRecord.type;
    if (!classType) {
      continue;
    }
    const inputs =
      nodeRecord.inputs && !Array.isArray(nodeRecord.inputs) && typeof nodeRecord.inputs === "object"
        ? coerceRecord(nodeRecord.inputs)
        : coerceRecord(nodeRecord.properties);
    prompt[String(nodeId)] = {
      class_type: classType,
      inputs,
    };
  }

  if (!Object.keys(prompt).length) {
    throw new Error("Не удалось сформировать prompt для ComfyUI из workflow.");
  }

  return prompt;
};

export class ComfyUiClient {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: ComfyUiClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.fetcher = options.fetch ?? fetch;
  }

  async queuePrompt(workflow: WorkflowGraph) {
    const prompt = buildPromptFromWorkflow(workflow);
    const response = await this.fetcher(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
      throw new Error(`ComfyUI вернул ошибку ${response.status} при постановке в очередь.`);
    }

    const payload = (await response.json()) as { prompt_id?: string };
    if (!payload.prompt_id) {
      throw new Error("ComfyUI не вернул prompt_id.");
    }

    return payload.prompt_id;
  }

  async waitForCompletion(promptId: string): Promise<ComfyUiGeneration> {
    const startedAt = Date.now();
    while (true) {
      if (Date.now() - startedAt > this.timeoutMs) {
        throw new Error("Время ожидания ответа от ComfyUI истекло.");
      }

      const response = await this.fetcher(`${this.baseUrl}/history/${promptId}`, {
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) {
        throw new Error(`ComfyUI вернул ошибку ${response.status} при получении истории.`);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const historyEntry = (payload[promptId] ?? payload) as Record<string, unknown>;
      const outputs = (historyEntry.outputs ?? {}) as Record<string, unknown>;
      const images = extractImages(this.baseUrl, outputs);
      const status = historyEntry.status as { completed?: boolean } | undefined;
      const isCompleted = status?.completed === true || images.length > 0;

      if (isCompleted) {
        const resultUrl = images[0]?.url;
        if (!resultUrl) {
          throw new Error("ComfyUI завершил задачу, но не вернул изображение.");
        }
        return { resultUrl };
      }

      await delay(this.pollIntervalMs);
    }
  }
}
