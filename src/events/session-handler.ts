import type { PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { Logger } from "../logger.js";
import type { AkameConfig } from "../constants.js";
import { type GranulateContext, type GranulationEngine } from "../granulator/engine.js";
import type { BatchEntry, BatchAccumulator } from "../granulator/batch-accumulator.js";
import type { Message } from "@opencode-ai/sdk";
import { BaseEventHandler } from "./base-handler.js";
import { CooldownManager } from "./cooldown-manager.js";

// ── Module-level singleton CooldownManager ──
const _cooldown = new CooldownManager();

// Сброс cooldown (для тестов)
export function resetCooldowns(): void {
  _cooldown.reset();
}

type MessageInfo = { info: Message; parts: unknown[] };
type SessionInfo = { id: string };

// ── Вспомогательные функции ──

function extractTextContent(msg: MessageInfo): string {
  if (!msg.parts || msg.parts.length === 0) {
    return "";
  }
  return msg.parts
    .filter((p: unknown) => (p as { type?: string }).type === "text")
    .map((p: unknown) => (p as { text?: string }).text ?? "")
    .join("\n");
}

function buildGranulateContext(
  sessionId: string,
  agent: string,
  projectId: string,
  messages: MessageInfo[],
  participants: string[]
): GranulateContext {
  return {
    sessionId,
    agent,
    projectId,
    messages: messages.map((m: MessageInfo) => ({
      id: m.info.id || `msg_${Date.now()}`,
      role: m.info.role,
      content: extractTextContent(m),
    })),
    participants,
  };
}

// ── Класс SessionHandler ──

export class SessionHandler extends BaseEventHandler {
  readonly supportedEvents = ["session.idle", "session.compacted", "session.diff"];
  protected cooldown = _cooldown;

  constructor(
    input: PluginInput,
    config: AkameConfig,
    log: Logger,
    batchProcessor: BatchAccumulator | null = null,
    granulationEngine: GranulationEngine | null = null,
  ) {
    super(input, config, log, batchProcessor, granulationEngine);
  }

  async handle(event: Event): Promise<void> {
    const e = event as unknown as {
      type: string;
      properties: Record<string, unknown>;
    };

    // opencode шлёт session.status с nested status.type — маппим на我们的事件
    const effectiveType = e.type === "session.status"
      ? `session.${(e.properties?.status as Record<string,unknown>)?.type ?? "unknown"}`
      : e.type;

    this.log.debug("session-handler: raw event", { rawType: e.type, effectiveType });

    switch (effectiveType) {
      case "session.idle":
        return this.handleSessionIdle(event);
      case "session.compacted":
        return this.handleSessionCompacted(event);
      case "session.diff":
        return this.handleSessionDiff(event);
    }
  }

  async handleSessionIdle(event: Event): Promise<void> {
    if (!this.config.granulateIdle) {
      this.log.debug('session.idle: granulateIdle=false, skip', {});
      return;
    }

    const eventData = event as unknown as {
      type: "session.idle" | "session.status";
      properties: { sessionID: string; location?: { directory?: string }; status?: { type?: string } };
    };
    const sessionId = eventData.properties?.sessionID;
    if (!sessionId) return;

    // Пропускаем служебные сессии akame (чтобы не зациклить)
    if (this.granulationEngine?.isServiceSession(sessionId) ?? false) {
      this.log.info('Пропуск служебной сессии', { sessionId, eventType: 'idle' });
      return;
    }

    // Глобальный cooldown
    if (this.cooldown.checkGlobal()) {
      this.log.debug('Глобальный cooldown', { sessionId, eventType: 'idle' });
      return;
    }

    // Проверка cooldown per-session
    if (this.cooldown.check(sessionId, this.config.cooldownMs)) return;
    this.cooldown.set(sessionId);
    this.cooldown.setGlobal();

    this.log.info('session.idle', { sessionId, eventType: 'idle' });

    try {
      const { client } = this.input;

      // Получаем сообщения сессии
      const messagesResult = await client.session.messages({
        path: { id: sessionId },
      });
      const messages: MessageInfo[] = messagesResult.data ?? [];
      this.log.debug('session.idle: messages fetched', { count: messages.length, sessionId });
      if (messages.length === 0) {
        this.log.info('session.idle: нет сообщений', { sessionId, eventType: 'idle' });
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
            } catch (err) {
              this.log.debug('children messages не удалось получить', { sessionId, eventType: 'idle', error: err instanceof Error ? err.message : String(err) });
            }
          }
        }
      } catch (err) {
        this.log.debug('children сессии не удалось получить', { sessionId, eventType: 'idle', error: err instanceof Error ? err.message : String(err) });
      }

      // Определяем участников
      const roles = new Set(messages.map((m: MessageInfo) => m.info.role));
      const participants = Array.from(roles);

      // Определяем проект: берём из location события или имя пользователя
      const eventPath = eventData.properties?.location?.directory;
      const detectedProject = eventPath
        ? eventPath.split("/").pop() || this.config.userId
        : this.config.userId;

      const context = buildGranulateContext(
        sessionId,
        "session.idle",
        detectedProject,
        messages,
        participants
      );

      this.log.debug('session.idle: calling batchOrDirect', { batchProcessor: !!this.batchProcessor, engine: !!this.granulationEngine, sessionId });
      await this.batchOrDirect(context, { sessionId, event: "idle", enqueuedAt: Date.now() });
      if (!this.batchProcessor) {
        this.cooldown.markSessionGranulated(sessionId);
      }
    } catch (err) {
      this.log.error('session.idle ошибка', { sessionId, eventType: 'idle', error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack?.split('\n').slice(0,3).join(' | ') : undefined });
    }
  }

  async handleSessionCompacted(event: Event): Promise<void> {
    if (!this.config.granulateCompacted) return;

    const eventData = event as unknown as {
      type: "session.compacted";
      properties: { sessionID: string };
    };
    const sessionId = eventData.properties?.sessionID;
    if (!sessionId) return;

    if (this.granulationEngine?.isServiceSession(sessionId) ?? false) {
      this.log.debug('Пропуск служебной сессии (compacted)', { sessionId, eventType: 'compacted' });
      return;
    }

    // Дедупликация: если сессия уже гранулирована через session.idle — пропускаем
    if (this.cooldown.isSessionGranulated(sessionId)) {
      this.log.debug('Сессия уже гранулирована (compacted)', { sessionId, eventType: 'compacted' });
      return;
    }

    this.log.info('session.compacted', { sessionId, eventType: 'compacted' });

    try {
      const { client } = this.input;
      const messagesResult = await client.session.messages({
        path: { id: sessionId },
      });
      const messages: MessageInfo[] = messagesResult.data ?? [];
      if (messages.length === 0) {
        this.log.debug('Нет сообщений в скомпакченной сессии', { sessionId, eventType: 'compacted' });
        return;
      }

      const roles = new Set(messages.map((m: MessageInfo) => m.info.role));
      const participants = Array.from(roles);

      const context = buildGranulateContext(
        sessionId,
        "memory-granulator",
        this.config.userId,
        messages,
        participants
      );

      await this.batchOrDirect(context, { sessionId, event: "compacted", enqueuedAt: Date.now() });
    } catch (err) {
      this.log.error('session.compacted ошибка', { sessionId, eventType: 'compacted', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async handleSessionDiff(event: Event): Promise<void> {
    if (!this.config.granulateDiff) return;

    const eventData = event as unknown as {
      type: "session.diff";
      properties: { sessionID: string };
    };
    const sessionId = eventData.properties?.sessionID;
    if (!sessionId) return;

    if (this.granulationEngine?.isServiceSession(sessionId) ?? false) {
      this.log.debug('Пропуск служебной сессии (diff)', { sessionId, eventType: 'diff' });
      return;
    }

    this.log.info('session.diff', { sessionId, eventType: 'diff' });

    // diff события приходят часто — гранулируем выборочно
    if (this.cooldown.check(`diff_${sessionId}`, this.config.cooldownMs)) return;
    this.cooldown.set(`diff_${sessionId}`);

    try {
      const { client } = this.input;
      const messagesResult = await client.session.messages({
        path: { id: sessionId },
      });
      const messages: MessageInfo[] = messagesResult.data ?? [];
      if (messages.length === 0) return;

      const roles = new Set(messages.map((m: MessageInfo) => m.info.role));
      const participants = Array.from(roles);

      const context = buildGranulateContext(
        sessionId,
        "memory-granulator",
        this.config.userId,
        messages,
        participants
      );

      await this.batchOrDirect(context, { sessionId, event: "diff", enqueuedAt: Date.now() });
    } catch (err) {
      this.log.error('session.diff ошибка', { sessionId, eventType: 'diff', error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ── Старые функции-обёртки (для обратной совместимости) ──

export async function handleSessionIdle(
  input: PluginInput,
  event: Event,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const handler = new SessionHandler(input, config, log);
  return handler.handleSessionIdle(event);
}

export async function handleSessionCompacted(
  input: PluginInput,
  event: Event,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const handler = new SessionHandler(input, config, log);
  return handler.handleSessionCompacted(event);
}

export async function handleSessionDiff(
  input: PluginInput,
  event: Event,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const handler = new SessionHandler(input, config, log);
  return handler.handleSessionDiff(event);
}
