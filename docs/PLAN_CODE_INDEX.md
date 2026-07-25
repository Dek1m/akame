# План: Инструмент code_index для автоматической индексации кода

> Статус: Предложен
> Приоритет: Средний

## Проблема

Сейчас code_knowledge заполняется только через диалоги — Тишь анализирует обсуждения и извлекает гранулы. Но:
1. Нет автоматической индексации кода (классы, функции, модули)
2. При первом знакомстве с проектом агенты не находят информацию о структуре кода
3. Граф зависимостей между сущностями строится вручную

## Решение

Добавить в плагин akame новый инструмент `code_index`, который:
1. Сканирует файлы проекта
2. Извлекает классы, функции, интерфейсы, SQL-запросы
3. Строит граф зависимостей (импорты, наследование)
4. Сохраняет всё в athena-memory в формате GRANULATION_STANDARD.md

## Требования

### 1. Новый файл `src/scanner/code-index.ts`

Инструмент, который запускается:
- По команде (tool `code_index`)
- Автоматически при старте новой сессии в проекте (опционально)

### 2. Парсеры

Для каждого типа файлов нужен парсер:

**TypeScript/JavaScript:**
- Извлекает: export class, export interface, export function, export type, export const enum
- Сигнатуры: параметры, возвращаемый тип
- Импорты: откуда импортируется, что именно
- AST-анализ через TypeScript Compiler API (`ts.createSourceFile`)

**Python:**
- Извлекает: class, def, Protocol, dataclass
- Импорты: import X, from X import Y
- AST-анализ через `ast` модуль (built-in)
- Достаточно базового парсинга без установки доп. зависимостей

**SQL:**
- Извлекает: именованные SQL-константы (в кавычках)
- Таблицы: CREATE TABLE
- Индексы: CREATE INDEX

### 3. Выходные данные

Для каждого найденного файла создаются гранулы:

```typescript
interface CodeIndexOutput {
  project: string;          // имя проекта
  files: ScannedFile[];
}

interface ScannedFile {
  path: string;             // относительный путь
  module: string;           // имя модуля (директория)
  
  classes: ScannedClass[];
  interfaces: ScannedInterface[];
  functions: ScannedFunction[];
  
  imports: string[];        // что импортируется
  exports: string[];        // что экспортируется
}

interface ScannedClass {
  name: string;
  signature: string;
  methods: string[];        // имена методов
  extends?: string;
  implements?: string[];
  source_location: string;  // строка
  dependencies: string[];   // что используется (из импортов)
}

interface ScannedFunction {
  name: string;
  signature: string;
  source_location: string;
}

interface ScannedInterface {
  name: string;
  extends?: string[];
  source_location: string;
}
```

### 4. Сохранение в athena-memory

Инструмент использует существующий `MCPClient.ingestBatch()` для сохранения.

Каждый класс/функция/интерфейс → отдельная гранула с:
- `entity_type`: class / function / interface
- `project_id`: из аргумента
- `module_path`: путь к файлу
- `entity_name`: имя
- `signature`: сигнатура
- `links`: зависимости (depends_on на импортируемые сущности)
- `source_location`: строка

### 5. Связи с существующими гранулами

Перед созданием проверять через `MCPClient.search()`:
- Если гранула с таким `entity_name` и `project_id` уже существует — **пропустить**
- Добавить `links.contained_by` на модуль (который тоже создаётся)

## Реализация

### Фаза 1: Базовый сканер TypeScript + Python

1. Создать `src/scanner/code-index.ts`
2. Простой парсер без AST (regex-based для начала)
3. Регистрация как tool в index.ts
4. Тесты

### Фаза 2: Граф зависимостей

1. По импортам строить `depends_on` связи
2. Находить связанные гранулы в памяти по имени
3. Создавать обоюдные связи

### Фаза 3: Автоматический запуск

1. При `file.edited` — переиндексация изменённого файла
2. При старте работы в проекте — полная индексация

## Файлы для изменений

| Файл | Изменение |
|---|---|
| `src/scanner/code-index.ts` | **Новый** — основной сканер |
| `src/index.ts` | Добавить регистрацию tool `code_index` |
| `src/mcp/client.ts` | Добавить метод `search` для поиска существующих гранул (если нет) |
| `tests/scanner/code-index.test.ts` | **Новый** — тесты сканера |

## Зависимости

- `typescript` (уже есть) — для TS AST
- Python `ast` — built-in, не требуется установка
- Node.js `fs` — для чтения файлов

## Критерии готовности

- [ ] `code_index` tool сканирует .ts/.py файлы
- [ ] Извлекает классы с методами, сигнатурами
- [ ] Извлекает интерфейсы/Protocols
- [ ] Извлекает функции
- [ ] Строит `depends_on` по импортам
- [ ] Сохраняет в athena-memory
- [ ] Не дублирует существующие гранулы
- [ ] Тесты: 80%+ покрытие
