import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { Logger } from "../logger.js";
import type { AkameConfig } from "../constants.js";
import { type GranulateContext, type GranulationEngine } from "../granulator/engine.js";
import type { BatchEntry, BatchAccumulator } from "../granulator/batch-accumulator.js";
import { BaseEventHandler } from "./base-handler.js";

// Инструменты, результаты которых гранулируются
// (проверка по суффиксу — чтобы работали MCP-префиксы)
const GRANULATABLE_TOOL_SUFFIXES = [
  // Git-тулы
  "git", "bash", "gh",
  // Gera — веб-поиск
  "web_search", "web_fetch", "web_crawl",
  // Файловые операции
  "read", "edit", "write",
  // Поиск в кодовой базе
  "glob", "grep",
  // Агенты и навыки
  "task", "skill",
  // Планирование
  "todowrite",
  // Планировщик (ino)
  "ino_create", "ino_update", "ino_delete", "ino_list", "ino_logs", "ino_get",
  // MCP-тулы selti (read-only — пишет только Тишь)
  "memory_search", "memory_recent", "memory_get", "memory_list",
  "memory_stats", "memory_find_similar", "memory_get_relations",
  "memory_traverse", "memory_graph_stats", "memory_namespaces", "memory_version",
  // Хеши
  "hash_upsert", "hash_get", "hash_list", "hash_delete",
  // Код-интеллект
  "code_index", "code_diff", "code_graph", "dependency_analyzer",
  "graph_health", "migrate_legacy_granules",
];

// Тривиальные тулы — их tool_result не содержит значимых знаний для грануляции.
// opencode не передаёт MCP-результат в toolOutput, поэтому для этих тулов
// контекст = только имя тула + query, что бессмысленно гранулировать.
const TRIVIAL_TOOL_SUFFIXES = [
  "read", "glob", "grep", "skill", "todowrite",
  "memory_search", "memory_recent", "memory_get", "memory_list",
  "memory_stats", "memory_find_similar", "memory_get_relations",
  "memory_traverse", "memory_graph_stats", "memory_namespaces", "memory_version",
  "hash_upsert", "hash_get", "hash_list", "hash_delete",
  "task",
  // ino-тулы — тривиальные CRUD-операции
  "ino_create", "ino_update", "ino_delete", "ino_list", "ino_logs", "ino_get",
];

function isTrivialTool(toolName: string): boolean {
  return TRIVIAL_TOOL_SUFFIXES.some(
    (suffix) => toolName === suffix || toolName.endsWith(`_${suffix}`) || toolName.endsWith(`-${suffix}`)
  );
}

function isGranulatableTool(toolName: string): boolean {
  return GRANULATABLE_TOOL_SUFFIXES.some(
    (suffix) => toolName === suffix || toolName.endsWith(`_${suffix}`) || toolName.endsWith(`-${suffix}`)
  );
}

interface ToolExecuteAfterInput {
  tool: string;
  args: Record<string, unknown>;
  sessionID: string;
}

interface ToolExecuteAfterOutput {
  result: unknown;
}

interface CommandExecutedInput {
  command: string;
  sessionID: string;
}

let toolCounter = 0;

// ── Класс ToolHandler ──

export class ToolHandler extends BaseEventHandler {
  readonly supportedEvents = ["command.executed"];

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
    return this.handleCommandExecuted(event as unknown as CommandExecutedInput);
  }

  async handleAfter(
    toolInput: ToolExecuteAfterInput,
    toolOutput: ToolExecuteAfterOutput
  ): Promise<void> {
    this.log.debug("handleAfter called, tool=" + toolInput.tool + ", sessionID=" + toolInput.sessionID);

    if (!this.config.granulateTool) {
      this.log.debug("handleAfter: granulateTool=false, skipping");
      return;
    }

    const toolName = (toolInput.tool || "").toLowerCase();
    this.log.debug("handleAfter: toolName=" + toolName + ", isGranulatable=" + isGranulatableTool(toolName));

    // Фильтруем только гранулируемые инструменты (с учётом MCP-префиксов)
    if (!isGranulatableTool(toolName)) {
      this.log.debug("handleAfter: not granulatable, skipping");
      return;
    }

    // Пропускаем тривиальные тулы — их результат не содержит значимых знаний
    if (isTrivialTool(toolName)) {
      this.log.debug("handleAfter: trivial tool, skipping granulation", { toolName });
      return;
    }

    const args = toolInput.args || {};
    const command = String(args.command || args.cmd || args._ || "").toLowerCase();

    // Для git-тулов проверяем, что команда git-связана
    const isGitTool = isGranulatableTool(toolName) && (toolName === "git" || toolName === "bash" || toolName === "gh" || toolName.endsWith("_git") || toolName.endsWith("_bash") || toolName.endsWith("_gh"));
    if (isGitTool) {
      const isGitCommand =
        command.includes("git ") ||
        command.startsWith("git") ||
        command.includes("gh ") ||
        command.includes("push") ||
        command.includes("commit") ||
        command.includes("merge") ||
        command.includes("pr") ||
        (args._ && Array.isArray(args._) && (args._ as string[]).some(
          (a: string) =>
            a === "git" || a === "gh" || a === "push" || a === "commit"
        ));

      if (!isGitCommand) return;
    }

    toolCounter++;
    // Определяем тип тула по суффиксу (Gera или git)
    const isGeraTool = isGranulatableTool(toolName) && !isGitTool;
    if (isGeraTool) {
      const query = String(args.query || args.url || "");
      this.log.info('tool.execute.after', { toolName, eventType: 'tool', toolCounter, query: query.slice(0, 100) });
    } else {
      this.log.info('tool.execute.after', { toolName, eventType: 'tool', toolCounter, command: command.slice(0, 100) });
    }

    // Грануляция результата
    try {
      const resultText = extractResultText(toolOutput);
      const _isGeraTool = isGranulatableTool(toolName) && !isGitTool;

      // Для Gera-тулов opencode не передаёт результат MCP-вызова,
      // поэтому используем аргументы запроса как контекст
      if (_isGeraTool) {
        const queryInfo = String(args.query || args.url || "").slice(0, 200);
        this.log.info('Gera tool result (empty — MCP), using args', { toolName, query: queryInfo, eventType: 'tool' });

        const title = `## Gera ${toolName}: ${queryInfo}`;
        const context: GranulateContext = {
          sessionId: toolInput.sessionID || `tool_${Date.now()}`,
          agent: "tool.execute.after",
          projectId: this.config.userId,
          mode: "tool_result",
          messages: [{ id: `${toolName}_${Date.now()}`, role: "system", content: title }],
          participants: [toolName, "Gera"],
        };

        await this.batchOrDirect(context, {
          sessionId: context.sessionId,
          event: "tool",
          enqueuedAt: Date.now(),
        });
        return;
      }

      // Для git-тулов проверяем, что результат не пустой
      if (!resultText || resultText.length < 10) {
        this.log.debug('Пустой результат git тула', { toolName, eventType: 'tool' });
        return;
      }

      // Формируем контекст для git-тулов
      const title = `## Git операция: ${command}\n## Результат:\n${resultText.slice(0, 2000)}`;

      const context: GranulateContext = {
        sessionId: toolInput.sessionID || `tool_${Date.now()}`,
        agent: "tool.execute.after",
        projectId: this.config.userId,
        mode: "tool_result",
        messages: [
          {
            id: `${toolName}_${Date.now()}`,
            role: "system",
            content: title,
          },
        ],
        participants: _isGeraTool ? [toolName, "Gera"] : [toolName, "git"],
      };

      this.log.debug("calling batchOrDirect, sessionId=" + context.sessionId + ", toolName=" + toolName);
      await this.batchOrDirect(context, {
        sessionId: context.sessionId,
        event: "tool",
        enqueuedAt: Date.now(),
      });
      this.log.debug("batchOrDirect completed");
    } catch (err) {
      this.log.error('tool.execute.after ошибка грануляции', { toolName, eventType: 'tool', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async handleBefore(
    toolInput: ToolExecuteAfterInput,
    _toolOutput: Record<string, unknown>
  ): Promise<void> {
    if (!this.config.granulateToolBefore) return;

    const toolName = (toolInput.tool || "").toLowerCase();

    // Пока только логируем важные вызовы
    this.log.debug('tool.execute.before', { toolName, sessionId: toolInput.sessionID, eventType: 'tool' });
  }

  private async handleCommandExecuted(event: CommandExecutedInput): Promise<void> {
    if (!this.config.granulateCommand) return;

    if (!event.command) return;

    this.log.info('command.executed', { eventType: 'command', command: event.command.slice(0, 100), sessionId: event.sessionID });

    // Здесь в будущем: грануляция пользовательских команд
  }
}

/**
 * Извлекает текстовый результат из toolOutput.
 */
function extractResultText(output: ToolExecuteAfterOutput): string {
  const result = output.result;
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((item: unknown) => {
        if (typeof item === "object" && item !== null) {
          const r = item as Record<string, unknown>;
          if (r.type === "text") return String(r.text ?? "");
        }
        return String(item);
      })
      .join("\n");
  }
  if (typeof result === "object" && result !== null) {
    return JSON.stringify(result, null, 2);
  }
  return String(result ?? "");
}

// ── Старые функции-обёртки (для обратной совместимости) ──

export async function handleToolExecuteAfter(
  input: PluginInput,
  toolInput: ToolExecuteAfterInput,
  toolOutput: ToolExecuteAfterOutput,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const handler = new ToolHandler(input, config, log);
  return handler.handleAfter(toolInput, toolOutput);
}

export async function handleToolExecuteBefore(
  _input: PluginInput,
  toolInput: ToolExecuteAfterInput,
  _toolOutput: Record<string, unknown>,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const handler = new ToolHandler(_input, config, log);
  return handler.handleBefore(toolInput, _toolOutput);
}

export async function handleCommandExecuted(
  _input: PluginInput,
  event: unknown,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const handler = new ToolHandler(_input, config, log);
  return handler.handle(event as Event);
}
