import { DEFAULTS } from "./defaults.js";
import type {
  TriggerConfig,
  BatchConfig,
  CooldownConfig,
  EnrichConfig,
  MCPConfig,
} from "./types.js";

// ── Валидация ──

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Класс конфигурации ──

export class AkameConfig {
  // Группированные конфиги
  readonly triggers: TriggerConfig;
  readonly batch: BatchConfig;
  readonly cooldown: CooldownConfig;
  readonly enrich: EnrichConfig;
  readonly mcp: MCPConfig;

  constructor(
    env: Record<string, string | undefined> = process.env
  ) {
    this.triggers = this._loadTriggers(env);
    this.batch = this._loadBatch(env);
    this.cooldown = this._loadCooldown(env);
    this.enrich = this._loadEnrich(env);
    this.mcp = this._loadMCP(env);
  }

  // ── Фабричный метод ──

  static load(env?: Record<string, string | undefined>): AkameConfig {
    return new AkameConfig(env);
  }

  // ── Валидация ──

  validate(): ValidationResult {
    const errors: string[] = [];

    if (this.batch.size < 1) {
      errors.push("AKAME_BATCH_SIZE должен быть >= 1");
    }
    if (this.batch.maxAgeMs < 1000) {
      errors.push("AKAME_BATCH_MAX_AGE_MS должен быть >= 1000");
    }
    if (this.cooldown.ms < 1000) {
      errors.push("AKAME_COOLDOWN_MS должен быть >= 1000");
    }
    if (this.cooldown.maxMessages < 1) {
      errors.push("AKAME_MAX_MESSAGES должен быть >= 1");
    }
    if (!this.mcp.url.startsWith("http")) {
      errors.push("AKAME_MCP_URL должен начинаться с http:// или https://");
    }

    return { valid: errors.length === 0, errors };
  }

  // ── Приватные загрузчики ──

  private _loadTriggers(env: Record<string, string | undefined>): TriggerConfig {
    return {
      idle: _parseBool(env.AKAME_GRANULATE_IDLE, DEFAULTS.GRANULATE_IDLE),
      fileEdited: _parseBool(env.AKAME_GRANULATE_FILE, DEFAULTS.GRANULATE_FILE),
      toolAfter: _parseBool(env.AKAME_GRANULATE_TOOL, DEFAULTS.GRANULATE_TOOL),
      compacted: _parseBool(env.AKAME_GRANULATE_COMPACTED, DEFAULTS.GRANULATE_COMPACTED),
      diff: _parseBool(env.AKAME_GRANULATE_DIFF, DEFAULTS.GRANULATE_DIFF),
      fileWatcher: _parseBool(env.AKAME_GRANULATE_FILE_WATCHER, DEFAULTS.GRANULATE_FILE_WATCHER),
      toolBefore: _parseBool(env.AKAME_GRANULATE_TOOL_BEFORE, DEFAULTS.GRANULATE_TOOL_BEFORE),
      command: _parseBool(env.AKAME_GRANULATE_COMMAND, DEFAULTS.GRANULATE_COMMAND),
    };
  }

  private _loadBatch(env: Record<string, string | undefined>): BatchConfig {
    return {
      enabled: _parseBool(env.AKAME_BATCH_ENABLED, DEFAULTS.BATCH_ENABLED),
      size: _parseInt(env.AKAME_BATCH_SIZE, DEFAULTS.BATCH_SIZE),
      maxAgeMs: _parseInt(env.AKAME_BATCH_MAX_AGE_MS, DEFAULTS.BATCH_MAX_AGE_MS),
    };
  }

  private _loadCooldown(env: Record<string, string | undefined>): CooldownConfig {
    return {
      ms: _parseInt(env.AKAME_COOLDOWN_MS, DEFAULTS.COOLDOWN_MS),
      debounceMs: _parseInt(env.AKAME_DEBOUNCE_MS, DEFAULTS.DEBOUNCE_MS),
      maxBatch: _parseInt(env.AKAME_MAX_BATCH, DEFAULTS.MAX_BATCH),
      maxMessages: _parseInt(env.AKAME_MAX_MESSAGES, DEFAULTS.MAX_MESSAGES),
    };
  }

  private _loadEnrich(env: Record<string, string | undefined>): EnrichConfig {
    return {
      links: _parseBool(env.AKAME_ENRICH_LINKS, DEFAULTS.ENRICH_LINKS),
      prompt: _parseBool(env.AKAME_ENRICH_PROMPT, DEFAULTS.ENRICH_PROMPT),
    };
  }

  private _loadMCP(env: Record<string, string | undefined>): MCPConfig {
    return {
      url: env.AKAME_MCP_URL ?? DEFAULTS.MCP_URL,
      apiKey: env.AKAME_API_KEY,
      userId: env.AKAME_USER_ID ?? DEFAULTS.USER_ID,
    };
  }

  // ── Обратная совместимость: плоские геттеры ──
  // Будут удалены после завершения рефакторинга (Фаза 7)

  get granulateIdle(): boolean { return this.triggers.idle; }
  get granulateFile(): boolean { return this.triggers.fileEdited; }
  get granulateTool(): boolean { return this.triggers.toolAfter; }
  get granulateCompacted(): boolean { return this.triggers.compacted; }
  get granulateDiff(): boolean { return this.triggers.diff; }
  get granulateFileWatcher(): boolean { return this.triggers.fileWatcher; }
  get granulateToolBefore(): boolean { return this.triggers.toolBefore; }
  get granulateCommand(): boolean { return this.triggers.command; }

  get cooldownMs(): number { return this.cooldown.ms; }
  get debounceMs(): number { return this.cooldown.debounceMs; }
  get maxBatch(): number { return this.cooldown.maxBatch; }
  get maxMessages(): number { return this.cooldown.maxMessages; }

  get enrichLinks(): boolean { return this.enrich.links; }
  get enrichPrompt(): boolean { return this.enrich.prompt; }

  get batchEnabled(): boolean { return this.batch.enabled; }
  get batchSize(): number { return this.batch.size; }
  get batchMaxAgeMs(): number { return this.batch.maxAgeMs; }

  get mcpUrl(): string { return this.mcp.url; }
  get apiKey(): string | undefined { return this.mcp.apiKey; }
  get userId(): string { return this.mcp.userId; }
}

// ── Утилиты ──

function _parseBool(
  value: string | undefined,
  fallback: boolean
): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

function _parseInt(value: string | undefined, fallback: number): number {
  const parsed = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}
