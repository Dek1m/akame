// ── Tool: graph_health — верификация здоровья графа знаний ──
// ДОСТУПЕН ТОЛЬКО агенту memory-granulator (Тишь).
// Анализирует связность гранул, сирот, дубликаты, cross-namespace связи.
// ОПТИМИЗИРОВАН: использует серверные tools для графа (memory_graph_stats, memory_get_relations).

import { tool } from "@opencode-ai/plugin";
import { MCPClient } from "../mcp/client.js";
import type { MemoryRecord } from "../mcp/client.js";
import type { AkameConfig } from "../constants.js";
import type { NamespaceRegistry } from "../namespace-registry.js";
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

interface GraphStatsResult {
  total_granules: number;
  total_relations: number;
  orphan_count: number;
  avg_links_per_granule: number;
  namespaces: Record<string, number>;
}

interface RelationsResult {
  relations: Array<{
    source_id: string;
    target_id: string;
    relation_type: string;
  }>;
  total: number;
}

// ── Вспомогательные функции ──

async function collectAllGranules(
  mcp: MCPClient,
  log: Logger,
  registry: NamespaceRegistry
): Promise<MemoryRecord[]> {
  const all: MemoryRecord[] = [];
  const namespaces = await registry.getUids();

  for (const ns of namespaces) {
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

export function createGraphHealthTool(config: AkameConfig, log: Logger, mcp: MCPClient, registry: NamespaceRegistry) {
  return tool({
    description:
      "[ТОЛЬКО ДЛЯ memory-granulator] Проверить здоровье графа знаний. " +
      "Анализирует связность, сирот, дубликаты и cross-namespace связи. " +
      "Использует серверные tools для оптимизации (memory_graph_stats, memory_get_relations).",

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

      const namespaces = await registry.getUids();
      const { project, verbose } = args;
      log.info(`graph_health: анализ для ${project}`);

      // ── 1. Получаем общую статистику графа через серверный tool ──
      let graphStats: GraphStatsResult | null = null;
      try {
        const result = await mcp.callTool("memory_graph_stats", {}) as { content: Array<{ text: string }> };
        if (result?.content?.[0]?.text) {
          graphStats = JSON.parse(result.content[0].text);
        }
      } catch (err) {
        log.debug(`graph_health: memory_graph_stats недоступен, используем fallback — ${err instanceof Error ? err.message : String(err)}`);
      }

      // ── 2. Собираем все гранулы (fallback если нет серверной статистики) ──
      const allGranules = await collectAllGranules(mcp, log, registry);

      if (allGranules.length === 0) {
        return `graph_health: граф пуст — гранул не найдено`;
      }

      log.info(
        `graph_health: собрано ${allGranules.length} гранул`
      );

      // ── 3. Строим lookup-таблицы ──
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

      // ── 4. Получаем связи через серверный tool (оптимизация) ──
      const hasIncoming = new Set<string>();
      const crossNsMap = new Map<string, number>(); // "from→to"
      let totalLinks = 0;

      // Пробуем получить связи через серверный tool для каждой гранулы
      // Ограничиваем количество запросов для производительности
      const GRANULES_WITH_RELATIONS_LIMIT = 100;
      const granulesToCheck = allGranules.slice(0, GRANULES_WITH_RELATIONS_LIMIT);

      for (const g of granulesToCheck) {
        try {
          const result = await mcp.callTool("memory_get_relations", { source_id: g.id }) as { content: Array<{ text: string }> };
          if (result?.content?.[0]?.text) {
            const relationsResult: RelationsResult = JSON.parse(result.content[0].text);
            totalLinks += relationsResult.total;

            for (const rel of relationsResult.relations) {
              const targetGranule = idToGranule.get(rel.target_id);
              if (targetGranule) {
                hasIncoming.add(rel.target_id);

                // Cross-namespace статистика
                if (targetGranule.namespace !== g.namespace) {
                  const key = `${g.namespace}→${targetGranule.namespace}`;
                  crossNsMap.set(key, (crossNsMap.get(key) ?? 0) + 1);
                }
              }
            }
          }
        } catch (err) {
          // Fallback на локальные данные при ошибке серверного вызова
          log.debug(`graph_health: fallback на локальные данные для ${g.id} — ${err instanceof Error ? err.message : String(err)}`);
          const links = extractLinks(g.metadata as Record<string, unknown>);
          totalLinks += links.length;

          for (const link of links) {
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
                for (const tg of (allGranules.filter(ng => ng.namespace === targetNs))) {
                  const tmeta = tg.metadata as Record<string, unknown>;
                  if (String(tmeta?.entity_name ?? "") === link.target) {
                    hasIncoming.add(tg.id);
                  }
                }
              }
            }

            if (targetNs && targetNs !== g.namespace) {
              const key = `${g.namespace}→${targetNs}`;
              crossNsMap.set(key, (crossNsMap.get(key) ?? 0) + 1);
            }
          }
        }
      }

      // Для оставшихся гранул используем локальные данные
      for (const g of allGranules.slice(GRANULES_WITH_RELATIONS_LIMIT)) {
        const links = extractLinks(g.metadata as Record<string, unknown>);
        totalLinks += links.length;

        for (const link of links) {
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
              for (const tg of (allGranules.filter(ng => ng.namespace === targetNs))) {
                const tmeta = tg.metadata as Record<string, unknown>;
                if (String(tmeta?.entity_name ?? "") === link.target) {
                  hasIncoming.add(tg.id);
                }
              }
            }
          }

          if (targetNs && targetNs !== g.namespace) {
            const key = `${g.namespace}→${targetNs}`;
            crossNsMap.set(key, (crossNsMap.get(key) ?? 0) + 1);
          }
        }
      }

      // ── 5. Статистика по namespace: linked vs orphan ──
      const nsStats: Record<string, NamespaceStats> = {};
      const nsGranules: Record<string, MemoryRecord[]> = {};

      for (const ns of namespaces) {
        nsGranules[ns] = [];
      }

      for (const g of allGranules) {
        if (nsGranules[g.namespace]) {
          nsGranules[g.namespace].push(g);
        }
      }

      for (const ns of namespaces) {
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

      // ── 6. Cross-namespace матрица ──
      const crossNsLinks: CrossNsEntry[] = [];
      for (const [key, count] of crossNsMap) {
        const [from, to] = key.split("→");
        crossNsLinks.push({ from, to, count });
      }
      crossNsLinks.sort((a, b) => b.count - a.count);

      // ── 7. Критичные сироты (importance ≥ 3 без связей) ──
      const criticalOrphans: CriticalOrphan[] = [];

      for (const ns of namespaces) {
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

      // ── 8. Среднее связей на гранулу ──
      const avgLinks =
        allGranules.length > 0
          ? Math.round((totalLinks / allGranules.length) * 10) / 10
          : 0;

      // ── 9. Дубликаты (одинаковый entity_name в одном namespace) ──
      const entityCounts = new Map<string, { ns: string; count: number }>();
      for (const ns of namespaces) {
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

      // ── 10. Формируем отчёт ──
      const lines: string[] = [
        `graph_health: отчёт о здоровье графа знаний`,
        `  Проект: ${project}`,
        `  Всего гранул: ${allGranules.length}`,
        `  Всего связей: ${totalLinks} (из них ${hasIncoming.size} входящих)`,
        ``,
        `  По namespace:`,
      ];

      for (const ns of namespaces) {
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
