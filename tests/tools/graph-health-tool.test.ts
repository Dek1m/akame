import { describe, it, expect, vi, beforeEach } from "vitest";

const mockList = vi.fn();
vi.mock("../../src/mcp/client.js", () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    list: mockList,
  })),
}));

import { createGraphHealthTool } from "../../src/tools/graph-health-tool.js";

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

function makeGranule(
  id: string,
  namespace: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    content: `content of ${id}`,
    metadata: {
      entity_name: id,
      entity_type: "module",
      importance: 3,
      session_id: "sess-1",
      project_id: "akame",
      title: id,
      message_ids: [],
      participants: ["test"],
      ...overrides,
    },
    namespace,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// Все namespace: user_facts, project_meta, dialogue_insights, code_knowledge, infrastructure
const ALL_NS = [
  "user_facts",
  "project_meta",
  "dialogue_insights",
  "code_knowledge",
  "infrastructure",
];

describe("graph-health-tool", () => {
  beforeEach(() => {
    mockList.mockReset();
    // По умолчанию — все namespace пустые
    mockList.mockImplementation((_userId, ns: string) => {
      return { items: [], total: 0 };
    });
  });

  describe("createGraphHealthTool", () => {
    it("бросает ошибку если агент не memory-granulator", async () => {
      const t = createGraphHealthTool(defaultConfig, mockLog);
      await expect(
        t.execute({ project: "akame" }, makeContext("tester"))
      ).rejects.toThrow("Доступ запрещён");
    });

    it("сообщает если граф пуст", async () => {
      const t = createGraphHealthTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("граф пуст");
    });

    it("собирает гранулы из всех namespace", async () => {
      mockList.mockImplementation((_userId, ns: string) => {
        if (ns === "code_knowledge") {
          return { items: [makeGranule("mod-1", "code_knowledge")], total: 1 };
        }
        return { items: [], total: 0 };
      });

      const t = createGraphHealthTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("Всего гранул: 1");
      expect(result).toContain("code_knowledge");
    });

    it("показывает статистику связанности", async () => {
      mockList.mockImplementation((_userId, ns: string) => {
        if (ns === "code_knowledge") {
          return {
            items: [
              makeGranule("mod-a", "code_knowledge", {
                links: [{ type: "depends_on", target: "mod-b" }],
              }),
              makeGranule("mod-b", "code_knowledge", {}),
            ],
            total: 2,
          };
        }
        return { items: [], total: 0 };
      });

      const t = createGraphHealthTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      // mod-a имеет исходящие, mod-b имеет входящие → оба связаны
      expect(result).toContain("100% связаны");
    });

    it("находит сирот", async () => {
      mockList.mockImplementation((_userId, ns: string) => {
        if (ns === "code_knowledge") {
          return {
            items: [
              makeGranule("orphan", "code_knowledge"),
            ],
            total: 1,
          };
        }
        return { items: [], total: 0 };
      });

      const t = createGraphHealthTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("сирот");
    });

    it("показывает verbose список сирот", async () => {
      mockList.mockImplementation((_userId, ns: string) => {
        if (ns === "code_knowledge") {
          return {
            items: [
              makeGranule("orphan-1", "code_knowledge"),
              makeGranule("orphan-2", "code_knowledge"),
            ],
            total: 2,
          };
        }
        return { items: [], total: 0 };
      });

      const t = createGraphHealthTool(defaultConfig, mockLog);
      const result = await t.execute(
        { project: "akame", verbose: true },
        makeContext()
      );
      expect(result).toContain("orphan-1");
      expect(result).toContain("orphan-2");
    });

    it("находит cross-namespace связи", async () => {
      mockList.mockImplementation((_userId, ns: string) => {
        if (ns === "code_knowledge") {
          return {
            items: [
              makeGranule("mod-x", "code_knowledge", {
                links: [{ type: "implements_adr", target: "adr-1" }],
              }),
            ],
            total: 1,
          };
        }
        if (ns === "project_meta") {
          return {
            items: [
              makeGranule("adr-1", "project_meta", {}),
            ],
            total: 1,
          };
        }
        return { items: [], total: 0 };
      });

      const t = createGraphHealthTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      // Должен показать cross-namespace связь
      expect(result).toContain("code_knowledge → project_meta");
    });

    it("находит критичных сирот (importance ≥ 3)", async () => {
      mockList.mockImplementation((_userId, ns: string) => {
        if (ns === "code_knowledge") {
          return {
            items: [
              makeGranule("critical", "code_knowledge", { importance: 5 }),
              makeGranule("minor", "code_knowledge", { importance: 1 }),
            ],
            total: 2,
          };
        }
        return { items: [], total: 0 };
      });

      const t = createGraphHealthTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("critical");
      // minor (importance=1) не должен быть в критичных сиротах
      expect(result).not.toContain("minor");
    });

    it("находит дубликаты entity_name", async () => {
      mockList.mockImplementation((_userId, ns: string) => {
        if (ns === "code_knowledge") {
          return {
            items: [
              makeGranule("dup", "code_knowledge"),
              makeGranule("dup-2", "code_knowledge", { entity_name: "dup" }),
            ],
            total: 2,
          };
        }
        return { items: [], total: 0 };
      });

      const t = createGraphHealthTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("Дубликатов entity_name: 1");
    });

    it("показывает среднее связей на гранулу", async () => {
      mockList.mockImplementation((_userId, ns: string) => {
        if (ns === "code_knowledge") {
          return {
            items: [
              makeGranule("a", "code_knowledge", {
                links: [
                  { type: "depends_on", target: "b" },
                  { type: "depends_on", target: "c" },
                ],
              }),
              makeGranule("b", "code_knowledge", {}),
              makeGranule("c", "code_knowledge", {}),
            ],
            total: 3,
          };
        }
        return { items: [], total: 0 };
      });

      const t = createGraphHealthTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("Среднее связей на гранулу:");
    });

    it("корректно обрабатывает несколько namespace с разным количеством", async () => {
      mockList.mockImplementation((_userId, ns: string) => {
        if (ns === "code_knowledge") {
          return {
            items: [makeGranule("c1", "code_knowledge")],
            total: 1,
          };
        }
        if (ns === "user_facts") {
          return {
            items: [makeGranule("u1", "user_facts")],
            total: 1,
          };
        }
        return { items: [], total: 0 };
      });

      const t = createGraphHealthTool(defaultConfig, mockLog);
      const result = await t.execute({ project: "akame" }, makeContext());
      expect(result).toContain("user_facts: 1");
      expect(result).toContain("code_knowledge: 1");
    });
  });
});
