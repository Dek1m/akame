// ── Группы конфигурации ──

export interface TriggerConfig {
  /** session.idle → грануляция */
  readonly idle: boolean;
  /** session.compacted → финальная грануляция */
  readonly compacted: boolean;
  /** session.diff → инкрементальная грануляция */
  readonly diff: boolean;
  /** file.edited → грануляция diff'ов */
  readonly fileEdited: boolean;
  /** file.watcher.updated → грануляция */
  readonly fileWatcher: boolean;
  /** tool.execute.after → грануляция git/Gera-операций */
  readonly toolAfter: boolean;
  /** tool.execute.before → pre-processing */
  readonly toolBefore: boolean;
  /** command.executed → грануляция */
  readonly command: boolean;
}

export interface BatchConfig {
  /** Группировать диалоги в batch перед грануляцией */
  readonly enabled: boolean;
  /** Максимальное количество диалогов в одном batch */
  readonly size: number;
  /** Максимальное время ожидания batch в мс (дефолт 1 час) */
  readonly maxAgeMs: number;
}

export interface CooldownConfig {
  /** Минимальное время между грануляциями одной сессии (мс) */
  readonly ms: number;
  /** Debounce для file.edited (мс) */
  readonly debounceMs: number;
  /** Сколько гранул в одном MCP batch-запросе */
  readonly maxBatch: number;
  /** Максимальное количество сообщений для грануляции */
  readonly maxMessages: number;
}

export interface EnrichConfig {
  /** Пост-обработка: автосвязи между гранулами (enrichLinks) */
  readonly links: boolean;
  /** Внедрение релевантных гранул в промпт (fetchRelevantGranules) */
  readonly prompt: boolean;
}

export interface MCPConfig {
  /** URL athena-memory MCP сервера */
  readonly url: string;
  /** API-ключ (опционально) */
  readonly apiKey?: string;
  /** ID пользователя в athena-memory */
  readonly userId: string;
}

// ── Структура JSON5 файла ──

/**
 * Плоский интерфейс конфигурации akame.json5.
 *
 * Все поля опциональны — отсутствующие значения берутся из DEFAULTS.
 * Ключи именуются в camelCase (в отличие от env-переменных AKAME_* в UPPER_SNAKE_CASE).
 *
 * Маппинг JSON5-ключей → env-переменные определён в `JSON5_KEY_MAP` (defaults.ts).
 *
 * @example
 * ```json5
 * {
 *   mcpUrl: "http://athena-memory:8000/mcp/",
 *   userId: "akame",
 *   idle: true,
 *   cooldownMs: 30000
 * }
 * ```
 */
export interface AkameFileConfig {
  // MCP
  /** URL athena-memory MCP сервера (@see AKAME_MCP_URL) */
  mcpUrl?: string;
  /** API-ключ для авторизации (@see AKAME_API_KEY) */
  apiKey?: string;
  /** ID пользователя в athena-memory (@see AKAME_USER_ID) */
  userId?: string;

  // Триггеры
  /** Гранулировать при session.idle (@see AKAME_GRANULATE_IDLE) */
  idle?: boolean;
  /** Гранулировать при file.edited (@see AKAME_GRANULATE_FILE) */
  fileEdited?: boolean;
  /** Гранулировать при tool.execute.after (@see AKAME_GRANULATE_TOOL) */
  toolAfter?: boolean;
  /** Гранулировать при session.compacted (@see AKAME_GRANULATE_COMPACTED) */
  compacted?: boolean;
  /** Гранулировать при session.diff (@see AKAME_GRANULATE_DIFF) */
  diff?: boolean;
  /** Гранулировать при file.watcher.updated (@see AKAME_GRANULATE_FILE_WATCHER) */
  fileWatcher?: boolean;
  /** Pre-processing при tool.execute.before (@see AKAME_GRANULATE_TOOL_BEFORE) */
  toolBefore?: boolean;
  /** Гранулировать при command.executed (@see AKAME_GRANULATE_COMMAND) */
  command?: boolean;

  // Настройки
  /** Мин. время между грануляциями, мс (@see AKAME_COOLDOWN_MS) */
  cooldownMs?: number;
  /** Debounce для file.edited, мс (@see AKAME_DEBOUNCE_MS) */
  debounceMs?: number;
  /** Макс. гранул в MCP batch-запросе (@see AKAME_MAX_BATCH) */
  maxBatch?: number;
  /** Макс. сообщений для анализа (@see AKAME_MAX_MESSAGES) */
  maxMessages?: number;

  // Обогащение
  /** Автосвязи между гранулами (@see AKAME_ENRICH_LINKS) */
  enrichLinks?: boolean;
  /** Внедрение релевантных гранул в промпт (@see AKAME_ENRICH_PROMPT) */
  enrichPrompt?: boolean;

  // Batch
  /** Группировка диалогов в batch (@see AKAME_BATCH_ENABLED) */
  batchEnabled?: boolean;
  /** Макс. диалогов в одном batch (@see AKAME_BATCH_SIZE) */
  batchSize?: number;
  /** Макс. время ожидания batch, мс (@see AKAME_BATCH_MAX_AGE_MS) */
  batchMaxAgeMs?: number;
}

// ── Плоский интерфейс для обратной совместимости ──

/** @deprecated Используй AkameConfig (класс из schema.ts) */
export interface AkameConfigFlat {
  mcpUrl: string;
  apiKey?: string;
  userId: string;
  granulateIdle: boolean;
  granulateFile: boolean;
  granulateTool: boolean;
  granulateCompacted: boolean;
  granulateDiff: boolean;
  granulateFileWatcher: boolean;
  granulateToolBefore: boolean;
  granulateCommand: boolean;
  cooldownMs: number;
  debounceMs: number;
  maxBatch: number;
  maxMessages: number;
  enrichLinks: boolean;
  enrichPrompt: boolean;
  batchEnabled: boolean;
  batchSize: number;
  batchMaxAgeMs: number;
}
