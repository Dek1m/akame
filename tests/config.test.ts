import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Мокаем file-loader для тестов каскада ──

vi.mock("../src/config/file-loader.js", () => ({
  loadConfigFile: vi.fn(),
}));

import { loadConfig, AkameConfig } from "../src/config.js";
import { loadConfigFile } from "../src/config/file-loader.js";
import type { FileConfig } from "../src/config/file-loader.js";

const mockLoadConfigFile = vi.mocked(loadConfigFile);

// ── Вспомогательные функции ──

function makeFileConfig(
  data: Record<string, unknown>,
  source = "/project/akame.json5"
): FileConfig {
  return { source, data };
}

// ═══════════════════════════════════════════════════════
// Старые тесты (обратная совместимость)
// ═══════════════════════════════════════════════════════

describe("loadConfig (legacy)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // По умолчанию — файл не найден
    mockLoadConfigFile.mockReturnValue(null);
  });

  it("возвращает дефолты при пустом env", () => {
    const config = loadConfig({});
    expect(config.mcpUrl).toBe("http://selti:8000/mcp/");
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

// ═══════════════════════════════════════════════════════
// Новые тесты: каскад defaults → file → env
// ═══════════════════════════════════════════════════════

describe("Каскад конфигурации: defaults → file → env", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Только defaults (без файла, без env)", () => {
    it("возвращает все дефолтные значения", () => {
      mockLoadConfigFile.mockReturnValue(null);

      const config = loadConfig({});

      // MCP
      expect(config.mcpUrl).toBe("http://selti:8000/mcp/");
      expect(config.userId).toBe("akame");
      expect(config.apiKey).toBeUndefined();

      // Триггеры
      expect(config.granulateIdle).toBe(true);
      expect(config.granulateFile).toBe(false);
      expect(config.granulateTool).toBe(true);
      expect(config.granulateCompacted).toBe(true);
      expect(config.granulateDiff).toBe(false);
      expect(config.granulateFileWatcher).toBe(false);
      expect(config.granulateToolBefore).toBe(false);
      expect(config.granulateCommand).toBe(false);

      // Cooldown
      expect(config.cooldownMs).toBe(30000);
      expect(config.debounceMs).toBe(2000);
      expect(config.maxBatch).toBe(20);
      expect(config.maxMessages).toBe(50);

      // Enrich
      expect(config.enrichLinks).toBe(true);
      expect(config.enrichPrompt).toBe(true);

      // Batch
      expect(config.batchEnabled).toBe(true);
      expect(config.batchSize).toBe(5);
      expect(config.batchMaxAgeMs).toBe(3600000);
    });
  });

  describe("Defaults + file (без env)", () => {
    it("значения из файла перезаписывают дефолты", () => {
      mockLoadConfigFile.mockReturnValue(
        makeFileConfig({
          mcpUrl: "http://file-server:8000/mcp/",
          userId: "file-user",
          idle: false,
          cooldownMs: 10000,
          batchSize: 15,
          enrichLinks: false,
        })
      );

      const config = loadConfig({});

      expect(config.mcpUrl).toBe("http://file-server:8000/mcp/");
      expect(config.userId).toBe("file-user");
      expect(config.granulateIdle).toBe(false);
      expect(config.cooldownMs).toBe(10000);
      expect(config.batchSize).toBe(15);
      expect(config.enrichLinks).toBe(false);
    });

    it("дефолты остаются для незаданных в файле ключей", () => {
      mockLoadConfigFile.mockReturnValue(
        makeFileConfig({ mcpUrl: "http://custom:9000/mcp/" })
      );

      const config = loadConfig({});

      // Изменилось
      expect(config.mcpUrl).toBe("http://custom:9000/mcp/");
      // Осталось из дефолтов
      expect(config.userId).toBe("akame");
      expect(config.granulateIdle).toBe(true);
      expect(config.cooldownMs).toBe(30000);
      expect(config.batchSize).toBe(5);
    });
  });

  describe("Defaults + file + env", () => {
    it("env перезаписывает значения из файла", () => {
      mockLoadConfigFile.mockReturnValue(
        makeFileConfig({
          mcpUrl: "http://file-server:8000/mcp/",
          userId: "file-user",
          cooldownMs: 10000,
        })
      );

      const config = loadConfig({
        AKAME_MCP_URL: "http://env-server:9000/mcp/",
        AKAME_USER_ID: "env-user",
      });

      // env побеждает
      expect(config.mcpUrl).toBe("http://env-server:9000/mcp/");
      expect(config.userId).toBe("env-user");
      // Файл (cooldownMs не переопределён env)
      expect(config.cooldownMs).toBe(10000);
    });

    it("env не перезаписывает файл, если ключ не передан в env", () => {
      mockLoadConfigFile.mockReturnValue(
        makeFileConfig({
          mcpUrl: "http://file-server:8000/mcp/",
          idle: false,
        })
      );

      const config = loadConfig({}); // пустой env

      // Из файла
      expect(config.mcpUrl).toBe("http://file-server:8000/mcp/");
      expect(config.granulateIdle).toBe(false);
    });
  });

  describe("Defaults + env (без файла)", () => {
    it("env перезаписывает дефолты напрямую", () => {
      mockLoadConfigFile.mockReturnValue(null);

      const config = loadConfig({
        AKAME_MCP_URL: "http://env-only:9000/mcp/",
        AKAME_GRANULATE_IDLE: "false",
        AKAME_COOLDOWN_MS: "5000",
      });

      expect(config.mcpUrl).toBe("http://env-only:9000/mcp/");
      expect(config.granulateIdle).toBe(false);
      expect(config.cooldownMs).toBe(5000);
    });
  });

  describe("Приоритет cwd перед home", () => {
    it("loadConfigFile вызывается один раз (отвечают за пути внутри)", () => {
      mockLoadConfigFile.mockReturnValue(
        makeFileConfig({ mcpUrl: "http://from-file:8000/mcp/" })
      );

      loadConfig({});

      // loadConfigFile вызывается без аргументов (cwd берётся из process.cwd внутри)
      expect(mockLoadConfigFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("Конвертация типов JSON5 → env string", () => {
    it("boolean → строка true/false", () => {
      mockLoadConfigFile.mockReturnValue(
        makeFileConfig({
          idle: true,
          fileEdited: false,
        })
      );

      const config = loadConfig({});

      expect(config.granulateIdle).toBe(true);
      expect(config.granulateFile).toBe(false);
    });

    it("number → строка", () => {
      mockLoadConfigFile.mockReturnValue(
        makeFileConfig({
          cooldownMs: 42000,
          batchSize: 42,
        })
      );

      const config = loadConfig({});

      expect(config.cooldownMs).toBe(42000);
      expect(config.batchSize).toBe(42);
    });

    it("string → строка", () => {
      mockLoadConfigFile.mockReturnValue(
        makeFileConfig({
          mcpUrl: "http://json5:8000/mcp/",
          userId: "json5-user",
        })
      );

      const config = loadConfig({});

      expect(config.mcpUrl).toBe("http://json5:8000/mcp/");
      expect(config.userId).toBe("json5-user");
    });

    it("undefined ключ в файле — пропускается", () => {
      mockLoadConfigFile.mockReturnValue(
        makeFileConfig({
          mcpUrl: "http://custom:8000/mcp/",
          // idle не задан — должен остаться дефолт
        })
      );

      const config = loadConfig({});

      expect(config.mcpUrl).toBe("http://custom:8000/mcp/");
      expect(config.granulateIdle).toBe(true); // дефолт
    });
  });

  describe("JSON5_KEY_MAP покрывает все ключи", () => {
    it("все ключи файла маппятся на env-имена", () => {
      const allKeys: Record<string, unknown> = {
        mcpUrl: "http://test:8000/mcp/",
        apiKey: "secret",
        userId: "test-user",
        idle: false,
        fileEdited: true,
        toolAfter: false,
        compacted: false,
        diff: true,
        fileWatcher: true,
        toolBefore: true,
        command: true,
        cooldownMs: 1000,
        debounceMs: 500,
        maxBatch: 10,
        maxMessages: 25,
        enrichLinks: false,
        enrichPrompt: false,
        batchEnabled: false,
        batchSize: 3,
        batchMaxAgeMs: 7200000,
      };

      mockLoadConfigFile.mockReturnValue(makeFileConfig(allKeys));

      const config = loadConfig({});

      // MCP
      expect(config.mcpUrl).toBe("http://test:8000/mcp/");
      expect(config.apiKey).toBe("secret");
      expect(config.userId).toBe("test-user");

      // Триггеры
      expect(config.granulateIdle).toBe(false);
      expect(config.granulateFile).toBe(true);
      expect(config.granulateTool).toBe(false);
      expect(config.granulateCompacted).toBe(false);
      expect(config.granulateDiff).toBe(true);
      expect(config.granulateFileWatcher).toBe(true);
      expect(config.granulateToolBefore).toBe(true);
      expect(config.granulateCommand).toBe(true);

      // Cooldown
      expect(config.cooldownMs).toBe(1000);
      expect(config.debounceMs).toBe(500);
      expect(config.maxBatch).toBe(10);
      expect(config.maxMessages).toBe(25);

      // Enrich
      expect(config.enrichLinks).toBe(false);
      expect(config.enrichPrompt).toBe(false);

      // Batch
      expect(config.batchEnabled).toBe(false);
      expect(config.batchSize).toBe(3);
      expect(config.batchMaxAgeMs).toBe(7200000);
    });
  });

  describe("Валидация AkameConfig.validate()", () => {
    it("дефолты валидны", () => {
      mockLoadConfigFile.mockReturnValue(null);

      const config = loadConfig({});
      const result = config.validate();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("невалидный batchSize", () => {
      mockLoadConfigFile.mockReturnValue(null);

      const config = loadConfig({ AKAME_BATCH_SIZE: "0" });
      const result = config.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining("BATCH_SIZE")
      );
    });

    it("невалидный cooldownMs", () => {
      mockLoadConfigFile.mockReturnValue(null);

      const config = loadConfig({ AKAME_COOLDOWN_MS: "100" });
      const result = config.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining("COOLDOWN_MS")
      );
    });

    it("невалидный MCP URL", () => {
      mockLoadConfigFile.mockReturnValue(null);

      const config = loadConfig({ AKAME_MCP_URL: "ftp://invalid" });
      const result = config.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining("MCP_URL")
      );
    });
  });
});
