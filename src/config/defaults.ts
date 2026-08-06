// ── Дефолты конфигурации ──

export const DEFAULTS = {
  MCP_URL: "http://selti:8000/mcp/",
  USER_ID: "akame",

  // Триггеры
  GRANULATE_IDLE: true,
  GRANULATE_FILE: false,
  GRANULATE_TOOL: true,
  GRANULATE_COMPACTED: true,
  GRANULATE_DIFF: false,
  GRANULATE_FILE_WATCHER: false,
  GRANULATE_TOOL_BEFORE: false,
  GRANULATE_COMMAND: false,

  // Настройки
  COOLDOWN_MS: 30_000,
  DEBOUNCE_MS: 2_000,
  MAX_BATCH: 20,
  MAX_MESSAGES: 50,

  // Обогащение
  ENRICH_LINKS: true,
  ENRICH_PROMPT: true,

  // Batch
  BATCH_ENABLED: true,
  BATCH_SIZE: 5,
  BATCH_MAX_AGE_MS: 3_600_000, // 1 час
} as const;

// ── Маппинг JSON5-ключей → env-имена ──

export const JSON5_KEY_MAP: Record<string, string> = {
  // MCP
  mcpUrl: "MCP_URL",
  apiKey: "API_KEY",
  userId: "USER_ID",

  // Триггеры
  idle: "GRANULATE_IDLE",
  fileEdited: "GRANULATE_FILE",
  toolAfter: "GRANULATE_TOOL",
  compacted: "GRANULATE_COMPACTED",
  diff: "GRANULATE_DIFF",
  fileWatcher: "GRANULATE_FILE_WATCHER",
  toolBefore: "GRANULATE_TOOL_BEFORE",
  command: "GRANULATE_COMMAND",

  // Настройки
  cooldownMs: "COOLDOWN_MS",
  debounceMs: "DEBOUNCE_MS",
  maxBatch: "MAX_BATCH",
  maxMessages: "MAX_MESSAGES",

  // Обогащение
  enrichLinks: "ENRICH_LINKS",
  enrichPrompt: "ENRICH_PROMPT",

  // Batch
  batchEnabled: "BATCH_ENABLED",
  batchSize: "BATCH_SIZE",
  batchMaxAgeMs: "BATCH_MAX_AGE_MS",
};
