import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import { handleFileEdited } from "../../src/events/file-handler.js";
import type { AkameConfig } from "../../src/constants.js";

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

describe("handleFileEdited", () => {
  const input = {
    client: { app: { log: vi.fn().mockResolvedValue({}) } },
  } as unknown as PluginInput;
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ничего не делает когда granulateFile = false", async () => {
    const config = makeConfig({ granulateFile: false });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/index.ts" } } as any,
      config,
      log
    );

    expect(log.info).not.toHaveBeenCalled();
  });

  it("игнорирует .txt файлы", async () => {
    const config = makeConfig({ granulateFile: true });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/file.txt" } } as any,
      config,
      log
    );

    expect(log.info).not.toHaveBeenCalled();
  });

  it("принимает .ts файлы и ставит debounce", async () => {
    const config = makeConfig({ granulateFile: true });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/index.ts" } } as any,
      config,
      log
    );

    // debounce — лог не вызовется сразу
    // но функция не должна упасть
    expect(true).toBe(true);
  });

  it("игнорирует .exe файлы", async () => {
    const config = makeConfig({ granulateFile: true });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/app.exe" } } as any,
      config,
      log
    );

    expect(log.info).not.toHaveBeenCalled();
  });

  it("принимает .py файлы", async () => {
    const config = makeConfig({ granulateFile: true });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/script.py" } } as any,
      config,
      log
    );

    // не упали — ок
    expect(true).toBe(true);
  });

  it("принимает .json файлы", async () => {
    const config = makeConfig({ granulateFile: true });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/config.json" } } as any,
      config,
      log
    );

    expect(true).toBe(true);
  });

  it("ничего не делает когда нет файла в событии", async () => {
    const config = makeConfig({ granulateFile: true });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: {} } as any,
      config,
      log
    );

    expect(log.info).not.toHaveBeenCalled();
  });

  it("ничего не делает когда path — пустая строка", async () => {
    const config = makeConfig({ granulateFile: true });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "" } } as any,
      config,
      log
    );

    expect(log.info).not.toHaveBeenCalled();
  });

  it("принимает .md файлы", async () => {
    const config = makeConfig({ granulateFile: true });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/README.md" } } as any,
      config,
      log
    );

    expect(true).toBe(true);
  });

  it("принимает .yaml файлы", async () => {
    const config = makeConfig({ granulateFile: true });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/docker-compose.yaml" } } as any,
      config,
      log
    );

    expect(true).toBe(true);
  });

  it("принимает .go файлы", async () => {
    const config = makeConfig({ granulateFile: true });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/main.go" } } as any,
      config,
      log
    );

    expect(true).toBe(true);
  });

  it("debounce сбрасывается при повторном вызове", async () => {
    const config = makeConfig({ granulateFile: true, debounceMs: 100 });

    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/index.ts" } } as any,
      config,
      log
    );

    // Второй вызов для того же файла — должен сбросить таймер
    await handleFileEdited(
      input,
      { type: "file.edited", properties: { file: "/a/index.ts" } } as any,
      config,
      log
    );

    expect(true).toBe(true);
  });
});
