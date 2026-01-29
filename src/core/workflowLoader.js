const fs = require("fs/promises");
const path = require("path");
const { z } = require("zod");

const workflowsDir = path.resolve(__dirname, "..", "..", "workflows");

const workflowNodeSchema = z
  .object({
    id: z.number().int(),
    type: z.string().min(1),
    pos: z.array(z.number()).length(2).optional(),
    size: z.array(z.number()).length(2).optional(),
    inputs: z.array(z.unknown()).optional(),
    outputs: z.array(z.unknown()).optional(),
    widgets_values: z.array(z.unknown()).optional(),
    properties: z.record(z.unknown()).optional(),
  })
  .passthrough();

const workflowSchema = z
  .object({
    last_node_id: z.number().int().nonnegative().optional(),
    last_link_id: z.number().int().nonnegative().optional(),
    nodes: z.array(workflowNodeSchema),
    links: z.array(z.unknown()).default([]),
  })
  .passthrough();

const resolveWorkflowPath = (workflowName) => {
  const safeName = workflowName.replace(/\.json$/i, "");
  const candidate = path.resolve(workflowsDir, `${safeName}.json`);

  if (!candidate.startsWith(workflowsDir + path.sep)) {
    throw new Error("Некорректное имя workflow.");
  }

  return candidate;
};

const loadWorkflow = async (workflowName) => {
  const filePath = resolveWorkflowPath(workflowName);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return workflowSchema.parse(parsed);
};

module.exports = {
  loadWorkflow,
  workflowSchema,
  workflowsDir,
};
