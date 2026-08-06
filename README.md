# akame

> opencode-плагин для автоматической грануляции диалогов и кода в семантическую память selti

**akame** — это плагин для [opencode](https://opencode.ai), который превращает ваши диалоги, код и архитектурные решения в структурированные знания. Он реагирует на события opencode, анализирует контекст через LLM с агентом **memory-granulator (Тишь)**, и та через кастомный tool `granulate_output` сохраняет гранулы — самодостаточные описания фактов — в семантическую память [selti](https://github.com/selti-project/selti).

Плагин работает незаметно: не блокирует opencode, не требует ручного запуска и автоматически извлекает суть из каждого диалога, каждого изменения файла и каждой git-команды.

---

## Архитектура

```
+-------------------------------------------------------------------+
|  opencode (Bun/Node.js)                                            |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  |  akame plugin (.opencode/plugins/akame/)                      | |
|  |                                                               | |
|  |  События:                    Обработчики:                     | |
|  |  session.idle ------------> session-handler.ts (cooldown 30s) | |
|  |  session.compacted -------> session-handler.ts                | |
|  |  session.diff ------------> session-handler.ts                | |
|  |  file.edited -------------> file-handler.ts    (debounce 2s)  | |
|  |  file.watcher.updated ----> file-handler.ts    (debounce 2s)  | |
|  |  tool.execute.after ------> tool-handler.ts    (git filter)   | |
|  |  tool.execute.before -----> tool-handler.ts    (pre-process)  | |
|  |  command.executed --------> tool-handler.ts    (git filter)   | |
|  |                                                               | |
|  |  Tools (зарегистрированы в hooks.tool):                       | |
|  |  granulate_output  code_index  code_diff  code_graph          | |
|  |  dependency_analyzer  migrate_legacy_granules  graph_health   | |
|  |                                                               | |
|  |  +-----------+   +---------------+   +--------------------+   | |
|  |  | collector |-->|  granulator   |-->|  LLM (agent:      |   | |
|  |  | (данные)  |   |  engine.ts    |   |  memory-granulator)|  | |
|  |  +-----------+   +---------------+   +---------+----------+   | |
|  |                                     tool вызовы|              | |
|  |                              granulate_output   |              | |
|  |                              code_index и др.   |              | |
|  |                                         |                      | |
|  |                                   +-----v----------+          | |
|  |                                   | granulate-tool  |          | |
|  |                                   | -> валидация    |          | |
|  |                                   | -> MCP client   |          | |
|  |                                   +--------+--------+          | |
|  |  +----------------------------------------------+             | |
|  |  | link-enricher (пост-обработка)               |             | |
|  |  | -> автосвязи между гранулами                 |             | |
|  |  +----------------------------------------------+             | |
|  +--------------------------------------------------------------+ |
+-------------------------------------------------------------------+
                                                 |
                                      JSON-RPC over HTTP POST
                                                 v
                             +-------------------------------------+
                             |  selti (selti) :8000        |
                             |  PostgreSQL + pgvector + Redis      |
                             +-------------------------------------+
```

---

## Быстрый старт

### 1. Установка

Скопируйте плагин в директорию плагинов opencode:

```bash
cp -r akame .opencode/plugins/akame
```

### 2. Зависимости

```bash
cd .opencode/plugins/akame
npm install
npm run build
```

### 3. Настройка

Создайте файл `.env` в корне проекта (см. `.env.example`):

```env
AKAME_MCP_URL=http://selti:8000/mcp/
AKAME_API_KEY=
AKAME_USER_ID=akame
```

### 4. Подключение в opencode.json

```json
{
  "plugins": {
    "akame": {
      "source": ".opencode/plugins/akame",
      "enabled": true
    }
  }
}
```

### 5. Проверка

Запустите opencode. В логах должно появиться:

```
akame загружен (userId: akame)
```

---

## Переменные окружения

| Переменная | Дефолт | Описание |
|---|---|---|
| `AKAME_MCP_URL` | `http://selti:8000/mcp/` | URL MCP-эндпоинта selti |
| `AKAME_API_KEY` | — | API-ключ для авторизации (Bearer token) |
| `AKAME_USER_ID` | `akame` | Владелец записей в памяти |
| `AKAME_GRANULATE_IDLE` | `true` | Гранулировать при `session.idle` |
| `AKAME_GRANULATE_FILE` | `false` | Гранулировать при `file.edited` |
| `AKAME_GRANULATE_TOOL` | `true` | Гранулировать после git-команд |
| `AKAME_COOLDOWN_MS` | `30000` | Cooldown между грануляциями (мс) |
| `AKAME_DEBOUNCE_MS` | `2000` | Debounce для `file.edited` (мс) |
| `AKAME_MAX_BATCH` | `20` | Макс. гранул в одном `ingest_batch` |
| `AKAME_MAX_MESSAGES` | `50` | Макс. сообщений для анализа |

Полный список (17 переменных, включая `AKAME_GRANULATE_COMPACTED`, `AKAME_ENRICH_LINKS` и др.) — в [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Конфигурационный файл (JSON5)

Альтернатива env-переменным — файл `akame.json5` с комментариями и нестрогим синтаксисом JSON.

**Каскад загрузки:**

```
defaults.ts → akame.json5 → AKAME_* env
```

Env-переменные **всегда** имеют наивысший приоритет.

**Поиск файла:**

| Приоритет | Путь |
|---|---|
| 1 | `./akame.json5` (рядом с opencode.json) |
| 2 | `~/.config/opencode/akame.json5` (глобальный) |

**Пример akame.json5:**

```json5
{
  // MCP-сервер selti
  mcpUrl: "http://selti:8000/mcp/",
  userId: "akame",

  // Триггеры грануляции
  idle: true,           // session.idle
  compacted: true,      // session.compacted
  toolAfter: true,      // tool.execute.after (git/Gera)

  // Cooldown и лимиты
  cooldownMs: 30000,
  maxMessages: 50,

  // Обогащение
  enrichLinks: true,
  enrichPrompt: true
}
```

**Пример: конфликт приоритетов**

```bash
# В akame.json5: maxBatch = 50
# В .env: AKAME_MAX_BATCH=20
# Результат: 20 (env побеждает)
```

Полный список ключей, маппинг на env-переменные и подробности — в [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## Как работает грануляция

akame реагирует на восемь типов событий opencode:

| Событие | Что происходит | Защита |
|---|---|---|
| `session.idle` | Собирает сообщения (включая дочерние сессии), отправляет промпт LLM с агентом `memory-granulator` | Cooldown 30 сек |
| `session.compacted` | Гранулирует компактированную сессию (сжатую историю диалога) | Cooldown |
| `session.diff` | Гранулирует изменения в рамках сессии (авто-коммиты) | Cooldown |
| `file.edited` | Фильтрует код/конфиги, debounce перед грануляцией | Debounce 2 сек |
| `file.watcher.updated` | Реагирует на изменения файлов через file watcher | Debounce 2 сек |
| `tool.execute.after` | Ловит git-команды (commit, push, merge, PR) | Фильтр только git |
| `tool.execute.before` | Pre-processing — перехват до выполнения инструмента | Фильтр |
| `command.executed` | Реагирует на выполненные команды в opencode | Фильтр только git |

**Ключевое отличие от предыдущей версии:** akame больше не парсит JSON из текстового ответа LLM. Вместо этого LLM (агент memory-granulator) вызывает кастомный tool `granulate_output` с типизированными аргументами. Валидация (`validateGranules`) происходит внутри tool, а не в engine.

Подробнее — в [docs/GRANULATION.md](docs/GRANULATION.md).

---

## Инструменты (Tools)

akame регистрирует 7 кастомных инструментов для LLM-агента `memory-granulator` (Тишь). Все тулы защищены — вызывать их может только Тишь (или пользователь для `migrate_legacy_granules`).

| Tool | Файл | Назначение |
|---|---|---|
| `granulate_output` | `src/granulator/granulate-tool.ts` | Сохранение гранул в selti: валидация → батчинг → MCP |
| `code_index` | `src/tools/code-index-tool.ts` | Сканирование `.ts`/`.py` файлов и создание `code_knowledge` гранул |
| `code_diff` | `src/tools/code-diff-tool.ts` | Анализ unified diff → гранулы code_knowledge (added/modified/removed) |
| `code_graph` | `src/tools/code-graph-tool.ts` | Построение графа зависимостей, поиск сирот, циклов, обратных связей |
| `dependency_analyzer` | `src/tools/dependency-analyzer-tool.ts` | Анализ импортов → создание `depends_on`/`used_by` связей |
| `migrate_legacy_granules` | `src/tools/migrate-legacy-granules-tool.ts` | Миграция старых гранул в новый формат (извлечение entity_type/name) |
| `graph_health` | `src/tools/graph-health-tool.ts` | Проверка здоровья графа: связность, дубликаты, cross-ns связи |

Все тулы (кроме `granulate_output`) работают через `MCPClient`: поиск существующих гранул → дедупликация → создание/обновление записей в selti.

Подробнее о каждом инструменте — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Namespace-ы selti

| Namespace | Назначение | Пример |
|---|---|---|
| `user_facts` | Факты о пользователе | «Серёжа предпочитает короткие access token» |
| `project_meta` | Архитектурные решения, ADR | «Принято решение использовать JWT вместо cookie-сессий» |
| `dialogue_insights` | Инсайты из диалогов | «Выяснено: проект требует горизонтального масштабирования» |
| `code_knowledge` | Знания из кода | «В `auth.middleware.ts` реализована проверка JWT» |
| `infrastructure` | Инфраструктурные факты | «selti работает на порту 8000 в Docker» |

---

## Технологический стек

| Компонент | Технология |
|---|---|
| Язык | TypeScript |
| Runtime | Bun (opencode) |
| Plugin API | `@opencode-ai/plugin` v1 |
| SDK | `@opencode-ai/sdk` |
| Тесты | Vitest |
| Память | selti (PostgreSQL + pgvector) |
| Протокол | JSON-RPC 2.0 over HTTP |

---

## Структура проекта

```
akame/
├── src/
│   ├── index.ts                        # PluginModule + v1 Hooks + регистрация 7 tools
│   ├── config.ts                       # Чтение AKAME_* переменных окружения
│   ├── constants.ts                    # Namespace-ы, дефолты, типы конфигурации
│   ├── logger.ts                       # Асинхронный логгер через client.app.log
│   ├── mcp/
│   │   └── client.ts                   # HTTP-клиент selti (JSON-RPC 2.0)
│   ├── scanner/
│   │   └── code-index.ts               # Regex-парсеры .ts/.py → классы, функции, типы
│   ├── granulator/
│   │   ├── schema.ts                   # JSON Schema + типы + валидация гранул
│   │   ├── engine.ts                   # Ядро: сбор контекста → LLM (memory-granulator)
│   │   ├── granulate-tool.ts           # Tool: валидация → MCP → selti
│   │   └── link-enricher.ts            # Пост-обработка: автосвязи между гранулами
│   ├── tools/
│   │   ├── code-index-tool.ts          # Tool: code_index
│   │   ├── code-diff-tool.ts           # Tool: code_diff
│   │   ├── code-graph-tool.ts          # Tool: code_graph
│   │   ├── dependency-analyzer-tool.ts # Tool: dependency_analyzer
│   │   ├── migrate-legacy-granules-tool.ts  # Tool: migrate_legacy_granules
│   │   └── graph-health-tool.ts        # Tool: graph_health
│   ├── events/
│   │   ├── session-handler.ts          # session.idle / compacted / diff
│   │   ├── file-handler.ts             # file.edited / file.watcher.updated
│   │   ├── tool-handler.ts             # tool.execute.after / before, command.executed
│   │   └── git-diff.ts                 # Git diff утилита (получение unified diff)
│   └── security/
│       └── validate.ts                 # Защита от path traversal (resolveSafePath)
├── tests/
│   ├── config.test.ts
│   ├── mcp/
│   │   └── client.test.ts
│   ├── scanner/
│   │   └── code-index.test.ts
│   ├── granulator/
│   │   ├── engine.test.ts
│   │   └── schema.test.ts
│   ├── tools/
│   │   ├── code-index-tool.test.ts
│   │   ├── code-diff-tool.test.ts
│   │   ├── code-graph-tool.test.ts
│   │   ├── dependency-analyzer-tool.test.ts
│   │   ├── migrate-legacy-granules-tool.test.ts
│   │   └── graph-health-tool.test.ts
│   └── events/
│       ├── session-handler.test.ts
│       ├── file-handler.test.ts
│       └── tool-handler.test.ts
├── docs/
│   ├── ARCHITECTURE.md                 # Детальная архитектура
│   ├── CONFIGURATION.md                # Полное руководство по конфигурации
│   ├── GRANULATION.md                  # Процесс грануляции
│   ├── GRANULATION_STANDARD.md         # Стандарт грануляции знаний
│   └── PLAN_CODE_INDEX.md              # План разработки code_index
├── .env.example
├── opencode.json.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Команда Argenta Team

| Роль | Имя | Специализация |
|---|---|---|
| Team Lead | Афина | Архитектура, координация |
| Planner | Момо | Декомпозиция, планирование |
| Architect | Эна | Высокоуровневая архитектура |
| Programmer | Сона | TypeScript, реализация |
| Tester | Катерина | Тестирование, качество |
| DB Architect | Нора | Схемы данных, миграции |
| DevOps | Рэй | CI/CD, деплой, инфраструктура |
| Security | Лита | Аудит безопасности |
| Tech Writer | Тиамат | Документация |
| Observability | Мая | Мониторинг, метрики |
| Networks | Кира | Сети, DNS, фаерволы |
| Memory-Granulator | Тишь | Грануляция знаний, промпты |

**Разработчик:** Серёжа (Dek1m)

---

## Лицензия

MIT
