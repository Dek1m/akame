// ── Кастомный тул для грануляции ──
// LLM вызывает этот тул вместо генерации JSON в тексте
// Тул валидирует данные и отправляет в athena-memory

import { tool } from "@opencode-ai/plugin";
import { MCPClient } from "../mcp/client.js";
import { validateGranules } from "./schema.js";
import type { AkameConfig } from "../constants.js";
import type { Logger } from "../logger.js";

// ── Module-level store для данных сессий ──
// Сохраняем при session.idle, забираем при вызове тула

interface SessionData {
  messages: { id: string; role: string; content: string }[];
  participants: string[];
}

const sessionStore = new Map<string, SessionData>();
const STORE_TTL = 10 * 60 * 1000; // 10 минут

export function storeSessionData(
  sessionId: string,
  data: SessionData
): void {
  sessionStore.set(sessionId, data);
  // Автоочистка
  setTimeout(() => sessionStore.delete(sessionId), STORE_TTL);
}

export function createGranulateTool(
  config: AkameConfig,
  log: Logger
) {
  const mcp = new MCPClient(config);

  return tool({
    description:
      "Сохранить результаты анализа диалога в athena-memory. Вызови этот инструмент после анализа сообщений диалога. Передай summary (о чём диалог) и массив извлечённых гранул знаний.",
    args: {
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
            namespace: tool.schema.enum([
              "user_facts",
              "project_meta",
              "dialogue_insights",
              "code_knowledge",
            ] as const),
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
          })
        )
        .min(1)
        .max(20)
        .describe("Массив извлечённых гранул знаний (1–20)"),
    },
    async execute(args, context) {
      const sessionId = context.sessionID;
      const sessionData = sessionStore.get(sessionId);

      log.info(
        `granulate_output: ${args.granules.length} гранул, summary: "${args.summary.slice(0, 80)}"`
      );

      // Формируем объект для валидации
      const granulesInput = {
        summary: args.summary,
        granules: args.granules.map((g) => ({
          content: g.content,
          namespace: g.namespace,
          importance: g.importance,
          metadata: {
            session_id: sessionId,
            agent: context.agent || "memory-granulator",
            project_id: "unknown",
            title: g.title,
            message_ids: sessionData?.messages.map((m) => m.id) ?? [],
            participants: g.participants,
          },
        })),
      };

      // Валидация по существующей схеме
      const validated = validateGranules(granulesInput);
      log.debug(`Валидация пройдена: ${validated.granules.length} гранул`);

      // Отправка в athena-memory
      const entries = validated.granules.map((g) => ({
        content: g.content,
        namespace: g.namespace,
        metadata: g.metadata as unknown as Record<string, unknown>,
      }));

      let totalInserted = 0;
      for (let i = 0; i < entries.length; i += config.maxBatch) {
        const batch = entries.slice(i, i + config.maxBatch);
        try {
          const result = await mcp.ingestBatch(batch, config.userId);
          totalInserted += result.inserted;
          log.debug(
            `MCP batch: ${result.inserted} вставлено, ${result.skipped} пропущено, ${result.updated} обновлено`
          );
        } catch (err) {
          log.error(
            `MCP ошибка: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      return `Грануляция завершена: ${validated.granules.length} гранул (${totalInserted} новых). Резюме: ${validated.summary}`;
    },
  });
}