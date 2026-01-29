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
