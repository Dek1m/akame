// ── Tool: code_diff — анализ diff и создание code_knowledge гранул ──
// ДОСТУПЕН ТОЛЬКО агенту memory-granulator (Тишь).

import { tool } from "@opencode-ai/plugin";
import { MCPClient } from "../mcp/client.js";
import type { AkameConfig } from "../constants.js";
import type { Logger } from "../logger.js";
import type { CodeLink } from "../granulator/schema.js";

// ── Типы ──

interface DiffFile {
  path: string;
  addedLines: number;
  removedLines: number;
  hunks: DiffHunk[];
}

interface DiffHunk {
  header: string;
  added: string[];
  removed: string[];
}

interface DiffChange {
  entityType: string;
  entityName: string;
  action: "added" | "modified" | "removed";
  file: string;
  line: string;
  signature: string;
}

// ── Парсер unified diff ──

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of diff.split("\n")) {
    // Новый файл: diff --git a/... b/... или --- a/...
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      if (current) files.push(current);
      current = {
        path: fileMatch[2],
        addedLines: 0,
        removedLines: 0,
        hunks: [],
      };
      currentHunk = null;
      continue;
    }

    if (!current) continue;

    // Пропускаем мета-строки (индекс, ---, +++, old/new mode)
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename ") ||
      line.startsWith("copy ")
    ) {
      continue;
    }

    // Хедер ханка: @@ -a,b +c,d @@
    const hunkMatch = line.match(/^@@\s+-(?:\d+)(?:,\d+)?\s+\+(?:\d+)(?:,\d+)?\s+@@(.*)/);
    if (hunkMatch) {
      currentHunk = {
        header: line,
        added: [],
        removed: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    // Строки изменений
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.added.push(line.slice(1));
      current.addedLines++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.removed.push(line.slice(1));
      current.removedLines++;
    }
  }

  if (current) files.push(current);
  return files;
}

// ── Извлечение сущностей из строк diff ──

function extractChanges(
  file: DiffFile,
  project: string,
  filePath: string
): DiffChange[] {
  const changes: DiffChange[] = [];
  const allAdded = file.hunks.flatMap((h) => h.added);
  const allRemoved = file.hunks.flatMap((h) => h.removed);

  // Функции: export function ... | export const ... = (...) => | export default function
  for (const line of allAdded) {
    const fn = line.match(
      /^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/
    );
    if (fn) {
      changes.push({
        entityType: "function",
        entityName: fn[1],
        action: "added",
        file: filePath,
        line: line.trim(),
        signature: line.trim(),
      });
      continue;
    }

    const cf = line.match(
      /^export\s+(?:default\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?[(<]/
    );
    if (cf) {
      changes.push({
        entityType: "function",
        entityName: cf[1],
        action: "added",
        file: filePath,
        line: line.trim(),
        signature: line.trim(),
      });
      continue;
    }
  }

  // Классы: export class ... | export default class ... | export abstract class
  for (const line of allAdded) {
    const cls = line.match(
      /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/
    );
    if (cls) {
      const ext = line.match(/extends\s+(\w+)/);
      const impl = line.match(/implements\s+([\w\s,]+)/);
      changes.push({
        entityType: "class",
        entityName: cls[1],
        action: "added",
        file: filePath,
        line: line.trim(),
        signature:
          `class ${cls[1]}` +
          (ext ? ` extends ${ext[1]}` : "") +
          (impl
            ? ` implements ${impl[1].split(",").map((x) => x.trim()).join(", ")}`
            : ""),
      });
      continue;
    }
  }

  // Интерфейсы
  for (const line of allAdded) {
    const ifc = line.match(/^export\s+(?:default\s+)?interface\s+(\w+)/);
    if (ifc) {
      changes.push({
        entityType: "interface",
        entityName: ifc[1],
        action: "added",
        file: filePath,
        line: line.trim(),
        signature: line.trim(),
      });
      continue;
    }
  }

  // Типы
  for (const line of allAdded) {
    const tp = line.match(/^export\s+type\s+(\w+)/);
    if (tp) {
      changes.push({
        entityType: "type",
        entityName: tp[1],
        action: "added",
        file: filePath,
        line: line.trim(),
        signature: line.trim(),
      });
      continue;
    }
  }

  // Enum
  for (const line of allAdded) {
    const en = line.match(/^export\s+(?:const\s+)?enum\s+(\w+)/);
    if (en) {
      changes.push({
        entityType: "enum",
        entityName: en[1],
        action: "added",
        file: filePath,
        line: line.trim(),
        signature: line.trim(),
      });
      continue;
    }
  }

  // Удалённые сущности — проверяем removed строки
  for (const line of allRemoved) {
    const fn = line.match(
      /^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/
    );
    const cf = line.match(
      /^export\s+(?:default\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?[(<]/
    );
    const cls = line.match(
      /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/
    );
    const ifc = line.match(/^export\s+(?:default\s+)?interface\s+(\w+)/);
    const tp = line.match(/^export\s+type\s+(\w+)/);
    const en = line.match(/^export\s+(?:const\s+)?enum\s+(\w+)/);

    const match = fn || cf || cls || ifc || tp || en;
    if (match) {
      let entityType = "function";
      if (cls) entityType = "class";
      else if (ifc) entityType = "interface";
      else if (tp) entityType = "type";
      else if (en) entityType = "enum";

      changes.push({
        entityType,
        entityName: match[1],
        action: "removed",
        file: filePath,
        line: line.trim(),
        signature: line.trim(),
      });
    }
  }

  return changes;
}

// ── Фабрика тула ──

export function createCodeDiffTool(config: AkameConfig, log: Logger, mcp: MCPClient) {
  return tool({
    description:
      "[ТОЛЬКО ДЛЯ memory-granulator] Проанализировать diff кода и создать code_knowledge гранулы.",

    args: {
      project: tool.schema
        .string()
        .describe("Project name (e.g. 'akame')"),

      diff: tool.schema
        .string()
        .describe("Unified diff string to analyze"),

      commitHash: tool.schema
        .string()
        .optional()
        .describe("Commit hash for context (optional)"),
    },

    async execute(args, context) {
      // ── Защита ──
      const caller = context.agent || "unknown";
      if (caller !== "memory-granulator") {
        const errMsg = `Доступ запрещён: агент "${caller}" не имеет права вызывать code_diff. Только memory-granulator (Тишь).`;
        log.warn(errMsg);
        throw new Error(errMsg);
      }

      const { project, diff, commitHash } = args;
      log.info(
        `code_diff: анализ diff для ${project}${commitHash ? ` (commit: ${commitHash.slice(0, 7)})` : ""}`
      );

      // ── 1. Парсим diff ──
      if (!diff || diff.trim().length === 0) {
        return "code_diff: пустой diff, нечего анализировать";
      }

      const diffFiles = parseDiff(diff);
      log.info(
        `code_diff: найдено ${diffFiles.length} изменённых файлов`
      );

      // ── 2. Извлекаем изменения ──
      const allChanges: DiffChange[] = [];
      for (const file of diffFiles) {
        const changes = extractChanges(file, project, file.path);
        allChanges.push(...changes);
      }

      if (allChanges.length === 0) {
        const stats = diffFiles
          .map(
            (f) =>
              `  ${f.path}: +${f.addedLines}/-${f.removedLines} строк`
          )
          .join("\n");
        return [
          `code_diff: анализ завершён (нет структурных изменений)`,
          `  Проект: ${project}`,
          `  Файлов изменено: ${diffFiles.length}`,
          `  Всего строк: +${diffFiles.reduce((s, f) => s + f.addedLines, 0)}/-${diffFiles.reduce((s, f) => s + f.removedLines, 0)}`,
          stats,
        ].join("\n");
      }

      // ── 3. Собираем существующие entity_name для дедупликации ──
      const existingKeys = new Set<string>();
      try {
        const found = await mcp.search(project, config.userId, 500, 0.2, "code_knowledge");
        for (const r of found) {
          const meta = r.metadata as Record<string, unknown>;
          if (
            meta?.entity_name &&
            meta?.project_id === project
          ) {
            existingKeys.add(
              `${String(meta.entity_name)}:${String(meta.project_id)}`
            );
          }
        }
      } catch (err) {
        log.warn(
          `code_diff: ошибка search: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ── 4. Строим гранулы ──
      interface GranuleEntry {
        content: string;
        namespace: string;
        metadata: Record<string, unknown>;
      }

      const granules: GranuleEntry[] = [];
      let entityCreated = 0;
      let skipped = 0;

      // Гранула-сводка о diff целиком
      granules.push({
        content: [
          `Diff для проекта ${project}` +
            (commitHash ? ` (commit: ${commitHash})` : ""),
          `Файлов изменено: ${diffFiles.length}`,
          `Структурных изменений: ${allChanges.length}`,
          "",
          "Файлы:",
          ...diffFiles.map(
            (f) => `  ${f.path}: +${f.addedLines}/-${f.removedLines}`
          ),
        ].join("\n"),
        namespace: "code_knowledge",
        metadata: {
          agent: "memory-granulator",
          session_id: context.sessionID || "code_diff",
          project_id: project,
          title: `Diff: ${diffFiles.length} файлов (${allChanges.length} изменений)`.slice(0, 80),
          message_ids: [],
          participants: ["memory-granulator", "code_diff"],
          entity_type: "change",
          entity_name: commitHash
            ? `diff_${commitHash.slice(0, 7)}`
            : `diff_${Date.now()}`,
          module_path: "-",
          source_location: "-",
        },
      });

      // Гранулы для каждого изменения
      for (const change of allChanges) {
        const key = `${change.entityName}:${project}`;
        if (existingKeys.has(key) && change.action !== "removed") {
          skipped++;
          continue;
        }

        const links: CodeLink[] = [];

        // Связь с файлом
        const fileModule = change.file
          .split("/")[0]
          ?.replace(/\.\w+$/, "") ||
          "root";
        links.push({
          type: "contained_by",
          target: fileModule,
          description: `часть модуля ${fileModule} (файл ${change.file})`,
        });

        // Для removed помечаем как deprecated
        const deprecated = change.action === "removed" ? true : undefined;

        granules.push({
          content: [
            `${change.entityType} ${change.entityName} — ${change.action} в файле ${change.file}`,
            change.signature ? `Сигнатура: ${change.signature}` : "",
            commitHash ? `Commit: ${commitHash}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          namespace: "code_knowledge",
          metadata: {
            agent: "memory-granulator",
            session_id: context.sessionID || "code_diff",
            project_id: project,
            title: `${change.action}: ${change.entityType} ${change.entityName}`.slice(0, 80),
            message_ids: [],
            participants: ["memory-granulator", "code_diff"],
            entity_type: change.entityType,
            entity_name: change.entityName,
            module_path: change.file,
            signature: change.signature,
            source_location: `L${change.line.slice(0, 60)}`,
            links: links as unknown as Record<string, unknown>[],
            ...(deprecated !== undefined ? { is_deprecated: deprecated } : {}),
          },
        });
        entityCreated++;
      }

      // ── 5. Сохраняем ──
      let totalInserted = 0;
      let totalSkippedByServer = 0;

      for (let i = 0; i < granules.length; i += config.maxBatch) {
        const batch = granules.slice(i, i + config.maxBatch);
        try {
          const res = await mcp.ingestBatch(batch, config.userId);
          totalInserted += res.inserted;
          totalSkippedByServer += res.skipped;
          log.debug(
            `code_diff batch: ${res.inserted} вставлено, ${res.skipped} пропущено`
          );
        } catch (err) {
          log.error(
            `code_diff batch error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const added = allChanges.filter((c) => c.action === "added").length;
      const removed = allChanges.filter((c) => c.action === "removed").length;
      const modified = allChanges.filter(
        (c) => c.action === "modified"
      ).length;

      return [
        `code_diff: анализ завершён`,
        `  Проект: ${project}`,
        `  Файлов изменено: ${diffFiles.length}`,
        `  Изменений: +${added} добавлено, ~${modified} изменено, -${removed} удалено`,
        `  Гранул создано: ${entityCreated + 1} (1 сводка + ${entityCreated} сущностей)`,
        `  Пропущено (есть в памяти): ${skipped}`,
        `  Сохранено: ${totalInserted}, пропущено сервером: ${totalSkippedByServer}`,
      ].join("\n");
    },
  });
}
