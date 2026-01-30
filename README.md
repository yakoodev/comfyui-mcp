# comfyui-mcp

A packaged scaffold for integrating **ComfyUI** with **MCP** and a standard HTTP API.
The project is built for extensibility: tool/workflow configuration lives in separate files,
while tool construction and invocation logic are centralized in a single place.

## What it does

- Reads **workflow JSON** exported from ComfyUI (API export).
- Reads **tool configuration** (fields, types, node mappings).
- Serves tool list via `/tools`.
- Accepts `/invoke`, injects parameters into the workflow and:
  - returns the updated graph (without ComfyUI), or
  - sends it to ComfyUI (if `COMFYUI_URL` is set).

## Quick start (demo)

A **working example** is included:
- `config/example.json`
- `workflows/example.json`

### 1) Run locally

```bash
npm install
npm run build

# Run with the example
TOOL_CONFIG_PATH=config/example.json \
WORKFLOWS_DIR=workflows \
npm start
```

Check tools:

```bash
curl http://localhost:3000/tools | jq
```

Invoke (without ComfyUI — returns updated workflow):

```bash
curl -X POST http://localhost:3000/invoke \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "example",
    "params": {
      "positive_prompt": "A cute cat, studio light",
      "negative_prompt": "watermark, low quality"
    }
  }' | jq
```

### 2) Run with ComfyUI

If ComfyUI is running (usually `http://localhost:8188`), set `COMFYUI_URL`:

```bash
COMFYUI_URL=http://localhost:8188 \
TOOL_CONFIG_PATH=config/example.json \
WORKFLOWS_DIR=workflows \
npm start
```

Now `/invoke` returns `resultUrl` with the generated image.

### 3) Docker / docker-compose

```bash
docker build -t comfyui-mcp .

# Example run with config file
# (config and workflows are mounted as volumes in docker-compose)
HOST_PORT=3003 docker compose up --build
```

---

# Precise usage guide

Below is a minimal but **exact and reproducible** flow for creating your own tool.

## Step 1. Export a workflow from ComfyUI

1. Open ComfyUI.
2. Build your graph (nodes + connections).
3. Export the **API workflow** (via the API export menu).
4. Save JSON to `workflows/<name>.json`.

**Important:** this server supports **both formats**:
- *ComfyUI API export* (object where keys are node ids).
- *Classic format with `nodes` and `links`*.

## Step 2. Create a tool config

The file can be an array or an object with `tools`.
For clarity, use **`config/example.json`**:

```json
[
  {
    "name": "example",
    "description": "Test txt2img workflow (ComfyUI API export): prompt replacement + KSampler seed generation.",
    "fields": [
      {
        "name": "positive_prompt",
        "description": "Positive prompt (CLIPTextEncode, node 6 -> text).",
        "type": "string",
        "required": true,
        "mapping": { "node": 6, "attribute": "text" }
      },
      {
        "name": "negative_prompt",
        "description": "Negative prompt (CLIPTextEncode, node 7 -> text).",
        "type": "string",
        "required": false,
        "default": "",
        "mapping": { "node": 7, "attribute": "text" }
      },
      {
        "name": "seed",
        "description": "Seed for KSampler (node 3 -> seed). Auto-generated if missing.",
        "type": "integer",
        "required": false,
        "generator": { "type": "seed", "options": { "min": 0, "max": 4294967295 } },
        "mapping": { "node": 3, "attribute": "seed" }
      }
    ]
  }
]
```

### How `mapping` works

- `mapping.node` — **node ID** (from API export) **or** its `class_type`.
- `mapping.attribute` — field inside the node (`inputs.text`, `seed`, etc.).
- If `attribute` contains `.` it is treated as a nested path.

### How `required` and `default` work

- If a field is **required**, it must be provided in inputs.
- If `default` is set, it is used as the default value.
- If neither `required` nor `default` is set and there is no generator, the field is optional.

### Value generation (`generator`)

Supported:
- `seed` — generates a random integer (`Math.random * MAX_SAFE_INTEGER`).
- `random` — generates a float `0..1`.

## Step 3. Start the server

```bash
TOOL_CONFIG_PATH=config/example.json \
WORKFLOWS_DIR=workflows \
npm start
```

## Step 4. List tools

```bash
curl http://localhost:3000/tools | jq
```

The response includes `name`, `description`, and JSON Schema for parameters.

## Step 5. Invoke a tool

```bash
curl -X POST http://localhost:3000/invoke \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "example",
    "params": {
      "positive_prompt": "A cute cat, studio light",
      "negative_prompt": "watermark, low quality",
      "seed": 42
    }
  }' | jq
```

---

# Architecture and extensibility

Key extension points live in one place (`src/server/index.ts`):

- **Tool Builder** — builds tools from config + workflow (`src/mcp/toolBuilder.ts`).
- **TransportAdapter** — add SSE, streaming, or OpenAI-compatible transport.
- **ToolInvoker** — replace invocation logic (queues, external job runners, etc.).

Goal: keep changes **centralized** without scattering logic across the codebase.

---

# Environment variables

- `PORT` — HTTP server port (default 3000).
- `TOOL_CONFIG_PATH` — tool config path (default `config/tools.json`).
- `WORKFLOWS_DIR` — directory with workflow JSON (default `workflows/`).
- `COMFYUI_URL` — ComfyUI API URL (if set, `/invoke` runs workflow in ComfyUI).
- `COMFYUI_POLL_INTERVAL_MS` — polling interval (default 1000 ms).
- `COMFYUI_TIMEOUT_MS` — timeout (default 5 minutes).
- `HOST_PORT` — port for docker-compose (default 3003).

---

# API

- `GET /tools` — list tools.
- `POST /invoke` — invoke a tool.
- `GET /health` / `GET /healthz` — health check.

---

# Documentation

- [LLM behavior and tool format (EN)](docs/llm-behavior.md)
- [LLM behavior and tool format (RU)](docs/llm-behavior.ru.md)
- [README на русском](README.ru.md)
