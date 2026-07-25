// ── Namespace-ы athena-memory ──
export const NAMESPACE_USER_FACTS = "user_facts" as const;
export const NAMESPACE_PROJECT_META = "project_meta" as const;
export const NAMESPACE_DIALOGUE_INSIGHTS = "dialogue_insights" as const;
export const NAMESPACE_CODE_KNOWLEDGE = "code_knowledge" as const;
export const NAMESPACE_INFRASTRUCTURE = "infrastructure" as const;

export const NAMESPACES = [
  NAMESPACE_USER_FACTS,
  NAMESPACE_PROJECT_META,
  NAMESPACE_DIALOGUE_INSIGHTS,
  NAMESPACE_CODE_KNOWLEDGE,
  NAMESPACE_INFRASTRUCTURE,
] as const;

export type Namespace = (typeof NAMESPACES)[number];

// ── Исключённые директории ──
export const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".venv",
  "dist",
  "build",
  "__pycache__",
  ".git",
  ".next",
  "coverage",
]);

// ── Дефолты конфигурации ──
export const DEFAULTS = {
  MCP_URL: "http://athena-memory:8000/mcp/",
  USER_ID: "akame",
  GRANULATE_IDLE: true,
  GRANULATE_FILE: false,
  GRANULATE_TOOL: true,
  GRANULATE_COMPACTED: true,
  GRANULATE_DIFF: false,
  GRANULATE_FILE_WATCHER: false,
  GRANULATE_TOOL_BEFORE: false,
  GRANULATE_COMMAND: false,
  COOLDOWN_MS: 30000,
  DEBOUNCE_MS: 2000,
  MAX_BATCH: 20,
  MAX_MESSAGES: 50,
  ENRICH_LINKS: true,
  ENRICH_PROMPT: true,
} as const;

// ── Типы конфигурации плагина ──
export interface AkameConfig {
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
}