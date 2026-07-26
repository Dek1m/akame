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
