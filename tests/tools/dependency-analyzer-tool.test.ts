import { describe, it, expect, vi, beforeEach } from "vitest";

// Мокаем зависимости
vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  },
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
}));

const mockSearch = vi.fn();
const mockUpdate = vi.fn();
vi.mock("../../src/mcp/client.js", () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    search: mockSearch,
    update: mockUpdate,
  })),
}));

vi.mock("../../src/security/validate.js", () => ({
  resolveSafePath: vi.fn((dir: string, ws: string) => dir),
}));

import fs from "fs";
import { createDependencyAnalyzerTool } from "../../src/tools/dependency-analyzer-tool.js";

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

function makeDirEntry(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    parentPath: "/fake",
    path: `/fake/${name}`,
  } as fs.Dirent;
}

describe("dependency-analyzer-tool", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockUpdate.mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    mockSearch.mockResolvedValue([]);
    mockUpdate.mockResolvedValue({});
  });

  describe("createDependencyAnalyzerTool", () => {
    it("бросает ошибку если агент не memory-granulator", async () => {
      const t = createDependencyAnalyzerTool(defaultConfig, mockLog, "/ws");
      await expect(
        t.execute(
          { project: "akame", directory: "/ws" },
          makeContext("tester")
        )
      ).rejects.toThrow("Доступ запрещён");
    });

    it("сообщает если файлов не найдено", async () => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      const t = createDependencyAnalyzerTool(defaultConfig, mockLog, "/ws");
      const result = await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      expect(result).toContain("Файлов: 0");
    });

    it("сканирует .ts файлы", async () => {
      vi.mocked(fs.readdirSync).mockImplementation((dir: fs.PathLike) => {
        const p = dir.toString();
        if (p === "/ws") return [makeDirEntry("src", true)];
        if (p === "/ws/src") return [makeDirEntry("index.ts", false)];
        return [];
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        `import { foo } from "./utils/bar";`
      );

      const t = createDependencyAnalyzerTool(defaultConfig, mockLog, "/ws");
      const result = await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      expect(result).toContain("Файлов: 1");
    });

    it("извлекает импорты и строит связи", async () => {
      vi.mocked(fs.readdirSync).mockImplementation((dir: fs.PathLike) => {
        const p = dir.toString();
        if (p === "/ws") return [makeDirEntry("main.ts", false)];
        return [];
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        `import { helper } from "./utils/helper";\nimport React from "react";`
      );
      mockSearch.mockResolvedValue([
        {
          id: "1",
          content: "main module",
          metadata: {
            entity_name: "src",
            entity_type: "module",
            project_id: "akame",
          },
          score: 0.8,
        },
        {
          id: "2",
          content: "helper",
          metadata: {
            entity_name: "helper",
            entity_type: "function",
            project_id: "akame",
          },
          score: 0.8,
        },
      ]);

      const t = createDependencyAnalyzerTool(defaultConfig, mockLog, "/ws");
      const result = await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      expect(result).toContain("сканирование завершено");
    });

    it("извлекает Python импорты", async () => {
      vi.mocked(fs.readdirSync).mockImplementation((dir: fs.PathLike) => {
        const p = dir.toString();
        if (p === "/ws") return [makeDirEntry("app.py", false)];
        return [];
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        `import os\nfrom flask import Flask\nfrom .utils import helper\n`
      );

      const t = createDependencyAnalyzerTool(defaultConfig, mockLog, "/ws");
      const result = await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      expect(result).toContain("Файлов: 1");
    });

    it("обрабатывает require() и динамические import()", async () => {
      vi.mocked(fs.readdirSync).mockImplementation((dir: fs.PathLike) => {
        const p = dir.toString();
        if (p === "/ws") return [makeDirEntry("main.ts", false)];
        return [];
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        `const x = require("lodash");\nconst y = await import("moment");`
      );

      const t = createDependencyAnalyzerTool(defaultConfig, mockLog, "/ws");
      const result = await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      expect(result).toContain("Внешних (npm): 2");
    });

    it("исключает node_modules и другие EXCLUDE_DIRS", async () => {
      vi.mocked(fs.readdirSync).mockImplementation((dir: fs.PathLike) => {
        const p = dir.toString();
        if (p === "/ws") return [
          makeDirEntry("src", true),
          makeDirEntry("node_modules", true),
          makeDirEntry(".git", true),
        ];
        if (p === "/ws/src") return [makeDirEntry("main.ts", false)];
        return [];
      });
      vi.mocked(fs.readFileSync).mockReturnValue(`const x = 1;`);

      const t = createDependencyAnalyzerTool(defaultConfig, mockLog, "/ws");
      const result = await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      expect(result).toContain("Файлов: 1"); // только src/main.ts
    });

    it("показывает внешние пакеты в отчёте", async () => {
      vi.mocked(fs.readdirSync).mockImplementation((dir: fs.PathLike) => {
        const p = dir.toString();
        if (p === "/ws") return [makeDirEntry("main.ts", false)];
        return [];
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        `import React from "react";\nimport { z } from "zod";\nimport * as _ from "lodash";`
      );

      const t = createDependencyAnalyzerTool(defaultConfig, mockLog, "/ws");
      const result = await t.execute(
        { project: "akame", directory: "/ws" },
        makeContext()
      );
      expect(result).toContain("react");
      expect(result).toContain("zod");
      expect(result).toContain("lodash");
    });
  });
});
