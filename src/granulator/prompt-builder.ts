// ── PromptBuilder — сборка промптов для LLM-грануляции ──

import fs from "fs";
import path from "path";
import type { Logger } from "../logger.js";
import type { AkameConfig } from "../config/schema.js";
import type { GranulateContext } from "./engine.js";
import type { PendingEntry } from "./batch-accumulator.js";
import { MCPClient } from "../mcp/client.js";
import { extractKeywords } from "./keyword-extractor.js";

export class PromptBuilder {
  private config: AkameConfig;
  private log: Logger;
  private mcp: MCPClient;
  private cachedPrompt: string | null = null;
  private cachedMtime: number = 0;
  private static readonly MAX_GRANULES_PROMPT_SIZE = 2000;

  constructor(config: AkameConfig, log: Logger, mcp: MCPClient) {
    this.config = config;
    this.log = log;
    this.mcp = mcp;
  }

  // ── Системный промпт (с кешированием по mtime) ──

  buildSystem(): string {
    try {
      const homeDir = process.env.HOME || "/home/opencode";
      const promptPath = path.join(
        homeDir,
        ".config",
        "opencode",
        "agents",
        "memory-granulator.md"
      );
      if (fs.existsSync(promptPath)) {
        const mtime = fs.statSync(promptPath).mtimeMs;
        if (this.cachedPrompt === null || mtime > this.cachedMtime) {
          this.cachedPrompt = fs.readFileSync(promptPath, "utf-8");
          this.cachedMtime = mtime;
        }
        return this.cachedPrompt;
      }
    } catch (err) {
      this.log?.debug('prompt file не удалось прочитать', { error: err instanceof Error ? err.message : String(err) });
    }

    return `Ты — Тишь, специалист по грануляции знаний команды Argenta Team.
Твоя задача — анализировать диалоги и извлекать из них структурированные гранулы знаний.

Правила:
1. Извлекай только существенную информацию
2. Каждая гранула должна быть самодостаточна
3. Используй существующие namespace: user_facts, project_meta, dialogue_insights, code_knowledge, infrastructure. Если нужен новый — создавай любой другой, сервер зарегистрирует автоматически
4. Оценивай importance от 1 до 5
5. Используй инструмент granulate_output для сохранения результатов`;
  }

  // ── Билдеры промптов для разных режимов ──

  async buildDialogue(context: GranulateContext): Promise<string> {
    let relevantGranules = "";
    if (this.config.enrichPrompt) {
      relevantGranules = await this.fetchRelevant(context);
    }

    return `${relevantGranules}ИНКРЕМЕНТАЛЬНАЯ ГРАНУЛЯЦИЯ: извлекай только НОВЫЕ факты, которых нет среди существующих гранул выше. Если факт уже отражён — не создавай дубликат.

Проанализируй диалог и извлеки гранулы знаний.

Извлекай гранулы по namespace: user_facts, project_meta, dialogue_insights, code_knowledge, infrastructure. Если тема не входит ни в один из них — создай новый namespace с осмысленным именем.

ID сессии: ${context.sessionId}
Агент: ${context.agent}
Проект: ${context.projectId}
Участники: ${context.participants.join(", ")}

Сообщения диалога:
${context.messages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n")}

При вызове granulate_output передай session_id="${context.sessionId}".
Используй инструмент granulate_output для сохранения результатов анализа.`;
  }

  buildCodeDiff(context: GranulateContext): string {
    return `ИНКРЕМЕНТАЛЬНАЯ ГРАНУЛЯЦИЯ: извлекай только НОВЫЕ факты об изменениях кода. Не создавай гранулы для уже известных сущностей.

Проанализируй изменения в коде (diff) и создай code_knowledge гранулы.

ID сессии: ${context.sessionId}
Проект: ${context.projectId}

Изменения (diff):
${context.messages.map((m) => m.content).join("\n\n")}

Создай гранулы с:
- namespace: "code_knowledge"
- entity_type: "change" (или "function", "class", "module" — по контексту)
- module_path: путь к изменённому файлу
- entity_name: имя изменённой сущности
- links: связи с существующими гранулами, если известны

Если изменения архитектурно значимые — добавь гранулу в namespace "project_meta".

При вызове granulate_output передай session_id="${context.sessionId}".
Используй инструмент granulate_output для сохранения результатов.`;
  }

  buildToolResult(context: GranulateContext): string {
    return `ИНКРЕМЕНТАЛЬНАЯ ГРАНУЛЯЦИЯ: извлекай только НОВЫЕ факты из результатов git-операций.

Проанализируй результат выполнения инструментов (git) и создай code_knowledge гранулы.

ID сессии: ${context.sessionId}
Проект: ${context.projectId}

Результаты операций:
${context.messages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n")}

Создай гранулы с:
- namespace: "code_knowledge"
- entity_type: "change"
- links типа "follows" и "references" где применимо

При вызове granulate_output передай session_id="${context.sessionId}".
Используй инструмент granulate_output для сохранения результатов.`;
  }

  // ── Батч-промпт ──

  async buildBatch(entries: PendingEntry[]): Promise<string> {
    let relevantGranules = "";

    if (this.config.enrichPrompt) {
      const allMessages = entries.flatMap((e) => e.context.messages);
      const virtualContext: GranulateContext = {
        sessionId: "__batch__",
        agent: "memory-granulator",
        projectId: entries[0]?.context.projectId ?? "",
        messages: allMessages,
        participants: [...new Set(entries.flatMap((e) => e.context.participants))],
      };
      relevantGranules = await this.fetchRelevant(virtualContext);
    }

    const entriesSections = entries
      .map((entry, i) => {
        const ctx = entry.context;
        const mode = ctx.mode || "dialogue";
        return `---
## ДИАЛОГ ${i + 1}/${entries.length}
ID сессии:       ${entry.sessionId}
Режим:            ${mode}
Агент:            ${ctx.agent}
Проект:           ${ctx.projectId}
Участники:        ${ctx.participants.join(", ")}
Событие:          ${entry.event}
Сообщения:
${this.formatEntryMessages(entry)}`;
      })
      .join("\n\n");

    return `${relevantGranules}Ты — Тишь, специалист по грануляции знаний Argenta Team.

СЕЙЧАС ТЫ ОБРАБАТЫВАЕШЬ ПАКЕТ ИЗ ${entries.length} ДИАЛОГОВ.
Твоя задача: для КАЖДОГО диалога вызови granulate_output ровно один раз.

ИНКРЕМЕНТАЛЬНАЯ ГРАНУЛЯЦИЯ: извлекай только НОВЫЕ факты, которых нет среди существующих гранул выше. Если факт уже отражён в существующей грануле — не создавай дубликат. Это экономит токены и держит память чистой.

ПРАВИЛА:
1. Для каждого диалога вызывай granulate_output отдельно.
2. ПЕРЕДАВАЙ session_id из заголовка диалога в аргумент session_id тула granulate_output.
3. В summary описывай суть диалога одной строкой (до 200 символов).
4. НЕ СМЕШИВАЙ гранулы из разных диалогов в одном вызове granulate_output.
5. Если диалог не содержит значимой информации — всё равно вызови granulate_output с summary="no significant knowledge" и пустым массивом гранул.

${entriesSections}`;
  }

  // ── Поиск существующих гранул для обогащения промпта ──

  async fetchRelevant(context: GranulateContext): Promise<string> {
    const keywords = extractKeywords(context.messages);
    if (keywords.length === 0) return "";

    const namespaces = [
      "user_facts",
      "project_meta",
      "code_knowledge",
      "dialogue_insights",
      "infrastructure",
    ];

    let result = "## Существующие гранулы (используй для links):\n\n";
    let totalSize = result.length;

    for (const ns of namespaces) {
      try {
        const query = keywords.join(" ");
        const searchResults = await this.mcp.search(
          query,
          this.config.userId,
          3,
          undefined,
          ns
        );

        if (searchResults.length === 0) continue;

        const nsHeader = `### ${ns}:\n`;
        let nsSection = nsHeader;

        for (const sr of searchResults) {
          const meta = (sr.metadata as Record<string, unknown>) ?? {};
          const entityName = meta.entity_name
            ? `[entity_name: "${meta.entity_name}"] `
            : "";
          const content =
            sr.content.length > 150
              ? sr.content.slice(0, 147) + "..."
              : sr.content;
          nsSection += `- ${entityName}${content}\n`;
        }

        if (totalSize + nsSection.length > PromptBuilder.MAX_GRANULES_PROMPT_SIZE) {
          const remaining = PromptBuilder.MAX_GRANULES_PROMPT_SIZE - totalSize;
          if (remaining > nsHeader.length + 20) {
            nsSection = nsHeader + "- ... (обрезано)\n";
            result += nsSection;
          }
          break;
        }

        result += nsSection;
        totalSize += nsSection.length;
      } catch (err) {
        this.log.debug('fetchRelevant: ошибка', {
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  // ── Триминг сообщений ──

  truncateMessages(
    messages: GranulateContext["messages"],
    max: number
  ): GranulateContext["messages"] {
    if (messages.length <= max) return messages;
    return messages.slice(-max);
  }

  // ── Приватные методы ──

  private formatEntryMessages(entry: PendingEntry): string {
    const { messages, mode } = entry.context;

    switch (mode) {
      case "code_diff":
        return messages.map((m) => m.content).join("\n\n");
      case "tool_result":
      default:
        return messages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    }
  }
}
