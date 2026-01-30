# LLM behavior and tool format (MCP)

This document describes how the LLM works with comfyui-mcp and the expected tool
format in `/tools` responses and `/invoke` calls.

## 1. LLM behavior within comfyui-mcp

1. **Get the tool list**
   - The LLM calls `GET /tools`.
   - The server returns an array of tools with `name`, `description`, `inputSchema`.
2. **Choose a tool**
   - The LLM selects a tool by description and input schema.
3. **Invoke the tool**
   - The LLM calls `POST /invoke` with parameters.
   - The server injects values into the workflow via `mapping`, adds generators.
4. **Handle the result**
   - If `COMFYUI_URL` is not set — returns the updated workflow.
   - If `COMFYUI_URL` is set — returns `resultUrl`.

## 2. Tool format returned by the server

Tools are built from `config/*.json` and `workflows/*.json`.
Each tool has:
- `name` — unique name.
- `description` — purpose.
- `inputSchema` — JSON Schema for parameters.

### Example `/tools` response

```json
{
  "tools": [
    {
      "name": "example",
      "description": "Test txt2img workflow",
      "inputSchema": {
        "type": "object",
        "properties": {
          "positive_prompt": {
            "type": "string",
            "description": "Positive prompt"
          },
          "negative_prompt": {
            "type": "string",
            "description": "Negative prompt",
            "default": ""
          },
          "seed": {
            "type": "integer",
            "description": "Seed for KSampler"
          }
        },
        "required": ["positive_prompt"]
      }
    }
  ]
}
```

## 3. Tool invocation format

### HTTP

```json
POST /invoke
{
  "tool": "example",
  "params": {
    "positive_prompt": "portrait photo, cinematic lighting",
    "negative_prompt": "blurry, watermark",
    "seed": 123456
  }
}
```

### MCP-style (tools/call)

```json
{
  "name": "example",
  "arguments": {
    "positive_prompt": "portrait photo, cinematic lighting",
    "negative_prompt": "blurry, watermark",
    "seed": 123456
  }
}
```

### OpenAI-style (function calling)

```json
{
  "type": "function",
  "function": {
    "name": "example",
    "arguments": "{\"positive_prompt\":\"portrait photo, cinematic lighting\",\"negative_prompt\":\"blurry, watermark\",\"seed\":123456}"
  }
}
```

## 4. How the server applies parameters

1. **Validation** against `inputSchema`.
2. **Injection** by `mapping` (node + attribute).
3. **Generation** of missing parameters (`seed` / `random`).
4. **Result**:
   - without ComfyUI — returns updated workflow;
   - with ComfyUI — returns `resultUrl`.

## 5. Tool-config structure (input)

The format supports an **object** with `tools` or an **array**.

```json
[
  {
    "name": "example",
    "description": "Test txt2img workflow",
    "fields": [
      {
        "name": "positive_prompt",
        "type": "string",
        "description": "Positive prompt",
        "required": true,
        "mapping": { "node": 6, "attribute": "text" }
      }
    ]
  }
]
```

### `mapping` field

- `node` — node ID from API export **or** `class_type`.
- `attribute` — attribute to inject into (`inputs.text`, `seed`, etc.).
- If `attribute` contains a dot (`inputs.text`), injection follows the path.

## 6. Extensibility

- **New transports** are added as `TransportAdapter` (SSE, streamable HTTP, OpenAI-compat).
- **Invocation logic** can be replaced via `ToolInvoker`.
- **Tool/workflow storage** can be replaced via `ToolRepository`/`WorkflowRepository`.

Goal: keep configuration and extension in one place without code sprawl.
