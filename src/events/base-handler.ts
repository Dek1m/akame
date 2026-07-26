import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { AkameConfig } from "../config/schema.js";
import type { Logger } from "../logger.js";
import type { GranulateContext, GranulationEngine } from "../granulator/engine.js";
import type { BatchEntry, BatchAccumulator } from "../granulator/batch-accumulator.js";

export abstract class BaseEventHandler {
  protected input: PluginInput;
  protected config: AkameConfig;
  protected log: Logger;
  protected batchProcessor: BatchAccumulator | null;
  protected granulationEngine: GranulationEngine | null;

  constructor(
    input: PluginInput,
    config: AkameConfig,
    log: Logger,
    batchProcessor: BatchAccumulator | null = null,
    granulationEngine: GranulationEngine | null = null,
  ) {
    this.input = input;
    this.config = config;
    this.log = log;
    this.batchProcessor = batchProcessor;
    this.granulationEngine = granulationEngine;
  }

  abstract supportedEvents: string[];
  abstract handle(event: Event): Promise<void>;

  protected async batchOrDirect(
    context: GranulateContext,
    entry: BatchEntry
  ): Promise<void> {
    console.log("[akame-diag] batchOrDirect: batchProcessor=" + (this.batchProcessor ? "yes" : "no") + ", engine=" + (this.granulationEngine ? "yes" : "no") + ", sessionId=" + context.sessionId);
    if (this.batchProcessor) {
      await this.batchProcessor.enqueue(entry, context);
      console.log("[akame-diag] batchOrDirect: enqueued to batch");
    } else if (this.granulationEngine) {
      await this.granulationEngine.granulate(this.input, context);
      console.log("[akame-diag] batchOrDirect: granulated directly");
    } else {
      // fallback для legacy обёрток
      const { granulate } = await import("../granulator/engine.js");
      await granulate(this.input, context, this.config, this.log);
      console.log("[akame-diag] batchOrDirect: fallback granulate called");
    }
  }
}
