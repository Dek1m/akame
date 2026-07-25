// ── Tool: dependency_analyzer — анализ импортов и связей модулей ──
// ДОСТУПЕН ТОЛЬКО агенту memory-granulator (Тишь).

import fs from "fs";
import path from "path";
import { tool } from "@opencode-ai/plugin";
import { MCPClient } from "../mcp/client.js";
import { EXCLUDE_DIRS } from "../constants.js";
import type { AkameConfig } from "../constants.js";
import type { Logger } from "../logger.js";
import type { CodeLink } from "../granulator/schema.js";
import { resolveSafePath } from "../security/validate.js";

// ── Константы ──

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);

// ── Типы ──

interface FileImports {
  filePath: string;
  module: string;
  imports: ImportEntry[];
}

interface ImportEntry {
  raw: string; // как написано в коде: "./utils/foo", "react", "fs"
  resolvedName: string; // имя сущности (последний компонент пути)
  isExternal: boolean; // npm/external пакет
  importPath: string; // от корня проекта
}

interface DependencyReport {
  totalDeps: number;
  externalDeps: string[];
  internalDeps: number;
  createdLinks: number;
  updatedLinks: number;
  errors: string[];
}

// ── Сканер файлов ──

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        results.push(...collectFiles(fullPath));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SOURCE_EXTS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// ── Парсер импортов ──

function extractImports(filePath: string): ImportEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const ext = path.extname(filePath);
  const lines = content.split("\n");
  const imports: ImportEntry[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const s = line.trim();

    // TypeScript/JavaScript imports
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      // import X from 'Y'
      // import { X } from 'Y'
      // import * as X from 'Y'
      // import 'Y'
      // import type { X } from 'Y'
      // const X = require('Y')
      // const X = await import('Y')
      const m = s.match(
        /^(?:import|export\s+(?:.*?\s+)?from)\s+(?:type\s+)?(?:.*?\s+from\s+)?['"]([^'"]+)['"]/
      );
      if (m) {
        const raw = m[1];
        if (!seen.has(raw)) {
          seen.add(raw);
          imports.push(parseImportEntry(raw, filePath));
        }
        continue;
      }

      // require('Y')
      const req = s.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (req) {
        const raw = req[1];
        if (!seen.has(raw)) {
          seen.add(raw);
          imports.push(parseImportEntry(raw, filePath));
        }
        continue;
      }

      // await import('Y')
      const dyn = s.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (dyn) {
        const raw = dyn[1];
        if (!seen.has(raw)) {
          seen.add(raw);
          imports.push(parseImportEntry(raw, filePath));
        }
        continue;
      }
    }

    // Python imports
    if (ext === ".py") {
      // from X import Y
      const fromMatch = s.match(/^from\s+(\S+)\s+import\s+/);
      if (fromMatch) {
        const raw = fromMatch[1];
        if (!seen.has(raw)) {
          seen.add(raw);
          imports.push(parseImportEntry(raw, filePath));
        }
        continue;
      }

      // import X
      const impMatch = s.match(/^import\s+(\S+)/);
      if (impMatch) {
        const raw = impMatch[1];
        if (!seen.has(raw)) {
          seen.add(raw);
          imports.push(parseImportEntry(raw, filePath));
        }
        continue;
      }
    }
  }

  return imports;
}

function parseImportEntry(raw: string, filePath: string): ImportEntry {
  // Определяем: относительный импорт, внутренний модуль или внешний пакет
  const isRelative = raw.startsWith("./") || raw.startsWith("../");
  const isExternal =
    !isRelative &&
    !raw.startsWith("@") &&
    !raw.startsWith("src/") &&
    raw.split("/").length === 1; // один сегмент → npm пакет

  // scoped пакеты (@scope/name) — всегда внешние
  const isScopedExternal =
    raw.startsWith("@") &&
    raw.split("/").length === 2;

  let resolvedName: string;
  let importPath: string;

  if (isRelative) {
    // ./utils/foo → foo
    resolvedName = raw.split("/").pop()!.replace(/\.\w+$/, "");
    importPath = path
      .normalize(path.join(path.dirname(filePath), raw))
      .replace(/\\/g, "/");
  } else if (isScopedExternal) {
    resolvedName = raw;
    importPath = raw;
  } else if (isExternal) {
    resolvedName = raw;
    importPath = raw;
  } else {
    // Внутренний путь (src/..., @internal/...)
    resolvedName = raw.split("/").pop()!.replace(/\.\w+$/, "");
    importPath = raw;
  }

  return {
    raw,
    resolvedName,
    isExternal: isExternal || isScopedExternal,
    importPath,
  };
}

// ── Модуль из пути ──

function getModule(relPath: string): string {
  return relPath.replace(/\\/g, "/").split("/")[0] || "root";
}

// ── Фабрика тула ──

export function createDependencyAnalyzerTool(
  config: AkameConfig,
  log: Logger,
  workspaceDir: string
) {
  const mcp = new MCPClient(config);

  return tool({
    description:
      "[ТОЛЬКО ДЛЯ memory-granulator] Проанализировать зависимости модулей проекта. " +
      "Сканирует импорты в .ts/.js/.py файлах и создаёт/обновляет depends_on и used_by связи в code_knowledge гранулах.",

    args: {
      project: tool.schema
        .string()
        .describe("Project name (e.g. 'akame')"),

      directory: tool.schema
        .string()
        .describe("Absolute path to the project directory"),
    },

    async execute(args, context) {
      // ── Защита ──
      const caller = context.agent || "unknown";
      if (caller !== "memory-granulator") {
        const errMsg = `Доступ запрещён: агент "${caller}" не имеет права вызывать dependency_analyzer. Только memory-granulator (Тишь).`;
        log.warn(errMsg);
        throw new Error(errMsg);
      }

      const { project, directory: rawDir } = args;
      const directory = resolveSafePath(rawDir, workspaceDir);
      log.info(
        `dependency_analyzer: сканирую ${project} в ${directory}`
      );

      // ── 1. Собираем файлы ──
      const files = collectFiles(directory);
      log.info(
        `dependency_analyzer: найдено ${files.length} файлов`
      );

      if (files.length === 0) {
        return [
          `dependency_analyzer: сканирование завершено`,
          `  Проект: ${project}`,
          `  Файлов: 0`,
          `  Не найдено .ts/.js/.py файлов в ${directory}`,
        ].join("\n");
      }

      // ── 2. Извлекаем импорты ──
      const fileImports: FileImports[] = [];
      const allExternalDeps = new Set<string>();
      const allResolvedNames = new Set<string>();

      for (const filePath of files) {
        const relPath = path.relative(directory, filePath).replace(/\\/g, "/");
        const imports = extractImports(filePath);
        if (imports.length > 0) {
          fileImports.push({
            filePath: relPath,
            module: getModule(relPath),
            imports,
          });
          for (const imp of imports) {
            if (imp.isExternal) {
              allExternalDeps.add(imp.resolvedName);
            }
            allResolvedNames.add(imp.resolvedName);
          }
        }
      }

      // ── 3. Загружаем существующие гранулы ──
      const granuleMap = new Map<string, { id: string; entityType: string; links: CodeLink[] }>();
      const nameToGranuleId = new Map<string, string>(); // entity_name → id

      try {
        const records = await mcp.search(
          project,
          config.userId,
          500,
          0.2,
          "code_knowledge"
        );
        for (const r of records) {
          const meta = r.metadata as Record<string, unknown>;
          if (meta?.project_id === project) {
            const entityName = String(meta.entity_name ?? "");
            const entityType = String(meta.entity_type ?? "");
            const rawLinks =
              (meta.links as Array<Record<string, unknown>>) || [];
            if (entityName) {
              granuleMap.set(entityName, {
                id: r.id,
                entityType,
                links: rawLinks.map((l) => ({
                  type: String(l.type || "") as CodeLink["type"],
                  target: String(l.target || ""),
                })),
              });
              nameToGranuleId.set(entityName, r.id);
            }
          }
        }
      } catch (err) {
        log.debug(`dependency_analyzer: ошибка search: ${err instanceof Error ? err.message : String(err)}`);
        log.warn(
          `dependency_analyzer: ошибка search: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ── 4. Строим отчёт и обновления ──
      const report: DependencyReport = {
        totalDeps: 0,
        externalDeps: [],
        internalDeps: 0,
        createdLinks: 0,
        updatedLinks: 0,
        errors: [],
      };

      // Собираем пары (from → to) с depends_on
      type DepPair = { fromFile: string; fromModule: string; targetName: string; isExternal: boolean };

      // Карта: targetName → набор fromEntityNames кто на него ссылается
      const usedByMap = new Map<string, Set<string>>();

      // Сначала собираем все depends_on пары
      const depPairs: DepPair[] = [];
      for (const fi of fileImports) {
        for (const imp of fi.imports) {
          depPairs.push({
            fromFile: fi.filePath,
            fromModule: fi.module,
            targetName: imp.resolvedName,
            isExternal: imp.isExternal,
          });
        }
      }

      // Ищем совпадения с существующими гранулами
      for (const dp of depPairs) {
        report.totalDeps++;

        if (dp.isExternal) {
          report.externalDeps.push(`${dp.fromFile} → ${dp.targetName} (npm)`);
          continue;
        }

        report.internalDeps++;

        // Есть ли гранула для fromFile? (по entity_name = имя модуля или файла)
        const fileBaseName = dp.fromFile
          .split("/")
          .pop()
          ?.replace(/\.\w+$/, "") || "";
        const fromGranule = granuleMap.get(dp.fromModule) || granuleMap.get(fileBaseName);

        const targetGranule = granuleMap.get(dp.targetName);

        if (targetGranule) {
          usedByMap.set(
            dp.targetName,
            (usedByMap.get(dp.targetName) || new Set()).add(
              fromGranule ? fileBaseName : dp.fromModule
            )
          );
        }
      }

      // ── 5. Создаём/обновляем depends_on и used_by связи ──
      const updates: Map<string, { id: string; links: CodeLink[] }> = new Map();

      for (const dp of depPairs) {
        if (dp.isExternal) continue;

        const fileBaseName = dp.fromFile
          .split("/")
          .pop()
          ?.replace(/\.\w+$/, "") || "";

        // Ищем гранулу модуля
        const moduleGranule = granuleMap.get(dp.fromModule);
        const targetGranule = granuleMap.get(dp.targetName);

        if (targetGranule) {
          // Добавляем depends_on к модулю (или файловой сущности)
          const sourceEntity = moduleGranule || granuleMap.get(fileBaseName);
          const sourceName = sourceEntity ? (moduleGranule ? dp.fromModule : fileBaseName) : null;

          if (sourceEntity && sourceName) {
            const hasDepLink = sourceEntity.links.some(
              (l) => l.type === "depends_on" && l.target === dp.targetName
            );

            if (!hasDepLink) {
              let entry = updates.get(sourceName);
              if (!entry) {
                entry = {
                  id: sourceEntity.id,
                  links: [...sourceEntity.links],
                };
                updates.set(sourceName, entry);
              }
              entry.links.push({
                type: "depends_on",
                target: dp.targetName,
                description: `import from ${dp.fromFile}`,
              });
              report.createdLinks++;
            }
          }

          // Добавляем used_by к target
          const hasUsedByLink = targetGranule.links.some(
            (l) =>
              l.type === "used_by" && l.target === (sourceEntity ? (moduleGranule ? dp.fromModule : fileBaseName) : dp.fromModule)
          );

          if (!hasUsedByLink) {
            const targetEntry = updates.get(dp.targetName) || {
              id: targetGranule.id,
              links: [...targetGranule.links],
            };
            if (!updates.has(dp.targetName)) {
              updates.set(dp.targetName, targetEntry);
            }
            targetEntry.links.push({
              type: "used_by",
              target: sourceEntity ? (moduleGranule ? dp.fromModule : fileBaseName) : dp.fromModule,
              description: `используется модулем ${dp.fromModule}`,
            });
            report.createdLinks++;
          }
        }
      }

      // ── 6. Применяем обновления ──
      for (const [entityName, update] of updates) {
        try {
          const metadata: Record<string, unknown> = {
            agent: "memory-granulator",
            session_id: context.sessionID || "dep_analyzer",
            project_id: project,
            title: entityName.slice(0, 80),
            message_ids: [],
            participants: ["memory-granulator", "dependency_analyzer"],
            entity_type: granuleMap.get(entityName)?.entityType || "module",
            entity_name: entityName,
            links: update.links as unknown as Record<string, unknown>[],
          };

          await mcp.update(update.id, undefined, metadata);
          report.updatedLinks++;
          log.debug(
            `dependency_analyzer: обновлён ${entityName} (${update.links.length} связей)`
          );
        } catch (err) {
          const errStr = err instanceof Error ? err.message : String(err);
          report.errors.push(`${entityName}: ${errStr}`);
          log.error(
            `dependency_analyzer: ошибка обновления ${entityName}: ${errStr}`
          );
        }
      }

      // ── 7. Формируем отчёт ──
      const reportLines: string[] = [
        `dependency_analyzer: сканирование завершено`,
        `  Проект: ${project}`,
        `  Файлов: ${files.length}`,
        `  Модулей с импортами: ${fileImports.length}`,
        `  Всего зависимостей: ${report.totalDeps}`,
        `  Внутренних: ${report.internalDeps}`,
        `  Внешних (npm): ${allExternalDeps.size}`,
      ];

      if (allExternalDeps.size > 0) {
        reportLines.push(`  Внешние пакеты:`);
        const sorted = Array.from(allExternalDeps).sort();
        for (const ext of sorted.slice(0, 20)) {
          reportLines.push(`    ${ext}`);
        }
        if (sorted.length > 20) {
          reportLines.push(`    ... и ещё ${sorted.length - 20}`);
        }
      }

      reportLines.push(
        `  Связей зависит_от: ${report.createdLinks}`,
        `  Гранул обновлено: ${report.updatedLinks}`
      );

      if (report.errors.length > 0) {
        reportLines.push(`  Ошибок: ${report.errors.length}`);
        for (const e of report.errors.slice(0, 5)) {
          reportLines.push(`    ${e}`);
        }
      }

      return reportLines.join("\n");
    },
  });
}
