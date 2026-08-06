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

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
};

function parseLogLevel(env?: string): LogLevel {
  switch (env?.toLowerCase()) {
    case "debug": return LogLevel.DEBUG;
    case "info":  return LogLevel.INFO;
    case "warn":  return LogLevel.WARN;
    case "error": return LogLevel.ERROR;
    default:      return LogLevel.INFO;
  }
}

const JSON_MODE = process.env.AKAME_LOG_FORMAT === "json";

function formatMessage(level: LogLevel, msg: string, ctx?: LogContext): string {
  const timestamp = new Date().toISOString();
  const levelName = LEVEL_NAMES[level];

  if (JSON_MODE) {
    const entry: Record<string, unknown> = {
      timestamp,
      level: levelName,
      service: "akame",
      message: msg,
    };
    if (ctx && Object.keys(ctx).length > 0) entry.meta = ctx;
    return JSON.stringify(entry);
  }

  const meta = ctx && Object.keys(ctx).length > 0 ? ` ${JSON.stringify(ctx)}` : "";
  return `[${timestamp}] [${levelName}] [akame] ${msg}${meta}`;
}

// ── Класс Logger ──

type Client = { app: { log: (opts: { body: { service: string; level: "debug" | "info" | "error" | "warn"; message: string } }) => Promise<unknown> } };

export class Logger {
  private client: Client;
  private minLevel: LogLevel;
  private context: LogContext;

  constructor(
    client: Client,
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
    const line = formatMessage(level, msg, Object.keys(merged).length > 0 ? merged : undefined);

    // Вывод в stderr для docker logs visibility
    console.error(line);

    this.client.app
      .log({
        body: {
          service: "akame",
          level: levelName as "debug" | "info" | "error" | "warn",
          message: line,
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
