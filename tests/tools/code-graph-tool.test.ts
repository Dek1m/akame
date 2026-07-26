import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCodeGraphTool } from "../../src/tools/code-graph-tool.js";

const mockSearch = vi.fn();
const mockUpdate = vi.fn();
vi.mock("../../src/mcp/client.js", () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    search: mockSearch,
    update: mockUpdate,
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

function makeRecord(
  id: string,
  entityName: string,
  entityType: string,
  links: Array<{ type: string; target: string }> = [],
  projectId = "akame"
) {
  return {
    id,
    content: `${entityType} ${entityName}`,
    metadata: {
      entity_name: entityName,
      entity_type: entityType,
      module_path: `src/${entityName}.ts`,
      project_id: projectId,
      links,
    },
    score: 0.8,
  };
}

describe("code-graph-tool", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockUpdate.mockReset();
    mockUpdate.mockResolvedValue({ id: "updated" });
  });

  describe("createCodeGraphTool", () => {
    it("бросает ошибку если агент не memory-granulator", async () => {
      const t = createCodeGraphTool(defaultConfig, mockLog);
      await expect(
        t.execute({ project: "akame" }, makeContext("tester"))
      ).rejects.toThrow("Доступ запрещён");
    });

    it("сообщает если граф пуст", async () => {
      mockSearch.mockResolvedValue([]);
      const t = createCodeGraphTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("Сущностей: 0");
    });

    it("строит граф с нодами и рёбрами", async () => {
      mockSearch.mockResolvedValue([
        makeRecord("1", "ModuleA", "module", [
          { type: "depends_on", target: "ModuleB" },
        ]),
        makeRecord("2", "ModuleB", "module", []),
      ]);
      const t = createCodeGraphTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("Сущностей: 2");
      expect(result).toContain("Рёбер: 1");
    });

    it("находит отсутствующие обратные связи", async () => {
      mockSearch.mockResolvedValue([
        makeRecord("1", "ModuleA", "module", [
          { type: "depends_on", target: "ModuleB" },
        ]),
        makeRecord("2", "ModuleB", "module", []), // нет used_by
      ]);
      const t = createCodeGraphTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("Отсутствует обратных связей: 1");
    });

    it("не находит обратных связей если они есть", async () => {
      mockSearch.mockResolvedValue([
        makeRecord("1", "ModuleA", "module", [
          { type: "depends_on", target: "ModuleB" },
        ]),
        makeRecord("2", "ModuleB", "module", [
          { type: "used_by", target: "ModuleA" },
        ]),
      ]);
      const t = createCodeGraphTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      // Когда обратных связей нет, строка "Отсутствует" не выводится вовсе
      expect(result).not.toContain("Отсутствует обратных связей");
      expect(result).toContain("Циклов: 0");
    });

    it("находит циклы", async () => {
      mockSearch.mockResolvedValue([
        makeRecord("1", "A", "module", [{ type: "depends_on", target: "B" }]),
        makeRecord("2", "B", "module", [{ type: "depends_on", target: "A" }]),
      ]);
      const t = createCodeGraphTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("Циклов: 1");
    });

    it("находит сирот", async () => {
      mockSearch.mockResolvedValue([
        makeRecord("1", "Orphan", "module", []),
      ]);
      const t = createCodeGraphTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("Сирот (без связей): 1");
    });

    it("исправляет связи при fixMissingLinks=true", async () => {
      mockSearch.mockResolvedValue([
        makeRecord("1", "A", "module", [{ type: "depends_on", target: "B" }]),
        makeRecord("2", "B", "module", []),
      ]);
      const t = createCodeGraphTool(defaultConfig, mockLog);
      const result = await t.execute(
        { project: "akame", fixMissingLinks: true },
        makeContext()
      );
      expect(mockUpdate).toHaveBeenCalled();
      expect(result).toContain("Связей исправлено");
    });

    it("фильтрует по project_id", async () => {
      mockSearch.mockResolvedValue([
        makeRecord("1", "A", "module", [], "akame"),
        makeRecord("2", "B", "module", [], "selti"), // другой проект
      ]);
      const t = createCodeGraphTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("Сущностей: 1");
    });

    it("мёржит дублирующиеся ноды (несколько записей с одним entity_name)", async () => {
      mockSearch.mockResolvedValue([
        makeRecord("1", "ModuleA", "module", [
          { type: "depends_on", target: "X" },
        ]),
        makeRecord("2", "ModuleA", "module", [
          { type: "depends_on", target: "Y" },
        ]),
      ]);
      const t = createCodeGraphTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      // Должен смержить и показать 1 сущность с 2 рёбрами
      expect(result).toContain("Сущностей: 1");
      expect(result).toContain("Рёбер: 2");
    });
  });
});
