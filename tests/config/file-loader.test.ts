import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Мокаем fs и os до импорта модуля ──

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

import { loadConfigFile } from "../../src/config/file-loader.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockHomedir = vi.mocked(homedir);

describe("loadConfigFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Дефолт: homedir возвращает что-то предсказуемое
    mockHomedir.mockReturnValue("/home/testuser");
  });

  it("возвращает null, если ни один файл не найден", () => {
    mockExistsSync.mockReturnValue(false);

    const result = loadConfigFile("/some/dir");

    expect(result).toBeNull();
    // Проверяем что искали в cwd и в home
    expect(mockExistsSync).toHaveBeenCalledWith("/some/dir/akame.json5");
    expect(mockExistsSync).toHaveBeenCalledWith(
      "/home/testuser/.config/opencode/akame.json5"
    );
  });

  it("загружает файл из cwd (приоритет)", () => {
    // cwd файл существует
    mockExistsSync.mockImplementation((p) => p === "/project/akame.json5");

    mockReadFileSync.mockReturnValue('{"mcpUrl": "http://custom:9000/mcp/"}');

    const result = loadConfigFile("/project");

    expect(result).not.toBeNull();
    expect(result!.source).toBe("/project/akame.json5");
    expect(result!.data.mcpUrl).toBe("http://custom:9000/mcp/");
  });

  it("загружает файл из home, если cwd нет", () => {
    // cwd не существует, home — существует
    mockExistsSync.mockImplementation(
      (p) => p === "/home/testuser/.config/opencode/akame.json5"
    );
    mockReadFileSync.mockReturnValue('{"userId": "from-home"}');

    const result = loadConfigFile("/empty-dir");

    expect(result).not.toBeNull();
    expect(result!.source).toBe(
      "/home/testuser/.config/opencode/akame.json5"
    );
    expect(result!.data.userId).toBe("from-home");
  });

  it("приоритет cwd: cwd файл читается, home — нет", () => {
    // Оба существуют
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"idle": true}');

    const result = loadConfigFile("/project");

    expect(result).not.toBeNull();
    expect(result!.source).toBe("/project/akame.json5");
    // readFileSync вызван только 1 раз (для cwd)
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("парсит JSON5 с комментариями", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`{
      // Это комментарий
      "mcpUrl": "http://localhost:8000/mcp/",
      /* Блочный комментарий */
      "idle": true
    }`);

    const result = loadConfigFile("/project");

    expect(result).not.toBeNull();
    expect(result!.data.mcpUrl).toBe("http://localhost:8000/mcp/");
    expect(result!.data.idle).toBe(true);
  });

  it("парсит JSON5 с trailing commas", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`{
      "mcpUrl": "http://localhost:8000/mcp/",
      "idle": true,
    }`);

    const result = loadConfigFile("/project");

    expect(result).not.toBeNull();
    expect(result!.data.mcpUrl).toBe("http://localhost:8000/mcp/");
    expect(result!.data.idle).toBe(true);
  });

  it("парсит JSON5 без кавычек у ключей", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`{
      mcpUrl: "http://localhost:8000/mcp/",
      idle: true
    }`);

    const result = loadConfigFile("/project");

    expect(result).not.toBeNull();
    expect(result!.data.mcpUrl).toBe("http://localhost:8000/mcp/");
    expect(result!.data.idle).toBe(true);
  });

  it("возвращает null + логирует предупреждение при невалидном JSON5", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("{ this is not json }");

    const result = loadConfigFile("/project");

    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[akame] Ошибка парсинга")
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("/project/akame.json5")
    );

    consoleWarnSpy.mockRestore();
  });

  it("возвращает null + логирует при ошибке чтения файла", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = loadConfigFile("/project");

    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("EACCES: permission denied")
    );

    consoleWarnSpy.mockRestore();
  });

  it("возвращает пустой объект data, если файл пустой", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");

    const result = loadConfigFile("/project");

    // Пустая строка — невалидный JSON5
    expect(result).toBeNull();
  });

  it("handle non-Error thrown values", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw "string error"; // не Error объект
    });

    const result = loadConfigFile("/project");

    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("string error")
    );

    consoleWarnSpy.mockRestore();
  });

  it("возвращает null если cwd не передан", () => {
    // cwd undefined → ищем только в home
    mockExistsSync.mockReturnValue(false);

    const result = loadConfigFile();

    expect(result).toBeNull();
    // Должны были проверить только home (без cwd)
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
    expect(mockExistsSync).toHaveBeenCalledWith(
      "/home/testuser/.config/opencode/akame.json5"
    );
  });

  it("корректно парсит числовые значения", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`{
      cooldownMs: 60000,
      batchSize: 10
    }`);

    const result = loadConfigFile("/project");

    expect(result).not.toBeNull();
    expect(result!.data.cooldownMs).toBe(60000);
    expect(result!.data.batchSize).toBe(10);
  });

  it("корректно парсит булевы значения", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`{
      idle: true,
      fileEdited: false,
      enrichLinks: true
    }`);

    const result = loadConfigFile("/project");

    expect(result).not.toBeNull();
    expect(result!.data.idle).toBe(true);
    expect(result!.data.fileEdited).toBe(false);
    expect(result!.data.enrichLinks).toBe(true);
  });
});
