# Правила грануляции akame

> Подробное описание того, что, когда и как гранулирует akame: правила, примеры, важность, ограничения.

---

## Что такое гранула

Гранула — это самодостаточное описание факта, извлечённого из диалога, кода или архитектурного решения. Гранула хранится в семантической памяти [athena-memory](https://github.com/selti-project/athena-memory) и может быть найдена по смысловому запросу.

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

---

## Namespace-ы

| Namespace | Что храним | Примеры |
|---|---|---|
| `user_facts` | Факты о пользователе: предпочтения, привычки, замечания | «Серёжа предпочитает короткие access token (15 минут)» |
| `project_meta` | Архитектурные решения, ADR, выбор технологий | «Принято решение использовать JWT вместо cookie-сессий для горизонтального масштабирования» |
| `dialogue_insights` | Инсайты из диалогов: договорённости, контекст, выводы | «Выяснено: проект требует горизонтального масштабирования из-за роста нагрузки» |
| `code_knowledge` | Знания о коде: функции, классы, модули, тесты | «В auth.middleware.ts реализована проверка JWT с верификацией signature» |

---

## Триггеры грануляции

### 1. session.idle — Диалог завершён

**Когда срабатывает:** Пользователь заканчивает диалог (пауза или явное завершение сессии).

**Что происходит:**
1. Проверка cooldown (30 сек по умолчанию)
2. Сбор сообщений из основной сессии
3. Сбор сообщений из дочерних сессий (sub-agents)
4. Сохранение данных сессии в session-store (для tool `granulate_output`)
5. Формирование контекста для LLM
6. Вызов LLM через служебную сессию с агентом `memory-granulator`
7. LLM анализирует диалог и вызывает кастомный tool `granulate_output`
8. Tool валидирует аргументы и отправляет гранулы в athena-memory

**Важно:** akame больше не парсит JSON из текста LLM и не отправляет данные в MCP напрямую из engine. Всю работу по валидации и отправке выполняет кастомный tool `granulate_output`, зарегистрированный в `index.ts` через hooks.tool.

**Cooldown:** 30 секунд между грануляциями одной сессии. Защищает от дублирования при быстрых повторных `session.idle`.

**Пример:**

```
Диалог: Серёжа обсуждает с Соной переход на JWT
         |
         v
    session.idle
         |
         v
    granulate() --> 4 гранулы:
      - project_meta: "Переход на JWT (RS256) вместо cookie-сессий"
      - dialogue_insights: "TTL: access 15 мин, refresh 7 дней"
      - code_knowledge: "Создать auth.middleware.ts с проверкой JWT"
      - user_facts: "Серёжа предпочитает короткоживущие токены"
```

---

### 2. file.edited — Файл изменён

**Когда срабатывает:** Сохранение файла в opencode.

**Что происходит:**
1. Фильтр по расширению (только код и конфиги)
2. Debounce (2 сек по умолчанию)
3. Грануляция diff-а файла

**Debounce:** Если файл быстро редактируется, таймер сбрасывается. Грануляция произойдёт только после паузы в `config.debounceMs`.

**По умолчанию выключен** (`AKAME_GRANULATE_FILE=false`).

**Допустимые расширения:**

| Категория | Расширения |
|---|---|
| TypeScript/JavaScript | `.ts`, `.tsx`, `.js`, `.jsx` |
| Языки программирования | `.py`, `.go`, `.rs`, `.java`, `.kt`, `.swift` |
| Конфигурация | `.json`, `.yaml`, `.yml`, `.toml` |
| Документация | `.md` |
| Базы данных | `.sql` |

---

### 3. tool.execute.after — Git-команда выполнена

**Когда срабатывает:** Выполнение инструмента, связанного с git.

**Фильтрация:**
- Имя инструмента: `git`, `bash`, `gh`
- Содержимое аргументов: `git`, `gh`, `push`, `commit`, `merge`, `pr`

**Что происходит:**
1. Фильтр только git-команд
2. Логирование команды
3. Извлечение результата для грануляции

**Пример:**

```
tool.execute.after: git commit -m "feat: add JWT auth"
         |
         v
    granulate() --> 1 гранула:
      - code_knowledge: "Добавлен модуль JWT-авторизации в auth.middleware.ts"
```

---

## Шкала важности

| Уровень | Название | Когда использовать | Пример |
|---|---|---|---|
| **1** | Мелочь | Незначительные детали, не влияющие на проект | «В README опечатка в описании установки» |
| **2** | Заметка | Полезная информация, но не критичная | «В package.json добавлен скрипт test:watch» |
| **3** | Важно | Информация, полезная для понимания проекта | «В auth.middleware.ts добавлена проверка expiry» |
| **4** | Очень важно | Ключевые решения, влияющие на архитектуру | «TTL токенов: access 15 мин, refresh 7 дней» |
| **5** | Критично | Архитектурные решения, определяющие направление | «Переход с cookie-сессий на JWT (RS256) для масштабирования» |

---

## Правила грануляции

### Что гранулировать

| Тип информации | Namespace | Важность | Пример |
|---|---|---|---|
| Архитектурное решение | `project_meta` | 4-5 | «Используем PostgreSQL + pgvector для семантического поиска» |
| Выбор технологии | `project_meta` | 3-5 | «Выбрали Vitest вместо Jest из-за нативной поддержки ESM» |
| Инсайт из диалога | `dialogue_insights` | 3-4 | «Выяснено: проект требует кэширования на уровне Redis» |
| Договорённость | `dialogue_insights` | 3-4 | «Договорились: code review через PR, минимум 1 одобрение» |
| Функция/класс/модуль | `code_knowledge` | 2-4 | «В user.service.ts реализован метод refreshTokens()» |
| Факт о пользователе | `user_facts` | 2-4 | «Серёжа предпочитает TypeScript strict mode» |
| Git-команда | `code_knowledge` | 1-2 | «Выполнен git commit: add JWT auth middleware» |

### Что НЕ гранулировать

| Тип информации | Причина |
|---|---|
| Trivial-код (геттеры, сеттеры) | Не несёт семантической нагрузки |
| Ошибки и исключения | Временные, не являются знаниями |
| Стандартные настройки IDE | Не проектные решения |
| Лишние комментарии | Шум, не информация |

---

## Примеры гранул

### Пример 1: Архитектурное решение

**Диалог:**

> **Серёжа:** Давай перепишем модуль авторизации на JWT, сейчас там сессии на куках — боль при масштабировании.
> **Сона:** Хорошо. Я предлагаю использовать `jsonwebtoken` с RS256. Ключи хранить в Vault.
> **Серёжа:** Согласен, но access token пусть живёт 15 минут, refresh — 7 дней.

**Гранула:**

```json
{
  "content": "Сона и Серёжа приняли решение перейти с cookie-сессий на JWT (RS256) для модуля авторизации, чтобы упростить масштабирование. Ключи будут храниться в Vault.",
  "namespace": "project_meta",
  "importance": 5,
  "metadata": {
    "session_id": "sess_abc123",
    "agent": "programmer",
    "project_id": "/home/opencode/projects/selti",
    "title": "Переход на JWT-авторизацию",
    "message_ids": ["msg_1", "msg_2", "msg_3"],
    "participants": ["user", "programmer"]
  }
}
```

### Пример 2: Инсайт из диалога

**Гранула:**

```json
{
  "content": "Серёжа установил: access token — 15 минут, refresh token — 7 дней. Компромисс между безопасностью (короткий access) и UX (длинный refresh).",
  "namespace": "dialogue_insights",
  "importance": 4,
  "metadata": {
    "session_id": "sess_abc123",
    "agent": "programmer",
    "project_id": "/home/opencode/projects/selti",
    "title": "TTL токенов",
    "message_ids": ["msg_3"],
    "participants": ["user", "programmer"]
  }
}
```

### Пример 3: Факт о пользователе

**Гранула:**

```json
{
  "content": "Серёжа предпочитает короткие access token (15 минут) с refresh-ротацией. Не любит долгоживущие сессии — считает их угрозой безопасности.",
  "namespace": "user_facts",
  "importance": 3,
  "metadata": {
    "session_id": "sess_abc123",
    "agent": "programmer",
    "project_id": "/home/opencode/projects/selti",
    "title": "Серёжа предпочитает короткоживущие токены",
    "message_ids": ["msg_3"],
    "participants": ["user", "programmer"]
  }
}
```

### Пример 4: Знание о коде

**Гранула:**

```json
{
  "content": "В auth.middleware.ts реализована middleware для проверки JWT: верификация RS256-signature, проверка expiry, извлечение payload в req.user.",
  "namespace": "code_knowledge",
  "importance": 4,
  "metadata": {
    "session_id": "sess_abc123",
    "agent": "programmer",
    "project_id": "/home/opencode/projects/selti",
    "title": "auth.middleware.ts — проверка JWT",
    "message_ids": ["msg_5"],
    "participants": ["user", "programmer"]
  }
}
```

---

## Ограничения

### Лимиты

| Параметр | Значение | Описание |
|---|---|---|
| `AKAME_MAX_BATCH` | 20 | Макс. гранул за один вызов `memory_ingest_batch` |
| `AKAME_MAX_MESSAGES` | 50 | Макс. сообщений для анализа (старые обрезаются) |
| `title` | 80 символов | Макс. длина заголовка гранулы |
| `summary` | 200 символов | Макс. длина описания диалога |
| `content` | — | Самодостаточное описание (без отсылок к другим гранулам) |

### Что важно

1. **Самодостаточность:** Каждая гранула должна быть понятна без контекста других гранул
2. **Конкретность:** Избегайте абстрактных формулировок вроде «обсуждение архитектуры»
3. **Один факт = одна гранула:** Не мешайте несколько фактов в одну гранулу
4. **Важность субъективна:** LLM определяет важность, но вы можете настроить промпт
5. **Tool-вызов обязателен:** LLM должна вызывать `granulate_output`, а не генерировать JSON в тексте. Если tool не вызван — гранулы не сохранятся

### Дедупликация

athena-memory автоматически дедуплицирует записи по `content_hash`. Если гранула с похожим содержимым уже существует, будет возвращена существующая запись.

---

## Flow грануляции с кастомным tool

Начиная с версии, использующей кастомный tool `granulate_output`, процесс грануляции выглядит так:

```
session.idle
    |
    v
session-handler.ts
    |  проверка cooldown
    |  сбор сообщений (основные + дочерние)
    v
engine.ts
    |  сохранение сессии в session-store (messages, participants)
    |  чтение промпта Тиши
    |  вызов LLM (agent: memory-granulator)
    v
LLM (memory-granulator)
    |  анализ диалога
    |  вызов tool granulate_output({ summary, granules })
    v
granulate-tool.ts
    |  получение данных сессии из session-store
    |  формирование GranuleMetadata (session_id, agent, message_ids из контекста)
    |  валидация через validateGranules()
    |  батчированная отправка в athena-memory через MCP
    v
athena-memory (PostgreSQL + pgvector)
```

### Что изменилось по сравнению со старой архитектурой

| Было | Стало |
|---|---|
| LLM возвращал JSON в тексте ответа | LLM вызывает tool `granulate_output` |
| Engine парсил JSON из текста (снимал markdown-блоки) | Парсинг не нужен — аргументы типизированы opencode |
| `validateGranules()` вызывался в engine | `validateGranules()` вызывается внутри tool |
| Engine напрямую вызывал MCP-клиент | Tool вызывает MCP-клиент |
| Engine формировал GranuleMetadata | Tool формирует metadata из аргументов + контекста |
| Ошибка валидации — error-лог, выход | Ошибка валидации — tool выбрасывает исключение, LLM может попробовать снова |

### Зачем это нужно

1. **Типобезопасность:** opencode проверяет аргументы tool на уровне SDK — LLM физически не может передать невалидные типы
2. **Меньше кода:** engine не нужно учить парсить JSON, снимать блоки, обрабатывать частичные ответы
3. **Прозрачность:** вся логика пост-обработки (валидация, формирование метаданных, отправка) — в одном файле
4. **Повторяемость:** при ошибке валидации LLM может скорректировать аргументы и вызвать tool снова

### Session-store

Данные сессии (`messages`, `participants`) сохраняются в in-memory `Map` с TTL 10 минут. Это нужно, чтобы tool `granulate_output` мог получить `message_ids` и передать их в metadata гранул.

```typescript
// engine.ts — сохранение перед вызовом LLM
storeSessionData(context.sessionId, {
  messages: context.messages,
  participants: context.participants,
});

// granulate-tool.ts — получение при вызове tool
const sessionData = sessionStore.get(sessionId);
// sessionData?.messages.map(m => m.id) -> message_ids
```

---

## Настройка промпта

Промпт для LLM читается из файла `~/.config/opencode/agents/memory-granulator.md`. Это промпт агента **Тишь** (Memory-Granulator).

Для изменения правил грануляции отредактируйте этот файл:

```bash
~/.config/opencode/agents/memory-granulator.md
```

**Важно:** Изменения промпта вступают в силу после перезапуска opencode.
