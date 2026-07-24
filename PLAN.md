# Akame — OpenCode Plugin for Memory Granulation

> **Akame** — opencode-плагин на TypeScript для автоматической грануляции диалогов и кода
> в athena-memory (selti). Реагирует на события opencode, анализирует контекст через LLM
> с промптом агента **Тишь** (memory-granulator) и сохраняет структурированные гранулы
> в семантическую память.

---

## Команда

| Роль | Имя | Возраст | Специализация |
|------|-----|---------|---------------|
| Team Lead | **Афина** | 18 | Архитектура, координация |
| Planner | **Момо** | 23 | Декомпозиция, планирование |
| Architect | **Эна** | 21 | Высокоуровневая архитектура |
| Programmer | **Сона** | 30 | TypeScript, реализация |
| Tester | **Катерина** | 24 | Тестирование, качество |
| DB Architect | **Нора** | 30 | Схемы данных, миграции |
| DevOps | **Рэй** | 23 | CI/CD, деплой, инфраструктура |
| Security | **Лита** | 23 | Аудит безопасности |
| Tech Writer | **Тиамат** | 26 | Документация |
| Observability | **Мая** | 25 | Мониторинг, метрики |
| Networks | **Кира** | 27 | Сети, DNS, фаерволы |
| **Memory-Granulator** | **Тишь** | 19 | Грануляция знаний, промпты |

---

## Архитектура

### Высокоуровневая схема

```
┌──────────────────────────────────────────────────────────────────┐
│  opencode (Bun/Node.js)                                           │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  akame plugin (.opencode/plugins/akame/)                   │    │
│  │                                                            │    │
│  │  События:                         Обработчики:             │    │
│  │  session.idle ──────────────────> session-handler.ts       │    │
│  │  file.edited ────────────────────> file-handler.ts         │    │
│  │  tool.execute.after ─────────────> tool-handler.ts         │    │
│  │                                                            │    │
│  │  ┌──────────┐   ┌──────────────┐   ┌──────────────────┐   │    │
│  │  │collector │──>│  granulator  │──>│  memory-client   │   │    │
│  │  │.ts       │   │  .ts         │   │  .ts             │   │    │
│  │  └──────────┘   │  (LLM via    │   │  (HTTP MCP)      │   │    │
│  │                 │   SDK)       │   └───────┬──────────┘   │    │
│  │                 └──────────────┘           │              │    │
│  └────────────────────────────────────────────┼──────────────┘    │
└───────────────────────────────────────────────┼───────────────────┘
                                                 │ JSON-RPC over HTTP
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │  athena-memory (selti) :8000         │
                              │  memory_ingest_batch                  │
                              │  PostgreSQL + pgvector + Redis       │
                              └──────────────────────────────────────┘
```

### Ключевые решения

1. **Реактивный подход** — без polling, только события opencode
2. **LLM через SDK** — вызов через `client.session.prompt()` с `format: json_schema`
3. **Промпт из файла** — читается из `~/.config/opencode/agents/memory-granulator.md`
4. **Fire-and-forget** — все операции асинхронные, не блокируют opencode
5. **HTTP MCP** — прямая отправка гранул в athena-memory через JSON-RPC

---

## Структура проекта

```
.opencode/plugins/akame/
├── package.json                    # name: akame, type: module
├── tsconfig.json                   # ESNext, NodeNext
├── src/
│   ├── index.ts                    # Точка входа — Plugin function
│   ├── config.ts                   # Чтение env, дефолты
│   ├── logger.ts                   # Логирование через client.app.log
│   ├── constants.ts                # Типы, namespace-ы, дефолты
│   ├── events/
│   │   ├── session-handler.ts      # session.idle → грануляция
│   │   ├── file-handler.ts         # file.edited → debounce → грануляция
│   │   └── tool-handler.ts         # tool.execute.after (git) → грануляция
│   ├── granulator/
│   │   ├── engine.ts               # Сбор → LLM → парсинг → гранулы
│   │   └── schema.ts               # JSON Schema + TS-типы + валидация
│   └── mcp/
│       └── client.ts               # HTTP-клиент к athena-memory
├── tests/
│   ├── mcp/
│   │   └── client.test.ts
│   ├── granulator/
│   │   └── engine.test.ts
│   └── events/
│       ├── session-handler.test.ts
│       ├── file-handler.test.ts
│       └── tool-handler.test.ts
├── docs/
│   ├── ARCHITECTURE.md
│   └── CONFIGURATION.md
└── README.md
```

---

## Фазы реализации

### Фаза 0 — Init (скелет проекта)

**Задачи:**
- [ ] 0.1 Создать `package.json` с зависимостями: `@opencode-ai/plugin`, `@opencode-ai/sdk`
- [ ] 0.2 Создать `tsconfig.json` (ESNext, NodeNext, strict)
- [ ] 0.3 Создать `src/index.ts` — точка входа, экспорт Plugin function
- [ ] 0.4 Создать `src/config.ts` — чтение переменных `AKAME_*`
- [ ] 0.5 Создать `src/constants.ts` — namespace-ы, дефолты, типы
- [ ] 0.6 Создать `src/logger.ts` — логгер через `client.app.log`

**Кто:** Сона + Рэй
**Сложность:** S
**Зависимости:** —

---

### Фаза 1 — MCP клиент

**Задачи:**
- [ ] 1.1 Реализовать `src/mcp/client.ts` — HTTP POST к `/mcp/` с JSON-RPC
- [ ] 1.2 Метод `ingestBatch(entries, userId)` — вызов `memory_ingest_batch`
- [ ] 1.3 Retry с exponential backoff (500ms → 1s → 2s)
- [ ] 1.4 Обработка ошибок: 4xx → не retry, 5xx → retry, таймаут
- [ ] 1.5 Unit-тесты MCP клиента (Mock HTTP через MockAgent/undici)

**Кто:** Сона + Катерина
**Сложность:** M
**Зависимости:** Фаза 0

---

### Фаза 2 — Схема грануляции (Тишь)

**Задачи:**
- [ ] 2.1 Создать `src/granulator/schema.ts`:
  - Интерфейс `Granule` (content, namespace, metadata, importance)
  - Интерфейс `GranulatorOutput` (summary, granules[])
  - JSON Schema для structured output LLM
  - Функция `validateGranules()` — валидация ответа LLM
- [ ] 2.2 Создать TS-типы для namespace-ов и metadata
- [ ] 2.3 Написать тесты валидации (schema.test.ts)
- [ ] 2.4 Задокументировать правила грануляции в `docs/GRANULATION.md`

**Кто:** Тишь (схема) + Сона (код) + Катерина (тесты)
**Сложность:** S
**Зависимости:** Фаза 0

---

### Фаза 3 — Granulator Engine (ядро)

**Задачи:**
- [ ] 3.1 Реализовать `src/granulator/engine.ts`:
  - Функция `granulate(client, context, config, log) → Granule[]`
  - Чтение промпта Тиши из файла `~/.config/opencode/agents/memory-granulator.md`
  - Формирование payload: system prompt + данные диалога
  - Вызов LLM через `client.session.prompt()` с `format: json_schema`
  - Парсинг JSON-ответа (с запасом — снимает ```json блоки)
  - Валидация через `validateGranules()`
  - Graceful degradation при ошибках
- [ ] 3.2 Обработка длинных диалогов (truncation до N сообщений)
- [ ] 3.3 Unit-тесты Granulator Engine (mock SDK)

**Кто:** Сона + Катерина
**Сложность:** M
**Зависимости:** Фаза 1, Фаза 2

---

### Фаза 4 — Event Handlers

**Задачи:**
- [ ] 4.1 `src/events/session-handler.ts`:
  - Обработка `session.idle`
  - Cooldown (30 сек между грануляциями одной сессии)
  - Сбор сообщений через `client.session.messages()`
  - Сбор дочерних сессий через `client.session.children()`
- [ ] 4.2 `src/events/file-handler.ts`:
  - Обработка `file.edited`
  - Debounce (2 сек после последнего изменения)
  - Фильтр по расширениям (только код и конфиги)
- [ ] 4.3 `src/events/tool-handler.ts`:
  - Обработка `tool.execute.after`
  - Фильтр только git-инструментов (Git, Bash, gh)
  - Извлечение toolOutput
- [ ] 4.4 Интеграция в `src/index.ts` — подключение всех обработчиков в Hooks
- [ ] 4.5 Unit-тесты каждого обработчика

**Кто:** Сона + Катерина
**Сложность:** M
**Зависимости:** Фаза 3

---

### Фаза 5 — Integration & E2E

**Задачи:**
- [ ] 5.1 Интеграционные тесты: событие → грануляция → MCP (с моками)
- [ ] 5.2 Тесты debounce/cooldown (через fake timers)
- [ ] 5.3 Тесты на длинные диалоги (>50 сообщений)
- [ ] 5.4 Тесты на невалидные ответы LLM
- [ ] 5.5 Создать `test-utils/runtime.ts` — хелпер для тестового раннера opencode

**Кто:** Катерина + Сона
**Сложность:** M
**Зависимости:** Фаза 4

---

### Фаза 6 — CI/CD

**Задачи:**
- [ ] 6.1 Создать `.github/workflows/ci.yml`:
  - Линтер (biome/tsc)
  - Сборка (`tsc`)
  - Тесты (`vitest run --coverage`)
  - Публикация в npm при push тега `v*`
- [ ] 6.2 `.env.example` — документировать переменные
- [ ] 6.3 `.gitignore` — dist, node_modules, .env
- [ ] 6.4 `.npmignore` — исключить src/, тесты

**Кто:** Рэй
**Сложность:** S
**Зависимости:** Фаза 0, Фаза 5

---

### Фаза 7 — Документация

**Задачи:**
- [ ] 7.1 `README.md`:
  - Что такое akame
  - Архитектура (схема)
  - Установка (локально + npm)
  - Настройка (переменные окружения)
  - Использование
  - Структура проекта
- [ ] 7.2 `docs/ARCHITECTURE.md` — полное описание архитектуры
- [ ] 7.3 `docs/CONFIGURATION.md` — все настройки и переменные
- [ ] 7.4 `docs/GRANULATION.md` — правила грануляции от Тиши

**Кто:** Тиамат
**Сложность:** S
**Зависимости:** Фаза 0-6

---

### Фаза 8 — Публикация и деплой

**Задачи:**
- [ ] 8.1 Собрать пакет (`npm run build`)
- [ ] 8.2 Опубликовать в npm (`npm publish`)
- [ ] 8.3 Подключить в opencode.json через `file://` (локально)
- [ ] 8.4 Настроить в `opencode.json` плагин akame
- [ ] 8.5 Проверить интеграцию с athena-memory
- [ ] 8.6 Написать healthcheck-команду `/akame:health`

**Кто:** Рэй + Сона
**Сложность:** S
**Зависимости:** Фаза 6, Фаза 7

---

## Схема грануляции (от Тиши)

### Namespace и их назначение

| Namespace | Когда создаём | Что пишем в content |
|---|---|---|
| `project_meta` | Архитектурные решения, ADR | «Принято решение использовать X для Y вместо Z, потому что...» |
| `dialogue_insights` | Инсайты, договорённости, контекст | «Выяснено: ... Контекст: ... Влияние: ...» |
| `code_knowledge` | Код, функции, тесты, требования | «В [файл] реализовано [что]. Требование: ...» |
| `user_facts` | Предпочтения пользователя | «Серёжа предпочитает/не приемлет/отметил ...» |

### JSON Schema для structured output LLM

```typescript
interface Granule {
  content: string;                    // самодостаточное описание
  namespace: "user_facts" | "project_meta" | "dialogue_insights" | "code_knowledge";
  importance: 1 | 2 | 3 | 4 | 5;     // 1 — мелочь, 5 — критично
  metadata: {
    session_id: string;
    agent: string;
    project_id: string;
    title: string;                    // заголовок гранулы (до 80 символов)
    message_ids: string[];
    participants: string[];
  };
}

interface GranulatorOutput {
  summary: string;                    // о чём диалог одной строкой
  granules: Granule[];
}
```

### Триггеры грануляции

| Событие | Что делаем | Debounce/Cooldown |
|---|---|---|
| `session.idle` | Весь диалог → LLM → гранулы → memory_ingest_batch | 30 сек cooldown |
| `file.edited` | Diff файла → LLM → code_knowledge гранулы | 2 сек debounce |
| `tool.execute.after` | git commit/push → LLM → code_knowledge | без лимита |

---

## Пример работы

### Вход (диалог Милорда и Соны):

> **Серёжа:** Давай перепишем модуль авторизации на JWT, сейчас там сессии на куках — боль при масштабировании.
> **Сона:** Хорошо. Я предлагаю использовать `jsonwebtoken` с RS256. Ключи хранить в Vault.
> **Серёжа:** Согласен, но access token пусть живёт 15 минут, refresh — 7 дней.

### Выход (гранулы в athena-memory):

```json
[
  {
    "content": "Сона и Серёжа приняли решение перейти с cookie-сессий на JWT (RS256) для модуля авторизации, чтобы упростить масштабирование. Ключи будут храниться в Vault.",
    "namespace": "project_meta",
    "importance": 5,
    "metadata": {
      "session_id": "sess_abc123",
      "agent": "programmer",
      "project_id": "/home/opencode/projects/selti",
      "title": "Переход на JWT-авторизацию",
      "participants": ["Серёжа", "programmer"]
    }
  },
  {
    "content": "Серёжа установил: access token — 15 минут, refresh token — 7 дней. Компромисс между безопасностью и UX.",
    "namespace": "dialogue_insights",
    "importance": 4,
    "metadata": { "session_id": "sess_abc123", "title": "TTL токенов" }
  },
  {
    "content": "Реализовать middleware проверки JWT в auth.middleware.ts. Проверка signature, expiry, проставление req.user.",
    "namespace": "code_knowledge",
    "importance": 4,
    "metadata": { "session_id": "sess_abc123", "title": "Создать auth.middleware.ts" }
  },
  {
    "content": "Серёжа предпочитает короткие access token (15 минут) с refresh-ротацией. Не любит долгоживущие сессии.",
    "namespace": "user_facts",
    "importance": 3,
    "metadata": { "session_id": "sess_abc123", "title": "Серёжа предпочитает короткоживущие токены" }
  }
]
```

---

## Технологический стек

| Компонент | Технология | Обоснование |
|---|---|---|
| Язык | TypeScript | Стандарт opencode, типизация, Bun-совместимость |
| Runtime | Bun (opencode) | Встроен в opencode, быстрый import модулей |
| Plugin API | @opencode-ai/plugin | Типы, Plugin, Hooks |
| SDK | @opencode-ai/sdk | Клиент для LLM и API opencode |
| Тесты | Vitest | Стандарт TS, built-in mock, fake timers |
| HTTP моки | MockAgent (undici) | Встроен в Node.js, не требует зависимостей |
| CI/CD | GitHub Actions | Стандарт, публ. в npm |
| База данных | PostgreSQL + pgvector (через selti) | Уже работает в athena-memory |

---

## Переменные окружения

| Переменная | Дефолт | Описание |
|---|---|---|
| `AKAME_MCP_URL` | `http://athena-memory:8000/mcp/` | URL MCP-эндпоинта |
| `AKAME_API_KEY` | — | API-ключ athena-memory |
| `AKAME_USER_ID` | `akame` | Владелец записей в памяти |
| `AKAME_GRANULATE_IDLE` | `true` | Гранулировать при session.idle |
| `AKAME_GRANULATE_FILE` | `false` | Гранулировать при file.edited |
| `AKAME_GRANULATE_TOOL` | `true` | Гранулировать после tool.execute.after |
| `AKAME_COOLDOWN_MS` | `30000` | Cooldown между грануляциями (мс) |
| `AKAME_DEBOUNCE_MS` | `2000` | Debounce file.edited (мс) |
| `AKAME_MAX_BATCH` | `20` | Макс. гранул в одном ingest_batch |
| `AKAME_MAX_MESSAGES` | `50` | Макс. сообщений для анализа |

---

## Граф зависимостей

```
Фаза 0 (скелет)
  ├── Фаза 1 (MCP клиент)
  ├── Фаза 2 (схема грануляции)
  │
  ├── Фаза 3 (Granulator Engine) — зависит от 1 и 2
  │     │
  │     └── Фаза 4 (Event Handlers) — зависит от 3
  │           │
  │           └── Фаза 5 (Integration тесты) — зависит от 4
  │
  ├── Фаза 6 (CI/CD) — зависит от 0, 5
  ├── Фаза 7 (Документация) — зависит от 0-6
  └── Фаза 8 (Публикация) — зависит от 6, 7
```

---

## Оценка сложности

| Фаза | Задач | Сложность | Кто |
|------|-------|-----------|-----|
| 0 — Init | 6 | S | Сона, Рэй |
| 1 — MCP клиент | 5 | M | Сона, Катерина |
| 2 — Схема грануляции | 4 | S | Тишь, Сона, Катерина |
| 3 — Granulator Engine | 3 | M | Сона, Катерина |
| 4 — Event Handlers | 5 | M | Сона, Катерина |
| 5 — Integration тесты | 5 | M | Катерина, Сона |
| 6 — CI/CD | 4 | S | Рэй |
| 7 — Документация | 4 | S | Тиамат |
| 8 — Публикация | 6 | S | Рэй, Сона |
| **Итого** | **42** | — | — |
