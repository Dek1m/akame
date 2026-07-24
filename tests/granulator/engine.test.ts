import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import type { AkameConfig } from "../../src/constants.js";
import { granulate, type GranulateContext } from "../../src/granulator/engine.js";

// Мокаем MCPClient — чтобы не дёргал настоящий fetch
vi.mock("../../src/mcp/client.js", () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    ingestBatch: vi
      .fn()
      .mockResolvedValue({ inserted: 1, skipped: 0, updated: 0, total: 1 }),
    store: vi.fn().mockResolvedValue({ id: "123" }),
  })),
}));

const makeConfig = (overrides: Partial<AkameConfig> = {}): AkameConfig => ({
  mcpUrl: "http://test:8000/mcp/",
  userId: "test",
  granulateIdle: true,
  granulateFile: false,
  granulateTool: true,
  cooldownMs: 30000,
  debounceMs: 2000,
  maxBatch: 20,
  maxMessages: 50,
  ...overrides,
});

describe("granulate", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockInput = {
    client: {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "session_test_123" } }),
        prompt: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        delete: vi.fn().mockResolvedValue({}),
      },
      app: {
        log: vi.fn().mockResolvedValue({}),
      },
    },
  } as unknown as PluginInput;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("вызывается с контекстом и логирует", async () => {
    const context: GranulateContext = {
      sessionId: "s1",
      agent: "programmer",
      projectId: "p1",
      messages: [{ id: "m1", role: "user", content: "привет" }],
      participants: ["user"],
    };

    await granulate(mockInput, context, makeConfig(), log);

    expect(log.info).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("s1")
    );
  });

  it("логирует количество сообщений и участников", async () => {
    const context: GranulateContext = {
      sessionId: "s2",
      agent: "team-lead",
      projectId: "p2",
      messages: [
        { id: "m1", role: "user", content: "hello" },
        { id: "m2", role: "assistant", content: "hi" },
      ],
      participants: ["user", "assistant"],
    };

    await granulate(mockInput, context, makeConfig(), log);

    const logMsg = log.info.mock.calls[0][0];
    expect(logMsg).toContain("сообщений: 2");
  });

  it("обрабатывает пустой массив сообщений", async () => {
    const context: GranulateContext = {
      sessionId: "s3",
      agent: "tester",
      projectId: "p3",
      messages: [],
      participants: [],
    };

    await granulate(mockInput, context, makeConfig(), log);

    expect(log.info).toHaveBeenCalledOnce();
    const logMsg = log.info.mock.calls[0][0];
    expect(logMsg).toContain("сообщений: 0");
  });
});
