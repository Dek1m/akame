import type { Plugin, PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin";
import { AkameConfig } from "./config/schema.js";
import { createLogger } from "./logger.js";
import { MCPClient } from "./mcp/client.js";
import { PluginManager } from "./manager/plugin-manager.js";

const akamePlugin: Plugin = async (
  input: PluginInput,
  _options?: PluginOptions
): Promise<Hooks> => {
  const config = AkameConfig.load();
  const log = createLogger(input.client);
  const mcp = new MCPClient(config);
  const manager = new PluginManager(input, config, log, mcp);
  return manager.start();
};

export const akame = akamePlugin;
export default akamePlugin;
