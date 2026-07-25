# Стандарт грануляции знаний

> Версия: 2.0
> Статус: Утверждён

## 1. Цель

Обеспечить единый формат гранул для **всех** namespace, чтобы:
- Любой агент Argenta Team мог найти любую информацию
- Гранулы были связаны в единый граф знаний
- Было понятно, к какому проекту и типу относится информация
- Устаревшие гранулы помечались, а не дублировались

## 2. Типы сущностей (entity_type)

Каждая гранула **в любом namespace** может содержать `metadata.entity_type`.
Поле опционально, но **рекомендовано** всегда заполнять.

### Для code_knowledge

| entity_type | Описание | Пример |
|---|---|---|
| `module` | Директория/пакет/модуль | `memory_server/memory/` |
| `class` | Класс (с методами) | `MCPClient`, `MemoryService` |
| `interface` | TypeScript interface / Python Protocol | `GranuleMetadata`, `EmbeddingProvider` |
| `function` | Функция | `validateGranules()`, `granulate()` |
| `sql_query` | Именованный SQL-запрос | `SEARCH_MEMORIES`, `INSERT_MEMORY` |
| `table` | Таблица БД | `memories` |
| `index` | Индекс БД | `idx_memories_user_ns_updated` |
| `architecture` | Архитектурный слой/паттерн | `Repository Pattern`, `Event-driven` |
| `dependency` | Внешняя зависимость | `asyncpg`, `vitest` |
| `config` | Настройка/конфигурация | `AkameConfig`, `Settings` |
| `change` | Изменение в коде | `user_id стал optional` |
| `test` | Тест/набор тестов | `MCPClient tests` |

### Для project_meta

| entity_type | Описание | Пример |
|---|---|---|
| `adr` | Architectural Decision Record | `ADR-001: Repository Pattern` |
| `decision` | Техническое решение | `Выбрали pgvector вместо Milvus` |
| `architecture` | Архитектура высокого уровня | `Слоистая архитектура selti` |
| `risk` | Риск/проблема | `Нет HNSW индекса для 4096-dim` |
| `requirement` | Требование | `Поддержка namespace` |
| `status` | Статус проекта/компонента | `akame готов к публикации` |
| `config` | Конфигурация/настройка | `Настройки CI/CD` |

### Для user_facts

| entity_type | Описание | Пример |
|---|---|---|
| `person` | Человек | `Серёжа, 37 лет, Москва` |
| `preference` | Предпочтение | `Любит архитектуру приложений` |
| `habit` | Привычка/паттерн поведения | `Пишет на TypeScript` |
| `skill` | Навык/компетенция | `Эксперт в PostgreSQL` |
| `pain_point` | Боль/проблема | `Не любит длинные циклы ревью` |
| `contact` | Контактные данные | `GitHub: Dek1m` |

### Для dialogue_insights

| entity_type | Описание | Пример |
|---|---|---|
| `insight` | Инсайт/неочевидный вывод | `user_id не security boundary` |
| `agreement` | Договорённость | `Пишем код на русском и английском` |
| `conclusion` | Заключение/итог | `Решили не делать отдельный сервис` |
| `context` | Контекст/предыстория | `Почему выбрали pgvector` |
| `pattern` | Паттерн взаимодействия | `Team Lead оркестрирует subagent-ов` |
| `question` | Вопрос/обсуждение | `Нужен ли отдельный watcher?` |

## 3. Обязательные поля metadata

```typescript
interface GranuleMetadata {
  // Всегда обязательны
  session_id: string;
  agent: string;
  project_id: string;
  title: string;           // до 80 символов
  message_ids: string[];
  participants: string[];

  // Опциональны для ВСЕХ namespace
  entity_type?: EntityType;  // тип сущности (см. таблицы выше)
  entity_name?: string;      // имя сущности

  // Для code_knowledge
  module_path?: string;      // путь к файлу от корня
  signature?: string;        // сигнатура
  is_deprecated?: boolean;   // устарела ли
  source_location?: string;  // строка в коде

  // Для project_meta
  adr_status?: "proposed" | "accepted" | "deprecated" | "superseded";

  // Для user_facts
  confidence?: number;       // 0.0 — 1.0

  // Для ВСЕХ namespace
  links?: CodeLink[];        // графовые связи
}
```

## 4. Связи (граф)

Поле `links` работает для **всех** namespace и позволяет строить единый граф знаний:

```typescript
interface CodeLink {
  type: LinkType;
  target: string;          // ID гранулы или entity_name
  description?: string;
}
```

### Типы связей:

| Тип | Значение | Пример |
|---|---|---|
| `depends_on` | A зависит от B | MCPClient → AkameConfig |
| `used_by` | A используется в B | AkameConfig ← MCPClient |
| `extends` | A наследует B | EmbeddingClient → EmbeddingProvider |
| `implements` | A реализует B | EmbeddingClient → EmbeddingProvider |
| `contains` | A содержит B | Модуль → Класс |
| `contained_by` | A содержится в B | Класс → Модуль |
| `calls` | A вызывает B | service.search() → repository.search() |
| `called_by` | A вызывается из B | repository.search() ← service.search() |
| `related_to` | A связана с B | ADR → Реализация |
| `contradicts` | A противоречит B | Новая гранула → Устаревшая |
| `solves` | A решает проблему B | Изменение → Проблема |
| `tested_by` | A тестируется B | Код → Тест |
| `implements_adr` | A реализует ADR | Код → ADR |
| `references` | A ссылается на B | Инсайт → ADR |
| `follows` | A следует за B | Фаза 2 → Фаза 1 |
| `precedes` | A предшествует B | Фаза 1 → Фаза 2 |
| `alternative_to` | A альтернатива B | Решение 1 → Решение 2 |
| `causes` | A причина B | Проблема → Решение |
| `prevents` | A предотвращает B | Ограничение → Решение |

### Правила связей:

1. Если target указан как `entity_name`, при поиске сначала ищется гранула с таким `entity_name` и `project_id`
2. Связи должны быть обоюдными (при создании A→B добавлять обратную, если возможно)
3. Для `contradicts` обязательно указывать `is_deprecated: true` на старой грануле

## 5. Приоритет важности (importance)

Работает одинаково для всех namespace:

| Значение | Когда ставить |
|---|---|
| 5 — Критично | Архитектурные решения, схемы БД, безопасность, ключевые интерфейсы, ADR |
| 4 — Очень важно | Классы, SQL-запросы, публичные API, важные факты о пользователе |
| 3 — Важно | Функции, конфиги, тесты, договорённости, инсайты |
| 2 — Заметка | Детали реализации, временные решения, контекст |
| 1 — Мелочь | Форматирование, стиль, косметика |

## 6. Дедупликация

**Запрещено** создавать новую гранулу, если в памяти уже есть гранула:
1. С тем же `entity_name` и `project_id` (точное совпадение)
2. С семантически идентичным содержанием (cosine similarity > 0.95)

Действия:
- Если информация актуальна — **пропустить** (SKIP)
- Если устарела — создать гранулу типа `change` (для кода) или `decision` (для meta), старую обновить с `is_deprecated: true`
- Если дополняет — добавить `links.related_to` на существующую

## 7. Поиск знаний для агентов

Все агенты Argenta Team при поиске используют `memory_search`:

```
# Найти сущность по имени (любой namespace)
memory_search(query="MCPClient", namespace="code_knowledge")

# Найти ADR
memory_search(query="adr repository", namespace="project_meta")

# Найти факты о пользователе
memory_search(query="person Серёжа", namespace="user_facts")

# Найти инсайты
memory_search(query="insight security", namespace="dialogue_insights")

# Найти по entity_type
memory_search(query="entity_type: class project_id: akame", namespace="code_knowledge")

# Найти по связям
memory_search(query="depends_on MCPClient", namespace="code_knowledge")
```

## 8. Инструмент granulate_output

**Доступен ТОЛЬКО агенту `memory-granulator` (Тишь).**
Любой другой агент получит ошибку "Доступ запрещён".

Тишь вызывает этот tool после анализа диалога. Она передаёт:
- `summary` — краткое описание диалога
- `granules` — массив гранул (до 20 за раз)

Каждая гранула может содержать поля для **любого** namespace: entity_type, entity_name, links.

## 9. Процесс грануляции

### A. При старте работы с проектом
1. Агент (Team Lead / Architect) запускает `code_index` для сканирования кода
2. Во время обсуждений Тишь фиксирует архитектурные решения и инсайты

### B. При изменениях
1. Тишь создаёт гранулы изменений с entity_type
2. Устаревшие гранулы помечаются `is_deprecated: true`
3. Связи обновляются (solves, implements_adr)

### C. При архитектурных обсуждениях
1. Тишь создаёт ADR в `project_meta` с entity_type: "adr"
2. Код, реализующий ADR, получает `links.implements_adr`
3. Инсайты из диалога получают `links.references` на ADR

## 10. Полные списки типов

### Все EntityType:
`module`, `class`, `interface`, `function`, `sql_query`, `table`, `index`, `architecture`, `dependency`, `config`, `change`, `test`, `adr`, `decision`, `risk`, `requirement`, `status`, `person`, `preference`, `habit`, `skill`, `pain_point`, `contact`, `insight`, `agreement`, `conclusion`, `context`, `pattern`, `question`, `unknown`

### Все LinkType:
`depends_on`, `used_by`, `extends`, `implements`, `contains`, `contained_by`, `calls`, `called_by`, `related_to`, `contradicts`, `solves`, `tested_by`, `implements_adr`, `references`, `follows`, `precedes`, `alternative_to`, `causes`, `prevents`
