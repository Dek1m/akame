// ── Code Index — сканер структуры кода ──
// Regex-based парсеры для .ts/.tsx/.py файлов
// Извлекает классы, интерфейсы, функции, типы, enum-ы

import fs from "fs";
import path from "path";
import { EXCLUDE_DIRS } from "../constants.js";

// ── Типы ──────────────────────────────────────────────────────────────────

export type ScannedEntityType = "class" | "interface" | "function" | "type" | "enum";

export interface ScannedEntity {
  type: ScannedEntityType;
  name: string;
  signature: string;
  source_location: string;
  extends?: string;
  implements?: string[];
  methods?: string[];
}

export interface ScannedFile {
  path: string;
  module: string;
  exports: ScannedEntity[];
  imports: string[];
}

export interface ScanResult {
  project: string;
  files: ScannedFile[];
  timestamp: string;
}

// ── Константы ─────────────────────────────────────────────────────────────

const TS_EXTS = new Set([".ts", ".tsx"]);
const PY_EXTS = new Set([".py"]);

// ── Helpers ────────────────────────────────────────────────────────────────

function getModule(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/")[0] || "root";
}

function extractImportsFromLine(line: string): string | null {
  // import X from '...'; import { X } from '...'; import * as X from '...'; import '...'
  const m = line.match(
    /^import\s+(?:type\s+)?(?:.*?\s+from\s+)?['"]([^'"]+)['"]/
  );
  return m ? m[1] : null;
}

// ── TS/TSX Parser ─────────────────────────────────────────────────────────

export function parseTSFile(content: string, relativePath: string): ScannedFile {
  const lines = content.split("\n");
  const exports: ScannedEntity[] = [];
  const imports: string[] = [];

  // Состояние для отслеживания тела класса
  let classCtx: {
    name: string;
    line: number;
    ext?: string;
    impl?: string[];
    methods: string[];
    depth: number;
    started: boolean;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const s = raw.trim();
    if (!s || s.startsWith("//") || s.startsWith("/*") || s.startsWith("*"))
      continue;

    // ── Импорты ──
    const impMod = extractImportsFromLine(s);
    if (impMod && !imports.includes(impMod)) imports.push(impMod);

    // ── Внутри класса ──
    if (classCtx) {
      for (const ch of raw) {
        if (ch === "{") {
          classCtx.depth++;
          classCtx.started = true;
        }
        if (ch === "}") classCtx.depth--;
      }

      if (classCtx.started) {
        // Методы: публичные/приватные/статические/асинхронные + имя(
        const meth = s.match(
          /^(?:public\s+|protected\s+|private\s+|static\s+|async\s+)*(?:get\s+|set\s+)?(\w+)\s*\(/
        );
        if (meth) {
          const mn = meth[1];
          if (
            !["if", "for", "while", "switch", "catch", "return"].includes(mn)
          ) {
            if (!classCtx.methods.includes(mn)) classCtx.methods.push(mn);
          }
        }
        // Стрелочные свойства: name = ( ... ) =>
        const arr = s.match(/^(\w+)\s*=\s*(?:async\s*)?\(/);
        if (
          arr &&
          !["if", "for", "while", "switch", "catch"].includes(arr[1])
        ) {
          if (!classCtx.methods.includes(arr[1]))
            classCtx.methods.push(arr[1]);
        }
      }

      if (classCtx.depth <= 0 && classCtx.started) {
        exports.push({
          type: "class",
          name: classCtx.name,
          signature: `class ${classCtx.name}` +
            (classCtx.ext ? ` extends ${classCtx.ext}` : "") +
            (classCtx.impl
              ? ` implements ${classCtx.impl.join(", ")}`
              : ""),
          source_location: `L${classCtx.line}`,
          extends: classCtx.ext,
          implements: classCtx.impl,
          methods:
            classCtx.methods.length > 0 ? classCtx.methods : undefined,
        });
        classCtx = null;
      }
      continue;
    }

    // ── Класс ──
    const cls = s.match(
      /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/
    );
    if (cls) {
      const ext = s.match(/extends\s+(\w+)/);
      const impl = s.match(/implements\s+([\w\s,]+)/);
      classCtx = {
        name: cls[1],
        line: i + 1,
        ext: ext?.[1],
        impl: impl?.[1]
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        methods: [],
        depth: 0,
        started: false,
      };
      // Тело класса может начинаться на той же строке
      for (const ch of raw) {
        if (ch === "{") {
          classCtx.depth++;
          classCtx.started = true;
        }
        if (ch === "}") classCtx.depth--;
      }
      // Если класс закрылся на той же строке (например class Foo {})
      if (classCtx.started && classCtx.depth <= 0) {
        exports.push({
          type: "class",
          name: classCtx.name,
          signature:
            `class ${classCtx.name}` +
            (classCtx.ext ? ` extends ${classCtx.ext}` : "") +
            (classCtx.impl
              ? ` implements ${classCtx.impl.join(", ")}`
              : ""),
          source_location: `L${classCtx.line}`,
          extends: classCtx.ext,
          implements: classCtx.impl,
          methods:
            classCtx.methods.length > 0 ? classCtx.methods : undefined,
        });
        classCtx = null;
      }
      continue;
    }

    // ── Интерфейс ──
    const ifc = s.match(
      /^export\s+(?:default\s+)?interface\s+(\w+)/
    );
    if (ifc) {
      exports.push({
        type: "interface",
        name: ifc[1],
        signature: s,
        source_location: `L${i + 1}`,
      });
      continue;
    }

    // ── Функция ──
    const fn = s.match(
      /^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/
    );
    if (fn) {
      exports.push({
        type: "function",
        name: fn[1],
        signature: s,
        source_location: `L${i + 1}`,
      });
      continue;
    }

    // ── Константная стрелочная функция ──
    // export const foo = ( ... ) => / export const foo: Type = ( ... ) =>
    const cf = s.match(
      /^export\s+(?:default\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?[(<]/
    );
    if (cf) {
      exports.push({
        type: "function",
        name: cf[1],
        signature: s,
        source_location: `L${i + 1}`,
      });
      continue;
    }

    // ── Type ──
    const tp = s.match(/^export\s+type\s+(\w+)/);
    if (tp) {
      exports.push({
        type: "type",
        name: tp[1],
        signature: s,
        source_location: `L${i + 1}`,
      });
      continue;
    }

    // ── Enum ──
    const en = s.match(/^export\s+(?:const\s+)?enum\s+(\w+)/);
    if (en) {
      exports.push({
        type: "enum",
        name: en[1],
        signature: s,
        source_location: `L${i + 1}`,
      });
      continue;
    }
  }

  return {
    path: relativePath,
    module: getModule(relativePath),
    exports,
    imports,
  };
}

// ── Python Parser ─────────────────────────────────────────────────────────

export function parsePythonFile(
  content: string,
  relativePath: string
): ScannedFile {
  const lines = content.split("\n");
  const exports: ScannedEntity[] = [];
  const imports: string[] = [];

  // Текущий класс (индент-основанный)
  let classCtx: {
    name: string;
    line: number;
    bases: string[];
    methods: string[];
    indent: number;
  } | null = null;

  // Состояние для пропуска docstring-ов ("""  или  ''')
  let inDocstring: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const s = raw.trim();

    // Пропускаем docstring-и
    if (inDocstring) {
      const idx = s.indexOf(inDocstring);
      if (idx >= 0) {
        // Проверяем, не закрылся ли docstring на той же строке
        const rest = s.slice(idx + 3);
        // Если остаток снова открывает — переключаем (корнер-кейс, но редко)
        const nextOpen = rest.includes(inDocstring);
        inDocstring = nextOpen ? inDocstring : null;
      }
      // Для """ которые начинаются и заканчиваются на одной строке:
      // Они не попадают сюда, т.к. inDocstring === null в начале
      continue;
    }
    // Проверяем начало docstring
    if (s.startsWith('"""') || s.startsWith("'''")) {
      const delim = s.slice(0, 3);
      // Если закрывается на той же строке — просто пропускаем эту строку
      if (s.length > 3 && s.slice(3).includes(delim)) {
        continue;
      }
      inDocstring = delim;
      continue;
    }

    if (!s || s.startsWith("#")) continue;

    const indent = raw.length - raw.trimStart().length;

    // ── Импорты ──
    const imp = s.match(/^(?:from\s+(\S+)\s+)?import\s+(\S+)/);
    if (imp) {
      // import X or from X import Y
      const modName = imp[1] || imp[2];
      if (modName && !imports.includes(modName)) imports.push(modName);
    }

    // ── Проверка выхода из класса ──
    if (classCtx && indent <= classCtx.indent) {
      exports.push({
        type: "class",
        name: classCtx.name,
        signature:
          `class ${classCtx.name}` +
          (classCtx.bases.length > 0
            ? `(${classCtx.bases.join(", ")})`
            : ""),
        source_location: `L${classCtx.line}`,
        extends: classCtx.bases[0],
        implements:
          classCtx.bases.length > 1 ? classCtx.bases.slice(1) : undefined,
        methods:
          classCtx.methods.length > 0 ? classCtx.methods : undefined,
      });
      classCtx = null;
    }

    // ── Класс ──
    const cls = s.match(/^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/);
    if (cls) {
      const bases = cls[2]
        ? cls[2].split(",").map((x) => x.trim()).filter(Boolean)
        : [];
      classCtx = {
        name: cls[1],
        line: i + 1,
        bases,
        methods: [],
        indent,
      };
      continue;
    }

    // ── Метод внутри класса ──
    if (classCtx && indent > classCtx.indent) {
      const fn = s.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
      if (fn) {
        classCtx.methods.push(fn[1]);
        continue;
      }
    }

    // ── Модульная функция ──
    if (!classCtx) {
      const fn = s.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
      if (fn) {
        exports.push({
          type: "function",
          name: fn[1],
          signature: s,
          source_location: `L${i + 1}`,
        });
        continue;
      }
    }
  }

  // Если файл закончился без закрытия класса
  if (classCtx) {
    exports.push({
      type: "class",
      name: classCtx.name,
      signature:
        `class ${classCtx.name}` +
        (classCtx.bases.length > 0
          ? `(${classCtx.bases.join(", ")})`
          : ""),
      source_location: `L${classCtx.line}`,
      extends: classCtx.bases[0],
      implements:
        classCtx.bases.length > 1 ? classCtx.bases.slice(1) : undefined,
      methods:
        classCtx.methods.length > 0 ? classCtx.methods : undefined,
    });
  }

  return {
    path: relativePath,
    module: getModule(relativePath),
    exports,
    imports,
  };
}

// ── Сканер директории ─────────────────────────────────────────────────────

export function scanDirectory(rootDir: string): ScannedFile[] {
  const results: ScannedFile[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!EXCLUDE_DIRS.has(e.name)) walk(fp);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        const rel = path.relative(rootDir, fp).replace(/\\/g, "/");
        if (TS_EXTS.has(ext)) {
          try {
            const content = fs.readFileSync(fp, "utf-8");
            results.push(parseTSFile(content, rel));
          } catch {
            /* пропускаем */
          }
        } else if (PY_EXTS.has(ext)) {
          try {
            const content = fs.readFileSync(fp, "utf-8");
            results.push(parsePythonFile(content, rel));
          } catch {
            /* пропускаем */
          }
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

// ── Основная точка входа ──────────────────────────────────────────────────

export function scanProject(
  project: string,
  directory: string
): ScanResult {
  return {
    project,
    files: scanDirectory(directory),
    timestamp: new Date().toISOString(),
  };
}
