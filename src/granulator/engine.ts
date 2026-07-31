// ── GranulationEngine — ядро грануляции знаний ──
// Фаза 5: рефакторинг в класс с PromptBuilder и keyword-extractor

import type { PluginInput } from "@opencode-ai/plugin";
import type { AkameConfig } from "../config/schema.js";
import type { Logger } from "../logger.js";
import { MCPClient } from "../mcp/client.js";
import { PromptBuilder } from "./prompt-builder.js";
import { enrichLinks } from "./link-enricher.js";
import type { PendingEntry } from "./batch-accumulator.js";
import { storeSessionData as toolStoreSessionData, type SessionData } from "./granulate-tool.js";

// ── Типы ──

export interface GranulateContext {
  sessionId: string;
  agent: string;
  projectId: string;
  messages: { id: string; role: string; content: string }[];
  participants: string[];
  mode?: "dialogue" | "code_diff" | "tool_result";
}

// Реэкспорт для обратной совместимости
export type { SessionData };

// ── Module-level Set для legacy isServiceSession ──

const _legacyServiceSessions = new Set<string>();

// ── Класс GranulationEngine ──

export class GranulationEngine {
  private config: AkameConfig;
  private log: Logger;
  private mcp: MCPClient;
  private promptBuilder: PromptBuilder;
  private serviceSessions: Set<string> = new Set();
  private sessionDataStore: Map<string, SessionData> = new Map();
  private static readonly LLM_TIMEOUT_MS = 300_000; // 5 минут — aitunnel/deepseek-v4-flash может быть медленным
  private static readonly STORE_TTL = 10 * 60 * 1000; // 10 минут
  private static readonly MIN_MESSAGES = 3;

  constructor(
    config: AkameConfig,
    log: Logger,
    mcp: MCPClient,
    promptBuilder: PromptBuilder
  ) {
    this.config = config;
    this.log = log;
    this.mcp = mcp;
    this.promptBuilder = promptBuilder;
  }

  // ── Основной метод грануляции ──

  async granulate(
    input: PluginInput,
    context: GranulateContext
  ): Promise<void> {
    const startTime = Date.now();
    this.log.info('granulate', {
      sessionId: context.sessionId,
      mode: context.mode,
      messageCount: context.messages.length,
    });

    try {
      const messages = this.promptBuilder.truncateMessages(
        context.messages,
        this.config.maxMessages
      );

      if (messages.length === 0) {
        this.log.debug("Нет сообщений для грануляции", {
          sessionId: context.sessionId,
        });
        return;
      }

      // Пропускаем слишком короткие диалоги — нечего гранулировать
      if (!context.mode && messages.length < GranulationEngine.MIN_MESSAGES) {
        this.log.debug('Слишком мало сообщений для грануляции', {
          sessionId: context.sessionId,
          messageCount: messages.length,
          minMessages: GranulationEngine.MIN_MESSAGES,
        });
        return;
      }

      // Сохраняем данные сессии для тула granulate_output
      this.storeSessionData(context.sessionId, {
        messages,
        participants: context.participants,
        projectId: context.projectId,
      });

      // Синхронизируем с legacy store для granulate-tool.ts
      toolStoreSessionData(context.sessionId, {
        messages,
        participants: context.participants,
        projectId: context.projectId,
      });

      const systemPrompt = this.promptBuilder.buildSystem();
      let userPrompt: string;

      switch (context.mode) {
        case "code_diff":
          userPrompt = this.promptBuilder.buildCodeDiff(context);
          break;
        case "tool_result":
          userPrompt = this.promptBuilder.buildToolResult(context);
          break;
        default:
          userPrompt = await this.promptBuilder.buildDialogue(context);
      }

      await this.callLLM(input, systemPrompt, userPrompt);

      const durationMs = Date.now() - startTime;
      this.log.info('granulate.complete', {
        sessionId: context.sessionId,
        durationMs,
        mode: context.mode,
      });

      // Пост-обработка: автоматическое cross-namespace связывание
      if (this.config.enrichLinks) {
        try {
          await enrichLinks(context, this.config, this.log, this.mcp);
        } catch (linkErr) {
          this.log.debug('enrichLinks ошибка', {
            error: linkErr instanceof Error ? linkErr.message : String(linkErr),
          });
        }
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      this.log.error('granulate.error', {
        sessionId: context.sessionId,
        durationMs,
        mode: context.mode,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Batch Granulation ──

  async granulateBatch(
    input: PluginInput,
    entries: PendingEntry[]
  ): Promise<void> {
    const startTime = Date.now();
    this.log.info('granulate.batch', { batchSize: entries.length });

    // 1. Тримминг сообщений и фильтрация
    const validEntries: PendingEntry[] = [];
    const filteredEntries: PendingEntry[] = [];

    for (const entry of entries) {
      const trimmed = this.promptBuilder.truncateMessages(
        entry.context.messages,
        this.config.maxMessages
      );
      entry.context.messages = trimmed;

      if (
        !entry.context.mode &&
        trimmed.length < GranulationEngine.MIN_MESSAGES
      ) {
        filteredEntries.push(entry);
        this.log.debug('batch: пропуск', {
          sessionId: entry.sessionId,
          eventType: 'batch',
          messageCount: trimmed.length,
          minMessages: GranulationEngine.MIN_MESSAGES,
        });
      } else {
        validEntries.push(entry);
      }
    }

    // Резолвим отфильтрованные
    for (const entry of filteredEntries) {
      entry.resolve();
    }

    if (validEntries.length === 0) {
      this.log.info("Batch: все entries отфильтрованы", { batchSize: 0 });
      return;
    }

    // 2. Сохраняем session data для всех valid entries
    for (const entry of validEntries) {
      this.storeSessionData(entry.sessionId, {
        messages: entry.context.messages,
        participants: entry.context.participants,
        projectId: entry.context.projectId,
      });

      toolStoreSessionData(entry.sessionId, {
        messages: entry.context.messages,
        participants: entry.context.participants,
        projectId: entry.context.projectId,
      });
    }

    try {
      // 3. Сборка батч-промпта
      const systemPrompt = this.promptBuilder.buildSystem();
      const userPrompt = await this.promptBuilder.buildBatch(validEntries);

      // 4. Один вызов LLM
      await this.callLLM(input, systemPrompt, userPrompt);
      const durationMs = Date.now() - startTime;
      this.log.info('granulate.batch.complete', {
        batchSize: validEntries.length,
        durationMs,
      });

      // 5. Резолвим все valid entries
      for (const entry of validEntries) {
        entry.resolve();
      }

      // 6. enrichLinks для каждого entry
      if (this.config.enrichLinks) {
        for (const entry of validEntries) {
          try {
            await enrichLinks(entry.context, this.config, this.log, this.mcp);
          } catch (linkErr) {
            this.log.debug(
              `batch enrichLinks ошибка для ${entry.sessionId}: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`
            );
          }
        }
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('granulate.batch.error', {
        batchSize: validEntries.length,
        durationMs,
        error: error.message,
      });
      for (const entry of validEntries) {
        entry.reject(error);
      }
    }
  }

  // ── Управление сессиями ──

  isServiceSession(id: string): boolean {
    return this.serviceSessions.has(id);
  }

  storeSessionData(sessionId: string, data: SessionData): void {
    this.sessionDataStore.set(sessionId, data);
    setTimeout(
      () => this.sessionDataStore.delete(sessionId),
      GranulationEngine.STORE_TTL
    );
  }

  getSessionData(sessionId: string): SessionData | undefined {
    return this.sessionDataStore.get(sessionId);
  }

  // ── Вызов LLM через служебную сессию ──

  private async callLLM(
    input: PluginInput,
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    const { client } = input;

    const sessionResult = await this.withTimeout(
      client.session.create({ body: { title: "akame-granulation" } }),
      GranulationEngine.LLM_TIMEOUT_MS,
      "session.create"
    );

    const sessionId = sessionResult.data?.id;
    if (!sessionId) {
      throw new Error("Не удалось создать служебную сессию: client.session.create вернул пустой id");
    }
    this.serviceSessions.add(sessionId);
    _legacyServiceSessions.add(sessionId);
    this.log.debug('Создана служебная сессия', {
      sessionId,
      eventType: 'llm',
    });

    try {
      await this.withTimeout(
        client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [
              {
                type: "text",
                text: systemPrompt + "\n\n" + userPrompt,
              },
            ],
            agent: "memory-granulator",
          },
        }),
        GranulationEngine.LLM_TIMEOUT_MS,
        "session.prompt"
      );

      const messagesResult = await this.withTimeout(
        client.session.messages({ path: { id: sessionId } }),
        GranulationEngine.LLM_TIMEOUT_MS,
        "session.messages"
      );

      const messages = messagesResult.data ?? [];
      if (messages.length === 0) {
        throw new Error(`LLM не вернул ответ (sessionId=${sessionId}, сообщений: 0)`);
      }

      const lastAssistant = messages
        .filter((m: { info?: { role?: string } }) => m.info?.role === "assistant")
        .pop();

      if (!lastAssistant) {
        throw new Error(`Нет ответа ассистента в сессии ${sessionId}`);
      }

      const parts = (lastAssistant as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
      const textParts = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "");

      return textParts.join("\n") || "OK (тул вызван)";
    } finally {
      try {
        await client.session.delete({ path: { id: sessionId } });
      } catch (err) {
        this.log.debug('session delete не удалась', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.serviceSessions.delete(sessionId);
      _legacyServiceSessions.delete(sessionId);
      this.log.debug('Служебная сессия удалена', { sessionId });
    }
  }

  // ── Таймаут для асинхронных операций ──

  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Таймаут ${label}: ${ms}ms`)), ms)
      ),
    ]);
  }
}

// ══════════════════════════════════════════════════════════
// ── Legacy function wrappers для обратной совместимости ──
// ══════════════════════════════════════════════════════════

export async function granulate(
  input: PluginInput,
  context: GranulateContext,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const mcp = new MCPClient(config);
  const { NamespaceRegistry } = await import("../namespace-registry.js");
  const registry = new NamespaceRegistry(mcp, log);
  const promptBuilder = new PromptBuilder(config, log, mcp, registry);
  const engine = new GranulationEngine(config, log, mcp, promptBuilder);
  return engine.granulate(input, context);
}

export async function granulateBatch(
  input: PluginInput,
  entries: PendingEntry[],
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const mcp = new MCPClient(config);
  const { NamespaceRegistry } = await import("../namespace-registry.js");
  const registry = new NamespaceRegistry(mcp, log);
  const promptBuilder = new PromptBuilder(config, log, mcp, registry);
  const engine = new GranulationEngine(config, log, mcp, promptBuilder);
  return engine.granulateBatch(input, entries);
}

export function isServiceSession(id: string): boolean {
  return _legacyServiceSessions.has(id);
}
