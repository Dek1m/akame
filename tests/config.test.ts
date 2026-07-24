import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("возвращает дефолты при пустом env", () => {
    const config = loadConfig({});
    expect(config.mcpUrl).toBe("http://athena-memory:8000/mcp/");
    expect(config.userId).toBe("akame");
    expect(config.granulateIdle).toBe(true);
    expect(config.cooldownMs).toBe(30000);
  });

  it("переопределяет из env", () => {
    const config = loadConfig({
      AKAME_MCP_URL: "http://custom:9000/mcp/",
      AKAME_USER_ID: "custom-user",
      AKAME_GRANULATE_IDLE: "false",
      AKAME_COOLDOWN_MS: "60000",
    });
    expect(config.mcpUrl).toBe("http://custom:9000/mcp/");
    expect(config.userId).toBe("custom-user");
    expect(config.granulateIdle).toBe(false);
    expect(config.cooldownMs).toBe(60000);
  });

  it("парсит true/false строковые булевы значения", () => {
    expect(loadConfig({ AKAME_GRANULATE_FILE: "true" }).granulateFile).toBe(true);
    expect(loadConfig({ AKAME_GRANULATE_FILE: "1" }).granulateFile).toBe(true);
    expect(loadConfig({ AKAME_GRANULATE_FILE: "false" }).granulateFile).toBe(false);
    expect(loadConfig({ AKAME_GRANULATE_FILE: "0" }).granulateFile).toBe(false);
  });
});
