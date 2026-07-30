// ── Регистрация тулов плагина ──
// Возвращает Record<string, Tool> для раздела tool в Hooks

import type { ToolDefinition } from "@opencode-ai/plugin";
import type { AkameConfig } from "../config/schema.js";
import type { Logger } from "../logger.js";
import { MCPClient } from "../mcp/client.js";
import { NamespaceRegistry } from "../namespace-registry.js";
import { createGranulateTool } from "../granulator/granulate-tool.js";
import { createCodeIndexTool } from "../tools/code-index-tool.js";
import { createCodeDiffTool } from "../tools/code-diff-tool.js";
import { createCodeGraphTool } from "../tools/code-graph-tool.js";
import { createDependencyAnalyzerTool } from "../tools/dependency-analyzer-tool.js";
import { createMigrateLegacyGranulesTool } from "../tools/migrate-legacy-granules-tool.js";
import { createGraphHealthTool } from "../tools/graph-health-tool.js";

export function registerTools(
  config: AkameConfig,
  log: Logger,
  mcp: MCPClient,
  directory: string
): Record<string, ToolDefinition> {
  const registry = new NamespaceRegistry(mcp, log);

  return {
    granulate_output: createGranulateTool(config, log, mcp),
    code_index: createCodeIndexTool(config, log, directory, mcp),
    code_diff: createCodeDiffTool(config, log, mcp),
    code_graph: createCodeGraphTool(config, log, mcp),
    dependency_analyzer: createDependencyAnalyzerTool(config, log, directory, mcp),
    migrate_legacy_granules: createMigrateLegacyGranulesTool(config, log, mcp),
    graph_health: createGraphHealthTool(config, log, mcp, registry),
  };
}
