# comfyui-mcp

Упакованный каркас для интеграции **ComfyUI** с **MCP** и обычным HTTP API.
Проект заточен под расширяемость: вся конфигурация инструментов и workflow живёт в
отдельных файлах, а логика построения инструментов и вызова — в одном месте.

## Что это делает

- Читает **workflow JSON**, экспортированные из ComfyUI (API export).
- Читает **конфигурацию инструментов** (поля, типы, маппинг на ноды).
- Отдаёт список инструментов через `/tools`.
- Принимает вызов через `/invoke`, подставляет параметры в workflow и:
  - либо возвращает обновлённый граф (без ComfyUI),
  - либо отправляет его в ComfyUI (если задан `COMFYUI_URL`).

## Быстрый старт (демо-версия)

В репозитории лежит **рабочий пример**:
- `config/example.json`
- `workflows/example.json`

### 1) Запуск локально

```bash
npm install
npm run build

# Запускаем с примером
TOOL_CONFIG_PATH=config/example.json \
WORKFLOWS_DIR=workflows \
npm start
```

Проверяем инструменты:

```bash
curl http://localhost:3000/tools | jq
```

Вызов (без ComfyUI — вернёт обновлённый workflow):

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

### 2) Запуск с ComfyUI

Если ComfyUI запущен (обычно `http://localhost:8188`), укажи `COMFYUI_URL`:

```bash
COMFYUI_URL=http://localhost:8188 \
TOOL_CONFIG_PATH=config/example.json \
WORKFLOWS_DIR=workflows \
npm start
```

Теперь `/invoke` вернёт `resultUrl` с готовым изображением.

### 3) Docker / docker-compose

```bash
docker build -t comfyui-mcp .

# Пример запуска с файлом конфига
# (config и workflows проброшены как volume в docker-compose)
HOST_PORT=3003 docker compose up --build
```

---

# Точный гайд по использованию

Ниже — минимальный, но **точный и воспроизводимый** сценарий для создания своего инструмента.

## Шаг 1. Экспортируй workflow из ComfyUI

1. Открой ComfyUI.
2. Собери граф (nodes + connections).
3. Экспортируй **API workflow** (через меню API export).
4. Сохрани JSON в `workflows/<имя>.json`.

**Важно:** этот сервер поддерживает **оба формата**:
- *ComfyUI API export* (объект, где ключи — id нод).
- *Классический формат с `nodes` и `links`*.

## Шаг 2. Создай конфиг инструмента

Файл может быть либо массивом, либо объектом с `tools`.
Для наглядности используем **`config/example.json`**:

```json
[
  {
    "name": "example",
    "description": "Тестовый txt2img workflow (ComfyUI API export): подмена позитивного/негативного промпта и генерация seed для KSampler.",
    "fields": [
      {
        "name": "positive_prompt",
        "description": "Позитивный промпт (CLIPTextEncode, node 6 -> text).",
        "type": "string",
        "required": true,
        "mapping": { "node": 6, "attribute": "text" }
      },
      {
        "name": "negative_prompt",
        "description": "Негативный промпт (CLIPTextEncode, node 7 -> text).",
        "type": "string",
        "required": false,
        "default": "",
        "mapping": { "node": 7, "attribute": "text" }
      },
      {
        "name": "seed",
        "description": "Seed для KSampler (node 3 -> seed). Если не задан — сгенерируется автоматически.",
        "type": "integer",
        "required": false,
        "generator": { "type": "seed", "options": { "min": 0, "max": 4294967295 } },
        "mapping": { "node": 3, "attribute": "seed" }
      }
    ]
  }
]
```

### Как работает `mapping`

- `mapping.node` — **ID ноды** (как в API export) **или** её тип (`class_type`).
- `mapping.attribute` — поле в ноде (`inputs.text`, `seed`, и т.п.).
- Если `attribute` содержит `.` — это будет интерпретироваться как вложенный путь.

### Как работают `required` и `default`

- Если поле **required** — оно обязательно во входных параметрах.
- Если задан `default`, оно будет использовано как значение по умолчанию.
- Если не задано ни `required`, ни `default`, и нет генератора — поле считается необязательным.

### Генерация значений (`generator`)

Поддерживаются:
- `seed` — генерирует случайное целое (`Math.random * MAX_SAFE_INTEGER`).
- `random` — генерирует float `0..1`.

## Шаг 3. Запусти сервер

```bash
TOOL_CONFIG_PATH=config/example.json \
WORKFLOWS_DIR=workflows \
npm start
```

## Шаг 4. Получи список инструментов

```bash
curl http://localhost:3000/tools | jq
```

Ответ содержит `name`, `description` и JSON Schema для параметров.

## Шаг 5. Вызови инструмент

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

# Архитектура и расширяемость

Ключевые точки расширения находятся в одном месте (`src/server/index.ts`):

- **Tool Builder** — собирает инструменты из конфигов + workflow (`src/mcp/toolBuilder.ts`).
- **TransportAdapter** — можно добавить SSE, streaming или OpenAI-совместимый транспорт.
- **ToolInvoker** — можно заменить логику запуска (очереди, external job runner, etc.).

Цель: все правки и расширения держать **централизованно**, без расползания логики.

---

# Переменные окружения

- `PORT` — порт HTTP сервера (по умолчанию 3000).
- `TOOL_CONFIG_PATH` — путь к конфигу инструментов (по умолчанию `config/tools.json`).
- `WORKFLOWS_DIR` — каталог с workflow JSON (по умолчанию `workflows/`).
- `COMFYUI_URL` — URL ComfyUI API (если задан — `/invoke` запускает workflow в ComfyUI).
- `COMFYUI_POLL_INTERVAL_MS` — интервал опроса (по умолчанию 1000 мс).
- `COMFYUI_TIMEOUT_MS` — тайм-аут ожидания (по умолчанию 5 минут).
- `HOST_PORT` — порт для docker-compose (по умолчанию 3003).

---

# API

- `GET /tools` — список инструментов.
- `POST /invoke` — вызов инструмента.
- `GET /health` / `GET /healthz` — health-check.

---

# Документация

- [Поведение LLM и формат инструментов](docs/llm-behavior.md)
