# Поведение LLM и формат инструментов (MCP)

Документ описывает, как LLM работает с comfyui-mcp, и какой формат инструментов
ожидается в ответах `/tools` и в вызовах `/invoke`.

## 1. Поведение LLM в рамках comfyui-mcp

1. **Получить список инструментов**
   - LLM вызывает `GET /tools`.
   - Сервер возвращает массив инструментов с `name`, `description`, `inputSchema`.
2. **Выбрать инструмент**
   - LLM выбирает инструмент по описанию и схеме входа.
3. **Вызвать инструмент**
   - LLM вызывает `POST /invoke` с параметрами.
   - Сервер подставляет значения в workflow по `mapping`, дополняет генераторами.
4. **Обработать результат**
   - Если `COMFYUI_URL` не задан — возвращается обновлённый workflow.
   - Если `COMFYUI_URL` задан — возвращается `resultUrl`.

## 2. Формат инструментов, который отдаёт сервер

Инструменты строятся из `config/*.json` и `workflows/*.json`.
Каждый инструмент имеет:
- `name` — уникальное имя.
- `description` — назначение.
- `inputSchema` — JSON Schema параметров.

### Пример ответа `/tools`

```json
{
  "tools": [
    {
      "name": "example",
      "description": "Тестовый txt2img workflow",
      "inputSchema": {
        "type": "object",
        "properties": {
          "positive_prompt": {
            "type": "string",
            "description": "Позитивный промпт"
          },
          "negative_prompt": {
            "type": "string",
            "description": "Негативный промпт",
            "default": ""
          },
          "seed": {
            "type": "integer",
            "description": "Seed для KSampler"
          }
        },
        "required": ["positive_prompt"]
      }
    }
  ]
}
```

## 3. Формат вызова инструмента

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

## 4. Как сервер применяет параметры

1. **Валидация** по `inputSchema`.
2. **Подстановка** значений по `mapping` (node + attribute).
3. **Генерация** отсутствующих параметров (`seed` / `random`).
4. **Результат**:
   - без ComfyUI — возвращается обновлённый workflow;
   - с ComfyUI — возвращается `resultUrl`.

## 5. Структура tool-config (на входе)

Формат поддерживает **объект** с `tools` или **массив**.

```json
[
  {
    "name": "example",
    "description": "Тестовый txt2img workflow",
    "fields": [
      {
        "name": "positive_prompt",
        "type": "string",
        "description": "Позитивный промпт",
        "required": true,
        "mapping": { "node": 6, "attribute": "text" }
      }
    ]
  }
]
```

### Поле `mapping`

- `node` — ID ноды из API export **или** `class_type`.
- `attribute` — атрибут, куда подставляем значение (`inputs.text`, `seed`, и т.п.).
- Если `attribute` содержит точку (`inputs.text`) — подстановка идёт по пути.

## 6. Расширяемость

- **Новые транспорты** добавляются как `TransportAdapter` (SSE, streamable HTTP, OpenAI-compat).
- **Логику вызова** можно заменить через `ToolInvoker`.
- **Хранилище** инструментов/Workflow можно заменить через `ToolRepository`/`WorkflowRepository`.

Цель — держать конфигурацию и расширение в одном месте без разрастания кода.
