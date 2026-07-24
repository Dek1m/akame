import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { Logger } from "../logger.js";
import type { AkameConfig } from "../constants.js";

// Debounce: filePath -> timeoutId
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".md",
  ".sql",
]);

export async function handleFileEdited(
  _input: PluginInput,
  event: Event,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  if (!config.granulateFile) return;

  const eventData = event as Event & { file?: string; path?: string };
  const filePath = eventData.file || eventData.path;
  if (!filePath) return;

  // Фильтр по расширениям — только код и конфиги
  const ext = filePath.toLowerCase().split(".").pop();
  if (!ext || !ALLOWED_EXTENSIONS.has(`.${ext}`)) return;

  // Debounce
  const existing = debounceTimers.get(filePath);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    filePath,
    setTimeout(() => {
      debounceTimers.delete(filePath);
      log.info(`file.edited (debounced): ${filePath}`);
      // Здесь будет грануляция diff — в следующей итерации через granulate
      // Пока только логируем
    }, config.debounceMs)
  );
}