// ═══════════════════════════════════════════════════════
// Обратная совместимость: старый loadConfig + старые типы
// Новый код: import { AkameConfig } from "./config/schema.js"
// ═══════════════════════════════════════════════════════

import { AkameConfig } from "./config/schema.js";

export { AkameConfig } from "./config/schema.js";
export { loadConfigFile } from "./config/file-loader.js";
export type { FileConfig } from "./config/file-loader.js";
export type { TriggerConfig, BatchConfig, CooldownConfig, EnrichConfig, MCPConfig } from "./config/types.js";

/**
 * Загрузка конфигурации из переменных окружения.
 *
 * @deprecated Используй `AkameConfig.load()` из "./config/schema.js"
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env
): AkameConfig {
  return new AkameConfig(env);
}
