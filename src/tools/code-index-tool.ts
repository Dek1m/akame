// ── Tool: code_index — сканирование проекта и индексация кода в athena-memory ──

import { tool } from "@opencode-ai/plugin";
import { MCPClient } from "../mcp/client.js";
import { scanProject } from "../scanner/code-index.js";
import type { CodeLink } from "../granulator/schema.js";
import type { AkameConfig } from "../constants.js";
import type { Logger } from "../logger.js";
import { resolveSafePath } from "../security/validate.js";

export function createCodeIndexTool(config: AkameConfig, log: Logger, workspaceDir: string, mcp: MCPClient) {
  return tool({
    description:
      "Scan project files and create code knowledge granules in athena-memory. " +
      "Extracts classes, interfaces, functions, types, and enums from TypeScript and Python files. " +
      "Creates module-level and entity-level granules with dependency links.",

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
      const caller = context?.agent || "unknown";
      if (caller !== "memory-granulator") {
        const errMsg = `Доступ запрещён: агент "${caller}" не имеет права вызывать code_index. Только memory-granulator (Тишь).`;
        log.warn(errMsg);
        throw new Error(errMsg);
      }

      const { project, directory: rawDir } = args;
      const directory = resolveSafePath(rawDir, workspaceDir);
      log.info(`code_index: начинаю сканирование ${project} в ${directory}`);

      // ── 1. Сканируем ──
      const result = scanProject(project, directory);
      log.info(
        `code_index: сканировано ${result.files.length} файлов`
      );

      // ── 2. Собираем существующие entity_name:project_id ──
      const existingKeys = new Set<string>();
      try {
        const found = await mcp.search(
          project,
          config.userId,
          500,
          0.2,
          "code_knowledge"
        );
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
        log.debug(`code_index: ошибка search: ${err instanceof Error ? err.message : String(err)}`);
        log.warn(
          `code_index: ошибка search: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      // ── 3. Собираем все имена для кросс-ссылок ──
      const allEntityNames = new Set<string>();
      for (const f of result.files) {
        for (const e of f.exports) allEntityNames.add(e.name);
      }

      // ── 4. Строим гранулы ──
      interface GranuleEntry {
        content: string;
        namespace: string;
        metadata: Record<string, unknown>;
      }

      const granules: GranuleEntry[] = [];
      let moduleCreated = 0;
      let entityCreated = 0;
      let skipped = 0;
      const processedModules = new Set<string>();

      for (const file of result.files) {
        // ── Модуль (один раз на модуль) ──
        if (!processedModules.has(file.module)) {
          processedModules.add(file.module);
          const key = `${file.module}:${project}`;
          if (!existingKeys.has(key)) {
            granules.push({
              content: `Модуль ${file.module} проекта ${project}. Содержит файлы: ${result.files
                .filter((f) => f.module === file.module)
                .map((f) => f.path)
                .join(", ")}`,
              namespace: "code_knowledge",
              metadata: {
                agent: "code_index",
                session_id: "code_index",
                project_id: project,
                title: `Модуль ${file.module}`.slice(0, 80),
                message_ids: [],
                participants: ["code_index"],
                entity_type: "module",
                entity_name: file.module,
                module_path: "-",
                source_location: "-",
              },
            });
            moduleCreated++;
          } else {
            skipped++;
          }
        }

        // ── Сущности ──
        for (const entity of file.exports) {
          const key = `${entity.name}:${project}`;
          if (existingKeys.has(key)) {
            skipped++;
            continue;
          }

          // Связи
          const links: CodeLink[] = [];
          links.push({
            type: "contained_by",
            target: file.module,
            description: `часть модуля ${file.module}`,
          });

          // depends_on по импортам (если имя совпадает с известной сущностью)
          for (const imp of file.imports) {
            const impBase =
              imp.split("/").pop()?.replace(/\.\w+$/, "") || "";
            if (allEntityNames.has(impBase)) {
              links.push({
                type: "depends_on",
                target: impBase,
                description: `import from ${imp}`,
              });
            }
          }

          // extends / implements
          if (entity.extends) {
            links.push({ type: "extends", target: entity.extends });
          }
          for (const impl of entity.implements ?? []) {
            links.push({ type: "implements", target: impl });
          }

          granules.push({
            content:
              `${entity.type} ${entity.name} — ${file.path}` +
              (entity.methods?.length
                ? `. Методы: ${entity.methods.join(", ")}`
                : ""),
            namespace: "code_knowledge",
            metadata: {
              agent: "code_index",
              session_id: "code_index",
              project_id: project,
              title: entity.name.slice(0, 80),
              message_ids: [],
              participants: ["code_index"],
              entity_type: entity.type,
              entity_name: entity.name,
              module_path: file.path,
              signature: entity.signature,
              source_location: entity.source_location,
              links: links as unknown as Record<string, unknown>[],
              ...(entity.methods?.length
                ? { methods: entity.methods }
                : {}),
            },
          });
          entityCreated++;
        }
      }

      // ── 5. Сохраняем батчами ──
      let totalInserted = 0;
      let totalSkippedByServer = 0;

      for (let i = 0; i < granules.length; i += config.maxBatch) {
        const batch = granules.slice(i, i + config.maxBatch);
        try {
          const res = await mcp.ingestBatch(batch, config.userId);
          totalInserted += res.inserted;
          totalSkippedByServer += res.skipped;
          log.debug(
            `code_index batch: ${res.inserted} вставлено, ${res.skipped} пропущено, ${res.updated} обновлено`
          );
        } catch (err) {
          log.error(
            `code_index batch error: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      const created = entityCreated + moduleCreated;
      const total = granules.length;

      return [
        `code_index: сканирование завершено`,
        `  Проект: ${project}`,
        `  Файлов просканировано: ${result.files.length}`,
        `  Гранул создано: ${created} (${moduleCreated} modules, ${entityCreated} entities)`,
        `  Пропущено (есть в памяти): ${skipped}`,
        `  Отправлено батчей: ${Math.ceil(granules.length / config.maxBatch)}, сохранено: ${totalInserted}, пропущено сервером: ${totalSkippedByServer}`,
        `  Всего гранул в батче: ${total}`,
      ].join("\n");
    },
  });
}
