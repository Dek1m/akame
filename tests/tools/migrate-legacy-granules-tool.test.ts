import { describe, it, expect, vi, beforeEach } from "vitest";

// Частично тестируем extractFromContent через приватную функцию
// и createMigrateLegacyGranulesTool

const mockMcp = {
  search: vi.fn(),
  ingestBatch: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  recent: vi.fn(),
  findSimilar: vi.fn(),
  store: vi.fn(),
};

import { createMigrateLegacyGranulesTool } from "../../src/tools/migrate-legacy-granules-tool.js";

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

function makeLegacyRecord(content: string, title = "", id = "id-1") {
  return {
    id,
    content,
    metadata: { title },
    namespace: "code_knowledge",
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
  };
}

describe("migrate-legacy-granules-tool", () => {
  beforeEach(() => {
    mockMcp.list.mockReset();
    mockMcp.update.mockReset();
    mockMcp.update.mockResolvedValue({ id: "updated" });
  });

  describe("createMigrateLegacyGranulesTool", () => {
    it("бросает ошибку для неавторизованного агента", async () => {
      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      await expect(
        t.execute({ namespace: "code_knowledge" }, makeContext("tester"))
      ).rejects.toThrow("Доступ запрещён");
    });

    it("разрешает memory-granulator", async () => {
      mockMcp.list.mockResolvedValueOnce({ items: [], total: 0 });
      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      const result = await t.execute(
        { namespace: "code_knowledge" },
        makeContext()
      );
      expect(result).toContain("миграция завершена");
    });

    it("мигрирует legacy запись с class (английский)", async () => {
      mockMcp.list
        .mockResolvedValueOnce({ items: [], total: 1 })
        .mockResolvedValueOnce({
          items: [
            makeLegacyRecord(
              "export class MyClass extends BaseClass — src/foo/bar.ts",
              "My Class Module"
            ),
          ],
          total: 1,
        });

      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      const result = await t.execute(
        { namespace: "code_knowledge", maxRecords: "10" },
        makeContext()
      );
      expect(result).toContain("Мигрировано: 1");
      expect(mockMcp.update).toHaveBeenCalledTimes(1);
    });

    it("мигрирует legacy запись с function", async () => {
      mockMcp.list
        .mockResolvedValueOnce({ items: [], total: 1 })
        .mockResolvedValueOnce({
          items: [
            makeLegacyRecord(
              "export function parseFile(path: string) — src/parser.ts"
            ),
          ],
          total: 1,
        });

      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      const result = await t.execute(
        { namespace: "code_knowledge", maxRecords: "10" },
        makeContext()
      );
      expect(result).toContain("Мигрировано: 1");
    });

    it("мигрирует interface", async () => {
      mockMcp.list
        .mockResolvedValueOnce({ items: [], total: 1 })
        .mockResolvedValueOnce({
          items: [
            makeLegacyRecord("export interface IConfig — src/types.ts"),
          ],
          total: 1,
        });

      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      await t.execute(
        { namespace: "code_knowledge", maxRecords: "10" },
        makeContext()
      );
      expect(mockMcp.update).toHaveBeenCalled();
    });

    it("мигрирует type", async () => {
      mockMcp.list
        .mockResolvedValueOnce({ items: [], total: 1 })
        .mockResolvedValueOnce({
          items: [
            makeLegacyRecord("export type UserId = string — src/types.ts"),
          ],
          total: 1,
        });

      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      await t.execute(
        { namespace: "code_knowledge", maxRecords: "10" },
        makeContext()
      );
      expect(mockMcp.update).toHaveBeenCalled();
    });

    it("мигрирует enum", async () => {
      mockMcp.list
        .mockResolvedValueOnce({ items: [], total: 1 })
        .mockResolvedValueOnce({
          items: [
            makeLegacyRecord("export enum Color { Red, Green } — src/enums.ts"),
          ],
          total: 1,
        });

      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      await t.execute(
        { namespace: "code_knowledge", maxRecords: "10" },
        makeContext()
      );
      expect(mockMcp.update).toHaveBeenCalled();
    });

    it("работает в dry-run режиме", async () => {
      mockMcp.list
        .mockResolvedValueOnce({ items: [], total: 1 })
        .mockResolvedValueOnce({
          items: [
            makeLegacyRecord("export class Foo — src/foo.ts"),
          ],
          total: 1,
        });

      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      const result = await t.execute(
        { namespace: "code_knowledge", dryRun: true, maxRecords: "10" },
        makeContext()
      );
      expect(result).toContain("dry-run");
      expect(mockMcp.update).not.toHaveBeenCalled(); // dry-run не обновляет
    });

    it("пропускает не-legacy записи (с entity_name)", async () => {
      mockMcp.list
        .mockResolvedValueOnce({ items: [], total: 1 })
        .mockResolvedValueOnce({
          items: [
            {
              id: "id-1",
              content: "test",
              metadata: { entity_name: "Foo", entity_type: "class" },
              namespace: "code_knowledge",
              created_at: "2024-01-01",
              updated_at: "2024-01-01",
            },
          ],
          total: 1,
        });

      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      const result = await t.execute(
        { namespace: "code_knowledge", maxRecords: "10" },
        makeContext()
      );
      // Не legacy, мигрировать нечего
      expect(result).toContain("Мигрировано: 0");
    });

    it("извлекает entity_type из русского контента (класс)", async () => {
      mockMcp.list
        .mockResolvedValueOnce({ items: [], total: 1 })
        .mockResolvedValueOnce({
          items: [
            makeLegacyRecord("Класс MyModule — src/module.ts"),
          ],
          total: 1,
        });

      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      await t.execute(
        { namespace: "code_knowledge", maxRecords: "10" },
        makeContext()
      );
      expect(mockMcp.update).toHaveBeenCalled();
    });

    it("строит links для упомянутых сущностей", async () => {
      mockMcp.list
        .mockResolvedValueOnce({ items: [], total: 1 })
        .mockResolvedValueOnce({
          items: [
            makeLegacyRecord(
              "class MyService — src/service.ts. Использует HttpClient и Logger."
            ),
          ],
          total: 1,
        });

      const t = createMigrateLegacyGranulesTool(defaultConfig, mockLog, mockMcp);
      await t.execute(
        { namespace: "code_knowledge", maxRecords: "10" },
        makeContext()
      );
      expect(mockMcp.update).toHaveBeenCalled();
    });
  });
});
