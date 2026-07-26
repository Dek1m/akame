import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRecent = vi.fn();
const mockFindSimilar = vi.fn();
const mockUpdate = vi.fn();
vi.mock("../../src/mcp/client.js", () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    recent: mockRecent,
    findSimilar: mockFindSimilar,
    update: mockUpdate,
  })),
}));

import { enrichLinks } from "../../src/granulator/link-enricher.js";

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
  enrichLinks: true,
  enrichPrompt: false,
};

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeGranule(overrides: Record<string, unknown> = {}) {
  return {
    id: "gran-1",
    content: "module MCPClient handles HTTP communication",
    metadata: {
      session_id: "sess-1",
      entity_name: "MCPClient",
      entity_type: "class",
      importance: 3,
      links: [],
      ...overrides,
    },
    namespace: "code_knowledge",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe("link-enricher", () => {
  beforeEach(() => {
    mockRecent.mockReset();
    mockFindSimilar.mockReset();
    mockUpdate.mockReset();
    mockUpdate.mockResolvedValue({});
  });

  describe("enrichLinks", () => {
    it("ничего не делает если enrichLinks=false", async () => {
      const config = { ...defaultConfig, enrichLinks: false };
      await enrichLinks(
        { sessionId: "sess-1", agent: "test", projectId: "akame", messages: [], participants: [] },
        config,
        mockLog
      );
      expect(mockRecent).not.toHaveBeenCalled();
      expect(mockLog.debug).toHaveBeenCalledWith(
        expect.stringContaining("отключён")
      );
    });

    it("ничего не делает если нет новых гранул для сессии", async () => {
      mockRecent.mockResolvedValue([
        makeGranule({ session_id: "other-session" }),
      ]);
      await enrichLinks(
        { sessionId: "sess-1", agent: "test", projectId: "akame", messages: [], participants: [] },
        defaultConfig,
        mockLog
      );
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("пропускает гранулы с importance ≤ 1", async () => {
      mockRecent.mockResolvedValue([
        makeGranule({ importance: 1 }),
      ]);
      await enrichLinks(
        { sessionId: "sess-1", agent: "test", projectId: "akame", messages: [], participants: [] },
        defaultConfig,
        mockLog
      );
      // Не должен вызывать findSimilar для importance=1
      expect(mockFindSimilar).not.toHaveBeenCalled();
    });

    it("обогащает связи через findSimilar", async () => {
      mockRecent.mockResolvedValue([
        makeGranule(),
      ]);
      mockFindSimilar.mockResolvedValue([
        { id: "adr-1", content: "ADR about MCP", score: 0.92, metadata: {} },
      ]);
      await enrichLinks(
        { sessionId: "sess-1", agent: "test", projectId: "akame", messages: [], participants: [] },
        defaultConfig,
        mockLog
      );
      expect(mockFindSimilar).toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("не превышает MAX_LINKS_PER_GRANULE (5)", async () => {
      mockRecent.mockResolvedValue([
        makeGranule({
          links: [
            { type: "related_to", target: "a" },
            { type: "related_to", target: "b" },
            { type: "related_to", target: "c" },
            { type: "related_to", target: "d" },
            { type: "related_to", target: "e" },
          ],
        }),
      ]);
      await enrichLinks(
        { sessionId: "sess-1", agent: "test", projectId: "akame", messages: [], participants: [] },
        defaultConfig,
        mockLog
      );
      // Уже 5 связей — не должен искать новые
      expect(mockFindSimilar).not.toHaveBeenCalled();
    });

    it("не связывает гранулу саму с собой", async () => {
      mockRecent.mockResolvedValue([
        makeGranule(),
      ]);
      mockFindSimilar.mockResolvedValue([
        { id: "gran-1", content: "module MCPClient", score: 0.95, metadata: {} },
      ]);
      await enrichLinks(
        { sessionId: "sess-1", agent: "test", projectId: "akame", messages: [], participants: [] },
        defaultConfig,
        mockLog
      );
      // Не должен добавить ссылку на самого себя
      const updateCalls = mockUpdate.mock.calls;
      if (updateCalls.length > 0) {
        const links = (updateCalls[0][2] as Record<string, unknown>)?.links as Array<{ target: string }>;
        const selfLinks = links?.filter((l) => l.target === "gran-1") ?? [];
        expect(selfLinks.length).toBe(0);
      }
    });

    it("использует CNLM_MATRIX для поиска", async () => {
      // code_knowledge → project_meta
      mockRecent.mockResolvedValue([
        makeGranule(),
      ]);
      mockFindSimilar.mockResolvedValue([]);
      await enrichLinks(
        { sessionId: "sess-1", agent: "test", projectId: "akame", messages: [], participants: [] },
        defaultConfig,
        mockLog
      );
      // Должен вызывать findSimilar для project_meta (из CNLM_MATRIX)
      expect(mockFindSimilar).toHaveBeenCalled();
      const calls = mockFindSimilar.mock.calls;
      // Проверяем что один из вызовов был с namespace="project_meta"
      const hasProjectMeta = calls.some(
        (call: unknown[]) => call[4] === "project_meta"
      );
      expect(hasProjectMeta).toBe(true);
    });

    it("обрабатывает ошибки MCP", async () => {
      mockRecent.mockRejectedValue(new Error("Connection refused"));
      await enrichLinks(
        { sessionId: "sess-1", agent: "test", projectId: "akame", messages: [], participants: [] },
        defaultConfig,
        mockLog
      );
      expect(mockLog.error).toHaveBeenCalled();
    });
  });
});
