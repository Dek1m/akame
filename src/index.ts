import type { Plugin, PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { handleSessionIdle } from "./events/session-handler.js";
import { handleFileEdited } from "./events/file-handler.js";
import { handleToolExecuteAfter } from "./events/tool-handler.js";
import { createGranulateTool } from "./granulator/granulate-tool.js";
import { createCodeIndexTool } from "./tools/code-index-tool.js";

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
        case "file.edited": {
          await handleFileEdited(input, event, config, log);
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

    tool: {
      granulate_output: granulateTool,
      code_index: codeIndexTool,
    },
  };
};

// Named export — opencode ищет функции-плагины
export const akame = akamePlugin;

// Default export — функция, не объект (opencode ожидает функцию)
export default akamePlugin;