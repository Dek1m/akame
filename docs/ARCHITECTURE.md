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

### 12. scanner/code-index.ts — Сканер кода

**Файл:** `src/scanner/code-index.ts`

Regex-based парсеры для `.ts`/`.tsx` и `.py` файлов. Извлекает классы, интерфейсы, функции, типы и enum-ы.

**Основные функции:**

```typescript
parseTSFile(content: string, relativePath: string): ScannedFile
parsePythonFile(content: string, relativePath: string): ScannedFile
scanDirectory(rootDir: string): ScannedFile[]
scanProject(project: string, directory: string): ScanResult
```

**Типы сущностей:**

```typescript
type ScannedEntityType = "class" | "interface" | "function" | "type" | "enum";

interface ScannedEntity {
  type: ScannedEntityType;
  name: string;
  signature: string;
  source_location: string;  // "L42"
  extends?: string;
  implements?: string[];
  methods?: string[];
}

interface ScannedFile {
  path: string;
  module: string;
  exports: ScannedEntity[];
  imports: string[];
}

interface ScanResult {
  project: string;
  files: ScannedFile[];
  timestamp: string;
}
```

**TS-парсер:** отслеживает состояние тела класса (глубина фигурных скобок), извлекает методы, свойства-стрелки, наследование (`extends`/`implements`). Определяет: `export class`, `export interface`, `export function`, `export const ... = (...) =>`, `export type`, `export enum`.

**Python-парсер:** indent-основанный. Отслеживает классы и методы (`def` внутри класса), пропускает docstring-и. Определяет: `class`, `def`, `from ... import`, `import`.

**Исключаемые директории:** `node_modules`, `.venv`, `dist`, `build`, `__pycache__`, `.git`, `.next`, `coverage`.

---

### 13. tools/code-index-tool.ts — Tool code_index

**Файл:** `src/tools/code-index-tool.ts`

Сканирует проект и создаёт code_knowledge гранулы в athena-memory. Извлекает классы, интерфейсы, функции, типы и enum-ы из TypeScript и Python файлов. Создаёт модульные и сущностные гранулы со связями.

**Аргументы:**

| Поле | Тип | Описание |
|---|---|---|
| `project` | `string` | Название проекта (например, `"akame"`) |
| `directory` | `string` | Абсолютный путь к директории проекта |

**Доступ:** только `memory-granulator` (Тишь). Другие агенты получат ошибку «Доступ запрещён».

**Защита:** аргумент `directory` проверяется через `resolveSafePath()` — предотвращает path traversal за пределы рабочей директории.

**Поток выполнения:**

1. **Сканирование** — вызов `scanProject()` → `ScannedFile[]`
2. **Дедупликация** — поиск существующих гранул через `mcp.search()` (threshold 0.2 для массового поиска), сбор ключей `entity_name:project_id`
3. **Построение гранул:**
   - **Модульные** — одна гранула на модуль (`entity_type: "module"`)
   - **Сущностные** — по одной на каждый `ScannedEntity` (`entity_type: class/function/interface/type/enum`)
4. **Связи:**
   - `contained_by` — сущность → модуль
   - `depends_on` — по импортам (если имя импорта совпадает с известной сущностью)
   - `extends` / `implements` — наследование
5. **Сохранение** — батчами через `MCPClient.ingestBatch()` по `config.maxBatch` штук

**Результат:** отчёт с количеством просканированных файлов, созданных гранул (модули + сущности), пропущенных (уже в памяти), и статистикой сохранения.

---

### 14. tools/code-diff-tool.ts — Tool code_diff

**Файл:** `src/tools/code-diff-tool.ts`

Анализирует unified diff и создаёт code_knowledge гранулы. Парсит `git diff`, извлекает добавленные/удалённые/изменённые сущности (классы, функции, интерфейсы, типы, enum-ы).

**Аргументы:**

| Поле | Тип | Описание |
|---|---|---|
| `project` | `string` | Название проекта |
| `diff` | `string` | Unified diff для анализа |
| `commitHash` | `string?` | Хеш коммита для контекста (опционально) |

**Доступ:** только `memory-granulator` (Тишь).

**Поток выполнения:**

1. **Парсинг diff** — `parseDiff()` разбирает unified diff на `DiffFile[]` (файлы, ханки, строки)
2. **Извлечение изменений** — `extractChanges()` находит:
   - **Добавленные** (`action: "added"`): `export class`, `export function`, `export const ... =`, `export interface`, `export type`, `export enum`
   - **Удалённые** (`action: "removed"`): те же паттерны в удалённых строках
3. **Дедупликация** — поиск существующих гранул по `entity_name:project_id`
4. **Построение гранул:**
   - **Сводка** — одна гранула типа `change` на весь diff (файлы, строки, статистика)
   - **Сущностные** — по одной на каждое изменение с типом `entity_type` = тип сущности
5. **Связи:** `contained_by` → модуль файла
6. **Удалённые сущности** — помечаются `is_deprecated: true`
7. **Сохранение** — батчами через `MCPClient.ingestBatch()`

**Результат:** отчёт с количеством файлов, добавленных/изменённых/удалённых сущностей, созданных гранул.

---

### 15. tools/code-graph-tool.ts — Tool code_graph

**Файл:** `src/tools/code-graph-tool.ts`

Строит граф зависимостей из code_knowledge гранул. Находит отсутствующие обратные связи, циклические зависимости и сирот.

**Аргументы:**

| Поле | Тип | Описание |
|---|---|---|
| `project` | `string` | Название проекта |
| `fixMissingLinks` | `boolean?` | Если `true` — автоматически создаёт отсутствующие обратные связи |

**Доступ:** только `memory-granulator` (Тишь).

**Анализ:**

- **Отсутствующие обратные связи** — например, у A есть `depends_on` B, но у B нет `used_by` A. Матрица обратных связей: `depends_on` ↔ `used_by`, `contains` ↔ `contained_by`, `calls` ↔ `called_by`, `follows` ↔ `precedes`
- **Циклические зависимости** — поиск через DFS с раскраской (WHITE/GRAY/BLACK)
- **Сироты** — гранулы без входящих и исходящих связей

**Режим `fixMissingLinks=true`:** для каждой отсутствующей обратной связи создаёт `CodeLink` и обновляет гранулу через `mcp.update()`. Группирует обновления по target-сущности.

**Результат:** отчёт с количеством сущностей, рёбер, списком отсутствующих обратных связей, циклов, сирот. При `fixMissingLinks` — также количество исправленных связей.

---

### 16. tools/dependency-analyzer-tool.ts — Tool dependency_analyzer

**Файл:** `src/tools/dependency-analyzer-tool.ts`

Анализирует импорты в `.ts`/`.js`/`.py` файлах и создаёт/обновляет `depends_on` и `used_by` связи в code_knowledge гранулах.

**Аргументы:**

| Поле | Тип | Описание |
|---|---|---|
| `project` | `string` | Название проекта |
| `directory` | `string` | Абсолютный путь к директории проекта |

**Доступ:** только `memory-granulator` (Тишь).

**Защита:** `resolveSafePath()` — проверка на path traversal.

**Поток выполнения:**

1. **Сбор файлов** — рекурсивный обход, фильтр по расширениям (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`)
2. **Извлечение импортов** — `import ... from '...'`, `require()`, `await import()`, Python `import X` / `from X import Y`
3. **Классификация:**
   - **Внешние** (npm) — одиночный сегмент пути или scoped-пакет (`@scope/name`)
   - **Внутренние** — относительные (`./utils`) или внутренние модульные (`src/...`)
4. **Сопоставление с гранулами** — поиск существующих code_knowledge гранул через `mcp.search()`
5. **Создание связей:**
   - `depends_on` — от модуля к target-сущности (если импорт совпадает с известной гранулой)
   - `used_by` — обратная связь к target-сущности
6. **Обновление** — батчами через `mcp.update()`, без дублирования существующих связей

**Результат:** отчёт с количеством файлов, модулей, внутренних/внешних зависимостей, созданных связей, обновлённых гранул.

---

### 17. tools/migrate-legacy-granules-tool.ts — Tool migrate_legacy_granules

**Файл:** `src/tools/migrate-legacy-granules-tool.ts`

Мигрирует старые гранулы code_knowledge в новый формат. Находит записи без полей `entity_name` и/или `entity_type`, извлекает их из контента и обновляет метаданные.

**Аргументы:**

| Поле | Тип | Дефолт | Описание |
|---|---|---|---|
| `namespace` | `string?` | `"code_knowledge"` | Namespace для миграции |
| `dryRun` | `boolean?` | `false` | Только показать, что будет изменено |
| `maxRecords` | `string?` | `"0"` | Максимум записей (0 = без лимита) |

**Доступ:** `memory-granulator` (Тишь) и `user`.

**Извлечение entity_type и entity_name:**

- **Английские паттерны:** `class Foo`, `function foo`, `interface Foo`, `type Foo`, `enum Foo` — из начала контента
- **Русские паттерны:** `класс Foo`, `функция foo`, `модуль foo`, `интерфейс Foo`, `тип Foo`
- **По ключевым словам:** `architecture` (архитектурный паттерн), `config` (конфигурация), `change` (изменение), `test` (тест), `sql_query` (SQL-запрос), `table` (таблица)
- **Fallback:** извлечение имени из `title` — первые 2-3 слова заголовка

**Связи:** строит до 5 `related_to` связей по упоминаниям сущностей с большой буквы в контенте (исключая стоп-слова вроде `The`, `This`, `For`, `HTTP`, `JSON`).

**Поток:**

1. Пагинированный сбор всех записей из namespace через `mcp.list()`
2. Фильтрация legacy (записи без `entity_name` или `entity_type`)
3. Миграция батчами по 10 записей с паузой 100ms
4. Обновление через `mcp.update()`

**Результат:** количество просканированных, найденных legacy, мигрированных записей и ошибок.

---

### 18. tools/graph-health-tool.ts — Tool graph_health

**Файл:** `src/tools/graph-health-tool.ts`

Проверяет здоровье графа знаний. Анализирует связность, сирот, дубликаты и cross-namespace связи.

**Аргументы:**

| Поле | Тип | Описание |
|---|---|---|
| `project` | `string` | Название проекта |
| `verbose` | `boolean?` | Если `true` — показывает первые 20 сирот каждого namespace |

**Доступ:** только `memory-granulator` (Тишь).

**Метрики:**

- **По namespace** — total / linked / orphan / % связанности. Гранула считается связанной, если у неё есть исходящие ссылки (`links`) или на неё кто-то ссылается (входящие)
- **Cross-namespace матрица** — связи между разными namespace (например, `dialogue_insights → code_knowledge: 42`)
- **Критичные сироты** — топ-10 гранул с `importance ≥ 3` без единой связи
- **Дубликаты** — одинаковый `entity_name` в одном namespace
- **Среднее число связей** на гранулу

**Поток:**

1. Сбор всех гранул из всех namespace пагинацией (по 50 записей)
2. Построение lookup-таблиц: `idToGranule`, `nameToNs`
3. Подсчёт входящих связей и cross-namespace переходов
4. Анализ дубликатов
5. Формирование отчёта

**Результат:** многострочный отчёт со статистикой, top-10 критичных сирот, списком дубликатов (до 15).

---

### 19. granulator/link-enricher.ts — Пост-обработка связей

**Файл:** `src/granulator/link-enricher.ts`

Пост-обработка гранул после успешной грануляции. Автоматически создаёт cross-namespace связи между новыми и существующими гранулами.

**Активация:** фича-флаг `config.enrichLinks` (по умолчанию `true`).

**CNLM-матрица (Cross-Namespace Link Matrix):** определяет, между какими namespace искать связи:

| Source NS | Target NS для поиска |
|---|---|
| `user_facts` | `dialogue_insights`, `project_meta` |
| `dialogue_insights` | `code_knowledge`, `project_meta` |
| `project_meta` | `code_knowledge`, `user_facts` |
| `code_knowledge` | `project_meta` |

**Типы автосвязей при высокой похожести (≥ 0.85):**

| Source → Target | Тип связи |
|---|---|
| `dialogue_insights` → `code_knowledge` | `solves` |
| `code_knowledge` → `project_meta` | `implements_adr` |
| `user_facts` → `dialogue_insights` | `causes` |
| Остальные комбинации | `references` |

**Ограничения:**
- Максимум 5 связей на гранулу
- Порог похожести: `0.75` (для `memory_find_similar`)
- Гранулы с `importance = 1` не обогащаются
- Не связывает гранулу саму с собой

**Поток:**

1. Получение последних 200 гранул через `mcp.recent()`
2. Фильтрация по `session_id` текущей сессии
3. Для каждой новой гранулы: поиск кандидатов в target-namespace через `mcp.findSimilar()`
4. Определение типа связи (CNLM-матрица + порог)
5. Обновление гранулы через `mcp.update()` с объединённым списком связей

**Вызов:** из `engine.ts` после успешного сохранения гранул (fire-and-forget, ошибки логируются).

---

### 20. events/git-diff.ts — Git diff утилита

**Файл:** `src/events/git-diff.ts`

Утилита для получения unified diff через git. Используется обработчиками событий при грануляции изменений кода.

**Типы:**

```typescript
interface DiffResult {
  diff: string;
  filePath: string;
  type: "modified" | "created" | "deleted";
  content?: string;
}
```

**Функции:**

```typescript
getGitDiff(filePath: string, log?: Logger): DiffResult
truncateDiff(diff: string, maxLines?: number): string
```

**Логика `getGitDiff()`:**

1. Если файл не существует → `type: "deleted"`
2. Если не git-репозиторий → читает файл через `fs.readFileSync()`, возвращает `content`
3. Пробует `git diff HEAD -- <file>` для staged-изменений
4. Если diff пустой → пробует `git diff --no-index /dev/null <file>` (для новых файлов)
5. Если всё ещё пусто → читает файл напрямую

**`truncateDiff()`:** обрезает diff до `maxLines` (по умолчанию 200), сохраняя голову и хвост, с сообщением о пропущенных строках посередине.

**Таймауты:** 10 секунд на git-команду, буфер до 1MB.

---

### 21. security/validate.ts — Защита от path traversal

**Файл:** `src/security/validate.ts`

Предотвращает выход за пределы рабочей директории через path traversal-атаки.

**Функция:**

```typescript
function resolveSafePath(inputDir: string, workspaceDir: string): string
```

**Логика:**

1. Разрешает `inputDir` относительно `workspaceDir` через `path.resolve()`
2. Проверяет, что результат начинается с `workspaceDir` (с учётом `path.sep`)
3. При нарушении — бросает ошибку: `Path traversal: "<inputDir>" выходит за пределы "<workspaceDir>"`

**Использование:** в тулах `code_index` и `dependency_analyzer` для проверки аргумента `directory`, переданного LLM. Например, если LLM попытается передать `../../../etc/passwd`, `resolveSafePath()` заблокирует вызов.

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
