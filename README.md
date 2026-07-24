# akame

> opencode-плагин для автоматической грануляции диалогов и кода в семантическую память athena-memory

**akame** — это плагин для [opencode](https://opencode.ai), который превращает ваши диалоги, код и архитектурные решения в структурированные знания. Он реагирует на события opencode, анализирует контекст через LLM с агентом **memory-granulator (Тишь)**, и та через кастомный tool `granulate_output` сохраняет гранулы — самодостаточные описания фактов — в семантическую память [athena-memory](https://github.com/selti-project/athena-memory).

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
|  |  События:                  Обработчики:                       | |
|  |  session.idle -----------> session-handler.ts (cooldown 30s)  | |
|  |  file.edited ------------> file-handler.ts    (debounce 2s)   | |
|  |  tool.execute.after -----> tool-handler.ts    (git filter)    | |
|  |                                                               | |
|  |  +-----------+   +---------------+   +--------------------+   | |
|  |  | collector |-->|  granulator   |-->|  LLM (agent:      |   | |
|  |  | (данные)  |   |  engine.ts    |   |  memory-granulator)|  | |
|  |  +-----------+   +---------------+   +---------+----------+   | |
|  |                                         tool   |              | |
|  |                                   granulate_output             | |
|  |                                         |                      | |
|  |                                   +-----v----------+          | |
|  |                                   | granulate-tool  |          | |
|  |                                   | -> валидация    |          | |
|  |                                   | -> MCP client   |          | |
|  |                                   +--------+--------+          | |
|  +--------------------------------------------+-------------------+ |
+-------------------------------------------------------------------+
                                                 |
                                      JSON-RPC over HTTP POST
                                                 v
                             +-------------------------------------+
                             |  athena-memory (selti) :8000        |
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
AKAME_MCP_URL=http://athena-memory:8000/mcp/
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
| `AKAME_MCP_URL` | `http://athena-memory:8000/mcp/` | URL MCP-эндпоинта athena-memory |
| `AKAME_API_KEY` | — | API-ключ для авторизации (Bearer token) |
| `AKAME_USER_ID` | `akame` | Владелец записей в памяти |
| `AKAME_GRANULATE_IDLE` | `true` | Гранулировать при `session.idle` |
| `AKAME_GRANULATE_FILE` | `false` | Гранулировать при `file.edited` |
| `AKAME_GRANULATE_TOOL` | `true` | Гранулировать после git-команд (`tool.execute.after`) |
| `AKAME_COOLDOWN_MS` | `30000` | Cooldown между грануляциями одной сессии (мс) |
| `AKAME_DEBOUNCE_MS` | `2000` | Debounce для `file.edited` (мс) |
| `AKAME_MAX_BATCH` | `20` | Максимальное количество гранул в одном batch |
| `AKAME_MAX_MESSAGES` | `50` | Максимальное количество сообщений для анализа |

Полное описание см. в [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## Как работает грануляция

akame реагирует на три типа событий opencode:

| Событие | Что происходит | Защита |
|---|---|---|
| `session.idle` | Собирает сообщения (включая дочерние сессии), сохраняет данные в session-store, отправляет промпт LLM с агентом `memory-granulator`. LLM вызывает кастомный tool `granulate_output`, который валидирует гранулы и отправляет в athena-memory | Cooldown 30 сек |
| `file.edited` | Фильтрует код/конфиги, debounce перед грануляцией | Debounce 2 сек |
| `tool.execute.after` | Ловит git-команды (commit, push, merge, PR) | Фильтр только git |

**Ключевое отличие от предыдущей версии:** akame больше не парсит JSON из текстового ответа LLM. Вместо этого LLM (агент memory-granulator) вызывает кастомный tool `granulate_output` с типизированными аргументами. Валидация (`validateGranules`) происходит внутри tool, а не в engine.

Подробнее — в [docs/GRANULATION.md](docs/GRANULATION.md).

---

## Namespace-ы athena-memory

| Namespace | Назначение | Пример |
|---|---|---|
| `user_facts` | Факты о пользователе | «Серёжа предпочитает короткие access token» |
| `project_meta` | Архитектурные решения, ADR | «Принято решение использовать JWT вместо cookie-сессий» |
| `dialogue_insights` | Инсайты из диалогов | «Выяснено: проект требует горизонтального масштабирования» |
| `code_knowledge` | Знания из кода | «В auth.middleware.ts реализована проверка JWT» |

---

## Технологический стек

| Компонент | Технология |
|---|---|
| Язык | TypeScript |
| Runtime | Bun (opencode) |
| Plugin API | `@opencode-ai/plugin` v1 |
| SDK | `@opencode-ai/sdk` |
| Тесты | Vitest |
| Память | athena-memory (PostgreSQL + pgvector) |
| Протокол | JSON-RPC 2.0 over HTTP |

---

## Структура проекта

```
akame/
├── src/
│   ├── index.ts                 # Точка входа — PluginModule + v1 Hooks + регистрация tool
│   ├── config.ts                # Чтение переменных окружения AKAME_*
│   ├── constants.ts             # Namespace-ы, дефолты, типы конфигурации
│   ├── logger.ts                # Асинхронный логгер через client.app.log
│   ├── mcp/
│   │   └── client.ts            # HTTP-клиент athena-memory (JSON-RPC 2.0)
│   ├── granulator/
│   │   ├── schema.ts            # JSON Schema + типы + валидация гранул
│   │   ├── engine.ts            # Ядро: сбор контекста -> LLM (memory-granulator)
│   │   └── granulate-tool.ts    # Кастомный tool: валидация -> MCP -> athena-memory
│   └── events/
│       ├── session-handler.ts   # session.idle + cooldown
│       ├── file-handler.ts      # file.edited + debounce
│       └── tool-handler.ts      # tool.execute.after (git-only)
├── tests/
│   ├── mcp/
│   │   └── client.test.ts
│   ├── granulator/
│   │   ├── engine.test.ts
│   │   └── schema.test.ts
│   └── events/
│       ├── session-handler.test.ts
│       ├── file-handler.test.ts
│       └── tool-handler.test.ts
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CONFIGURATION.md
│   └── GRANULATION.md
├── .env.example
├── package.json
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
