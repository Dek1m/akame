import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());
const mockExists = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ spawnSync: mockSpawn }));

vi.mock("fs", () => ({
  default: { existsSync: mockExists, readFileSync: mockReadFile },
  existsSync: mockExists,
  readFileSync: mockReadFile,
}));

import { getGitDiff, truncateDiff } from "../../src/events/git-diff.js";

describe("git-diff", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockExists.mockReset();
    mockReadFile.mockReset();
    mockExists.mockReturnValue(true);
  });

  describe("getGitDiff", () => {
    it("возвращает deleted если файл не существует", () => {
      mockExists.mockReturnValue(false);
      const result = getGitDiff("/path/to/deleted.ts");
      expect(result.type).toBe("deleted");
      expect(result.diff).toBe("");
      expect(result.filePath).toBe("/path/to/deleted.ts");
    });

    it("читает файл напрямую если не git-репозиторий", () => {
      mockSpawn.mockReturnValue({ status: 1 }); // git rev-parse fails
      mockReadFile.mockReturnValue("console.log('hello');");
      const result = getGitDiff("/path/to/file.ts");
      expect(result.content).toBe("console.log('hello');");
      expect(result.diff).toBe("");
      expect(result.type).toBe("modified");
    });

    it("возвращает staged diff", () => {
      mockSpawn
        .mockReturnValueOnce({ status: 0 }) // isGitRepo
        .mockReturnValueOnce({ stdout: "+added line\n-removed line" }); // gitDiffStaged
      const result = getGitDiff("/path/to/file.ts");
      expect(result.diff).toBe("+added line\n-removed line");
      expect(result.type).toBe("modified");
    });

    it("пробует diff --no-index если staged diff пустой и файл новый", () => {
      mockSpawn
        .mockReturnValueOnce({ status: 0 }) // isGitRepo
        .mockReturnValueOnce({ stdout: "" }) // staged — пусто
        .mockReturnValueOnce({ stdout: "+new file content" }); // --no-index
      const result = getGitDiff("/path/to/newfile.ts");
      expect(result.diff).toBe("+new file content");
      expect(result.type).toBe("created");
    });

    it("читает файл если оба diff пустые", () => {
      mockSpawn
        .mockReturnValueOnce({ status: 0 }) // isGitRepo
        .mockReturnValueOnce({ stdout: "" }) // staged empty
        .mockReturnValueOnce({ stdout: "" }); // --no-index empty
      mockReadFile.mockReturnValue("file content here");
      const result = getGitDiff("/path/to/file.ts");
      expect(result.content).toBe("file content here");
      expect(result.diff).toBe("");
    });

    it("обрабатывает ошибку spawnSync для staged diff", () => {
      mockSpawn
        .mockReturnValueOnce({ status: 0 }) // isGitRepo
        .mockImplementation(() => {
          throw new Error("spawn failed");
        });
      mockReadFile.mockReturnValue("fallback content");
      const result = getGitDiff("/path/to/file.ts");
      // Если оба diff упали — должен читать файл
      expect(result.content).toBeDefined();
    });
  });

  describe("truncateDiff", () => {
    it("не обрезает короткий diff", () => {
      const diff = "line1\nline2\nline3";
      expect(truncateDiff(diff, 10)).toBe(diff);
    });

    it("обрезает длинный diff с индикатором пропущенных строк", () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line${i}`);
      const diff = lines.join("\n");
      const result = truncateDiff(diff, 200);
      expect(result).toContain("... (пропущено 300 строк)");
      const resultLines = result.split("\n");
      expect(resultLines.length).toBeLessThanOrEqual(202); // 100 head + 1 skip + 100 tail = 201
    });

    it("использует дефолтный maxLines 200", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line${i}`);
      const diff = lines.join("\n");
      expect(truncateDiff(diff)).toBe(diff);
    });

    it("сохраняет голову и хвост", () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
      const diff = lines.join("\n");
      const result = truncateDiff(diff, 6);
      expect(result).toContain("line0");
      expect(result).toContain("line9");
    });

    it("корректно работает с кастомным maxLines", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
      const diff = lines.join("\n");
      const result = truncateDiff(diff, 10);
      const resultLines = result.split("\n");
      expect(resultLines).toContain("L0");
      expect(resultLines).toContain("L19");
    });
  });
});
