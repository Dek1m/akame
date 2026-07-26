import type { PluginInput } from "@opencode-ai/plugin";

// ── Интерфейс контекста для структурированного логирования ──

export interface LogContext {
  sessionId?: string;
  eventType?: string;
  durationMs?: number;
  toolName?: string;
  batchSize?: number;
  mode?: string;
  messageCount?: number;
  [key: string]: unknown;
}

// ── Уровни логирования ──

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

function parseLogLevel(env?: string): LogLevel {
  switch (env?.toLowerCase()) {
    case "debug": return LogLevel.DEBUG;
    case "info":  return LogLevel.INFO;
    case "warn":  return LogLevel.WARN;
    case "error": return LogLevel.ERROR;
    default:      return LogLevel.INFO;
  }
}

// ── Класс Logger ──

export class Logger {
  private client: { app: { log: (opts: { body: { service: string; level: "debug" | "info" | "error" | "warn"; message: string } }) => Promise<unknown> } };
  private minLevel: LogLevel;
  private context: LogContext;

  constructor(
    client: { app: { log: (opts: { body: { service: string; level: "debug" | "info" | "error" | "warn"; message: string } }) => Promise<unknown> } },
    minLevel?: LogLevel,
    context?: LogContext
  ) {
    this.client = client;
    this.minLevel = minLevel ?? parseLogLevel(process.env.AKAME_LOG_LEVEL);
    this.context = context ?? {};
  }

  private log(level: LogLevel, levelName: string, msg: string, ctx?: LogContext): void {
    if (level < this.minLevel) return;

    const merged = { ...this.context, ...ctx };
    const ctxStr = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : "";

    this.client.app
      .log({
        body: {
          service: "akame",
          level: levelName as "debug" | "info" | "error" | "warn",
          message: `[${levelName.toUpperCase()}] ${msg}${ctxStr}`,
        },
      })
      .catch(() => {
        // fire-and-forget
      });
  }

  debug(msg: string, ctx?: LogContext): void {
    this.log(LogLevel.DEBUG, "debug", msg, ctx);
  }

  info(msg: string, ctx?: LogContext): void {
    this.log(LogLevel.INFO, "info", msg, ctx);
  }

  warn(msg: string, ctx?: LogContext): void {
    this.log(LogLevel.WARN, "warn", msg, ctx);
  }

  error(msg: string, ctx?: LogContext): void {
    this.log(LogLevel.ERROR, "error", msg, ctx);
  }

  child(extra: LogContext): Logger {
    return new Logger(this.client, this.minLevel, { ...this.context, ...extra });
  }
}

// ── Совместимость со старым API ──

export function createLogger(
  client: PluginInput["client"],
  minLevel?: LogLevel
): Logger {
  return new Logger(client, minLevel);
}
