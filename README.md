# comfyui-mcp

Минимальный каркас сервиса для интеграции с ComfyUI и MCP. Проект ориентирован на
расширяемость: базовая структура и зависимости уже заданы, чтобы в дальнейшем можно
было добавлять модули, обработчики и схемы в одном месте без переписывания основы.

## Цели

- Единая точка входа для будущих API и интеграций.
- Валидация входных данных (через Zod/Ajv) и конфигурации.
- Простая разработка и запуск в контейнере.

## Схема конфигурации инструментов

В `config/schema/tool-config.schema.json` описан формат конфигурации инструментов:
каждый инструмент содержит `name`, `description` и набор `fields`. Поля привязываются
к конкретной ноде графа через `mapping` (пара `node` + `attribute`) и при необходимости
могут иметь генератор значения (`generator`) с типом `seed` или `random` и расширяемыми
опциями. Пример файла находится в `config/tools.example.json`: он показывает, как
подменить поле `text` у узла `CLIPTextEncode` и сгенерировать `seed` для `KSampler`.

## Workflows

Workflow — это экспортированный из ComfyUI граф (формат API export), который хранится
в каталоге `workflows/`. Такой файл можно использовать как шаблон для последующей
параметризации, связывания с инструментами или запуска в ComfyUI API.

Минимальные требования к структуре workflow:
- Корневой объект JSON.
- `nodes`: массив узлов, где у каждого узла есть минимум `id` (число) и `type`
  (строка). Дополнительные поля пропускаются для расширяемости.
- `links`: массив связей (может быть пустым).

Пример: `workflows/example-workflow.json`.

Для загрузки и базовой валидации используется модуль `src/core/workflowLoader.js`,
который читает JSON из каталога `workflows/` и проверяет базовую структуру через Zod.
Это оставляет место для расширения схемы (добавления метаданных, версий и т.д.).

## HTTP API и точки расширения

Новый HTTP слой реализован в `src/server/index.ts`. Он строится вокруг трёх сущностей:

- **Tool Builder** (`src/mcp/toolBuilder.ts`): собирает список инструментов из конфигураций и
  workflow-файлов. По умолчанию инструменты связываются с workflow по совпадению имени
  (например, инструмент `text2img` будет использовать `workflows/text2img.json`), но
  можно передать собственный `resolveWorkflowName` или расширить `ToolConfig` полем `workflow`.
- **TransportAdapter**: интерфейс транспорта. Встроен `HttpTransportAdapter` с маршрутами
  `GET /tools` и `POST /invoke`. Заготовки для SSE, Streamable HTTP и OpenAI-compatible
  адаптеров вынесены в классы `SseTransportAdapter`, `StreamableHttpTransportAdapter`,
  `OpenAiCompatibleTransportAdapter` — их можно переопределить или заменить в списке адаптеров.
- **ToolInvoker**: слой исполнения. `DefaultToolInvoker` берёт workflow, применяет параметры
  инструмента и возвращает обновлённый граф. Если нужна реальная отправка в ComfyUI,
  достаточно подменить реализацию `ToolInvoker` или функцию применения полей.

Ключевые точки расширения:

- `buildTools(...)` — если требуется более сложная логика сборки/валидации инструментов.
- `ToolRepository`/`WorkflowRepository` — если инструменты и workflow хранятся не в памяти.
- `TransportAdapter` — если нужна доставка через SSE/streaming/OpenAI API.
- `ToolInvoker` — если нужно интегрироваться с внешними сервисами или очередями задач.

## Быстрый старт (Docker)

```bash
# Сборка образа (используем официальный Node.js образ)
docker build -t comfyui-mcp - <<'DOCKERFILE'
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
DOCKERFILE

# Запуск контейнера
docker run --rm -p 3000:3000 --env-file .env comfyui-mcp
```

> Для локальной разработки используйте `npm run dev`.
