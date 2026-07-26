import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIngestBatch = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => vi.fn());
const mockScanProject = vi.hoisted(() => vi.fn());

vi.mock("../../src/mcp/client.js", () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    ingestBatch: mockIngestBatch,
    search: mockSearch,
  })),
}));

vi.mock("../../src/scanner/code-index.js", () => ({
  scanProject: mockScanProject,
}));

vi.mock("../../src/security/validate.js", () => ({
  resolveSafePath: vi.fn((dir: string, ws: string) => dir),
}));

import { createCodeIndexTool } from "../../src/tools/code-index-tool.js";

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

function makeContext(agent = "memory-granulator") {
  return { agent, sessionID: "sess-1" };
}

function makeFile(path: string, module: string, exports: Array<Record<string, unknown>> = []) {
  return {
    path,
    module,
    exports,
    imports: [],
  };
}

describe("code-index-tool", () => {
  beforeEach(() => {
    mockIngestBatch.mockReset();
    mockSearch.mockReset();
    mockScanProject.mockReset();
    mockIngestBatch.mockResolvedValue({ inserted: 1, skipped: 0, updated: 0 });
    mockSearch.mockResolvedValue([]);
  });

  describe("createCodeIndexTool", () => {
    it("бросает ошибку если агент не memory-granulator", async () => {
      const t = createCodeIndexTool(defaultConfig, mockLog, "/ws");
      await expect(
        t.execute(
          { project: "akame", directory: "/ws" },
          makeContext("tester")
        )
      ).rejects.toThrow("Доступ запрещён");
    });

    it("сканирует проект и создаёт гранулы", async () => {
      mockScanProject.mockReturnValue({
        project: "akame",
        files: [
          makeFile("src/index.ts", "src", [
            { type: "function", name: "main", signature: "export function main()", source_location: "L1" },
          ]),
        ],
        timestamp: new Date().toISOString(),
      });

      const t = createCodeIndexTool(defaultConfig, mockLog, "/ws");
      const result = await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      expect(result).toContain("сканирование завершено");
      expect(result).toContain("akame");
    });

    it("создаёт модульные гранулы", async () => {
      mockScanProject.mockReturnValue({
        project: "akame",
        files: [
          makeFile("src/foo.ts", "src", [
            { type: "class", name: "Foo", signature: "export class Foo {}", source_location: "L5" },
          ]),
        ],
        timestamp: new Date().toISOString(),
      });

      const t = createCodeIndexTool(defaultConfig, mockLog, "/ws");
      await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      // Должен быть вызов ingestBatch
      expect(mockIngestBatch).toHaveBeenCalled();
      const calls = mockIngestBatch.mock.calls;
      const batch = calls[0][0];
      const modules = batch.filter(
        (g: { metadata: { entity_type: string } }) => g.metadata.entity_type === "module"
      );
      expect(modules.length).toBeGreaterThan(0);
    });

    it("создаёт сущностные гранулы с links", async () => {
      mockScanProject.mockReturnValue({
        project: "akame",
        files: [
          makeFile("src/app.ts", "src", [
            {
              type: "class",
              name: "App",
              signature: "export class App extends BaseApp",
              source_location: "L10",
              extends: "BaseApp",
            },
          ]),
        ],
        timestamp: new Date().toISOString(),
      });
      // Добавляем все имена в search для кросс-ссылок
      mockSearch.mockResolvedValue([]);

      const t = createCodeIndexTool(defaultConfig, mockLog, "/ws");
      await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      expect(mockIngestBatch).toHaveBeenCalled();
    });

    it("пропускает существующие сущности", async () => {
      mockScanProject.mockReturnValue({
        project: "akame",
        files: [
          makeFile("src/main.ts", "src", [
            { type: "function", name: "init", signature: "export function init()", source_location: "L1" },
          ]),
        ],
        timestamp: new Date().toISOString(),
      });
      mockSearch.mockResolvedValue([
        {
          id: "existing-1",
          content: "test",
          metadata: { entity_name: "init", project_id: "akame" },
          score: 0.9,
        },
      ]);

      const t = createCodeIndexTool(defaultConfig, mockLog, "/ws");
      const result = await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      expect(result).toContain("Пропущено (есть в памяти)");
    });

    it("вызывает ingestBatch батчами", async () => {
      const files = Array.from({ length: 10 }, (_, i) =>
        makeFile(`src/file${i}.ts`, "src", [
          { type: "function", name: `fn${i}`, signature: `export function fn${i}()`, source_location: "L1" },
        ])
      );
      mockScanProject.mockReturnValue({
        project: "akame",
        files,
        timestamp: new Date().toISOString(),
      });
      mockSearch.mockResolvedValue([]);

      const t = createCodeIndexTool(defaultConfig, mockLog, "/ws");
      await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      // 10 файлов в одном модуле "src": 1 модуль + 10 сущностей = 11 гранул, maxBatch=5 → 3 батча
      expect(mockIngestBatch.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });
});
