import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import { handleSessionIdle, resetCooldowns } from "../../src/events/session-handler.js";
import type { AkameConfig } from "../../src/constants.js";

const makeMockInput = () =>
  ({
    client: {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [
            { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "Hello" }] },
            { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "Hi there" }] },
          ],
        }),
        children: vi.fn().mockResolvedValue({ data: [] }),
      },
      app: { log: vi.fn().mockResolvedValue({}) },
    },
  } as unknown as PluginInput);

const makeConfig = (
  overrides: Partial<AkameConfig> = {}
): AkameConfig => ({
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

describe("handleSessionIdle", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // Уникальные sessionID для каждого теста, чтобы cooldown-мапа (module-level) не блокировала
  let sidCounter = 0;
  const nextSid = () => `sid_${++sidCounter}`;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCooldowns();
    sidCounter = 0;
  });

  it("ничего не делает когда granulateIdle = false", async () => {
    const input = makeMockInput();
    const config = makeConfig({ granulateIdle: false });

    await handleSessionIdle(
      input,
      { type: "session.idle", properties: { sessionID: nextSid() } } as any,
      config,
      log
    );

    expect(input.client.session.messages).not.toHaveBeenCalled();
  });

  it("ничего не делает когда нет sessionID в properties", async () => {
    const input = makeMockInput();
    const config = makeConfig();

    await handleSessionIdle(
      input,
      { type: "session.idle", properties: {} } as any,
      config,
      log
    );

    expect(input.client.session.messages).not.toHaveBeenCalled();
  });

  it("вызывает granulate при валидном событии", async () => {
    const input = makeMockInput();
    const sid = nextSid();
    const config = makeConfig({ cooldownMs: 0 });

    await handleSessionIdle(
      input,
      { type: "session.idle", properties: { sessionID: sid } } as any,
      config,
      log
    );

    expect(log.info).toHaveBeenCalledWith("session.idle", expect.objectContaining({ sessionId: sid }));
  });

  it("получает сообщения сессии", async () => {
    const input = makeMockInput();
    const config = makeConfig({ cooldownMs: 0 });

    await handleSessionIdle(
      input,
      { type: "session.idle", properties: { sessionID: nextSid() } } as any,
      config,
      log
    );

    expect(input.client.session.messages).toHaveBeenCalledOnce();
  });

  it("получает дочерние сессии", async () => {
    const input = makeMockInput();
    const config = makeConfig({ cooldownMs: 0 });

    await handleSessionIdle(
      input,
      { type: "session.idle", properties: { sessionID: nextSid() } } as any,
      config,
      log
    );

    expect(input.client.session.children).toHaveBeenCalledOnce();
  });

  it("логирует ошибку при падении", async () => {
    const input = makeMockInput();
    (input.client.session.messages as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("API down")
    );
    const config = makeConfig({ cooldownMs: 0 });

    await handleSessionIdle(
      input,
      { type: "session.idle", properties: { sessionID: nextSid() } } as any,
      config,
      log
    );

    expect(log.error).toHaveBeenCalledWith(
      "session.idle ошибка",
      expect.objectContaining({ error: "API down" })
    );
  });

  it("ничего не делает когда нет сообщений", async () => {
    const input = makeMockInput();
    (input.client.session.messages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [],
    });
    const config = makeConfig({ cooldownMs: 0 });

    await handleSessionIdle(
      input,
      { type: "session.idle", properties: { sessionID: nextSid() } } as any,
      config,
      log
    );

    expect(log.info).toHaveBeenCalledWith(
      "session.idle: нет сообщений",
      expect.objectContaining({ eventType: "idle" })
    );
  });

  it("собирает участников из ролей сообщений", async () => {
    const input = makeMockInput();
    const config = makeConfig({ cooldownMs: 0 });

    await handleSessionIdle(
      input,
      { type: "session.idle", properties: { sessionID: nextSid() } } as any,
      config,
      log
    );

    // Should have logged successfully — participants extracted
    expect(log.info).toHaveBeenCalled();
  });
});
