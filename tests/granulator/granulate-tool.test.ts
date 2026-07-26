import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGranulateTool, storeSessionData } from "../../src/granulator/granulate-tool.js";

// Мокаем MCPClient
const mockIngestBatch = vi.fn();
vi.mock("../../src/mcp/client.js", () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    ingestBatch: mockIngestBatch,
  })),
}));

const defaultConfig = {
  mcpUrl: "http://localhost:8000/mcp",
  userId: "test-user",
  maxBatch: 5,
  granulateIdle: true,
  granulateFile: false,
  granulateTool: true,
  granulateCompacted: true,
  granulateDiff: false,
  granulateFileWatcher: false,
  granulateToolBefore: false,
  granulateCommand: false,
  cooldownMs: 30000,
  debounceMs: 2000,
  maxMessages: 50,
  enrichLinks: false,
  enrichPrompt: false,
};

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeContext(agent: string, sessionId = "sess-1") {
  return { agent, sessionID: sessionId };
}

function makeGranule(overrides: Record<string, unknown> = {}) {
  return {
    content: "test content",
    namespace: "code_knowledge" as const,
    importance: 3,
    title: "Test Granule",
    participants: ["tester"],
    ...overrides,
  };
}

describe("granulate-tool", () => {
  beforeEach(() => {
    mockIngestBatch.mockReset();
    mockIngestBatch.mockResolvedValue({ inserted: 1, skipped: 0, updated: 0 });
  });

  describe("storeSessionData", () => {
    it("сохраняет данные сессии", () => {
      storeSessionData("sess-test", {
        messages: [{ id: "1", role: "user", content: "hello" }],
        participants: ["user", "agent"],
        projectId: "akame",
      });
      // Не падает — уже хорошо, а проверим через execute
    });
  });

  describe("createGranulateTool", () => {
    it("создаёт тул с правильным описанием", () => {
      const t = createGranulateTool(defaultConfig, mockLog);
      expect(t).toBeDefined();
      expect(t.description).toContain("memory-granulator");
    });

    it("бросает ошибку если агент не memory-granulator", async () => {
      const t = createGranulateTool(defaultConfig, mockLog);
      await expect(
        t.execute(
          { summary: "test", granules: [makeGranule()] },
          makeContext("tester")
        )
      ).rejects.toThrow("Доступ запрещён");
    });

    it("разрешает memory-granulator", async () => {
      const t = createGranulateTool(defaultConfig, mockLog);
      const result = await t.execute(
        { summary: "test", granules: [makeGranule()] },
        makeContext("memory-granulator")
      );
      expect(result).toContain("Грануляция завершена");
    });

    it("вызывает ingestBatch для сохранения гранул", async () => {
      const t = createGranulateTool(defaultConfig, mockLog);
      await t.execute(
        { summary: "test", granules: [makeGranule()] },
        makeContext("memory-granulator")
      );
      expect(mockIngestBatch).toHaveBeenCalledTimes(1);
    });

    it("использует project_id из аргументов если передан", async () => {
      const t = createGranulateTool(defaultConfig, mockLog);
      await t.execute(
        { summary: "test", project_id: "selti", granules: [makeGranule()] },
        makeContext("memory-granulator")
      );
      const callArgs = mockIngestBatch.mock.calls[0];
      // Проверяем что project_id = selti в metadata
      const entries = callArgs[0];
      expect(entries[0].metadata.project_id).toBe("selti");
    });

    it("валидирует гранулы через validateGranules", async () => {
      const t = createGranulateTool(defaultConfig, mockLog);
      await expect(
        t.execute(
          { summary: "test", granules: [{ content: "", namespace: "invalid", importance: 99 }] },
          makeContext("memory-granulator")
        )
      ).rejects.toThrow();
    });

    it("корректно собирает metadata", async () => {
      const t = createGranulateTool(defaultConfig, mockLog);
      await t.execute(
        {
          summary: "test summary",
          granules: [
            makeGranule({
              content: "module foo",
              namespace: "code_knowledge",
              entity_type: "module",
              entity_name: "foo",
              module_path: "src/foo.ts",
              signature: "export function foo()",
              is_deprecated: false,
              source_location: "L10",
              links: [{ type: "depends_on", target: "bar" }],
            }),
          ],
        },
        makeContext("memory-granulator")
      );
      const entries = mockIngestBatch.mock.calls[0][0];
      expect(entries[0].namespace).toBe("code_knowledge");
      expect(entries[0].metadata.entity_type).toBe("module");
      expect(entries[0].metadata.entity_name).toBe("foo");
      expect(entries[0].metadata.module_path).toBe("src/foo.ts");
    });
  });
});
