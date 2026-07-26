// ── Дефолты конфигурации ──

export const DEFAULTS = {
  MCP_URL: "http://athena-memory:8000/mcp/",
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
