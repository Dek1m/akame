# Архитектура akame

> Детальное описание архитектуры плагина akame: потоки данных, модули, LLM-вызов, MCP-клиент, event handlers, обработка ошибок.

---

## Схема потока данных

```
+-------------------+     +-----------------+     +--------------------------+
|   opencode event  |     |  Event Handler  |     |  Granulator Engine       |
|                   |---->|                 |---->|                          |
| session.idle      |     | session-handler |     | 1. Собрать контекст      |
| file.edited       |     | file-handler    |     | 2. Сохранить session-data|
| tool.execute.after|     | tool-handler    |     |    в session-store       |
+-------------------+     +-----------------+     | 3. Прочитать промпт Тиши |
                                                   | 4. Вызвать LLM           |
                                                   |    (agent: memory-       |
                                                   |     granulator)          |
                                                   +-----------+--------------+
                                                               |
                                                               | LLM вызывает tool
                                                               v
                                                   +--------------------------+
                                                   |  granulate-tool.ts       |
                                                   |  (кастомный tool)         |
                                                   |                          |
                                                   | 1. Получить session-data |
                                                   |    из session-store      |
                                                   | 2. Валидация аргументов  |
                                                   |    (validateGranules)    |
                                                   | 3. Отправка в MCP        |
                                                   |    (memory_ingest_batch) |
                                                   +-----------+--------------+
                                                               |
                                                               v
                                                   +--------------------------+
                                                   |  MCP Client              |
                                                   |  (HTTP POST)             |
                                                   |                          |
                                                   | JSON-RPC 2.0:            |
                                                   | memory_ingest_batch      |
                                                   +-----------+--------------+
                                                               |
                                                               v
                                                   +--------------------------+
                                                   | athena-memory            |
                                                   | PostgreSQL +             |
                                                   | pgvector + Redis         |
                                                   +--------------------------+
```

---

## Модули

### 1. index.ts — Точка входа

**Файл:** `src/index.ts`

Экспорт `PluginModule` с функцией `server` — основной хук плагина opencode v1 API.

```typescript
pluginModule.server(input, options) -> Hooks
```

Возвращает объект `Hooks` с четырьмя обработчиками:

| Хук | Тип | Описание |
|---|---|---|
| `event` | `(event: Event) => Promise<void>` | Обработка событий opencode |
| `tool.execute.after` | `(input, output) => Promise<void>` | Пост-обработка инструментов |
| `tool` | `Record<string, Tool>` | Регистрация кастомных tools (в т.ч. `granulate_output`) |
| `dispose` | `() => Promise<void>` | Выгрузка плагина |

**Регистрация tool:** При загрузке плагина создаётся экземпляр `granulateTool` через `createGranulateTool()`. Tool регистрируется в хуке `tool`:

```typescript
tool: {
  granulate_output: granulateTool,
},
```

**Ответственность:** Инициализация конфигурации, логгера, регистрация tools, маршрутизация событий.

---

### 2. config.ts — Конфигурация

**Файл:** `src/config.ts`

Читает переменные окружения `AKAME_*` и возвращает объект `AkameConfig`.

```typescript
function loadConfig(env?: Record<string, string | undefined>): AkameConfig
```

- Все переменные опциональны — дефолты определены в `constants.ts`
- Булевы значения парсятся из строк `"true"` или `"1"`
- Числовые значения парсятся через `parseInt` с дефолтами

---

### 3. constants.ts — Константы и типы

**Файл:** `src/constants.ts`

Определяет:

- **Namespace-ы** athena-memory: `user_facts`, `project_meta`, `dialogue_insights`, `code_knowledge`
- **Дефолты** конфигурации (MCP_URL, USER_ID, таймауты, лимиты)
- **Интерфейс** `AkameConfig` — полная типизация конфигурации

---

### 4. logger.ts — Логирование

**Файл:** `src/logger.ts`

Асинхронный логгер, интегрированный с `client.app.log` opencode.

**Уровни:** `info`, `warn`, `error`, `debug`

**Особенность:** Все вызовы `fire-and-forget` — ошибки логирования не влияют на работу плагина. Это принципиальное решение: плагин не должен падать из-за проблем с логированием.

```typescript
// Пример использования
log.info("session.idle: sess_abc123");
log.error("MCP ошибка: connection refused");
```

---

### 5. mcp/client.ts — HTTP-клиент athena-memory

**Файл:** `src/mcp/client.ts`

Класс `MCPClient` — обёртка над HTTP POST для вызова методов athena-memory через JSON-RPC 2.0.

**Протокол:**

```
POST /mcp/
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": "uuid",
  "method": "tools/call",
  "params": {
    "name": "memory_ingest_batch",
    "arguments": { "entries": [...], "user_id": "akame" }
  }
}
```

**Методы:**

| Метод | Описание |
|---|---|
| `ingestBatch(entries, userId)` | Пакетная вставка гранул |
| `store(content, userId, metadata?, namespace?)` | Одиночная запись |
| `search(query, userId, limit?, threshold?, namespace?)` | Семантический поиск |
| `get(id)` | Получение записи по ID |
| `update(id, content?, metadata?)` | Обновление записи |
| `delete(id)` | Удаление записи |
| `list(userId?, namespace?, limit?, offset?)` | Список записей |
| `forget(userId, namespace?)` | Удаление всех записей |
| `stats(userId)` | Статистика по namespaces |
| `findSimilar(content, userId, ...)` | Поиск похожих записей |

**Обработка ответов:**

Клиент поддерживает два формата ответа:
1. **SSE (Server-Sent Events)** — ответ приходит блоками `data: {...}`
2. **Прямой JSON-RPC** — ответ в теле HTTP

В обоих случаях извлекается `result.content[0].text` и парсится как JSON.

**Таймаут:** 30 секунд на каждый запрос.

**Авторизация:** Опциональный `Bearer` токен через `AKAME_API_KEY`.

---

### 6. granulator/schema.ts — Схема грануляции

**Файл:** `src/granulator/schema.ts`

Определяет JSON Schema и TypeScript-типы для structured output LLM.

**Структура гранулы:**

```typescript
interface Granule {
  content: string;                    // самодостаточное описание
  namespace: Namespace;               // категория
  importance: 1 | 2 | 3 | 4 | 5;     // важность
  metadata: {
    session_id: string;               // ID сессии
    agent: string;                    // имя агента
    project_id: string;               // ID проекта
    title: string;                    // заголовок (до 80 символов)
    message_ids: string[];            // ID сообщений
    participants: string[];           // участники диалога
  };
}
```

**Структура ответа LLM:**

```typescript
interface GranulatorOutput {
  summary: string;      // о чём диалог одной строкой (до 200 символов)
  granules: Granule[];  // массив гранул (0-20 штук)
}
```

**Валидация:**

Функция `validateGranules()` проверяет каждый ответ LLM:
- `summary` — непустая строка
- `granules` — массив объектов
- Каждая гранула: `content` непустой, `namespace` из допустимых, `importance` 1-5
- `metadata` содержит все обязательные поля
- `title` не длиннее 80 символов

---

### 7. granulator/engine.ts — Ядро грануляции

**Файл:** `src/granulator/engine.ts`

Центральная функция `granulate()` — координирует процесс, но **не занимается отправкой в athena-memory**. Эту работу выполняет кастомный tool `granulate_output`.

**Входные данные (GranulateContext):**

```typescript
interface GranulateContext {
  sessionId: string;
  agent: string;
  projectId: string;
  messages: { id: string; role: string; content: string }[];
  participants: string[];
}
```

**Поток:**

1. Чтение промпта Тиши из `~/.config/opencode/agents/memory-granulator.md`
2. Сохранение данных сессии в session-store (in-memory `Map` с TTL 10 минут) — чтобы tool `granulate_output` мог получить `message_ids` и `participants`
3. Формирование payload: system prompt + данные диалога
4. Вызов LLM через `client.session.prompt()` с агентом `memory-granulator`
5. LLM анализирует диалог и вызывает кастомный tool `granulate_output` с аргументами
6. Tool валидирует, отправляет в athena-memory, возвращает результат
7. Служебная сессия удаляется

**Что НЕ делает engine:**
- Не парсит JSON из текста LLM (это делает opencode при вызове tool)
- Не вызывает `validateGranules()` напрямую (это делает tool)
- Не отправляет данные в MCP-клиент (это делает tool)
- Не генерирует `GranuleMetadata` (LLM передаёт title + participants, остальное добавляет tool)

**Обработка длинных диалогов:**

Если сообщений больше `AKAME_MAX_MESSAGES`, они обрезаются — берутся последние N.

**Fire-and-forget:**

Все ошибки логируются, но не прерывают работу opencode.

---

### 8. granulator/granulate-tool.ts — Кастомный tool грануляции

**Файл:** `src/granulator/granulate-tool.ts`

Кастомный tool, который LLM (агент memory-granulator) вызывает вместо генерации JSON в тексте. Зарегистрирован в `index.ts` через hooks.tool.

**Создание:**

```typescript
export function createGranulateTool(config: AkameConfig, log: Logger) {
  const mcp = new MCPClient(config);

  return tool({
    description: "Сохранить результаты анализа диалога...",
    args: { /* summary, granules */ },
    async execute(args, context) { /* ... */ },
  });
}
```

**Аргументы tool:**

| Поле | Тип | Описание |
|---|---|---|
| `summary` | `string` (max 200) | Краткое описание диалога |
| `granules` | `array` (1–20) | Массив извлечённых гранул |

**Каждая гранула в аргументах:**

```typescript
{
  content: string;        // самодостаточное описание
  namespace: "user_facts" | "project_meta" | "dialogue_insights" | "code_knowledge";
  importance: 1 | 2 | 3 | 4 | 5;
  title: string;          // заголовок (до 80 символов)
  participants: string[]; // участники, имеющие отношение к грануле
}
```

**Обратите внимание:** LLM не передаёт `session_id`, `agent`, `project_id`, `message_ids` — их добавляет сам tool из контекста вызова и session-store.

**Поток выполнения tool:**

1. **Извлечение контекста:** `context.sessionID` из opencode, данные сессии из session-store
2. **Формирование полноценного объекта GranulatorOutput:** аргументы LLM + метаданные из контекста
3. **Валидация:** вызов `validateGranules()` из `schema.ts` — проверяет структуру, типы, обязательные поля
4. **Отправка в athena-memory:** через `MCPClient.ingestBatch()` с батчированием (по `config.maxBatch` штук)
5. **Возврат результата:** строка с количеством гранул и summary

**Session-store:**

```typescript
const sessionStore = new Map<string, SessionData>();
const STORE_TTL = 10 * 60 * 1000; // 10 минут
```

Данные сессии (сообщения, участники) сохраняются в `engine.ts` перед вызовом LLM и забираются tool при вызове. TTL 10 минут — чтобы tool мог найти данные, даже если LLM отвечает с задержкой.

**Преимущества подхода с tool:**

- **Типобезопасность:** LLM не может сгенерировать невалидный JSON — opencode проверяет аргументы
- **Нет парсинга:** Не нужно вытаскивать JSON из markdown-блоков
- **Прозрачность:** Вся логика валидации и отправки — в одном месте
- **Меньше кода в engine:** engine только собирает контекст и вызывает LLM

---

### 9. events/session-handler.ts — Обработчик сессий

**Файл:** `src/events/session-handler.ts`

**Триггер:** `session.idle`

**Поток:**

1. Проверка `config.granulateIdle` — если `false`, выход
2. Извлечение `sessionID` из события
3. Проверка cooldown — если прошло меньше `config.cooldownMs` с последней грануляции, выход
4. Запись времени cooldown
5. Получение сообщений сессии через `client.session.messages()`
6. Получение дочерних сессий через `client.session.children()`
7. Сбор сообщений из дочерних сессий
8. Определение участников (ролей)
9. Формирование `GranulateContext`
10. Вызов `granulate()`

**Cooldown:**

```typescript
const cooldowns = new Map<string, number>();  // sessionId -> timestamp
```

Cooldown хранится в памяти — при перезапуске opencode сбрасывается. Это нормально: после перезапуска первая сессия будет гранулирована.

**Особенности:**

- Фильтрует только `text`-части сообщений (игнорирует изображения, tool calls)
- Собирает дочерние сессии (sub-agents) рекурсивно
- Ловит ошибки на каждом шаге — одна проблемная сессия не ломает остальные

---

### 10. events/file-handler.ts — Обработчик файлов

**Файл:** `src/events/file-handler.ts`

**Триггер:** `file.edited`

**Поток:**

1. Проверка `config.granulateFile` — если `false`, выход (по умолчанию выключен)
2. Извлечение пути файла из события
3. Фильтр по расширениям — только код и конфиги
4. Debounce — откладывает грануляцию на `config.debounceMs`

**Допустимые расширения:**

`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.swift`, `.json`, `.yaml`, `.yml`, `.toml`, `.md`, `.sql`

**Debounce:**

```typescript
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
```

Если файл быстро редактируется, таймер сбрасывается. Грануляция произойдёт только после паузы в `config.debounceMs`.

---

### 11. events/tool-handler.ts — Обработчик инструментов

**Файл:** `src/events/tool-handler.ts`

**Триггер:** `tool.execute.after`

**Поток:**

1. Проверка `config.granulateTool` — если `false`, выход
2. Фильтр по имени инструмента — только `git`, `bash`, `gh`
3. Фильтр по аргументам — только git-команды:
   - `git commit`, `git push`, `git merge`
   - `gh pr create`, `gh pr merge`
   - Любые команды с `push`, `commit`, `merge`, `pr`
4. Логирование команды

**Фильтрация git-команд:**

```typescript
const GIT_TOOLS = new Set(["git", "bash", "gh"]);

// Проверяются:
// - Имя инструмента в GIT_TOOLS
// - Аргументы содержат git/gh/push/commit/merge/pr
```

---

## LLM-вызов

### Служебная сессия

akame вызывает LLM через **изолированную служебную сессию** opencode. Это значит:

- Вызов **не блокирует** диалог пользователя
- LLM работает в отдельном контексте
- Используется `client.session.prompt()` с указанием агента `memory-granulator`
- Промпт читается из файла `~/.config/opencode/agents/memory-granulator.md` (промпт агента Тишь)

### Пример вызова

```typescript
const result = await client.session.prompt({
  path: { id: serviceSessionId },
  body: {
    parts: [{ type: "text", text: systemPrompt + "\n\n" + userPrompt }],
    agent: "memory-granulator",
  },
});
```

**Важное отличие от предыдущей версии:** LLM больше не вызывается с `format: json_schema`. Вместо этого opencode предоставляет LLM кастомный tool `granulate_output`, и LLM вызывает его по мере необходимости. Это стандартный механизм tool-вызова в opencode — LLM может решить, когда вызывать tool и с какими аргументами.

### Обработка ответа

1. LLM анализирует диалог и вызывает tool `granulate_output`
2. Tool валидирует аргументы, формирует GranuleMetadata, шлёт в athena-memory
3. Engine получает текстовый ответ от tool (не JSON для парсинга)
4. Служебная сессия удаляется

---

## MCP-клиент

MCP-клиент используется **только внутри кастомного tool `granulate_output`**. Engine не вызывает MCP напрямую.

### Протокол

Все запросы к athena-memory идут через HTTP POST на `AKAME_MCP_URL` в формате JSON-RPC 2.0:

```json
{
  "jsonrpc": "2.0",
  "id": "uuid",
  "method": "tools/call",
  "params": {
    "name": "memory_ingest_batch",
    "arguments": {
      "entries": [...],
      "user_id": "akame"
    }
  }
}
```

### Поддержка SSE

Клиент умеет работать с ответами в формате Server-Sent Events:

```
data: {"jsonrpc":"2.0","id":"...","result":{"content":[{"type":"text","text":"..."}]}}
```

Последний блок `data:` парсится как JSON-RPC ответ.

### Таймауты

- **HTTP-запрос:** 30 секунд (AbortController)
- При превышении — ошибка, error-лог, выход

---

## Event Handlers

### Жизненный цикл

```
opencode event
      |
      v
index.ts (event hook)
      |
      +-- session.idle --> session-handler.ts
      |                        |
      |                        v
      |                   cooldown check
      |                        |
      |                        v
      |                   engine.ts (сохраняет сессию, зовёт LLM)
      |                        |
      |                        v
      |                   LLM вызывает granulate-tool.ts
      |                        |
      |                        v
      |                   tool валидирует + шлёт в MCP
      |
      +-- file.edited --> file-handler.ts
      |                        |
      |                        v
      |                   debounce + filter
      |
      +-- tool.execute.after --> tool-handler.ts
                                     |
                                     v
                                git filter
```

### Cooldown (session.idle)

Защищает от дублирования гранул при быстрых повторных `session.idle`. Хранится в `Map<sessionId, timestamp>` в памяти процесса.

```
session.idle (t=0)  -->  грануляция OK
session.idle (t=15) -->  пропуск (прошло 15 сек < 30 сек)
session.idle (t=31) -->  грануляция OK
```

### Debounce (file.edited)

Откладывает грануляцию直到 пользователь перестанет редактировать файл. Таймер сбрасывается при каждом новом событии для того же файла.

```
file.edited (t=0)   -->  start timer 2s
file.edited (t=1)   -->  reset timer 2s
file.edited (t=2.1) -->  грануляция (прошло 2.1 сек без редактирования)
```

### Git-фильтр (tool.execute.after)

Фильтрует только git-связанные команды. Проверяется и имя инструмента, и содержимое аргументов.

```typescript
const GIT_TOOLS = new Set(["git", "bash", "gh"]);

// Команда считается git-командой, если:
// - Инструмент в GIT_TOOLS
// - Аргументы содержат: git, gh, push, commit, merge, pr
```

---

## Обработка ошибок

### Принцип

**Плагин не должен падать.** Все ошибки ловятся и логируются, но не прерывают работу opencode.

### Уровни

| Уровень | Что происходит | Пример |
|---|---|---|
| **Debug** | Нормальная работа | `событие: session.idle` |
| **Info** | Ключевые шаги | `granulate: sess_abc (12 сообщений)` |
| **Warn** | Проблемы, не критичные | `MCP timeout, retrying...` |
| **Error** | Ошибки, требующие внимания | `MCP HTTP 500: Internal Server Error` |

### Сценарии ошибок

| Сценарий | Поведение |
|---|---|
| Нет сообщений в сессии | Debug-лог, выход |
| Cooldown не прошёл | Тихий выход |
| LLM не вызвал tool `granulate_output` | Error-лог, выход (engine получит пустой или текстовый ответ) |
| Tool получил невалидные аргументы | Tool выбрасывает ошибку, LLM может попробовать снова |
| athena-memory недоступна | Error-лог, выход (tool ловит ошибку) |
| Неподдерживаемое расширение файла | Тихий выход |
| Ошибка чтения промпта | Error-лог, выход |
| Данные сессии истекли в session-store (TTL 10 мин) | Tool создаёт гранулы без message_ids, но сохраняет

### Логирование

Все логи идут через `client.app.log` opencode:

```typescript
client.app.log({
  body: {
    service: "akame",
    level: "error",
    message: "MCP HTTP 500: Internal Server Error",
  },
});
```

При ошибке `app.log` плагин молча проглатывает — не влияет на работу.
