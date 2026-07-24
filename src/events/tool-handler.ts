import type { PluginInput } from "@opencode-ai/plugin";
import type { Logger } from "../logger.js";
import type { AkameConfig } from "../constants.js";

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
  _toolOutput: ToolExecuteAfterOutput,
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

  // Здесь в будущем: извлечение toolOutput -> грануляция через granulate
  // Пока только логируем
}
