// ── Tool: graph_health — верификация здоровья графа знаний ──
// ДОСТУПЕН ТОЛЬКО агенту memory-granulator (Тишь).
// Анализирует связность гранул, сирот, дубликаты, cross-namespace связи.

import { tool } from "@opencode-ai/plugin";
import { MCPClient } from "../mcp/client.js";
import type { MemoryRecord } from "../mcp/client.js";
import type { AkameConfig } from "../constants.js";
import { NAMESPACES } from "../constants.js";
import type { Logger } from "../logger.js";
import type { CodeLink } from "../granulator/schema.js";

// ── Константы ──

const PAGE_SIZE = 50;
const TOP_CRITICAL_ORPHANS = 10;

// ── Типы для статистики ──

interface NamespaceStats {
  total: number;
  linked: number;
  orphan: number;
  linkedPct: number;
}

interface CrossNsEntry {
  from: string;
  to: string;
  count: number;
}

interface CriticalOrphan {
  namespace: string;
  entityName: string;
  importance: number;
}

interface DuplicateGroup {
  namespace: string;
  entityName: string;
  count: number;
}

// ── Вспомогательные функции ──

async function collectAllGranules(
  mcp: MCPClient,
  log: Logger
): Promise<MemoryRecord[]> {
  const all: MemoryRecord[] = [];

  for (const ns of NAMESPACES) {
    try {
      const page1 = await mcp.list(undefined, ns, 1, 0);
      log.debug(`graph_health: ${ns} содержит ${page1.total} записей`);

      let offset = 0;
      while (offset < page1.total) {
        const page = await mcp.list(undefined, ns, PAGE_SIZE, offset);
        all.push(...page.items);
        offset += PAGE_SIZE;
      }
    } catch (err) {
      log.error(
        `graph_health: ошибка list ${ns} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return all;
}

function extractLinks(meta: Record<string, unknown>): CodeLink[] {
  const raw = meta?.links;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (l): l is Record<string, unknown> =>
        typeof l === "object" && l !== null
    )
    .map((l) => ({
      type: String(l.type ?? "related_to"),
      target: String(l.target ?? ""),
      description: l.description
        ? String(l.description)
        : undefined,
    })) as CodeLink[];
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ── Фабрика тула ──

export function createGraphHealthTool(config: AkameConfig, log: Logger) {
  const mcp = new MCPClient(config);

  return tool({
    description:
      "[ТОЛЬКО ДЛЯ memory-granulator] Проверить здоровье графа знаний. " +
      "Анализирует связность, сирот, дубликаты и cross-namespace связи.",

    args: {
      project: tool.schema
        .string()
        .describe("Project name (e.g. 'akame')"),

      verbose: tool.schema
        .boolean()
        .optional()
        .describe("Если true — показывает первые 20 сирот каждого namespace"),
    },

    async execute(args, context) {
      // ── Защита ──
      const caller = context.agent || "unknown";
      if (caller !== "memory-granulator") {
        const errMsg = `Доступ запрещён: агент "${caller}" не имеет права вызывать graph_health. Только memory-granulator (Тишь).`;
        log.warn(errMsg);
        throw new Error(errMsg);
      }

      const { project, verbose } = args;
      log.info(`graph_health: анализ для ${project}`);

      // ── 1. Собираем все гранулы ──
      const allGranules = await collectAllGranules(mcp, log);

      if (allGranules.length === 0) {
        return `graph_health: граф пуст — гранул не найдено`;
      }

      log.info(
        `graph_health: собрано ${allGranules.length} гранул`
      );

      // ── 2. Строим lookup-таблицы ──
      const idToGranule = new Map<string, MemoryRecord>();
      const nameToNs = new Map<string, string>(); // entity_name → namespace (first occurrence)

      for (const g of allGranules) {
        idToGranule.set(g.id, g);
        const meta = g.metadata as Record<string, unknown>;
        const ename = String(meta?.entity_name ?? "");
        if (ename && !nameToNs.has(ename)) {
          nameToNs.set(ename, g.namespace);
        }
      }

      // ── 3. Статистика по namespace: linked vs orphan ──
      const nsStats: Record<string, NamespaceStats> = {};
      const nsGranules: Record<string, MemoryRecord[]> = {};

      for (const ns of NAMESPACES) {
        nsGranules[ns] = [];
      }

      for (const g of allGranules) {
        if (nsGranules[g.namespace]) {
          nsGranules[g.namespace].push(g);
        }
      }

      // Собираем множество ID гранул, на которые кто-то ссылается (входящие связи)
      const hasIncoming = new Set<string>();
      const crossNsMap = new Map<string, number>(); // "from→to"

      for (const g of allGranules) {
        const links = extractLinks(g.metadata as Record<string, unknown>);
        for (const link of links) {
          // Резолвим target namespace
          let targetNs: string | null = null;
          if (isUuid(link.target)) {
            const targetGranule = idToGranule.get(link.target);
            if (targetGranule) {
              targetNs = targetGranule.namespace;
              hasIncoming.add(link.target);
            }
          } else {
            targetNs = nameToNs.get(link.target) ?? null;
            if (targetNs) {
              // Находим ID гранулы по имени
              for (const tg of nsGranules[targetNs] ?? []) {
                const tmeta = tg.metadata as Record<string, unknown>;
                if (String(tmeta?.entity_name ?? "") === link.target) {
                  hasIncoming.add(tg.id);
                }
              }
            }
          }

          // Cross-namespace статистика
          if (targetNs && targetNs !== g.namespace) {
            const key = `${g.namespace}→${targetNs}`;
            crossNsMap.set(key, (crossNsMap.get(key) ?? 0) + 1);
          }
        }
      }

      for (const ns of NAMESPACES) {
        const granules = nsGranules[ns] ?? [];
        let linked = 0;
        let orphan = 0;

        for (const g of granules) {
          const links = extractLinks(
            g.metadata as Record<string, unknown>
          );
          const hasOutgoing = links.length > 0;
          const hasInc = hasIncoming.has(g.id);

          if (hasOutgoing || hasInc) {
            linked++;
          } else {
            orphan++;
          }
        }

        nsStats[ns] = {
          total: granules.length,
          linked,
          orphan,
          linkedPct:
            granules.length > 0
              ? Math.round((linked / granules.length) * 100)
              : 0,
        };
      }

      // ── 4. Cross-namespace матрица ──
      const crossNsLinks: CrossNsEntry[] = [];
      for (const [key, count] of crossNsMap) {
        const [from, to] = key.split("→");
        crossNsLinks.push({ from, to, count });
      }
      crossNsLinks.sort((a, b) => b.count - a.count);

      // ── 5. Критичные сироты (importance ≥ 3 без связей) ──
      const criticalOrphans: CriticalOrphan[] = [];

      for (const ns of NAMESPACES) {
        for (const g of nsGranules[ns] ?? []) {
          const meta = g.metadata as Record<string, unknown>;
          const importance = Number(meta?.importance ?? 3);
          const links = extractLinks(meta);
          const hasOutgoing = links.length > 0;
          const hasInc = hasIncoming.has(g.id);

          if (!hasOutgoing && !hasInc && importance >= 3) {
            criticalOrphans.push({
              namespace: ns,
              entityName: String(meta?.entity_name ?? meta?.title ?? g.id.slice(0, 8)),
              importance,
            });
          }
        }
      }
      criticalOrphans.sort((a, b) => b.importance - a.importance);

      // ── 6. Среднее связей на гранулу ──
      let totalLinks = 0;
      for (const g of allGranules) {
        totalLinks += extractLinks(
          g.metadata as Record<string, unknown>
        ).length;
      }
      const avgLinks =
        allGranules.length > 0
          ? Math.round((totalLinks / allGranules.length) * 10) / 10
          : 0;

      // ── 7. Дубликаты (одинаковый entity_name в одном namespace) ──
      const entityCounts = new Map<string, { ns: string; count: number }>();
      for (const ns of NAMESPACES) {
        for (const g of nsGranules[ns] ?? []) {
          const meta = g.metadata as Record<string, unknown>;
          const ename = String(meta?.entity_name ?? "");
          if (!ename) continue;
          const key = `${ns}:${ename}`;
          const existing = entityCounts.get(key);
          if (existing) {
            existing.count++;
          } else {
            entityCounts.set(key, { ns, count: 1 });
          }
        }
      }

      const duplicates: DuplicateGroup[] = [];
      for (const [key, { ns, count }] of entityCounts) {
        if (count > 1) {
          const ename = key.slice(ns.length + 1);
          duplicates.push({ namespace: ns, entityName: ename, count });
        }
      }
      duplicates.sort((a, b) => b.count - a.count);

      // ── 8. Формируем отчёт ──
      const lines: string[] = [
        `graph_health: отчёт о здоровье графа знаний`,
        `  Проект: ${project}`,
        `  Всего гранул: ${allGranules.length}`,
        ``,
        `  По namespace:`,
      ];

      for (const ns of NAMESPACES) {
        const s = nsStats[ns];
        if (!s) continue;
        lines.push(
          `    ${ns}: ${s.total} гранул (${s.linkedPct}% связаны, ${s.orphan} сирот)`
        );

        if (verbose && s.orphan > 0) {
          const orphanGranules = (nsGranules[ns] ?? [])
            .filter((g) => {
              const links = extractLinks(
                g.metadata as Record<string, unknown>
              );
              return links.length === 0 && !hasIncoming.has(g.id);
            })
            .slice(0, 20);

          for (const og of orphanGranules) {
            const ometa = og.metadata as Record<string, unknown>;
            lines.push(
              `      - ${String(ometa?.entity_name ?? ometa?.title ?? og.id.slice(0, 8))}`
            );
          }
        }
      }

      // Cross-namespace
      if (crossNsLinks.length > 0) {
        lines.push(``);
        lines.push(`  Cross-namespace связи:`);
        for (const entry of crossNsLinks) {
          lines.push(
            `    ${entry.from} → ${entry.to}: ${entry.count}`
          );
        }
      }

      // Критичные сироты
      if (criticalOrphans.length > 0) {
        lines.push(``);
        lines.push(
          `  Топ-${Math.min(TOP_CRITICAL_ORPHANS, criticalOrphans.length)} критичных сирот (importance ≥ 3):`
        );
        for (const co of criticalOrphans.slice(0, TOP_CRITICAL_ORPHANS)) {
          lines.push(
            `    [${co.namespace}] ${co.entityName} (importance=${co.importance})`
          );
        }
      } else {
        lines.push(``);
        lines.push(`  Критичных сирот: 0`);
      }

      lines.push(``);
      lines.push(`  Среднее связей на гранулу: ${avgLinks}`);

      if (duplicates.length > 0) {
        lines.push(``);
        lines.push(`  Дубликатов entity_name: ${duplicates.length}`);
        for (const d of duplicates.slice(0, 15)) {
          lines.push(
            `    ${d.namespace}: ${d.entityName} (x${d.count})`
          );
        }
        if (duplicates.length > 15) {
          lines.push(
            `    ... и ещё ${duplicates.length - 15}`
          );
        }
      } else {
        lines.push(``);
        lines.push(`  Дубликатов entity_name: 0`);
      }

      return lines.join("\n");
    },
  });
}
