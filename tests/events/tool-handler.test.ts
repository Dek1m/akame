import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleToolExecuteAfter } from "../../src/events/tool-handler.js";
import type { AkameConfig } from "../src/constants.js";

const makeConfig = (o: Partial<AkameConfig> = {}): AkameConfig => ({
  mcpUrl: "http://test:8000/mcp/", userId: "test", granulateIdle: true,
  granulateFile: false, granulateTool: true, cooldownMs: 30000,
  debounceMs: 2000, maxBatch: 20, maxMessages: 50, ...o,
});

const input = { client: { app: { log: vi.fn().mockResolvedValue({}) } } } as any;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("handleToolExecuteAfter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ничего не делает когда granulateTool = false", async () => {
    await handleToolExecuteAfter(input, { tool: "git", args: { command: "git push" }, sessionID: "s1" }, { result: "ok" }, makeConfig({ granulateTool: false }), log);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("игнорирует не-git инструменты", async () => {
    await handleToolExecuteAfter(input, { tool: "read", args: {}, sessionID: "s1" }, { result: "ok" }, makeConfig(), log);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("обрабатывает git push", async () => {
    await handleToolExecuteAfter(input, { tool: "git", args: { command: "git push origin main" }, sessionID: "s1" }, { result: "ok" }, makeConfig(), log);
    expect(log.info).toHaveBeenCalled();
  });
});
