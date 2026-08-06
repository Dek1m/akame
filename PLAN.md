# Akame — OpenCode Plugin for Memory Granulation

> **Akame** — opencode-плагин на TypeScript для автоматической грануляции диалогов и кода
> в selti. Реагирует на события opencode, анализирует контекст через LLM
> с промптом агента **Тишь** (memory-granulator) и сохраняет структурированные гранулы
> в семантическую память.

---

## Статус проекта

| Параметр | Значение |
|---|---|
| **Версия** | 0.0.1 |
| **Статус** | Активно разрабатывается |
| **Язык** | TypeScript (ESNext, NodeNext, strict) |
| **Runtime** | Bun (встроен в opencode) |
| **Модель Тиши** | `opencode-go/deepseek-v4-flash` |
| **Тесты** | 88 тестов, 8 файлов — все зелёные |
| **Гранулы selti** | 702 (code_knowledge: 408, project_meta: 162, dialogue_insights: 78, user_facts: 54, infrastructure: 0) |
| **Cross-namespace связи** | 137 |
| **Сироты** | 400 (56.9%) |
| **Связность по namespace** | code_knowledge 48%, dialogue_insights 44%, project_meta 35%, user_facts 30% → 72% (после ретроспективной линковки) |
| **Деплой** | `~/.config/opencode/plugins/akame/` → Docker-контейнер opencode на `ai.atom.ui` |

---

## Архитектура (актуальная на 25.07.2026)

### Высокоуровневая схема

```
┌──────────────────────────────────────────────────────────────────┐
│  opencode (Bun) на ai.atom.ui                                     │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  akame plugin (~/.config/opencode/plugins/akame/)             │ │
│  │                                                                │ │
│  │  7 событий:                      3 хука:                      │ │
│  │  session.idle ──────────────────> session-handler.ts           │ │
│  │  session.compacted ─────────────> session-handler.ts           │ │
│  │  session.diff ──────────────────> session-handler.ts           │ │
│  │  file.edited ───────────────────> file-handler.ts              │ │
│  │  file.watcher.updated ──────────> file-handler.ts              │ │
│  │  command.executed ──────────────> tool-handler.ts              │ │
│  │  + tool.execute.after ──────────> tool-handler.ts              │ │
│  │  + tool.execute.before ─────────> tool-handler.ts              │ │
│  │                                                                │ │
│  │  7 кастомных тулов:                                           │ │
│  │  granulate_output  (Тишь)                                     │ │
│  │  code_index        (Тишь)                                     │ │
│  │  code_diff         (Тишь)                                     │ │
│  │  code_graph        (Тишь)                                     │ │
│  │  dependency_analyzer (Тишь)                                   │ │
│  │  migrate_legacy_granules (Тишь)                               │ │
│  │  graph_health      (Тишь)                                     │ │
│  │                                                                │ │
│  │  ┌──────────┐   ┌──────────────┐   ┌──────────────────┐      │ │
│  │  │ engine.ts │──>│  granulator  │──>│  MCPClient.ts    │      │ │
│  │  │(3 режима) │   │  (LLM via    │   │  (HTTP MCP)      │      │ │
│  │  │дедупликац.│   │   SDK)       │   └───────┬──────────┘      │ │
│  │  └──────────┘   └──────────────┘           │                  │ │
│  │  ┌──────────────────────┐                   │                  │ │
│  │  │ link-enricher.ts     │                   │                  │ │
│  │  │ (enrichLinks —       │                   │                  │ │
│  │  │  CNLM + auto-link)   │                   │                  │ │
│  │  └──────────────────────┘                   │                  │ │
│  └────────────────────────────────────────────┼──────────────────┘ │
└───────────────────────────────────────────────┼────────────────────┘
                                                 │ JSON-RPC over HTTP
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │  selti (selti) :8000         │
                              │  memory_ingest_batch                  │
                              │  PostgreSQL + pgvector + Redis       │
                              └──────────────────────────────────────┘
```

### Ключевые компоненты

| Компонент | Описание |
|---|---|
| **engine.ts** | Ядро грануляции: 3 режима (dialogue / code_diff / tool_result), дедупликация idle/compacted, вызов LLM |
| **schema.ts** | JSON Schema + TS-типы, CNLM-матрица (5 namespace), 24 LinkType, валидация гранул |
| **link-enricher.ts** | Пост-обработка: enrichLinks — поиск похожих гранул через `memory_find_similar`, автосвязывание через CNLM |
| **fetchRelevantGranules** | Обогащение промпта Тиши релевантными гранулами из других namespace (Tier 2 auto-linker) |
| **code-index.ts** | Сканер: извлекает классы/функции/интерфейсы из TS/Python файлов, создаёт code_knowledge гранулы |
| **git-diff.ts** | Получение реального git diff для грануляции изменений кода |
| **MCPClient.ts** | HTTP-клиент к selti: JSON-RPC, retry с exponential backoff |

---

## Выполненные фазы

### Фаза 0 — Документация opencode в selti [x]

- [x] 0.1 Загружены 9 страниц официальной документации opencode в selti
- [x] 0.2 `/docs/plugins/`, `/docs/sdk/`, `/docs/tools/`, `/docs/permissions/`, `/docs/agents/`, `/docs/custom-tools/`, `/docs/config/`

**Результат:** полное понимание Plugin API, встроенной permission system, событий и хуков.

---

### Фаза 1 — 5 новых триггеров + compaction hook [x]

- [x] 1.1 `session.compacted` — грануляция при компакшене сессии
- [x] 1.2 `session.diff` — грануляция изменений диалога
- [x] 1.3 `file.watcher.updated` — отслеживание изменений файлов
- [x] 1.4 `tool.execute.before` + `command.executed` — грануляция команд
- [x] 1.5 `experimental.session.compacting` hook — внедрение контекста при компакшене

---

### Фаза 2 — Engine: 3 режима, дедупликация [x]

- [x] 2.1 Три режима: `dialogue`, `code_diff`, `tool_result`
- [x] 2.2 Убран хардкод агента — agent берётся из контекста
- [x] 2.3 Дедупликация idle/compacted — проверка `minMessages`
- [x] 2.4 `enrichLinks` — автосвязывание гранул через `memory_find_similar`

---

### Фаза 3 — File-handler с грануляцией diff [x]

- [x] 3.1 `getGitDiff()` — получение реального git diff изменённых файлов
- [x] 3.2 Debounce (2 сек) — фильтрация по расширениям `.ts`, `.py`, `.js`
- [x] 3.3 Грануляция в режиме `code_diff` — анализ изменений кода

---

### Фаза 4 — Tool-handler с грануляцией git [x]

- [x] 4.1 Парсинг результатов git-команд (`git commit`, `git push`)
- [x] 4.2 Грануляция в режиме `tool_result`
- [x] 4.3 Фильтрация: только git-инструменты (Git, Bash с git, gh)

---

### Фаза 5 — 3 новых тула [x]

- [x] 5.1 `code_diff` — грануляция diff (только Тишь)
- [x] 5.2 `code_graph` — построение графа зависимостей (только Тишь)
- [x] 5.3 `dependency_analyzer` — анализ импортов модулей (только Тишь)
- [x] 5.4 Все тулы с защитой `context.agent === 'memory-granulator'`

---

### Фаза 6 — Permission system [x]

- [x] 6.1 `opencode.json.example` с deny/allow правилами
- [x] 6.2 Двухуровневая защита: opencode.json + in-code `context.agent`
- [x] 6.3 Все 7 тулов доступны только агенту `memory-granulator`

---

### Фаза 7 — Compaction hook [x]

- [x] 7.1 `experimental.session.compacting` — внедрение промпта грануляции
- [x] 7.2 Базовый контекст в `output.context[]`

---

### Фаза 8 — Тесты и TypeScript [x]

- [x] 8.1 TypeScript strict — `npx tsc --noEmit` без ошибок
- [x] 8.2 88 тестов, все зелёные
- [x] 8.3 8 тестовых файлов: config, schema, engine, client, session-handler, file-handler, tool-handler, code-index

---

### Фаза 9 — Миграция legacy гранул [x]

- [x] 9.1 `migrate_legacy_granules` — тул миграции старых гранул в новый формат
- [x] 9.2 Поддержка `--dry-run` для предпросмотра
- [x] 9.3 Извлечение `entity_type`, `entity_name`, `module_path` из контента

---

### Фаза 10 — Cross-namespace граф [x]

- [x] 10.1 `link-enricher.ts` — пост-обработка с автосвязыванием гранул
- [x] 10.2 `graph_health` — тул проверки здоровья графа (сироты, дубликаты, циклы)
- [x] 10.3 CNLM-матрица (Cross-Namespace Link Matrix) — 5 namespace, разрешённые LinkType для каждой пары
- [x] 10.4 3 новых LinkType: `derived_from`, `motivates`, `informed_by`

---

### Фаза 11 — enrichLinks + fetchRelevantGranules [x]

- [x] 11.1 `enrichLinks` (фича-флаг, default: true) — автосвязывание после грануляции
- [x] 11.2 `fetchRelevantGranules()` — обогащение промпта Тиши релевантными гранулами
- [x] 11.3 `extractKeywords()` — извлечение ключевых слов для семантического поиска
- [x] 11.4 `enrichPrompt` (фича-флаг, default: true) — внедрение контекста в промпт

---

### Фаза 12 — Инфраструктурная каталогизация [x]

- [x] 12.1 Namespace `infrastructure` в `schema.ts` (entity_type: server, container, service, api, network, volume, os)
- [x] 12.2 10 инфраструктурных гранул о `ai.atom.ui` (сервер, контейнеры, сети, API)
- [x] 12.3 Временно сохранены в `project_meta` — namespace `infrastructure` не зарегистрирован в backend selti
- [x] 12.4 CNLM-матрица расширена до 5 namespace (включая infrastructure)

---

## Текущие задачи (НЕ выполнены)

По результатам аудита кодовой базы от 25.07.2026 выявлено 15 проблем.

### Волна 1 — Критические (P0)

- [ ] **Добавить `infrastructure` в enum granulate-tool** — namespace объявлен в `schema.ts`, но отсутствует в рантайм-валидации `granulate-tool`. Сона уже исправила.
- [ ] **Добавить 8 LinkType в granulate-tool** — `runs_on`, `exposes`, `mounts`, `derived_from`, `motivates`, `informs`, `informed_by`, `connected_to` не в enum. Сона уже исправила.
- [ ] **Написать тесты для 9 модулей (2544 строки)** — 224 тест-кейса для: index.ts, logger.ts, granulate-tool.ts, code-diff-tool.ts, code-graph-tool.ts, dependency-analyzer-tool.ts, migrate-legacy-granules-tool.ts, graph-health-tool.ts, link-enricher.ts

### Волна 2 — Безопасность (P1)

- [ ] **Shell-инжекция:** `execSync` → `spawnSync` в `git-diff.ts`
- [ ] **Path traversal:** `resolveSafePath()` для `code-index` и `dependency-analyzer`
- [ ] **Агентская защита в `code-index-tool`** — единственный exclusive tool без `context.agent` проверки
- [ ] **8 молчаливых `catch` → `log.debug()`** — подавленные ошибки без логирования
- [ ] **Тройное дублирование `GranulateContext` → `buildGranulateContext()`** — в engine.ts, file-handler.ts, tool-handler.ts
- [ ] **Документация: 7 недокументированных env vars** — добавить в `.env.example`: `ENRICH_LINKS`, `ENRICH_PROMPT` и 5 новых триггеров
- [ ] **Актуализация документации:** `CONFIGURATION.md`, `README.md`, `ARCHITECTURE.md`

### Волна 3 — Качество (P2-P3)

- [ ] **Контекст в сообщениях ошибок** — все `throw new Error(...)` без контекста
- [ ] **Кеш чтения промпта** — `readPromptFromFile()` вызывается при каждой грануляции без кеша
- [ ] **Вынос общих констант** — `EXCLUDE_DIRS`, `SOURCE_EXTS` дублируются в 3 модулях
- [ ] **Синглтон MCPClient** — создаётся заново в каждом обработчике вместо переиспользования

### Стратегия выполнения

| Волна | Приоритет | Оценка | Стратегия |
|---|---|---|---|
| Волна 1 | P0 | ~1 час | Один коммит — независимые файлы |
| Волна 2 | P1 | ~1.5 часа | Второй коммит |
| Волна 3 (тесты) | P0 | 4-6 часов | Отдельные PR по 2-3 модуля |
| Волна 3 (качество) | P2-P3 | ~1 час | Третий коммит |

**Итого:** ~2.5 часа на исправления + 4-6 часов на тесты.

---

## Стандарт развертывания [НОВЫЙ]

> Детали: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

### Принципы

1. **Сборка ТОЛЬКО через compose** — `docker compose build akame`
2. **Context = git-клон проекта** — `docker-compose.yml` в корне репозитория
3. **Dockerfile относительно context** — `dockerfile: Dockerfile`
4. **GH Actions через compose** — используем `docker/build-push-action`

### Файлы

| Файл | Назначение |
|------|------------|
| `Dockerfile` | Многостадийная сборка (builder → production) |
| `docker-compose.yml` | Определение сервисов (akame, dev-окружение) |
| `deploy.sh` | Скрипт деплоя (SSH/rsync) |
| `.dockerignore` | Исключения для build context |
| `.github/workflows/deploy.yml` | CI/CD (build → deploy → health check) |

### Команды

```bash
# Сборка
docker compose build akame

# Dev-окружение
docker compose --profile dev up -d

# Деплой
./deploy.sh

# Откат
./deploy.sh --rollback v0.10.0
```

### Автоматический деплой

При пуше в `main`:
1. CI: `npm ci` → `tsc` → `vitest` → `docker build`
2. CD: `rsync dist/` → `docker restart` → `health check`

### Rollback

```bash
gh workflow run deploy.yml -f rollback_tag=v0.10.0
```

---

## Актуальная структура проекта (25+ файлов)

```
akame/
├── package.json                         # name: akame, type: module
├── tsconfig.json                        # ESNext, NodeNext, strict
├── opencode.json.example                # Permission rules (deny/allow)
├── .env.example                         # 16 из 18 переменных окружения
├── vitest.config.ts
│
├── Dockerfile                           # [НОВЫЙ] Многостадийная сборка плагина
├── docker-compose.yml                   # [НОВЫЙ] Определение сервисов
├── deploy.sh                            # [НОВЫЙ] Скрипт деплоя (SSH/rsync)
├── .dockerignore                        # [НОВЫЙ] Исключения для build context
│
├── src/
│   ├── index.ts                         # Точка входа — Plugin function.
│   │                                    #   Регистрирует 7 событий, 3 хука, 7 тулов.
│   │
│   ├── config.ts                        # Чтение env (AKAME_*), AkameConfig
│   ├── constants.ts                     # 5 namespace, DEFAULTS, AkameConfig interface
│   │                                    #   ENRICH_LINKS=true, ENRICH_PROMPT=true
│   ├── logger.ts                        # Логирование через client.app.log
│   │
│   ├── events/
│   │   ├── session-handler.ts           # session.idle, .compacted, .diff →
│   │   │                                #   granulate(mode: 'dialogue')
│   │   ├── file-handler.ts              # file.edited, file.watcher.updated →
│   │   │                                #   getGitDiff() → granulate(mode: 'code_diff')
│   │   ├── tool-handler.ts              # tool.execute.after, .before,
│   │   │                                #   command.executed → грануляция git-результатов
│   │   └── git-diff.ts                  # execSync('git diff ...') — получение diff
│   │                                    #   [P1: shell-инжекция, заменить на spawnSync]
│   │
│   ├── granulator/
│   │   ├── engine.ts                    # Ядро: 3 режима (dialogue/code_diff/tool_result),
│   │   │                                #   дедупликация, enrichLinks,
│   │   │                                #   fetchRelevantGranules, вызов LLM
│   │   ├── schema.ts                    # JSON Schema, Granule, LinkType (24 типа),
│   │   │                                #   CNLM-матрица (5 namespace), validateGranules()
│   │   ├── granulate-tool.ts            # granulate_output — ручная грануляция (только Тишь)
│   │   └── link-enricher.ts             # enrichLinks: memory_find_similar →
│   │                                    #   автосвязывание через CNLM (threshold ≥0.75)
│   │
│   ├── mcp/
│   │   └── client.ts                    # MCPClient — HTTP JSON-RPC к selti.
│   │                                    #   Методы: memory_search, memory_ingest_batch и др.
│   │                                    #   Retry с exponential backoff (500ms→1s→2s).
│   │
│   ├── scanner/
│   │   └── code-index.ts                # Сканер .ts/.py файлов:
│   │                                    #   scanProject(), parseTSFile(), parsePythonFile()
│   │                                    #   → code_knowledge гранулы с дедупликацией
│   │
│   └── tools/
│       ├── code-index-tool.ts           # code_index — обёртка над scanner (только Тишь)
│       │                                #   [P1: нет агентской защиты]
│       ├── code-diff-tool.ts            # code_diff — грануляция diff (только Тишь)
│       ├── code-graph-tool.ts           # code_graph — граф зависимостей (только Тишь)
│       ├── dependency-analyzer-tool.ts  # dependency_analyzer — импорты (только Тишь)
│       ├── migrate-legacy-granules-tool.ts  # migrate_legacy_granules (только Тишь)
│       └── graph-health-tool.ts         # graph_health — сироты, дубликаты (только Тишь)
│
├── tests/
│   ├── config.test.ts                   # 3 теста, 100% покрытие
│   ├── events/
│   │   ├── session-handler.test.ts      # 8 тестов
│   │   ├── file-handler.test.ts         # 12 тестов
│   │   └── tool-handler.test.ts         # 3 теста
│   ├── granulator/
│   │   ├── schema.test.ts              # 14 тестов, ~100% покрытие
│   │   └── engine.test.ts              # 3 теста (только успешный path)
│   ├── mcp/
│   │   └── client.test.ts              # 9 тестов, ~100% покрытие
│   └── scanner/
│       └── code-index.test.ts           # покрытие code-index
│
├── docs/
│   ├── ARCHITECTURE.md                  # [требует актуализации]
│   ├── CONFIGURATION.md                 # [требует актуализации]
│   ├── DEPLOYMENT.md                    # [НОВЫЙ] Стандарт развертывания
│   ├── GRANULATION.md                   # Правила грануляции
│   ├── GRANULATION_STANDARD.md          # Полный стандарт грануляции (сущности, связи)
│   └── PLAN_CODE_INDEX.md               # План code_index
│
├── .github/
│   └── workflows/
│       ├── ci.yml                       # Тестирование (PR)
│       └── deploy.yml                   # [НОВЫЙ] Сборка + деплой (main)
│
└── README.md                            # [требует актуализации]
```

---

## 5 Namespace в selti

| Namespace | Гранул | Связность | Назначение |
|---|---|---|---|
| `code_knowledge` | 408 | 48% | Код: модули, классы, функции, архитектура, изменения |
| `project_meta` | 162 | 35% | Архитектурные решения, ADR, риски, статусы |
| `dialogue_insights` | 78 | 44% | Инсайты, договорённости, выводы, контекст диалогов |
| `user_facts` | 54 | 30% → **72%** | Факты о пользователях, предпочтения, навыки |
| `infrastructure` | 0 | — | Серверы, контейнеры, сети, API (ждёт регистрации в backend) |

### CNLM-матрица (Cross-Namespace Link Matrix)

Определяет разрешённые LinkType для каждой пары namespace. Примеры:

| Источник | Цель | Разрешённые LinkType |
|---|---|---|
| `user_facts` | `dialogue_insights` | `derived_from`, `references` |
| `user_facts` | `project_meta` | `motivates`, `references` |
| `dialogue_insights` | `code_knowledge` | `references`, `solves` |
| `project_meta` | `code_knowledge` | `implements_adr`, `references` |
| `infrastructure` | `infrastructure` | `runs_on`, `contains`, `connected_to`, `exposes`, `mounts`, `depends_on`, `references` |

CNLM-валидация в `validateGranules()` — неблокирующая (`console.warn` при нарушении).

---

## Технологический стек

| Компонент | Технология |
|---|---|
| Язык | TypeScript (strict) |
| Runtime | Bun (встроен в opencode) |
| Plugin API | `@opencode-ai/plugin` |
| SDK | `@opencode-ai/sdk` |
| Тесты | Vitest (88 тестов, 8 файлов) |
| LLM (Тишь) | `opencode-go/deepseek-v4-flash` |
| Хранилище | PostgreSQL + pgvector + Redis (через selti) |
| Деплой | `~/.config/opencode/plugins/akame/` → Docker на ai.atom.ui |

---

## Ключевые архитектурные решения (ADR)

- **Реактивный подход** — без polling, только события opencode
- **LLM через SDK** — `client.session.prompt()` с `format: json_schema`
- **Fire-and-forget** — все операции асинхронные, не блокируют opencode
- **HTTP MCP** — прямая отправка гранул в selti через JSON-RPC
- **Permission delegation** — двухуровневая: opencode.json + in-code `context.agent`
- **Three-tier auto-linker** — Schema (CNLM) → Prompt (fetchRelevantGranules) → Post-process (enrichLinks)
- **Global cooldown** — 5 сек между любыми грануляциями, предотвращает лавину
- **Singleton prevention** — `globalThis` флаг, предотвращает 20x загрузку плагина
- **Service sessions** — отслеживаются в Set, пропускаются в обработчиках (защита от бесконечного цикла)

---

## История изменений

| Дата | Событие |
|---|---|
| 2026-07-24 | Плагин загружен, базовая грануляция работает |
| 2026-07-24 | Исправлено: бесконечный цикл, uppercase логгер, 20x загрузка, модель LLM |
| 2026-07-24 | Commit `f3d4b34` — все 8 фаз завершены, +2003/-27 строк |
| 2026-07-25 | Фаза 9: `migrate_legacy_granules` — миграция старых гранул |
| 2026-07-25 | Фаза 10: `link-enricher`, `graph_health`, CNLM-матрица |
| 2026-07-25 | Фаза 11: `enrichLinks`, `fetchRelevantGranules` |
| 2026-07-25 | Фаза 12: namespace `infrastructure`, 10 гранул о сервере |
| 2026-07-25 | Деплой на `ai.atom.ui` — SSH перезапуск контейнера |
| 2026-07-25 | Ретроспективная линковка: user_facts связность 30% → 72% |
| 2026-07-25 | Аудит: 15 проблем (2 P0, 8 P1, 4 P2, 1 P3) |
| 2026-07-25 | Дедупликация: 50 записей помечены `is_deprecated` |
| 2026-07-25 | Актуальное состояние: 702 гранулы, 88 тестов, 12 фаз завершено |
| **2026-07-30** | **Стандарт развертывания: Dockerfile, docker-compose.yml, deploy.sh, deploy.yml** |
