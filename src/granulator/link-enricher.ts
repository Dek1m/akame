// ── Link Enricher — пост-обработка гранул после грануляции ──
// Вызывается из engine.ts после успешного сохранения гранул.
// Обогащает свежие гранулы кросс-неймспейсными связями через findSimilar.
// Контролируется фича-флагом config.enrichLinks (по умолчанию false).

import { MCPClient } from "../mcp/client.js";
import type { AkameConfig } from "../constants.js";
import type { Logger } from "../logger.js";
import type { GranulateContext } from "./engine.js";
import type { CodeLink, LinkType } from "./schema.js";

// ── CNLM-матрица: Cross-Namespace Link Matrix ──
// source namespace → target namespaces для поиска

const CNLM_MATRIX: Record<string, string[]> = {
  user_facts: ["dialogue_insights", "project_meta"],
  dialogue_insights: ["code_knowledge", "project_meta"],
  project_meta: ["code_knowledge", "user_facts"],
  code_knowledge: ["project_meta"],
};

// ── Ограничения ──

const MAX_LINKS_PER_GRANULE = 5;
const HIGH_SIMILARITY_THRESHOLD = 0.85;

// ── Определение типа связи при высокой похожести ──

function determineLinkType(sourceNs: string, targetNs: string): LinkType {
  if (sourceNs === "dialogue_insights" && targetNs === "code_knowledge") {
    return "solves";
  }
  if (sourceNs === "dialogue_insights" && targetNs === "project_meta") {
    return "references";
  }
  if (sourceNs === "code_knowledge" && targetNs === "project_meta") {
    return "implements_adr";
  }
  if (sourceNs === "user_facts" && targetNs === "dialogue_insights") {
    return "causes";
  }
  if (sourceNs === "user_facts" && targetNs === "project_meta") {
    return "references";
  }
  if (sourceNs === "project_meta" && targetNs === "code_knowledge") {
    return "references";
  }
  if (sourceNs === "project_meta" && targetNs === "user_facts") {
    return "references";
  }
  return "references";
}

// ── Main ──

export async function enrichLinks(
  context: GranulateContext,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  if (!config.enrichLinks) {
    log.debug("link-enricher: отключён (enrichLinks=false)");
    return;
  }

  const mcp = new MCPClient(config);
  const startTime = Date.now();

  try {
    // 1. Получаем последние гранулы
    const recent = await mcp.recent(undefined, 200);

    const newGranules = recent.filter(
      (r) =>
        (r.metadata as Record<string, unknown>)?.session_id ===
        context.sessionId
    );

    if (newGranules.length === 0) {
      log.debug(
        `link-enricher: нет новых гранул для сессии ${context.sessionId}`
      );
      return;
    }

    log.info(
      `link-enricher: ${newGranules.length} гранул для обогащения`
    );

    let totalLinksCreated = 0;
    const nsAffected = new Set<string>();

    for (const granule of newGranules) {
      const meta = granule.metadata as Record<string, unknown>;
      const importance = Number(meta?.importance ?? 3);

      // Не связываем гранулы с importance=1
      if (importance <= 1) continue;

      const ns = granule.namespace;
      const existingLinks = (meta?.links as CodeLink[]) ?? [];

      // Не больше MAX_LINKS_PER_GRANULE
      if (existingLinks.length >= MAX_LINKS_PER_GRANULE) continue;

      const targetNamespaces = CNLM_MATRIX[ns];
      if (!targetNamespaces || targetNamespaces.length === 0) continue;

      const newLinks: CodeLink[] = [];

      for (const targetNs of targetNamespaces) {
        const candidates = await mcp.findSimilar(
          granule.content,
          config.userId,
          5,
          0.75,
          targetNs
        );

        for (const candidate of candidates) {
          if (existingLinks.length + newLinks.length >= MAX_LINKS_PER_GRANULE) {
            break;
          }

          // Не связываем гранулу саму с собой
          if (candidate.id === granule.id) continue;

          // Не дублируем уже существующие связи
          const alreadyLinked =
            existingLinks.some((l) => l.target === candidate.id) ||
            newLinks.some((l) => l.target === candidate.id);

          if (alreadyLinked) continue;

          const linkType: LinkType =
            candidate.score >= HIGH_SIMILARITY_THRESHOLD
              ? determineLinkType(ns, targetNs)
              : "references";

          newLinks.push({
            type: linkType,
            target: candidate.id,
            description: `автосвязь: ${ns} → ${targetNs} (${Math.round(candidate.score * 100)}%)`,
          });
        }
      }

      // Применяем, если есть новые связи
      if (newLinks.length > 0) {
        const mergedLinks = [...existingLinks, ...newLinks];
        const updatedMeta = { ...meta, links: mergedLinks };

        await mcp.update(
          granule.id,
          undefined,
          updatedMeta as Record<string, unknown>
        );

        totalLinksCreated += newLinks.length;
        nsAffected.add(ns);

        log.debug(
          `link-enricher: +${newLinks.length} связей для ${String(meta?.entity_name ?? granule.id.slice(0, 8))}`
        );
      }
    }

    const duration = Date.now() - startTime;
    log.info(
      `link-enricher: создано ${totalLinksCreated} связей, затронуто ${nsAffected.size} namespace, за ${duration}ms`
    );
  } catch (err) {
    log.error(
      `link-enricher: ошибка — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
