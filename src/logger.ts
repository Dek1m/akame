import type { PluginInput } from "@opencode-ai/plugin";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export function createLogger(client: PluginInput["client"]): Logger {
  const log = (level: string, msg: string) => {
    client.app
      .log({
        body: {
          service: "akame",
          level: level as "debug" | "info" | "error" | "warn",
          message: msg,
        },
      })
      .catch(() => {
        // silent — fire-and-forget
      });
  };

  return {
    info: (msg: string) => log("info", msg),
    warn: (msg: string) => log("warn", msg),
    error: (msg: string) => log("error", msg),
    debug: (msg: string) => log("debug", msg),
  };
}