// ── Tool: migrate_legacy_granules — миграция старых гранул code_knowledge ──
// Находит записи без entity_name и обогащает их:
//   entity_type, entity_name, module_path — из контента, title — из существующего.
// Поддерживает русскоязычный и англоязычный контент.
// Доступен memory-granulator (Тишь) и любому агенту с явным разрешением.

import { tool } from "@opencode-ai/plugin";
import { MCPClient } from "../mcp/client.js";
import type { MemoryRecord } from "../mcp/client.js";
import type { AkameConfig } from "../constants.js";
import type { Logger } from "../logger.js";
import type { CodeLink } from "../granulator/schema.js";

// ── Константы ──

const PAGE_SIZE = 50; // записей за один list-запрос
const UPDATE_BATCH = 10; // обновлений за раз

// ── Типы ──

interface MigrationResult {
  totalScanned: number;
  legacyFound: number;
  migrated: number;
  skipped: number;
  errors: string[];
  dryRun: boolean;
}

// ── Проверка: запись старая? ──

function isLegacy(record: MemoryRecord): boolean {
  const meta = record.metadata as Record<string, unknown>;
  return !meta?.entity_name || !meta?.entity_type;
}

// ── Извлечение entity_type ──

type ExtractedInfo = {
  entityType: string | null;
  entityName: string | null;
  modulePath: string | null;
};

function extractFromContent(content: string, title: string): ExtractedInfo {
  const s = content.trim();

  // ── Английские паттерны (приоритет — точнее) ──

  // class Foo — path/to/file.ts
  const clsEn = s.match(
    /^(?:export\s+(?:default\s+)?(?:abstract\s+)?)?class\s+(\w+)\b/
  );
  if (clsEn) {
    const mp = extractPath(s);
    return { entityType: "class", entityName: clsEn[1], modulePath: mp };
  }

  // function foo — path/to/file.ts
  const fnEn = s.match(
    /^(?:export\s+(?:default\s+)?(?:async\s+)?)?function\s+(\w+)\b/
  );
  if (fnEn) {
    const mp = extractPath(s);
    return { entityType: "function", entityName: fnEn[1], modulePath: mp };
  }

  // interface Foo — path/to/file.ts
  const ifcEn = s.match(/^(?:export\s+(?:default\s+)?)?interface\s+(\w+)\b/);
  if (ifcEn) {
    const mp = extractPath(s);
    return { entityType: "interface", entityName: ifcEn[1], modulePath: mp };
  }

  // type Foo — path/to/file.ts  (но не typeof)
  const tpEn = s.match(/^(?:export\s+)?type\s+(\w+)\b/);
  if (tpEn && !s.startsWith("type EntityType")) {
    const mp = extractPath(s);
    return { entityType: "type", entityName: tpEn[1], modulePath: mp };
  }

  // enum Foo — path/to/file.ts
  const enEn = s.match(/^(?:export\s+(?:const\s+)?)?enum\s+(\w+)\b/);
  if (enEn) {
    const mp = extractPath(s);
    return { entityType: "enum", entityName: enEn[1], modulePath: mp };
  }

  // ── Русские паттерны ──

  // класс Foo
  const clsRu = s.match(/класс\s+(\w+)/i);
  if (clsRu) {
    return { entityType: "class", entityName: clsRu[1], modulePath: extractPath(s) };
  }

  // функция Foo
  const fnRu = s.match(/функци[яи]\s+(\w+)/i);
  if (fnRu) {
    return { entityType: "function", entityName: fnRu[1], modulePath: extractPath(s) };
  }

  // модуль Foo
  const modRu = s.match(/[Мм]одуль\s+(\w+)/i);
  if (modRu) {
    return { entityType: "module", entityName: modRu[1], modulePath: extractPath(s) || "-" };
  }

  // интерфейс Foo
  const ifcRu = s.match(/интерфейс\s+(\w+)/i);
  if (ifcRu) {
    return { entityType: "interface", entityName: ifcRu[1], modulePath: extractPath(s) };
  }

  // тип Foo (но осторожно — слово "тип" частотно)
  const tpRu = s.match(/^тип\s+(\w+)/i);
  if (tpRu) {
    return { entityType: "type", entityName: tpRu[1], modulePath: extractPath(s) };
  }

  // ── Паттерны по ключевым словам ──

  if (/\b(?:архитектур(?:ный|а|ное|ные)\s+(?:паттерн|решение|слой)|архитектура\s+проекта|architecture|architectural pattern)\b/i.test(s)) {
    return { entityType: "architecture", entityName: extractArchitectureName(s, title), modulePath: extractPath(s) || "-" };
  }

  if (/\b(?:конфигураци[яи]|конфиг|config(?:uration)?|settings)\b/i.test(s) && /\b(?:настро[ей]к|параметр|переменн|\.env)/i.test(s)) {
    return { entityType: "config", entityName: extractNameFromTitle(title) || extractFirstCap(s), modulePath: extractPath(s) || "-" };
  }

  if (/\b(?:изменени[яийе]|change|обновл(?:ени[ея]|ён)|добавлен|реализаци[яи])\b/i.test(s)) {
    return { entityType: "change", entityName: extractNameFromTitle(title) || extractFirstCap(s), modulePath: extractPath(s) || "-" };
  }

  if (/\b(?:тест(?:ов|ировани[ея])?|test(?:\s+suite)?)\b/i.test(s) && /\b(?:passed|failed|покрыти[ея]|файлов)\b/i.test(s)) {
    return { entityType: "test", entityName: extractNameFromTitle(title) || extractFirstCap(s), modulePath: extractPath(s) || "-" };
  }

  if (/\bSQL[- ]запрос|sql_query|SELECT\b/i.test(s)) {
    return { entityType: "sql_query", entityName: extractNameFromTitle(title) || "sql_query", modulePath: extractPath(s) || "-" };
  }

  if (/\bтаблица|table\b/i.test(s) && /\b(?:колонк|столб(?:ец|цы)|column|CREATE\s+TABLE)\b/i.test(s)) {
    return { entityType: "table", entityName: extractNameFromTitle(title) || "table", modulePath: extractPath(s) || "-" };
  }

  if (/\b(?:проект|project)\s+\w+[:—–-]/i.test(s)) {
    return { entityType: "module", entityName: extractNameFromTitle(title) || extractFirstCap(s), modulePath: extractPath(s) || "-" };
  }

  // ── Fallback: пробуем title ──

  const fromTitle = extractNameFromTitle(title);
  if (fromTitle) {
    return { entityType: "unknown", entityName: fromTitle, modulePath: extractPath(s) || "-" };
  }

  return { entityType: null, entityName: null, modulePath: extractPath(s) || "-" };
}

// ── Helpers ──

function extractPath(content: string): string | null {
  // src/foo/bar.ts, tests/foo/bar.test.ts, docs/FOO.md
  const m = content.match(/((?:src|tests|docs)\/[^\s,.;:]+\.(?:ts|tsx|js|jsx|py|md|sql))/i);
  if (m) return m[1];

  // "файле path", "module_path=path", "-- path"
  const m2 = content.match(/(?:файл[е]?|module_path[=:]|—)\s*([^\s]+\.[\w]+)/i);
  if (m2) return m2[1];

  return null;
}

function extractArchitectureName(content: string, title: string): string {
  // Попробуем найти имя паттерна: "Pattern Name", "Название паттерна"
  const m = content.match(
    /(?:паттерн|pattern|архитектур)[:\s]+(\w[\w\s-]{2,40}?)(?:,|\.|$|\s+—)/i
  );
  if (m) return m[1].trim();

  return extractNameFromTitle(title) || "architecture";
}

function extractNameFromTitle(title: string): string | null {
  if (!title || title.length < 2) return null;
  // Берём первые 2-3 слова, обрезаем до разумного имени
  const cleaned = title
    .replace(/^[:\s—–-]+|[:\s—–-]+$/g, "")
    .slice(0, 60);
  return cleaned || null;
}

function extractFirstCap(content: string): string {
  const m = content.match(/\b([A-ZА-ЯЁ][\wА-ЯЁ]+)/);
  return m ? m[1] : "unknown";
}

// ── Построение links ──

function buildLinks(content: string, entityName: string): CodeLink[] {
  const links: CodeLink[] = [];
  const seen = new Set<string>();

  // Ищем упоминания известных сущностей (с большой буквы, 2+ символа)
  const mentioned = content.match(/\b([A-ZА-ЯЁ]\w{1,40})\b/g);
  if (mentioned) {
    for (const name of mentioned) {
      const n = name.toLowerCase();
      if (n === entityName.toLowerCase()) continue;
      if (seen.has(n)) continue;
      if (/^(?:The|This|And|For|With|From|Into|New|All|One|Module|Class|Function|Interface|Type|Enum|Config|Test|Change|SQL|API|HTTP|JSON|MCP|LLM|CI|CD|TS|JS|PY|UUID|PK|ID|URL|SSH|PAT|HNSW|TTL|SHA|MD|CSS|HTML|XML|YAML|TOML)$/i.test(n)) continue;
      seen.add(n);
      links.push({ type: "related_to", target: name, description: `упоминается в контенте` });
      if (links.length >= 5) break;
    }
  }

  return links;
}

// ── Миграция одной записи ──

async function migrateOne(
  record: MemoryRecord,
  mcp: MCPClient,
  log: Logger,
  dryRun: boolean
): Promise<{ migrated: boolean; error: string | null }> {
  const meta = record.metadata as Record<string, unknown>;
  const content = record.content;
  const title = (meta?.title as string) || "";

  const { entityType, entityName, modulePath } = extractFromContent(content, title);

  if (!entityType || !entityName) {
    return {
      migrated: false,
      error: `не удалось извлечь entity_type/entity_name из: "${content.slice(0, 80)}"`,
    };
  }

  const links = buildLinks(content, entityName);

  const newMetadata: Record<string, unknown> = {
    ...meta,
    entity_type: entityType,
    entity_name: entityName,
    module_path: modulePath || "-",
    ...(links.length > 0
      ? { links: links as unknown as Record<string, unknown>[] }
      : {}),
    // Сохраняем существующие поля, если есть
    ...(meta?.agent ? {} : { agent: "migrate_legacy" }),
    ...(meta?.session_id ? {} : { session_id: "migrate_legacy" }),
    ...(meta?.project_id ? {} : { project_id: "akame" }),
    ...(meta?.title ? {} : { title: entityName.slice(0, 80) }),
    ...(meta?.message_ids ? {} : { message_ids: [] }),
    ...(meta?.participants ? {} : { participants: ["migrate_legacy"] }),
  };

  if (dryRun) {
    log.info(
      `[dry-run] ${record.id.slice(0, 8)}: ${entityType} ${entityName} (${modulePath || "-"})`
    );
    return { migrated: true, error: null };
  }

  try {
    await mcp.update(record.id, undefined, newMetadata);
    log.debug(
      `мигрирована: ${record.id.slice(0, 8)} → ${entityType} ${entityName}`
    );
    return { migrated: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { migrated: false, error: `${record.id.slice(0, 8)}: ${msg}` };
  }
}

// ── Фабрика тула ──

export function createMigrateLegacyGranulesTool(config: AkameConfig, log: Logger) {
  const mcp = new MCPClient(config);

  return tool({
    description:
      "Мигрировать старые гранулы code_knowledge в новый формат. " +
      "Находит записи без entity_name, извлекает entity_type/entity_name/module_path из контента " +
      "и обновляет их через memory_update. Поддерживает --dry-run.",

    args: {
      namespace: tool.schema
        .string()
        .optional()
        .default("code_knowledge")
        .describe("Namespace для миграции (по умолчанию code_knowledge)"),

      dryRun: tool.schema
        .boolean()
        .optional()
        .default(false)
        .describe("Если true — только показать, что будет изменено, без реальных обновлений"),

      maxRecords: tool.schema
        .string()
        .optional()
        .default("0")
        .describe("Максимум записей для миграции (0 = без лимита)"),
    },

    async execute(args, context) {
      const caller = context.agent || "unknown";
      if (caller !== "memory-granulator" && caller !== "user") {
        const errMsg = `Доступ запрещён: агент "${caller}" не имеет права вызывать migrate_legacy_granules.`;
        log.warn(errMsg);
        throw new Error(errMsg);
      }

      const ns = args.namespace as string;
      const dryRun = args.dryRun as boolean;
      const maxRecords = parseInt(String(args.maxRecords || "0"), 10) || 0;

      log.info(
        `migrate_legacy: начало миграции namespace=${ns}, dryRun=${dryRun}`
      );

      const result: MigrationResult = {
        totalScanned: 0,
        legacyFound: 0,
        migrated: 0,
        skipped: 0,
        errors: [],
        dryRun,
      };

      // ── 1. Собираем все записи пагинацией ──
      let offset = 0;
      let totalInNs = 0;

      try {
        const firstPage = await mcp.list(undefined, ns, 1, 0);
        totalInNs = firstPage.total;
      } catch (err) {
        result.errors.push(
          `Ошибка list: ${err instanceof Error ? err.message : String(err)}`
        );
        return formatResult(result);
      }

      log.info(
        `migrate_legacy: namespace ${ns} содержит ${totalInNs} записей`
      );

      // ── 2. Сканируем все записи, собираем legacy ──
      const legacyRecords: MemoryRecord[] = [];

      while (offset < totalInNs) {
        try {
          const page = await mcp.list(undefined, ns, PAGE_SIZE, offset);
          result.totalScanned += page.items.length;

          for (const record of page.items) {
            if (isLegacy(record)) {
              legacyRecords.push(record);
            }
          }

          offset += PAGE_SIZE;

          if (maxRecords > 0 && legacyRecords.length >= maxRecords) {
            break;
          }
        } catch (err) {
          result.errors.push(
            `Ошибка list offset=${offset}: ${err instanceof Error ? err.message : String(err)}`
          );
          break;
        }
      }

      result.legacyFound = legacyRecords.length;
      log.info(
        `migrate_legacy: просканировано ${result.totalScanned}, найдено legacy: ${result.legacyFound}`
      );

      if (legacyRecords.length === 0) {
        result.errors.push("Не найдено записей для миграции (все уже в новом формате)");
        return formatResult(result);
      }

      // ── 3. Мигрируем батчами ──
      for (let i = 0; i < legacyRecords.length; i += UPDATE_BATCH) {
        const batch = legacyRecords.slice(i, i + UPDATE_BATCH);
        const results = await Promise.all(
          batch.map((r) => migrateOne(r, mcp, log, dryRun))
        );

        for (const r of results) {
          if (r.migrated) {
            result.migrated++;
          } else {
            result.skipped++;
            if (r.error) result.errors.push(r.error);
          }
        }

        // Небольшая пауза между батчами чтобы не нагружать сервер
        if (!dryRun && i + UPDATE_BATCH < legacyRecords.length) {
          await sleep(100);
        }
      }

      return formatResult(result);
    },
  });
}

// ── Форматирование результата ──

function formatResult(result: MigrationResult): string {
  const lines = [
    `migrate_legacy: миграция завершена${result.dryRun ? " (dry-run)" : ""}`,
    `  Просканировано: ${result.totalScanned}`,
    `  Найдено legacy: ${result.legacyFound}`,
    `  Мигрировано: ${result.migrated}`,
    `  Пропущено/ошибок: ${result.skipped}`,
  ];

  if (result.errors.length > 0) {
    const maxErr = result.dryRun ? 10 : 20;
    lines.push(`  Ошибки (первые ${Math.min(result.errors.length, maxErr)}):`);
    for (const e of result.errors.slice(0, maxErr)) {
      lines.push(`    ${e}`);
    }
    if (result.errors.length > maxErr) {
      lines.push(`    ... и ещё ${result.errors.length - maxErr}`);
    }
  }

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
