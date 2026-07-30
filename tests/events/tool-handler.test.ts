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

  it("игнорирует неизвестные инструменты", async () => {
    await handleToolExecuteAfter(input, { tool: "unknown_tool_xyz", args: {}, sessionID: "s1" }, { result: "ok" }, makeConfig(), log);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("обрабатывает git push", async () => {
    await handleToolExecuteAfter(input, { tool: "git", args: { command: "git push origin main" }, sessionID: "s1" }, { result: "ok" }, makeConfig(), log);
    expect(log.info).toHaveBeenCalled();
  });

  it("обрабатывает read (файловая операция)", async () => {
    await handleToolExecuteAfter(input, { tool: "read", args: { filePath: "/tmp/test.ts" }, sessionID: "s1" }, { result: "file content here" }, makeConfig(), log);
    expect(log.info).toHaveBeenCalled();
  });

  it("обрабатывает grep (поиск в коде)", async () => {
    await handleToolExecuteAfter(input, { tool: "grep", args: { pattern: "function" }, sessionID: "s1" }, { result: "match found" }, makeConfig(), log);
    expect(log.info).toHaveBeenCalled();
  });

  it("обрабатывает task (вызов агента)", async () => {
    await handleToolExecuteAfter(input, { tool: "task", args: { description: "test" }, sessionID: "s1" }, { result: "agent done" }, makeConfig(), log);
    expect(log.info).toHaveBeenCalled();
  });

  it("обрабатывает memory_search (MCP athena-memory)", async () => {
    await handleToolExecuteAfter(input, { tool: "memory_search", args: { query: "test" }, sessionID: "s1" }, { result: "[]", isMcpResult: true }, makeConfig(), log);
    expect(log.info).toHaveBeenCalled();
  });

  it("обрабатывает bash с git командой", async () => {
    await handleToolExecuteAfter(input, { tool: "bash", args: { command: "git status" }, sessionID: "s1" }, { result: "On branch main" }, makeConfig(), log);
    expect(log.info).toHaveBeenCalled();
  });

  it("пропускает bash без git команды", async () => {
    await handleToolExecuteAfter(input, { tool: "bash", args: { command: "ls -la" }, sessionID: "s1" }, { result: "file list" }, makeConfig(), log);
    expect(log.info).not.toHaveBeenCalled();
  });
});
