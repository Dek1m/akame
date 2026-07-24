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
| `AKAME_GRANULATE_FILE` | boolean | `false` | Гранулировать при `file.edited` |
| `AKAME_GRANULATE_TOOL` | boolean | `true` | Гранулировать после git-команд |
| `AKAME_COOLDOWN_MS` | number | `30000` | Cooldown между грануляциями (мс) |
| `AKAME_DEBOUNCE_MS` | number | `2000` | Debounce для `file.edited` (мс) |
| `AKAME_MAX_BATCH` | number | `20` | Макс. гранул в одном `ingest_batch` |
| `AKAME_MAX_MESSAGES` | number | `50` | Макс. сообщений для анализа |

---

## Пример .env файла

```env
# ── Подключение к athena-memory ──
AKAME_MCP_URL=http://athena-memory:8000/mcp/
AKAME_API_KEY=sk-athena-your-key-here

# ── Идентификатор владельца ──
AKAME_USER_ID=akame

# ── Триггеры грануляции ──
AKAME_GRANULATE_IDLE=true
AKAME_GRANULATE_FILE=false
AKAME_GRANULATE_TOOL=true

# ── Таймауты ──
AKAME_COOLDOWN_MS=30000
AKAME_DEBOUNCE_MS=2000

# ── Лимиты ──
AKAME_MAX_BATCH=20
AKAME_MAX_MESSAGES=50
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
        "AKAME_GRANULATE_FILE": "false",
        "AKAME_GRANULATE_TOOL": "true",
        "AKAME_COOLDOWN_MS": "30000",
        "AKAME_DEBOUNCE_MS": "2000",
        "AKAME_MAX_BATCH": "20",
        "AKAME_MAX_MESSAGES": "50"
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

## Сценарии настройки

### Локальная разработка

```env
AKAME_MCP_URL=http://localhost:8000/mcp/
AKAME_USER_ID=sergey
AKAME_GRANULATE_IDLE=true
AKAME_GRANULATE_FILE=false
AKAME_GRANULATE_TOOL=true
AKAME_COOLDOWN_MS=30000
```

### Команда (Docker)

```env
AKAME_MCP_URL=http://athena-memory:8000/mcp/
AKAME_API_KEY=sk-team-shared-key
AKAME_USER_ID=akame
AKAME_GRANULATE_IDLE=true
AKAME_GRANULATE_FILE=true
AKAME_GRANULATE_TOOL=true
AKAME_COOLDOWN_MS=15000
AKAME_MAX_MESSAGES=100
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
```

---

## Приоритет источников конфигурации

1. **Переменные окружения** — наивысший приоритет
2. **opencode.json** (`env` блок) — второй приоритет
3. **Дефолты в constants.ts** — fallback

Пример:

```bash
# В .env: AKAME_MAX_BATCH=20
# В opencode.json: AKAME_MAX_BATCH=50
# Результат: 50 (opencode.json перезаписывает .env)
```

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
