import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { Logger } from "../logger.js";
import type { AkameConfig } from "../constants.js";
import { getGitDiff, truncateDiff } from "./git-diff.js";
import { type GranulateContext, type GranulationEngine } from "../granulator/engine.js";
import type { BatchEntry, BatchAccumulator } from "../granulator/batch-accumulator.js";
import { BaseEventHandler } from "./base-handler.js";
import { DebounceManager } from "./debounce-manager.js";

const ALLOWED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs",
  ".java", ".kt", ".swift", ".json", ".yaml", ".yml",
  ".toml", ".md", ".sql",
]);

// ── Module-level singleton DebounceManager (для обратной совместимости) ──
const _debounce = new DebounceManager(2000);

// ── Класс FileHandler ──

export class FileHandler extends BaseEventHandler {
  readonly supportedEvents = ["file.edited", "file.watcher.updated"];
  private debounce = _debounce;

  constructor(
    input: PluginInput,
    config: AkameConfig,
    log: Logger,
    batchProcessor: BatchAccumulator | null = null,
    granulationEngine: GranulationEngine | null = null,
  ) {
    super(input, config, log, batchProcessor, granulationEngine);
  }

  async handle(event: Event): Promise<void> {
    const e = event as unknown as { type: string };
    switch (e.type) {
      case "file.edited":
        return this.handleFileEdited(event);
      case "file.watcher.updated":
        return this.handleFileWatcherUpdated(event);
    }
  }

  async handleFileEdited(event: Event): Promise<void> {
    if (!this.config.granulateFile) return;

    const eventData = event as Event & { file?: string; path?: string };
    const filePath = eventData.file || eventData.path;
    if (!filePath) return;

    // Фильтр по расширениям — только код и конфиги
    const ext = filePath.toLowerCase().split(".").pop();
    if (!ext || !ALLOWED_EXTENSIONS.has(`.${ext}`)) return;

    const config = this.config;
    const log = this.log;

    this.debounce.debounce(filePath, async () => {
      log.info('file.edited (debounced)', { filePath, eventType: 'file' });

      try {
        // Получаем diff изменённого файла
        const diffResult = getGitDiff(filePath);

        if (!diffResult.diff && !diffResult.content) {
          log.debug('Нет изменений в файле', { filePath, eventType: 'file' });
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

        const batchEntry: BatchEntry = {
          sessionId: context.sessionId,
          event: "file",
          enqueuedAt: Date.now(),
        };
        await this.batchOrDirect(context, batchEntry);
      } catch (err) {
        log.error('file.edited ошибка грануляции', { filePath, eventType: 'file', error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  async handleFileWatcherUpdated(event: Event): Promise<void> {
    if (!this.config.granulateFileWatcher) return;

    const eventData = event as Event & { file?: string; path?: string };
    const filePath = eventData.file || eventData.path;
    if (!filePath) return;

    const ext = filePath.toLowerCase().split(".").pop();
    if (!ext || !ALLOWED_EXTENSIONS.has(`.${ext}`)) return;

    // Пока только логируем — реальная грануляция в Фазе 3
    this.log.info('file.watcher.updated', { filePath, eventType: 'file.watcher' });
  }
}

// ── Старые функции-обёртки (для обратной совместимости) ──

export async function handleFileEdited(
  input: PluginInput,
  event: Event,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const handler = new FileHandler(input, config, log);
  return handler.handleFileEdited(event);
}

export async function handleFileWatcherUpdated(
  _input: PluginInput,
  event: Event,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const handler = new FileHandler(_input, config, log);
  return handler.handleFileWatcherUpdated(event);
}
