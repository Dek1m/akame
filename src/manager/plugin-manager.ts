// ── DI-контейнер akame ──
// Фаза 2: PluginManager управляет жизненным циклом всех компонентов.
// Фаза 3: Event Handlers — классы с иерархией BaseEventHandler.
// Фаза 4: BatchProcessor через DI вместо module-level singleton.
// Фаза 5: GranulationEngine и PromptBuilder.

import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { AkameConfig } from "../config/schema.js";
import type { Logger } from "../logger.js";
import { MCPClient } from "../mcp/client.js";
import { PromptBuilder } from "../granulator/prompt-builder.js";
import { GranulationEngine } from "../granulator/engine.js";
import { SessionHandler } from "../events/session-handler.js";
import { FileHandler } from "../events/file-handler.js";
import { ToolHandler } from "../events/tool-handler.js";
import { BatchAccumulator } from "../granulator/batch-accumulator.js";
import { registerTools } from "./tool-registry.js";

export class PluginManager {
  readonly config: AkameConfig;
  readonly log: Logger;
  readonly mcp: MCPClient;
  readonly input: PluginInput;
  readonly promptBuilder: PromptBuilder;
  readonly granulationEngine: GranulationEngine;
  readonly batchProcessor: BatchAccumulator | null;

  sessionHandler: SessionHandler;
  fileHandler: FileHandler;
  toolHandler: ToolHandler;

  constructor(
    input: PluginInput,
    config: AkameConfig,
    log: Logger,
    mcp: MCPClient,
  ) {
    this.input = input;
    this.config = config;
    this.log = log;
    this.mcp = mcp;

    this.log.debug("PluginManager constructor: config.batch.enabled=" + config.batch.enabled);

    this.promptBuilder = new PromptBuilder(config, log, mcp);
    this.log.debug("PromptBuilder created");

    this.granulationEngine = new GranulationEngine(config, log, mcp, this.promptBuilder);
    this.log.debug("GranulationEngine created");

    // Создаём BatchAccumulator только если batch включён (Фаза 4)
    this.batchProcessor = config.batch.enabled
      ? new BatchAccumulator(
          config,
          log,
          async (entries) => await this.granulationEngine.granulateBatch(this.input, entries),
        )
      : null;

    this.sessionHandler = new SessionHandler(input, config, log, this.batchProcessor, this.granulationEngine);
    this.fileHandler = new FileHandler(input, config, log, this.batchProcessor, this.granulationEngine);
    this.toolHandler = new ToolHandler(input, config, log, this.batchProcessor, this.granulationEngine);
  }

  start(): Hooks {
    this.log.debug("PluginManager.start() called, batch.enabled=" + this.config.batch.enabled);

    if (this.batchProcessor) {
      this.log.debug("BatchProcessor created, size=" + this.config.batch.size + ", maxAgeMs=" + this.config.batch.maxAgeMs);
      this.log.info("Batch-грануляция включена", {
        batchSize: this.config.batch.size,
        batchMaxAgeMs: this.config.batch.maxAgeMs,
      });
    } else {
      this.log.debug("BatchProcessor NOT created");
    }

    this.log.debug("Registering tools...");
    this.log.info("akame загружен", {
      userId: this.config.mcp.userId,
      directory: this.input.directory,
    });

    // ── Регистрация тулов ──
    const tools = registerTools(this.config, this.log, this.mcp, this.input.directory);
    this.log.debug("Tools registered: " + Object.keys(tools).join(", "));

    const manager = this;

    return {
      dispose: async () => {
        if (manager.batchProcessor) {
          try {
            await manager.batchProcessor.flush();
            await manager.batchProcessor.dispose();
          } catch (err) {
            manager.log.debug("dispose flush", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        manager.log.info("akame выгружен");
      },

      event: async ({ event }: { event: Event }) => {
        manager.log.debug("event", { eventType: (event as Event).type });
        const e = event as Event;
        switch (e.type) {
          case "session.idle":
          case "session.compacted":
          case "session.diff":
            await manager.sessionHandler.handle(e);
            break;
          case "file.edited":
          case "file.watcher.updated":
            await manager.fileHandler.handle(e);
            break;
          case "command.executed":
            await manager.toolHandler.handle(e);
            break;
        }
      },

      "tool.execute.after": async (toolInput: unknown, toolOutput: unknown) => {
        await manager.toolHandler.handleAfter(
          toolInput as Parameters<ToolHandler["handleAfter"]>[0],
          toolOutput as Parameters<ToolHandler["handleAfter"]>[1]
        );
      },

      "tool.execute.before": async (toolInput: unknown, toolOutput: unknown) => {
        await manager.toolHandler.handleBefore(
          toolInput as Parameters<ToolHandler["handleBefore"]>[0],
          toolOutput as Record<string, unknown>
        );
      },

      "experimental.session.compacting": async (
        _input: unknown,
        output: { context: string[]; prompt?: string }
      ) => {
        if (!output.prompt) {
          output.context.push(
            "## Akame Plugin\n" +
            "Сессия гранулируется плагином akame в athena-memory.\n" +
            "Сохраняются: архитектурные решения, инсайты диалогов, code_knowledge, user_facts."
          );
        }
      },

      tool: tools,
    };
  }
}
