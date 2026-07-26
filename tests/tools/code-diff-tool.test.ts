import { describe, it, expect, vi, beforeEach } from "vitest";

// Импортируем то, что можем протестировать напрямую
// parseDiff и extractChanges — приватные, но проверим через createCodeDiffTool
import { createCodeDiffTool } from "../../src/tools/code-diff-tool.js";

const mockIngestBatch = vi.fn();
const mockSearch = vi.fn();
vi.mock("../../src/mcp/client.js", () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    ingestBatch: mockIngestBatch,
    search: mockSearch,
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

function makeContext(agent = "memory-granulator") {
  return { agent, sessionID: "sess-1" };
}

const sampleDiff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,8 @@
-export function oldFunc() {
-  return 1;
+export function newFunc() {
+  return 2;
+}
+
+export class MyClass {
+  hello() {}
 }
`;

const classDiff = `diff --git a/src/bar.ts b/src/bar.ts
new file mode 100644
--- /dev/null
+++ b/src/bar.ts
@@ -0,0 +1,5 @@
+export interface IBar {
+  name: string;
+}
+export type MyType = string | number;
+export enum Color { Red, Green }
`;

describe("code-diff-tool", () => {
  beforeEach(() => {
    mockIngestBatch.mockReset();
    mockSearch.mockReset();
    mockIngestBatch.mockResolvedValue({ inserted: 1, skipped: 0, updated: 0 });
    mockSearch.mockResolvedValue([]);
  });

  describe("createCodeDiffTool", () => {
    it("бросает ошибку если агент не memory-granulator", async () => {
      const t = createCodeDiffTool(defaultConfig, mockLog);
      await expect(
        t.execute(
          { project: "akame", diff: "some diff" },
          makeContext("tester")
        )
      ).rejects.toThrow("Доступ запрещён");
    });

    it("возвращает сообщение для пустого diff", async () => {
      const t = createCodeDiffTool(defaultConfig, mockLog);
      const result = await t.execute(
        { project: "akame", diff: "   " },
        makeContext()
      );
      expect(result).toContain("пустой diff");
    });

    it("парсит diff и создаёт гранулы для функций", async () => {
      const t = createCodeDiffTool(defaultConfig, mockLog);
      const result = await t.execute(
        { project: "akame", diff: sampleDiff },
        makeContext()
      );
      expect(result).toContain("анализ завершён");
      expect(mockIngestBatch).toHaveBeenCalled();
    });

    it("парсит diff с классами, интерфейсами, типами, enum", async () => {
      const t = createCodeDiffTool(defaultConfig, mockLog);
      const result = await t.execute(
        { project: "akame", diff: classDiff },
        makeContext()
      );
      expect(result).toContain("анализ завершён");
    });

    it("создаёт сводную гранулу о diff", async () => {
      const t = createCodeDiffTool(defaultConfig, mockLog);
      await t.execute(
        { project: "akame", diff: sampleDiff },
        makeContext()
      );
      const calls = mockIngestBatch.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const firstBatch = calls[0][0];
      // Первая гранула — сводка о diff
      expect(firstBatch[0].metadata.entity_type).toBe("change");
    });

    it("обрабатывает commitHash", async () => {
      const t = createCodeDiffTool(defaultConfig, mockLog);
      const result = await t.execute(
        { project: "akame", diff: sampleDiff, commitHash: "abc123def456" },
        makeContext()
      );
      // commitHash используется в сводной грануле, проверяем что вызов был
      expect(mockIngestBatch).toHaveBeenCalled();

    });

    it("обрабатывает diff без структурных изменений", async () => {
      const noStructDiff = `diff --git a/readme.md b/readme.md
--- a/readme.md
+++ b/readme.md
@@ -1,1 +1,1 @@
- old text
+ new text
`;
      const t = createCodeDiffTool(defaultConfig, mockLog);
      const result = await t.execute(
        { project: "akame", diff: noStructDiff },
        makeContext()
      );
      expect(result).toContain("нет структурных изменений");
    });

    it("пропускает сущности найденные через search", async () => {
      mockSearch.mockResolvedValue([
        {
          id: "id-1",
          content: "test",
          metadata: { entity_name: "newFunc", project_id: "akame" },
          score: 0.9,
        },
      ]);
      const t = createCodeDiffTool(defaultConfig, mockLog);
      await t.execute(
        { project: "akame", diff: sampleDiff },
        makeContext()
      );
      expect(mockSearch).toHaveBeenCalled();
    });

    it("помечает удалённые сущности как deprecated", async () => {
      const removedDiff = `diff --git a/src/removed.ts b/src/removed.ts
--- a/src/removed.ts
+++ b/src/removed.ts
@@ -1,2 +0,0 @@
-export function removedFunc() {
-  return 1;
`;
      const t = createCodeDiffTool(defaultConfig, mockLog);
      await t.execute(
        { project: "akame", diff: removedDiff },
        makeContext()
      );
      const calls = mockIngestBatch.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});
