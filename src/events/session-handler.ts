import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { Logger } from "../logger.js";
import type { AkameConfig } from "../constants.js";
import {
  granulate,
  isServiceSession,
  type GranulateContext,
} from "../granulator/engine.js";
import type { Message } from "@opencode-ai/sdk";

// Cooldown map: sessionId -> lastGranulationTime
const cooldowns = new Map<string, number>();

// Глобальный cooldown: последняя грануляция (любой сессии)
let lastGlobalGranulation = 0;
const GLOBAL_COOLDOWN_MS = 5_000; // 5 секунд между любыми грануляциями

// Сброс cooldown (для тестов)
export function resetCooldowns(): void {
  lastGlobalGranulation = 0;
  cooldowns.clear();
}

type MessageInfo = { info: Message; parts: unknown[] };
type SessionInfo = { id: string };

export async function handleSessionIdle(
  input: PluginInput,
  event: Event,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  if (!config.granulateIdle) return;

  const eventData = event as unknown as {
    type: "session.idle";
    properties: { sessionID: string; location?: { directory?: string } };
  };
  const sessionId = eventData.properties?.sessionID;
  if (!sessionId) return;

  // Пропускаем служебные сессии akame (чтобы не зациклить)
  if (isServiceSession(sessionId)) {
    log.debug(`Пропуск служебной сессии: ${sessionId}`);
    return;
  }

  // Глобальный cooldown
  const now = Date.now();
  if (now - lastGlobalGranulation < GLOBAL_COOLDOWN_MS) {
    log.debug(`Глобальный cooldown, пропуск: ${sessionId}`);
    return;
  }

  // Проверка cooldown per-session
  const last = cooldowns.get(sessionId) || 0;
  if (now - last < config.cooldownMs) return;
  cooldowns.set(sessionId, now);
  lastGlobalGranulation = now;

  log.info(`session.idle: ${sessionId}`);

  try {
    const { client } = input;

    // Получаем сообщения сессии
    const messagesResult = await client.session.messages({
      path: { id: sessionId },
    });
    const messages: MessageInfo[] = messagesResult.data ?? [];
    if (messages.length === 0) {
      log.debug(`Нет сообщений в сессии ${sessionId}`);
      return;
    }

    // Получаем дочерние сессии
    let childrenSessionIds: string[] = [];
    try {
      const childrenResult = await client.session.children({
        path: { id: sessionId },
      });
      const children: SessionInfo[] = childrenResult.data ?? [];
      if (children.length > 0) {
        childrenSessionIds = children.map((c: SessionInfo) => c.id);
        // Получаем сообщения из дочерних сессий
        for (const childId of childrenSessionIds) {
          try {
            const childResult = await client.session.messages({
              path: { id: childId },
            });
            const childMsgs: MessageInfo[] = childResult.data ?? [];
            messages.push(...childMsgs);
          } catch {
            // silent
          }
        }
      }
    } catch {
      // children может не поддерживаться
    }

    // Определяем участников
    const roles = new Set(messages.map((m: MessageInfo) => m.info.role));
    const participants = Array.from(roles);

    // Определяем проект: берём из location события или имя пользователя
    const eventPath = eventData.properties?.location?.directory;
    const detectedProject = eventPath
      ? eventPath.split("/").pop() || config.userId
      : config.userId;

    const context: GranulateContext = {
      sessionId,
      agent: "team-lead",
      projectId: detectedProject,
      messages: messages.map((m: MessageInfo) => ({
        id: m.info.id || `msg_${Date.now()}`,
        role: m.info.role,
        content: extractTextContent(m),
      })),
      participants,
    };

    await granulate(input, context, config, log);
  } catch (err) {
    log.error(
      `session.idle ошибка: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function extractTextContent(msg: MessageInfo): string {
  if (!msg.parts || msg.parts.length === 0) {
    return "";
  }
  return msg.parts
    .filter((p: unknown) => (p as { type?: string }).type === "text")
    .map((p: unknown) => (p as { text?: string }).text ?? "")
    .join("\n");
}