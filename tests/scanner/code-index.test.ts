import { describe, it, expect } from "vitest";
import {
  parseTSFile,
  parsePythonFile,
  scanDirectory,
  scanProject,
} from "../../src/scanner/code-index.js";
import path from "path";
import fs from "fs";
import os from "os";

// ── TS Parser ──────────────────────────────────────────────────────────────

describe("parseTSFile", () => {
  it("парсит класс с методами", () => {
    const code = `
export class UserService {
  constructor(private db: Database) {}

  async findUser(id: string): Promise<User> {
    return this.db.get(id);
  }

  deleteUser(id: string): void {
    this.db.remove(id);
  }
}
`;
    const result = parseTSFile(code, "src/services/user.ts");
    expect(result.module).toBe("src");
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0].type).toBe("class");
    expect(result.exports[0].name).toBe("UserService");
    expect(result.exports[0].source_location).toBe("L2");
    expect(result.exports[0].methods).toEqual([
      "constructor",
      "findUser",
      "deleteUser",
    ]);
  });

  it("парсит интерфейс", () => {
    const code = `
export interface User {
  id: string;
  name: string;
  email?: string;
}
`;
    const result = parseTSFile(code, "src/types/user.ts");
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0].type).toBe("interface");
    expect(result.exports[0].name).toBe("User");
    expect(result.exports[0].source_location).toBe("L2");
  });

  it("парсит функцию", () => {
    const code = `
export async function fetchData(url: string): Promise<Data> {
  const response = await fetch(url);
  return response.json();
}

export function helper(): void {
  console.log("help");
}
`;
    const result = parseTSFile(code, "src/utils/api.ts");
    expect(result.exports).toHaveLength(2);
    expect(result.exports[0].type).toBe("function");
    expect(result.exports[0].name).toBe("fetchData");
    expect(result.exports[1].name).toBe("helper");
  });

  it("парсит константную стрелочную функцию", () => {
    const code = `
export const getData = async (id: string): Promise<Data> => {
  // ...
};

export const parseInput = (raw: string): Input => {
  // ...
};
`;
    const result = parseTSFile(code, "src/utils/data.ts");
    expect(result.exports).toHaveLength(2);
    expect(result.exports[0].type).toBe("function");
    expect(result.exports[0].name).toBe("getData");
    expect(result.exports[1].name).toBe("parseInput");
  });

  it("парсит export type", () => {
    const code = `
export type Status = "active" | "inactive";

export type Callback<T> = (value: T) => void;
`;
    const result = parseTSFile(code, "src/types.ts");
    expect(result.exports).toHaveLength(2);
    expect(result.exports[0].type).toBe("type");
    expect(result.exports[0].name).toBe("Status");
    expect(result.exports[1].name).toBe("Callback");
  });

  it("парсит export enum", () => {
    const code = `
export enum Color {
  Red,
  Green,
  Blue,
}

export const enum Direction {
  Up,
  Down,
}
`;
    const result = parseTSFile(code, "src/enums.ts");
    expect(result.exports).toHaveLength(2);
    expect(result.exports[0].type).toBe("enum");
    expect(result.exports[0].name).toBe("Color");
    expect(result.exports[1].name).toBe("Direction");
  });

  it("извлекает импорты из TS", () => {
    const code = `
import { User } from "./types.js";
import Database from "../db/index.js";
import * as Utils from "./utils/helpers.js";
import "./styles.css";
import type { Config } from "./config.js";
`;
    const result = parseTSFile(code, "src/main.ts");
    expect(result.imports).toEqual([
      "./types.js",
      "../db/index.js",
      "./utils/helpers.js",
      "./styles.css",
      "./config.js",
    ]);
  });

  it("парсит класс с extends и implements", () => {
    const code = `
export class AdminService extends BaseService implements Validatable, Loggable {
  validate(): boolean {
    return true;
  }
}
`;
    const result = parseTSFile(code, "src/services/admin.ts");
    expect(result.exports).toHaveLength(1);
    const cls = result.exports[0];
    expect(cls.type).toBe("class");
    expect(cls.name).toBe("AdminService");
    expect(cls.extends).toBe("BaseService");
    expect(cls.implements).toEqual(["Validatable", "Loggable"]);
    expect(cls.methods).toEqual(["validate"]);
  });

  it("пропускает комментарии", () => {
    const code = `
// export class ShouldNotAppear {}
/**
 * export class AlsoNotAppear {}
 */
export class RealClass {}
`;
    const result = parseTSFile(code, "src/test.ts");
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0].name).toBe("RealClass");
  });
});

// ── Python Parser ──────────────────────────────────────────────────────────

describe("parsePythonFile", () => {
  it("парсит класс с методами", () => {
    const code = `
class UserService:
    def __init__(self, db):
        self.db = db

    async def find_user(self, id):
        return await self.db.get(id)

    def delete_user(self, id):
        self.db.remove(id)
`;
    const result = parsePythonFile(code, "src/services/user.py");
    expect(result.module).toBe("src");
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0].type).toBe("class");
    expect(result.exports[0].name).toBe("UserService");
    expect(result.exports[0].source_location).toBe("L2");
    expect(result.exports[0].methods).toEqual([
      "__init__",
      "find_user",
      "delete_user",
    ]);
  });

  it("парсит класс с наследованием", () => {
    const code = `
class AdminService(BaseService, Validatable):
    def validate(self):
        return True
`;
    const result = parsePythonFile(code, "src/services/admin.py");
    expect(result.exports).toHaveLength(1);
    const cls = result.exports[0];
    expect(cls.name).toBe("AdminService");
    expect(cls.extends).toBe("BaseService");
    expect(cls.implements).toEqual(["Validatable"]);
  });

  it("парсит функции модуля", () => {
    const code = `
def helper():
    pass

async def fetch_data(url):
    return await request(url)

def process(item):
    pass
`;
    const result = parsePythonFile(code, "src/utils/helpers.py");
    expect(result.exports).toHaveLength(3);
    expect(result.exports[0].name).toBe("helper");
    expect(result.exports[1].name).toBe("fetch_data");
    expect(result.exports[2].name).toBe("process");
  });

  it("извлекает импорты Python", () => {
    const code = `
import os
import json
from django.db import models
from .local import helper
`;
    const result = parsePythonFile(code, "src/main.py");
    expect(result.imports).toEqual(["os", "json", "django.db", ".local"]);
  });

  it("пропускает комментарии", () => {
    const code = `
# class FakeClass:
"""
def fake_function():
    pass
"""
class RealClass:
    pass
`;
    const result = parsePythonFile(code, "src/test.py");
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0].name).toBe("RealClass");
  });

  it("парсит async def как функцию", () => {
    const code = `
async def process_async():
    pass
`;
    const result = parsePythonFile(code, "src/async_module.py");
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0].type).toBe("function");
    expect(result.exports[0].name).toBe("process_async");
  });
});

// ── Directory Scanner ──────────────────────────────────────────────────────

describe("scanDirectory", () => {
  it("игнорирует node_modules и .venv", () => {
    // Сканируем корень проекта — node_modules не должно входить
    const results = scanDirectory(
      path.resolve(__dirname, "../..")
    );
    const hasNodeModules = results.some((f) =>
      f.path.startsWith("node_modules")
    );
    expect(hasNodeModules).toBe(false);

    const hasVenv = results.some((f) =>
      f.path.startsWith(".venv")
    );
    expect(hasVenv).toBe(false);
  });

  it("находит ts-файлы в src", () => {
    const results = scanDirectory(
      path.resolve(__dirname, "../../src")
    );
    expect(results.length).toBeGreaterThan(0);
    const allTsOrTsx = results.every(
      (f) =>
        f.path.endsWith(".ts") || f.path.endsWith(".tsx")
    );
    expect(allTsOrTsx).toBe(true);
  });
});

describe("scanProject", () => {
  it("возвращает ScanResult с временной меткой", () => {
    const result = scanProject(
      "akame",
      path.resolve(__dirname, "../../src")
    );
    expect(result.project).toBe("akame");
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.timestamp).toBeTruthy();
    expect(() => new Date(result.timestamp)).not.toThrow();
  });
});

// ── Интеграционный тест: реальные файлы проекта ──────────────────────────

describe("integration: реальные файлы akame", () => {
  it("парсит MCP client.ts", () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, "../../src/mcp/client.ts"),
      "utf-8"
    );
    const result = parseTSFile(content, "src/mcp/client.ts");
    expect(result.module).toBe("src");

    // Должен найти класс MCPClient
    const mcpClass = result.exports.find(
      (e) => e.name === "MCPClient"
    );
    expect(mcpClass).toBeDefined();
    expect(mcpClass!.type).toBe("class");

    // Должен найти методы
    expect(mcpClass!.methods).toBeDefined();
    expect(mcpClass!.methods!.length).toBeGreaterThan(0);
  });

  it("парсит schema.ts", () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, "../../src/granulator/schema.ts"),
      "utf-8"
    );
    const result = parseTSFile(content, "src/granulator/schema.ts");
    // Должен найти интерфейсы: GranuleMetadata, Granule, GranulatorOutput, CodeLink
    const ifaces = result.exports.filter(
      (e) => e.type === "interface"
    );
    expect(ifaces.length).toBeGreaterThanOrEqual(4);

    const names = ifaces.map((i) => i.name);
    expect(names).toContain("GranuleMetadata");
    expect(names).toContain("Granule");
    expect(names).toContain("GranulatorOutput");
    expect(names).toContain("CodeLink");
  });

  it("парсит granulate-tool.ts", () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, "../../src/granulator/granulate-tool.ts"),
      "utf-8"
    );
    const result = parseTSFile(content, "src/granulator/granulate-tool.ts");
    // Должен найти функцию createGranulateTool
    const func = result.exports.find(
      (e) => e.name === "createGranulateTool"
    );
    expect(func).toBeDefined();
    expect(func!.type).toBe("function");
    expect(result.exports.length).toBeGreaterThanOrEqual(2); // storeSessionData + createGranulateTool
  });
});
