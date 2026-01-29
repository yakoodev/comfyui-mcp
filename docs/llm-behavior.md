# Поведение LLM и формат инструментов (MCP)

Документ описывает, как LLM будет взаимодействовать с сервером comfyui-mcp и в каком формате будут представлены инструменты.

## Поведение LLM в рамках comfyui-mcp

1. **Получение списка инструментов**
   LLM запрашивает `/tools` (или MCP `tools/list`) и получает список доступных инструментов, сформированных из `config` и `workflows`.
2. **Выбор инструмента**
   На основе запроса пользователя LLM выбирает наиболее подходящий инструмент и формирует параметры вызова, руководствуясь описанием полей.
3. **Вызов инструмента**
   LLM вызывает `/invoke` (или MCP `tools/call`) с параметрами. Сервер подставляет значения в workflow (по mapping конфигурации), дополняет поля с генерацией (например, seed), выполняет workflow и возвращает результат.
4. **Интерпретация результата**
   LLM получает ответ сервера (URL/метаданные результата), резюмирует и при необходимости предлагает следующий шаг.

## Каноническая структура инструмента (генерируемая сервером)

Каждый инструмент строится на основе конфига и имеет:
- `name`: уникальное имя для вызова (стабильное API для LLM).
- `description`: краткое назначение инструмента.
- `inputSchema`: JSON Schema для параметров.
- `mapping`: соответствие параметров входа параметрам нод ComfyUI (на сервере).

### Пример JSON Schema инструмента (MCP / tools/list)

```json
{
  "name": "txt2img_portrait",
  "description": "Генерация портретов (позитивный промпт + негативный промпт + seed)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "positive": {
        "type": "string",
        "description": "Позитивный промпт (text node #9)"
      },
      "negative": {
        "type": "string",
        "description": "Негативный промпт (text node #10)"
      },
      "seed": {
        "type": "integer",
        "description": "Сид генерации (если не передан — будет сгенерирован случайно)"
      }
    },
    "required": ["positive"],
    "additionalProperties": false
  }
}
```

## Пример входного конфига (config/tools.json)

```json
{
  "tools": [
    {
      "name": "txt2img_portrait",
      "description": "Генерация портретов",
      "workflow": "portrait.json",
      "fields": [
        {
          "name": "positive",
          "type": "string",
          "description": "Позитивный промпт",
          "mapping": { "nodeId": 9, "field": "text" }
        },
        {
          "name": "negative",
          "type": "string",
          "description": "Негативный промпт",
          "mapping": { "nodeId": 10, "field": "text" }
        },
        {
          "name": "seed",
          "type": "integer",
          "description": "Сид генерации",
          "generation": { "strategy": "randomInt", "min": 1, "max": 999999999 }
        }
      ]
    }
  ]
}
```

## Пример вызова инструмента (LLM → сервер)

### MCP-style (tools/call)

```json
{
  "name": "txt2img_portrait",
  "arguments": {
    "positive": "portrait photo, cinematic lighting",
    "negative": "blurry, low quality",
    "seed": 123456
  }
}
```

### OpenAI-style (function calling)

```json
{
  "type": "function",
  "function": {
    "name": "txt2img_portrait",
    "arguments": "{\"positive\":\"portrait photo, cinematic lighting\",\"negative\":\"blurry, low quality\",\"seed\":123456}"
  }
}
```

## Как сервер обрабатывает вызов

1. Валидирует входные данные по `inputSchema`.
2. Подставляет входные значения в `workflow` по `mapping`.
3. Генерирует отсутствующие поля с `generation`.
4. Отправляет workflow в ComfyUI API.
5. Возвращает метаданные результата (например, URL итогового изображения).

## Расширяемость

- Новые транспорты (SSE, Streamable HTTP, OpenAI-compat) добавляются как адаптеры поверх общего `toolBuilder`.
- Конфигурация остаётся централизованной (один формат, один schema), а разные протоколы используют один и тот же набор tools.

