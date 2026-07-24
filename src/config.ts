import { DEFAULTS, type AkameConfig } from "./constants.js";

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): AkameConfig {
  return {
    mcpUrl: env.AKAME_MCP_URL ?? DEFAULTS.MCP_URL,
    apiKey: env.AKAME_API_KEY,
    userId: env.AKAME_USER_ID ?? DEFAULTS.USER_ID,
    granulateIdle: parseBool(env.AKAME_GRANULATE_IDLE, DEFAULTS.GRANULATE_IDLE),
    granulateFile: parseBool(env.AKAME_GRANULATE_FILE, DEFAULTS.GRANULATE_FILE),
    granulateTool: parseBool(env.AKAME_GRANULATE_TOOL, DEFAULTS.GRANULATE_TOOL),
    cooldownMs: parseInt(env.AKAME_COOLDOWN_MS ?? String(DEFAULTS.COOLDOWN_MS), 10),
    debounceMs: parseInt(env.AKAME_DEBOUNCE_MS ?? String(DEFAULTS.DEBOUNCE_MS), 10),
    maxBatch: parseInt(env.AKAME_MAX_BATCH ?? String(DEFAULTS.MAX_BATCH), 10),
    maxMessages: parseInt(env.AKAME_MAX_MESSAGES ?? String(DEFAULTS.MAX_MESSAGES), 10),
  };
}

function parseBool(
  value: string | undefined,
  fallback: boolean
): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}