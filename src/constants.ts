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

// ── Обратная совместимость ──
// Новый код использует AkameConfig из src/config/schema.ts
export { AkameConfig } from "./config/schema.js";
export type { TriggerConfig, BatchConfig, CooldownConfig, EnrichConfig, MCPConfig } from "./config/types.js";
