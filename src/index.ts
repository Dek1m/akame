import type { Plugin, PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import {
  handleSessionIdle,
  handleSessionCompacted,
  handleSessionDiff,
} from "./events/session-handler.js";
import { handleFileEdited, handleFileWatcherUpdated } from "./events/file-handler.js";
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
  handleCommandExecuted,
} from "./events/tool-handler.js";
import { createGranulateTool } from "./granulator/granulate-tool.js";
import { createCodeIndexTool } from "./tools/code-index-tool.js";
import { createCodeDiffTool } from "./tools/code-diff-tool.js";
import { createCodeGraphTool } from "./tools/code-graph-tool.js";
import { createDependencyAnalyzerTool } from "./tools/dependency-analyzer-tool.js";

const akamePlugin: Plugin = async (
  input: PluginInput,
  _options?: PluginOptions
): Promise<Hooks> => {
  const config = loadConfig();
  const log = createLogger(input.client);

  log.info(`akame загружен (userId: ${config.userId}, dir: ${input.directory})`);

  // Создаём тулы (один раз, при загрузке плагина)
  const granulateTool = createGranulateTool(config, log);
  const codeIndexTool = createCodeIndexTool(config, log);
  const codeDiffTool = createCodeDiffTool(config, log);
  const codeGraphTool = createCodeGraphTool(config, log);
  const dependencyAnalyzerTool = createDependencyAnalyzerTool(config, log);

  return {
    dispose: async () => {
      log.info("akame выгружен");
    },

    event: async ({ event }: { event: Event }) => {
      log.debug(`event: ${(event as Event).type}`);
      switch ((event as Event).type) {
        case "session.idle": {
          await handleSessionIdle(input, event, config, log);
          break;
        }
        case "session.compacted": {
          await handleSessionCompacted(input, event, config, log);
          break;
        }
        case "session.diff": {
          await handleSessionDiff(input, event, config, log);
          break;
        }
        case "file.edited": {
          await handleFileEdited(input, event, config, log);
          break;
        }
        case "file.watcher.updated": {
          await handleFileWatcherUpdated(input, event, config, log);
          break;
        }
        case "command.executed": {
          await handleCommandExecuted(input, event, config, log);
          break;
        }
        default: {
          // silently ignore other events
        }
      }
    },

    "tool.execute.after": async (toolInput: unknown, toolOutput: unknown) => {
      await handleToolExecuteAfter(
        input,
        toolInput as Parameters<typeof handleToolExecuteAfter>[1],
        toolOutput as Parameters<typeof handleToolExecuteAfter>[2],
        config,
        log
      );
    },

    "tool.execute.before": async (toolInput: unknown, toolOutput: unknown) => {
      await handleToolExecuteBefore(
        input,
        toolInput as Parameters<typeof handleToolExecuteBefore>[1],
        toolOutput as Parameters<typeof handleToolExecuteBefore>[2],
        config,
        log
      );
    },

    // Внедрение контекста гранул при компакшене сессии
    "experimental.session.compacting": async (
      _input: unknown,
      output: { context: string[]; prompt?: string }
    ) => {
      // Пока добавляем базовый контекст для грануляции
      // В Фазе 7 будет внедрение актуальных гранул из athena-memory
      if (!output.prompt) {
        output.context.push(
          `## Akame Plugin
Сессия гранулируется плагином akame в athena-memory.
Сохраняются: архитектурные решения, инсайты диалогов, code_knowledge, user_facts.`
        );
      }
    },

    tool: {
      granulate_output: granulateTool,
      code_index: codeIndexTool,
      code_diff: codeDiffTool,
      code_graph: codeGraphTool,
      dependency_analyzer: dependencyAnalyzerTool,
    },
  };
};

// Named export — opencode ищет функции-плагины
export const akame = akamePlugin;

// Default export — функция, не объект (opencode ожидает функцию)
export default akamePlugin;
