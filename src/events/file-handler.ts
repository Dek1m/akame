import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { Logger } from "../logger.js";
import type { AkameConfig } from "../constants.js";
import { getGitDiff, truncateDiff } from "./git-diff.js";
import { granulate, type GranulateContext } from "../granulator/engine.js";
import { getAccumulator } from "../granulator/batch-accumulator.js";
import type { BatchEntry } from "../granulator/batch-accumulator.js";

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
  input: PluginInput,
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
    setTimeout(async () => {
      debounceTimers.delete(filePath);
      log.info(`file.edited (debounced): ${filePath}`);

      try {
        // Получаем diff изменённого файла
        const diffResult = getGitDiff(filePath);

        if (!diffResult.diff && !diffResult.content) {
          log.debug(`Нет изменений в файле: ${filePath}`);
          return;
        }

        const diffText = diffResult.diff
          ? truncateDiff(diffResult.diff)
          : diffResult.content || "";

        if (!diffText.trim()) return;

        // Определяем проект
        const projectId = eventData.path
          ? eventData.path.split("/").slice(0, -1).join("/") || config.userId
          : config.userId;

        const context: GranulateContext = {
          sessionId: `file_${Buffer.from(filePath).toString("base64").slice(0, 16)}`,
          agent: "file.edited",
          projectId,
          mode: "code_diff",
          messages: [
            {
              id: `diff_${Date.now()}`,
              role: "system",
              content: `## Изменения в файле: ${filePath}\n\`\`\`diff\n${diffText}\n\`\`\``,
            },
          ],
          participants: ["file.edited"],
        };

        if (config.batchEnabled) {
          const acc = getAccumulator();
          const batchEntry: BatchEntry = {
            sessionId: context.sessionId,
            event: "file",
            enqueuedAt: Date.now(),
          };
          await acc.enqueue(batchEntry, context);
        } else {
          await granulate(input, context, config, log);
        }
      } catch (err) {
        log.error(
          `file.edited ошибка грануляции: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, config.debounceMs)
  );
}

// ── file.watcher.updated — дополнительный триггер изменений файлов ──

export async function handleFileWatcherUpdated(
  _input: PluginInput,
  event: Event,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  if (!config.granulateFileWatcher) return;

  const eventData = event as Event & { file?: string; path?: string };
  const filePath = eventData.file || eventData.path;
  if (!filePath) return;

  const ext = filePath.toLowerCase().split(".").pop();
  if (!ext || !ALLOWED_EXTENSIONS.has(`.${ext}`)) return;

  // Пока только логируем — реальная грануляция в Фазе 3
  log.info(`file.watcher.updated: ${filePath}`);
}
