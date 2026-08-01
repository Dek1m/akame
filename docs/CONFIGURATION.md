# Конфигурация akame

> Полное руководство по настройке плагина akame: переменные окружения, примеры, советы.

---

## Переменные окружения

| Переменная | Тип | Дефолт | Описание |
|---|---|---|---|
| `AKAME_MCP_URL` | string | `http://athena-memory:8000/mcp/` | URL MCP-эндпоинта athena-memory |
| `AKAME_API_KEY` | string | — | API-ключ для авторизации (Bearer token) |
| `AKAME_USER_ID` | string | `akame` | Владелец записей в памяти |
| `AKAME_GRANULATE_IDLE` | boolean | `true` | Гранулировать при `session.idle` |
| `AKAME_GRANULATE_COMPACTED` | boolean | `true` | Гранулировать при `session.compacted` |
| `AKAME_GRANULATE_DIFF` | boolean | `false` | Гранулировать при `session.diff` |
| `AKAME_GRANULATE_FILE` | boolean | `false` | Гранулировать при `file.edited` |
| `AKAME_GRANULATE_FILE_WATCHER` | boolean | `false` | Гранулировать при `file.watcher.updated` |
| `AKAME_GRANULATE_TOOL` | boolean | `true` | Гранулировать после git-команд |
| `AKAME_GRANULATE_TOOL_BEFORE` | boolean | `false` | Pre-processing при `tool.execute.before` |
| `AKAME_GRANULATE_COMMAND` | boolean | `false` | Гранулировать после выполненных команд |
| `AKAME_COOLDOWN_MS` | number | `30000` | Cooldown между грануляциями (мс) |
| `AKAME_DEBOUNCE_MS` | number | `2000` | Debounce для `file.edited` (мс) |
| `AKAME_MAX_BATCH` | number | `20` | Макс. гранул в одном `ingest_batch` |
| `AKAME_MAX_MESSAGES` | number | `50` | Макс. сообщений для анализа |
| `AKAME_ENRICH_LINKS` | boolean | `true` | Пост-обработка: автосвязи между гранулами |
| `AKAME_ENRICH_PROMPT` | boolean | `true` | Внедрение релевантных гранул в промпт |

---

## Пример .env файла

```env
# ── Подключение к athena-memory ──
AKAME_MCP_URL=http://athena-memory:8000/mcp/
AKAME_API_KEY=sk-athena-your-key-here

# ── Идентификатор владельца ──
AKAME_USER_ID=akame

# ── Триггеры грануляции: события сессий ──
AKAME_GRANULATE_IDLE=true
AKAME_GRANULATE_COMPACTED=true
AKAME_GRANULATE_DIFF=false

# ── Триггеры грануляции: события файлов ──
AKAME_GRANULATE_FILE=false
AKAME_GRANULATE_FILE_WATCHER=false

# ── Триггеры грануляции: события тулов ──
AKAME_GRANULATE_TOOL=true
AKAME_GRANULATE_TOOL_BEFORE=false
AKAME_GRANULATE_COMMAND=false

# ── Таймауты ──
AKAME_COOLDOWN_MS=30000
AKAME_DEBOUNCE_MS=2000

# ── Лимиты ──
AKAME_MAX_BATCH=20
AKAME_MAX_MESSAGES=50

# ── Обогащение гранул ──
AKAME_ENRICH_LINKS=true
AKAME_ENRICH_PROMPT=true
```

---

## Настройка в opencode.json

### Минимальная конфигурация

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

### С переменными окружения

```json
{
  "plugins": {
    "akame": {
      "source": ".opencode/plugins/akame",
      "enabled": true,
      "env": {
        "AKAME_MCP_URL": "http://athena-memory:8000/mcp/",
        "AKAME_API_KEY": "sk-athena-your-key",
        "AKAME_USER_ID": "akame"
      }
    }
  }
}
```

### Полная конфигурация

```json
{
  "plugins": {
    "akame": {
      "source": ".opencode/plugins/akame",
      "enabled": true,
      "env": {
        "AKAME_MCP_URL": "http://athena-memory:8000/mcp/",
        "AKAME_API_KEY": "sk-athena-your-key",
        "AKAME_USER_ID": "akame",
        "AKAME_GRANULATE_IDLE": "true",
        "AKAME_GRANULATE_COMPACTED": "true",
        "AKAME_GRANULATE_DIFF": "false",
        "AKAME_GRANULATE_FILE": "false",
        "AKAME_GRANULATE_FILE_WATCHER": "false",
        "AKAME_GRANULATE_TOOL": "true",
        "AKAME_GRANULATE_TOOL_BEFORE": "false",
        "AKAME_GRANULATE_COMMAND": "false",
        "AKAME_COOLDOWN_MS": "30000",
        "AKAME_DEBOUNCE_MS": "2000",
        "AKAME_MAX_BATCH": "20",
        "AKAME_MAX_MESSAGES": "50",
        "AKAME_ENRICH_LINKS": "true",
        "AKAME_ENRICH_PROMPT": "true"
      }
    }
  }
}
```

---

## Описание настроек

### Подключение

#### AKAME_MCP_URL

URL-адрес MCP-эндпоинта athena-memory. Все запросы идут через HTTP POST на этот адрес.

```env
# Локально
AKAME_MCP_URL=http://localhost:8000/mcp/

# В Docker (ссылка на сервис)
AKAME_MCP_URL=http://athena-memory:8000/mcp/

# С внешним доменом
AKAME_MCP_URL=https://memory.example.com/mcp/
```

#### AKAME_API_KEY

API-ключ для авторизации. Если athena-memory требует авторизацию, передаётся как `Bearer` токен в заголовке `Authorization`.

```env
# С авторизацией
AKAME_API_KEY=sk-athena-production-key

# Без авторизации (переменная не задана)
# Заголовок Authorization не отправляется
```

#### AKAME_USER_ID

Идентификатор владельца записей в athena-memory. Все гранулы привязываются к этому пользователю.

```env
# Дефолт
AKAME_USER_ID=akame

# Каждому разработчику — свой ID
AKAME_USER_ID=sergey
```

---

### Триггеры

#### AKAME_GRANULATE_IDLE

Включает/выключает грануляцию при событии `session.idle`.

```env
# Включено (по умолчанию)
AKAME_GRANULATE_IDLE=true

# Выключено
AKAME_GRANULATE_IDLE=false
AKAME_GRANULATE_IDLE=0
```

**Когда включать:** Всегда. Это основной источник знаний — диалоги пользователя с агентами.

#### AKAME_GRANULATE_FILE

Включает/выключает грануляцию при событии `file.edited`.

```env
# Выключено (по умолчанию)
AKAME_GRANULATE_FILE=false

# Включено
AKAME_GRANULATE_FILE=true
```

**Когда включать:** Если хотите, чтобы каждое изменение файла генерировало гранулу `code_knowledge`. Осторожно: при активном редактировании генерируется много записей.

#### AKAME_GRANULATE_TOOL

Включает/выключает грануляцию после git-команд.

```env
# Включено (по умолчанию)
AKAME_GRANULATE_TOOL=true

# Выключено
AKAME_GRANULATE_TOOL=false
```

**Когда выключать:** Если git-команды выполняются слишком часто и засоряют память.

---

### Таймауты

#### AKAME_COOLDOWN_MS

Минимальный интервал между грануляциями одной сессии. Защищает от дублирования при быстрых повторных `session.idle`.

```env
# Дефолт: 30 секунд
AKAME_COOLDOWN_MS=30000

# Чаще (для коротких диалогов)
AKAME_COOLDOWN_MS=10000

# Реже (для долгих сессий)
AKAME_COOLDOWN_MS=60000
```

#### AKAME_DEBOUNCE_MS

Задержка перед грануляцией `file.edited`. Если файл быстро редактируется, таймер сбрасывается.

```env
# Дефолт: 2 секунды
AKAME_DEBOUNCE_MS=2000

# Быстрее
AKAME_DEBOUNCE_MS=1000

# Медленнее (для частого редактирования)
AKAME_DEBOUNCE_MS=5000
```

---

### Лимиты

#### AKAME_MAX_BATCH

Максимальное количество гранул, отправляемых за один вызов `memory_ingest_batch`.

```env
# Дефолт: 20
AKAME_MAX_BATCH=20

# Больше (для длинных диалогов)
AKAME_MAX_BATCH=50

# Меньше (для экономии памяти)
AKAME_MAX_BATCH=10
```

#### AKAME_MAX_MESSAGES

Максимальное количество сообщений, передаваемых в LLM для анализа. При превышении обрезаются самые старые.

```env
# Дефолт: 50
AKAME_MAX_MESSAGES=50

# Короткие диалоги
AKAME_MAX_MESSAGES=20

# Длинные диалоги
AKAME_MAX_MESSAGES=100
```

---

### Обогащение гранул

#### AKAME_ENRICH_LINKS

Включает пост-обработку гранул: автоматическое создание связей между гранулами после грануляции.

```env
# Включено (по умолчанию)
AKAME_ENRICH_LINKS=true

# Выключено
AKAME_ENRICH_LINKS=false
```

**Когда включать:** Всегда. Автосвязи (`depends_on`, `used_by`, `references` и др.) делают граф знаний связным и навигабельным.

#### AKAME_ENRICH_PROMPT

Внедряет релевантные гранулы из памяти в промпт LLM перед грануляцией. LLM получает контекст предыдущих знаний, что повышает качество новых гранул.

```env
# Включено (по умолчанию)
AKAME_ENRICH_PROMPT=true

# Выключено
AKAME_ENRICH_PROMPT=false
```

**Когда отключать:** Если промпт становится слишком большим, а модель имеет ограниченное контекстное окно. Либо если релевантные гранулы не помогают качеству.

---

## Сценарии настройки

### Локальная разработка

```env
AKAME_MCP_URL=http://localhost:8000/mcp/
AKAME_USER_ID=sergey
AKAME_GRANULATE_IDLE=true
AKAME_GRANULATE_FILE=false
AKAME_GRANULATE_TOOL=true
AKAME_COOLDOWN_MS=30000
AKAME_ENRICH_LINKS=true
AKAME_ENRICH_PROMPT=true
```

### Команда (Docker)

```env
AKAME_MCP_URL=http://athena-memory:8000/mcp/
AKAME_API_KEY=sk-team-shared-key
AKAME_USER_ID=akame
AKAME_GRANULATE_IDLE=true
AKAME_GRANULATE_COMPACTED=true
AKAME_GRANULATE_FILE=true
AKAME_GRANULATE_TOOL=true
AKAME_COOLDOWN_MS=15000
AKAME_MAX_MESSAGES=100
AKAME_ENRICH_LINKS=true
AKAME_ENRICH_PROMPT=true
```

### Продакшен

```env
AKAME_MCP_URL=https://memory.prod.example.com/mcp/
AKAME_API_KEY=sk-prod-production-key
AKAME_USER_ID=akame
AKAME_GRANULATE_IDLE=true
AKAME_GRANULATE_FILE=false
AKAME_GRANULATE_TOOL=true
AKAME_COOLDOWN_MS=60000
AKAME_MAX_BATCH=10
AKAME_MAX_MESSAGES=30
AKAME_ENRICH_LINKS=true
AKAME_ENRICH_PROMPT=true
```

---

## JSON5 конфигурация

Альтернатива env-переменным — файл `akame.json5`. Поддерживает комментарии, trailing commas и нестрогий синтаксис JSON.

### Каскад загрузки

```
defaults.ts → akame.json5 → AKAME_* env
```

Каждый следующий источник перезаписывает предыдущий. Env-переменные **всегда** имеют наивысший приоритет.

### Поиск файла

| Приоритет | Путь | Описание |
|---|---|---|
| 1 | `./akame.json5` | Рядом с `opencode.json` (локальный) |
| 2 | `~/.config/opencode/akame.json5` | Глобальный для пользователя |

Если файл не найден — используются дефолты из `defaults.ts`. Если найден, но содержит ошибку парсинга — выводится предупреждение в консоль, используются дефолты.

### Формат akame.json5

```json5
{
  // ── MCP-сервер athena-memory ──
  mcpUrl: "http://athena-memory:8000/mcp/",
  apiKey: "sk-athena-your-key",   // опционально
  userId: "akame",

  // ── Триггеры грануляции ──
  idle: true,           // session.idle → грануляция
  compacted: true,      // session.compacted → финальная
  diff: false,          // session.diff → инкрементальная
  fileEdited: false,    // file.edited → diff'ы
  fileWatcher: false,   // file.watcher.updated
  toolAfter: true,      // tool.execute.after → git/Gera
  toolBefore: false,    // tool.execute.before → pre-processing
  command: false,       // command.executed

  // ── Cooldown и лимиты ──
  cooldownMs: 30000,       // Мин. время между грануляциями (мс)
  debounceMs: 2000,        // Debounce для file.edited (мс)
  maxBatch: 20,            // Макс. гранул в MCP batch-запросе
  maxMessages: 50,         // Макс. сообщений для анализа

  // ── Обогащение гранул ──
  enrichLinks: true,       // Автосвязи между гранулами
  enrichPrompt: true,      // Внедрение релевантных гранул в промпт

  // ── Batch-обработка ──
  batchEnabled: true,      // Группировка диалогов в batch
  batchSize: 5,            // Макс. диалогов в одном batch
  batchMaxAgeMs: 3600000   // Макс. время ожидания batch (1 час)
}
```

### Маппинг JSON5-ключей → env-переменные

| JSON5 ключ | Env-переменная | Тип |
|---|---|---|
| `mcpUrl` | `AKAME_MCP_URL` | string |
| `apiKey` | `AKAME_API_KEY` | string |
| `userId` | `AKAME_USER_ID` | string |
| `idle` | `AKAME_GRANULATE_IDLE` | boolean |
| `compacted` | `AKAME_GRANULATE_COMPACTED` | boolean |
| `diff` | `AKAME_GRANULATE_DIFF` | boolean |
| `fileEdited` | `AKAME_GRANULATE_FILE` | boolean |
| `fileWatcher` | `AKAME_GRANULATE_FILE_WATCHER` | boolean |
| `toolAfter` | `AKAME_GRANULATE_TOOL` | boolean |
| `toolBefore` | `AKAME_GRANULATE_TOOL_BEFORE` | boolean |
| `command` | `AKAME_GRANULATE_COMMAND` | boolean |
| `cooldownMs` | `AKAME_COOLDOWN_MS` | number |
| `debounceMs` | `AKAME_DEBOUNCE_MS` | number |
| `maxBatch` | `AKAME_MAX_BATCH` | number |
| `maxMessages` | `AKAME_MAX_MESSAGES` | number |
| `enrichLinks` | `AKAME_ENRICH_LINKS` | boolean |
| `enrichPrompt` | `AKAME_ENRICH_PROMPT` | boolean |
| `batchEnabled` | `AKAME_BATCH_ENABLED` | boolean |
| `batchSize` | `AKAME_BATCH_SIZE` | number |
| `batchMaxAgeMs` | `AKAME_BATCH_MAX_AGE_MS` | number |

### Приоритеты

```
AKAME_* env  >  akame.json5  >  defaults.ts
```

Пример:

```bash
# В akame.json5: maxBatch = 50
# В .env: AKAME_MAX_BATCH=20
# Результат: 20 (env перезаписывает файл)
```

### Когда использовать JSON5

- Когда нужно хранить конфигурацию в репозитории (version control)
- Когда удобнее редактировать структурированный файл, чем список переменных
- Когда нужна типизация ключей (IDE подсказывает опечатки)

### Когда использовать env-переменные

- Когда значение зависит от окружения (dev/staging/prod)
- Когда секреты хранятся в vault или CI/CD
- Когда нужно переопределять отдельные значения без правки файла

---

## Проверка конфигурации

После запуска opencode проверьте логи:

```bash
# Должно появиться:
akame загружен (userId: akame)
```

Если видите ошибки — проверьте:
1. Путь к плагину в `opencode.json`
2. Наличие `node_modules` и `dist` в директории плагина
3. Доступность `AKAME_MCP_URL`
