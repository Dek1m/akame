// ── Кастомный тул для грануляции ──
// ДОСТУПЕН ТОЛЬКО агенту memory-granulator (Тишь).
// Любой другой агент получит ошибку.

import { tool } from "@opencode-ai/plugin";
import { MCPClient } from "../mcp/client.js";
import { validateGranules } from "./schema.js";
import type { AkameConfig } from "../constants.js";
import type { Logger } from "../logger.js";

// ── Module-level store для данных сессий ──
// Сохраняем при granulate(), забираем при вызове тула
// Используется GranulationEngine для синхронизации

export interface SessionData {
  messages: { id: string; role: string; content: string }[];
  participants: string[];
  projectId: string;
}

const sessionStore = new Map<string, SessionData>();
const STORE_TTL = 10 * 60 * 1000; // 10 минут

export function storeSessionData(
  sessionId: string,
  data: SessionData
): void {
  sessionStore.set(sessionId, data);
  setTimeout(() => sessionStore.delete(sessionId), STORE_TTL);
}

export function getSessionData(sessionId: string): SessionData | undefined {
  return sessionStore.get(sessionId);
}

export function createGranulateTool(
  config: AkameConfig,
  log: Logger,
  mcp: MCPClient
) {
  return tool({
    description:
      "[ТОЛЬКО ДЛЯ memory-granulator] Сохранить результаты анализа диалога в athena-memory. " +
      "Вызов этого инструмента разрешён только агенту memory-granulator (Тишь). " +
      "Передай summary (о чём диалог) и массив извлечённых гранул знаний. " +
      "Для code_knowledge указывай entity_type, module_path, entity_name, signature. " +
      "Для всех namespace можно указывать entity_type, entity_name, links (граф знаний). " +
      "Опционально можно указать project_id — если не указан, определяется автоматически из сессии или конфига.",
    args: {
      project_id: tool.schema
        .string()
        .optional()
        .describe("ID проекта (akame/selti). Если не указан, используется из данных сессии или дефолтный из конфига."),
      session_id: tool.schema
        .string()
        .optional()
        .describe("ID оригинальной сессии диалога. Обязателен в batch-режиме для связи гранул с исходным диалогом."),
      summary: tool.schema
        .string()
        .describe("Краткое описание диалога одной строкой (до 200 символов)"),
      granules: tool.schema
        .array(
          tool.schema.object({
            content: tool.schema
              .string()
              .describe(
                "Самодостаточное описание факта. Не используй отсылки к другим гранулам."
              ),
            namespace: tool.schema
              .string()
              .describe("Namespace гранулы (любой из реестра athena-memory)"),
            importance: tool.schema
              .number()
              .int()
              .min(1)
              .max(5)
              .describe("1 — мелочь, 2 — заметка, 3 — важно, 4 — очень важно, 5 — критично"),
            title: tool.schema
              .string()
              .max(80)
              .describe("Заголовок гранулы (до 80 символов)"),
            participants: tool.schema
              .array(tool.schema.string())
              .describe("Участники диалога, имеющие отношение к этой грануле"),
            // Универсальные поля для любого namespace
            entity_type: tool.schema
              .string()
              .optional()
              .describe("Тип сущности. Для code_knowledge: module/class/interface/function/sql_query/table/architecture/change. Для project_meta: adr/decision/architecture/risk. Для user_facts: person/preference/habit/skill. Для dialogue_insights: insight/agreement/conclusion/pattern."),
            entity_name: tool.schema
              .string()
              .optional()
              .describe("Имя сущности (класса, ADR, человека, паттерна)"),
            // Поля для code_knowledge
            module_path: tool.schema
              .string()
              .optional()
              .describe("Путь к файлу от корня проекта (для code_knowledge)"),
            signature: tool.schema
              .string()
              .optional()
              .describe("Сигнатура функции/класса (для code_knowledge)"),
            is_deprecated: tool.schema
              .boolean()
              .optional()
              .describe("true если информация устарела"),
            source_location: tool.schema
              .string()
              .optional()
              .describe("Локация в коде, например L42"),
            // Поля для project_meta
            adr_status: tool.schema
              .enum(["proposed", "accepted", "deprecated", "superseded"] as const)
              .optional()
              .describe("Статус ADR (для project_meta)"),
            // Поля для user_facts
            confidence: tool.schema
              .number()
              .min(0)
              .max(1)
              .optional()
              .describe("Уверенность в факте 0.0–1.0 (для user_facts)"),
            // Графовые связи
            links: tool.schema
              .array(
                tool.schema.object({
                  type: tool.schema.enum([
                    "depends_on", "used_by", "extends", "implements",
                    "contains", "contained_by", "calls", "called_by",
                    "related_to", "contradicts", "solves", "tested_by",
                    "implements_adr", "references", "follows", "precedes",
                    "alternative_to", "causes", "prevents",
                    "runs_on", "exposes", "mounts",
                    "derived_from", "motivates", "informs", "informed_by", "connected_to",
                  ] as const),
                  target: tool.schema
                    .string()
                    .describe("ID или имя связанной гранулы"),
                  description: tool.schema
                    .string()
                    .optional()
                    .describe("Пояснение связи"),
                })
              )
              .optional()
              .describe("Связи с другими гранулами (граф знаний). Работает для всех namespace."),
          })
        )
        .min(1)
        .max(20)
        .describe("Массив извлечённых гранул знаний (1–20)"),
    },
    async execute(args, context) {
      // ── Защита: ТОЛЬКО memory-granulator может писать в память ──
      const caller = context.agent || "unknown";
      if (caller !== "memory-granulator") {
        const errMsg = `Доступ запрещён: агент "${caller}" не имеет права вызывать granulate_output. Только memory-granulator (Тишь) может писать в athena-memory.`;
        log.warn(errMsg, { caller });
        throw new Error(errMsg);
      }

      const lookupId = args.session_id || context.sessionID;
      const sessionData = sessionStore.get(lookupId);

      log.info('granulate_output', { granuleCount: args.granules.length, summary: args.summary.slice(0, 80) });

      // Формируем объект для валидации
      const granulesInput = {
        summary: args.summary,
        granules: args.granules.map((g) => ({
          content: g.content,
          namespace: g.namespace,
          importance: g.importance,
          metadata: {
            session_id: lookupId,
            agent: "memory-granulator",
            project_id: args.project_id ?? sessionData?.projectId ?? config.userId,
            title: g.title,
            message_ids: sessionData?.messages.map((m) => m.id) ?? [],
            participants: g.participants,
            // Универсальные поля
            ...(g.entity_type ? { entity_type: g.entity_type } : {}),
            ...(g.entity_name ? { entity_name: g.entity_name } : {}),
            // code_knowledge
            ...(g.module_path ? { module_path: g.module_path } : {}),
            ...(g.signature ? { signature: g.signature } : {}),
            ...(g.is_deprecated !== undefined ? { is_deprecated: g.is_deprecated } : {}),
            ...(g.source_location ? { source_location: g.source_location } : {}),
            // project_meta
            ...(g.adr_status ? { adr_status: g.adr_status } : {}),
            // user_facts
            ...(g.confidence !== undefined ? { confidence: g.confidence } : {}),
            // links
            ...(g.links ? { links: g.links } : {}),
          },
        })),
      };

      // Валидация по расширенной схеме
      const validated = validateGranules(granulesInput, log);
      log.debug('Валидация пройдена', { granuleCount: validated.granules.length });

      // Отправка в athena-memory
      const entries = validated.granules.map((g) => ({
        content: g.content,
        namespace: g.namespace,
        importance: g.importance,
        metadata: g.metadata as unknown as Record<string, unknown>,
      }));

      let totalInserted = 0;
      for (let i = 0; i < entries.length; i += config.maxBatch) {
        const batch = entries.slice(i, i + config.maxBatch);
        try {
          const result = await mcp.ingestBatch(batch, config.userId);
          totalInserted += result.inserted;
          log.debug('MCP batch', { inserted: result.inserted, skipped: result.skipped, updated: result.updated });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('MCP ошибка', { error: msg });
          throw new Error(`MCP ingestBatch failed: ${msg}`);
        }
      }

      return `Грануляция завершена: ${validated.granules.length} гранул (${totalInserted} новых). Резюме: ${validated.summary}`;
    },
  });
}
