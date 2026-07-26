// ── Tool: code_graph — построение графа зависимостей code_knowledge ──
// ДОСТУПЕН ТОЛЬКО агенту memory-granulator (Тишь).

import { tool } from "@opencode-ai/plugin";
import { MCPClient } from "../mcp/client.js";
import type { AkameConfig } from "../constants.js";
import type { Logger } from "../logger.js";
import type { CodeLink, LinkType } from "../granulator/schema.js";

// ── Типы ──

interface GraphNode {
  id: string; // гранула ID
  entityName: string;
  entityType: string;
  modulePath: string;
  links: { type: string; target: string }[];
}

interface GraphReport {
  totalNodes: number;
  totalEdges: number;
  missingReverseLinks: { from: string; to: string; type: LinkType }[];
  orphans: string[];
  cycles: string[][];
}

// ── Обратная связь для направленных рёбер ──

const REVERSE_LINK: Record<string, LinkType> = {
  depends_on: "used_by",
  contains: "contained_by",
  calls: "called_by",
  follows: "precedes",
};

function reverseLink(type: string): LinkType | null {
  return (REVERSE_LINK as Record<string, LinkType>)[type] || null;
}

// ── Поиск циклов (DFS с цветами) ──

function findCycles(
  adj: Map<string, string[]>,
  nodeNames: string[]
): string[][] {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodeNames) color.set(n, WHITE);

  const cycles: string[][] = [];
  const stack: string[] = [];

  function dfs(u: string): void {
    color.set(u, GRAY);
    stack.push(u);
    const neighbors = adj.get(u) || [];
    for (const v of neighbors) {
      const c = color.get(v);
      if (c === GRAY) {
        // Нашли цикл
        const idx = stack.indexOf(v);
        if (idx >= 0) {
          cycles.push([...stack.slice(idx), v]);
        }
      } else if (c === WHITE) {
        dfs(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  }

  for (const n of nodeNames) {
    if (color.get(n) === WHITE) dfs(n);
  }

  return cycles;
}

// ── Фабрика тула ──

export function createCodeGraphTool(config: AkameConfig, log: Logger, mcp: MCPClient) {
  return tool({
    description:
      "[ТОЛЬКО ДЛЯ memory-granulator] Построить граф зависимостей из code_knowledge гранул. " +
      "Находит отсутствующие обратные связи (used_by), циклические зависимости и сирот.",

    args: {
      project: tool.schema
        .string()
        .describe("Project name (e.g. 'akame')"),

      fixMissingLinks: tool.schema
        .boolean()
        .optional()
        .describe("If true, automatically create missing used_by links"),
    },

    async execute(args, context) {
      // ── Защита ──
      const caller = context.agent || "unknown";
      if (caller !== "memory-granulator") {
        const errMsg = `Доступ запрещён: агент "${caller}" не имеет права вызывать code_graph. Только memory-granulator (Тишь).`;
        log.warn(errMsg);
        throw new Error(errMsg);
      }

      const { project, fixMissingLinks } = args;
      log.info(
        `code_graph: строим граф для ${project}${fixMissingLinks ? " (с исправлением связей)" : ""}`
      );

      // ── 1. Загружаем все code_knowledge гранулы ──
      let records: Awaited<ReturnType<typeof mcp.search>>;
      try {
        records = await mcp.search(project, config.userId, 500, 0.2, "code_knowledge");
      } catch (err) {
        const errMsg = `code_graph: MCP недоступен: ${err instanceof Error ? err.message : String(err)}`;
        log.error(errMsg);
        throw new Error(errMsg);
      }

      // ── 2. Фильтруем по project и строим граф ──
      const nodes = new Map<string, GraphNode>(); // entity_name → node

      for (const r of records) {
        const meta = r.metadata as Record<string, unknown>;
        if (meta?.project_id !== project) continue;

        const entityName = String(meta.entity_name ?? "");
        const entityType = String(meta.entity_type ?? "unknown");
        const modulePath = String(meta.module_path ?? "");

        if (!entityName) continue;

        const rawLinks = (meta.links as Array<Record<string, unknown>>) || [];

        // Если уже есть — мёржим (собираем все links)
        const existing = nodes.get(entityName);
        if (existing) {
          for (const l of rawLinks) {
            const lt = String(l.type || "");
            const tg = String(l.target || "");
            if (lt && tg && !existing.links.some((el) => el.type === lt && el.target === tg)) {
              existing.links.push({ type: lt, target: tg });
            }
          }
        } else {
          nodes.set(entityName, {
            id: r.id,
            entityName,
            entityType,
            modulePath,
            links: rawLinks.map((l) => ({
              type: String(l.type || ""),
              target: String(l.target || ""),
            })),
          });
        }
      }

      const nodeNames = Array.from(nodes.keys());
      log.info(
        `code_graph: ${nodeNames.length} сущностей загружено`
      );

      if (nodeNames.length === 0) {
        return [
          `code_graph: граф построен`,
          `  Проект: ${project}`,
          `  Сущностей: 0`,
          `  Ничего не найдено — запусти code_index для индексации`,
        ].join("\n");
      }

      // ── 3. Строим отчёт ──
      let totalEdges = 0;
      const allLinks = new Set<string>(); // "from→type→to"
      const outAdj = new Map<string, string[]>(); // depends_on / contains / calls → target
      const outEdges = new Map<string, Set<string>>(); // entity → targets (все типы, для сирот)

      for (const [name, node] of nodes) {
        outEdges.set(name, new Set());
        outAdj.set(name, []);
        for (const link of node.links) {
          const key = `${name}→${link.type}→${link.target}`;
          allLinks.add(key);
          totalEdges++;
          outEdges.get(name)!.add(link.target);

          // Для поиска циклов: направленные рёбра depends_on, contains, calls, extends, implements, follows
          if (
            ["depends_on", "contains", "calls", "extends", "implements", "follows"].includes(
              link.type
            )
          ) {
            outAdj.get(name)!.push(link.target);
          }
        }
      }

      // ── 4. Поиск отсутствующих обратных связей ──
      const missingReverse: { from: string; to: string; type: LinkType }[] = [];

      for (const [name, node] of nodes) {
        for (const link of node.links) {
          const revType = reverseLink(link.type);
          if (!revType) continue;

          const targetNode = nodes.get(link.target);
          if (!targetNode) continue;

          // Проверяем: есть ли у targetNode ссылка обратно на name с типом revType
          const hasReverse = targetNode.links.some(
            (tl) => tl.type === revType && tl.target === name
          );
          if (!hasReverse) {
            const key = `${link.target}→${revType}→${name}`;
            if (!allLinks.has(key)) {
              missingReverse.push({
                from: link.target,
                to: name,
                type: revType,
              });
            }
          }
        }
      }

      // ── 5. Сироты (нет ни входящих, ни исходящих) ──
      const hasIncoming = new Set<string>();
      for (const [, node] of nodes) {
        for (const link of node.links) {
          hasIncoming.add(link.target);
        }
      }

      const orphans: string[] = [];
      for (const [name] of nodes) {
        const outgoing = outEdges.get(name);
        if ((!outgoing || outgoing.size === 0) && !hasIncoming.has(name)) {
          orphans.push(name);
        }
      }

      // ── 6. Поиск циклов ──
      const cycles = findCycles(outAdj, nodeNames);

      // ── 7. Исправление связей (если fixMissingLinks=true) ──
      let fixedCount = 0;
      const fixedErrors: string[] = [];

      if (fixMissingLinks && missingReverse.length > 0) {
        log.info(
          `code_graph: исправляем ${missingReverse.length} отсутствующих обратных связей`
        );

        // Группируем по target (кто должен получить новые links)
        const updatesByTarget = new Map<
          string,
          { id: string; newLinks: CodeLink[] }
        >();

        for (const mr of missingReverse) {
          const node = nodes.get(mr.from);
          if (!node) continue;

          let entry = updatesByTarget.get(mr.from);
          if (!entry) {
            entry = {
              id: node.id,
              newLinks: [],
            };
            updatesByTarget.set(mr.from, entry);
          }

          if (
            !entry.newLinks.some(
              (l) => l.type === mr.type && l.target === mr.to
            )
          ) {
            entry.newLinks.push({
              type: mr.type,
              target: mr.to,
              description: `обратная связь: ${mr.to} → ${mr.from}`,
            });
          }
        }

        // Применяем обновления
        for (const [entityName, update] of updatesByTarget) {
          try {
            const existing = nodes.get(entityName);
            if (!existing) continue;

            const mergedLinks: CodeLink[] = [
              ...existing.links.map((l) => ({
                type: l.type as LinkType,
                target: l.target,
              })),
              ...update.newLinks,
            ];

            const metadata: Record<string, unknown> = {
              agent: "memory-granulator",
              session_id: context.sessionID || "code_graph",
              project_id: project,
              title: entityName.slice(0, 80),
              message_ids: [],
              participants: ["memory-granulator", "code_graph"],
              entity_type: existing.entityType,
              entity_name: entityName,
              module_path: existing.modulePath,
              links: mergedLinks as unknown as Record<string, unknown>[],
            };

            await mcp.update(update.id, undefined, metadata);
            fixedCount += update.newLinks.length;
            log.debug(
              `code_graph: обновлён ${entityName} (+${update.newLinks.length} связей)`
            );
          } catch (err) {
            const errStr = err instanceof Error ? err.message : String(err);
            fixedErrors.push(`${entityName}: ${errStr}`);
            log.error(`code_graph: ошибка обновления ${entityName}: ${errStr}`);
          }
        }
      }

      // ── 8. Формируем отчёт ──
      const reportLines: string[] = [
        `code_graph: граф построен`,
        `  Проект: ${project}`,
        `  Сущностей: ${nodeNames.length}`,
        `  Рёбер: ${totalEdges}`,
      ];

      if (missingReverse.length > 0) {
        reportLines.push(
          `  Отсутствует обратных связей: ${missingReverse.length}`
        );
        if (missingReverse.length <= 20) {
          for (const mr of missingReverse) {
            reportLines.push(`    ${mr.from} →[${mr.type}]→ ${mr.to}`);
          }
        } else {
          for (const mr of missingReverse.slice(0, 10)) {
            reportLines.push(`    ${mr.from} →[${mr.type}]→ ${mr.to}`);
          }
          reportLines.push(
            `    ... и ещё ${missingReverse.length - 10}`
          );
        }
      }

      if (cycles.length > 0) {
        reportLines.push(`  Циклов: ${cycles.length}`);
        for (const cycle of cycles) {
          reportLines.push(`    ${cycle.join(" → ")}`);
        }
      } else {
        reportLines.push(`  Циклов: 0`);
      }

      if (orphans.length > 0) {
        reportLines.push(`  Сирот (без связей): ${orphans.length}`);
        if (orphans.length <= 15) {
          for (const o of orphans) {
            reportLines.push(`    ${o}`);
          }
        } else {
          for (const o of orphans.slice(0, 10)) {
            reportLines.push(`    ${o}`);
          }
          reportLines.push(`    ... и ещё ${orphans.length - 10}`);
        }
      } else {
        reportLines.push(`  Сирот: 0`);
      }

      if (fixMissingLinks) {
        reportLines.push(`  Связей исправлено: ${fixedCount}`);
        if (fixedErrors.length > 0) {
          reportLines.push(
            `  Ошибок исправления: ${fixedErrors.length}`
          );
          for (const e of fixedErrors) {
            reportLines.push(`    ${e}`);
          }
        }
      }

      return reportLines.join("\n");
    },
  });
}
