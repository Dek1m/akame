import type { PluginInput } from "@opencode-ai/plugin";
import type { Logger } from "../logger.js";
import type { AkameConfig } from "../constants.js";
import { granulate, type GranulateContext } from "../granulator/engine.js";

// Git-инструменты для фильтрации
const GIT_TOOLS = new Set(["git", "bash", "gh"]);

interface ToolExecuteAfterInput {
  tool: string;
  args: Record<string, unknown>;
  sessionID: string;
}

interface ToolExecuteAfterOutput {
  result: unknown;
}

let toolCounter = 0;

export async function handleToolExecuteAfter(
  input: PluginInput,
  toolInput: ToolExecuteAfterInput,
  toolOutput: ToolExecuteAfterOutput,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  if (!config.granulateTool) return;

  const toolName = (toolInput.tool || "").toLowerCase();

  // Фильтруем только git-связанные инструменты
  if (!GIT_TOOLS.has(toolName)) return;

  // Проверяем, что команда git-связана
  const args = toolInput.args || {};
  const command = String(args.command || args.cmd || args._ || "").toLowerCase();

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

  toolCounter++;
  log.info(
    `tool.execute.after (git): ${toolName} #${toolCounter}, команда: ${command.slice(0, 100)}`
  );

  // Грануляция git-операции
  try {
    const resultText = extractResultText(toolOutput);

    if (!resultText || resultText.length < 10) {
      log.debug(`Пустой результат git-команды: ${command}`);
      return;
    }

    const context: GranulateContext = {
      sessionId: toolInput.sessionID || `tool_${Date.now()}`,
      agent: "tool.execute.after",
      projectId: config.userId,
      mode: "tool_result",
      messages: [
        {
          id: `git_${Date.now()}`,
          role: "system",
          content: `## Git операция: ${command}\n## Результат:\n${resultText.slice(0, 2000)}`,
        },
      ],
      participants: [toolName, "git"],
    };

    await granulate(input, context, config, log);
  } catch (err) {
    log.error(
      `tool.execute.after ошибка грануляции: ${err instanceof Error ? err.message : String(err)}`
    );
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

// ── tool.execute.before — pre-processing перед выполнением тула ──

export async function handleToolExecuteBefore(
  _input: PluginInput,
  toolInput: ToolExecuteAfterInput,
  _toolOutput: Record<string, unknown>,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  if (!config.granulateToolBefore) return;

  const toolName = (toolInput.tool || "").toLowerCase();

  // Пока только логируем важные вызовы
  log.debug(
    `tool.execute.before: ${toolName}, сессия: ${toolInput.sessionID}`
  );
}

// ── command.executed — пользователь выполнил команду ──

interface CommandExecutedInput {
  command: string;
  sessionID: string;
}

export async function handleCommandExecuted(
  _input: PluginInput,
  event: unknown,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  if (!config.granulateCommand) return;

  const cmd = event as CommandExecutedInput;
  if (!cmd.command) return;

  log.info(`command.executed: ${cmd.command.slice(0, 100)}`);

  // Здесь в будущем: грануляция пользовательских команд
}
