import fs from "fs";
import path from "path";
import type { PluginInput } from "@opencode-ai/plugin";
import type { AkameConfig } from "../constants.js";
import type { Logger } from "../logger.js";
import { storeSessionData } from "./granulate-tool.js";
import { enrichLinks } from "./link-enricher.js";

export interface GranulateContext {
  sessionId: string;
  agent: string;
  projectId: string;
  messages: { id: string; role: string; content: string }[];
  participants: string[];
  mode?: "dialogue" | "code_diff" | "tool_result";
}

// ── Чтение промпта для грануляции ──

function getSystemPrompt(): string {
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
      return fs.readFileSync(promptPath, "utf-8");
    }
  } catch {
    // fallback
  }

  return `Ты — Тишь, специалист по грануляции знаний команды Argenta Team.
Твоя задача — анализировать диалоги и извлекать из них структурированные гранулы знаний.

Правила:
1. Извлекай только существенную информацию
2. Каждая гранула должна быть самодостаточна
3. Разделяй гранулы по namespace: user_facts, project_meta, dialogue_insights, code_knowledge
4. Оценивай importance от 1 до 5
5. Используй инструмент granulate_output для сохранения результатов`;
}

// ── Множество служебных сессий (чтобы не зациклить) ──

const serviceSessions = new Set<string>();

export function isServiceSession(sessionId: string): boolean {
  return serviceSessions.has(sessionId);
}

// ── Granulator Engine ──

export async function granulate(
  input: PluginInput,
  context: GranulateContext,
  config: AkameConfig,
  log: Logger
): Promise<void> {
  const startTime = Date.now();
  log.info(
    `Грануляция: сессия ${context.sessionId}, сообщений: ${context.messages.length}`
  );

  try {
    const messages = truncateMessages(context.messages, config.maxMessages);

    if (messages.length === 0) {
      log.debug("Нет сообщений для грануляции");
      return;
    }

    // Пропускаем слишком короткие диалоги — нечего гранулировать
    // Для code_diff и tool_result это не актуально (одно сообщение = diff)
    const MIN_MESSAGES = 3;
    if (!context.mode && messages.length < MIN_MESSAGES) {
      log.debug(
        `Слишком мало сообщений для грануляции: ${messages.length} < ${MIN_MESSAGES}`
      );
      return;
    }

    // Сохраняем данные сессии для тула granulate_output (с projectId)
    storeSessionData(context.sessionId, {
      messages,
      participants: context.participants,
      projectId: context.projectId,
    });

    const systemPrompt = getSystemPrompt();
    let userPrompt: string;

    switch (context.mode) {
      case "code_diff":
        userPrompt = buildCodeDiffPrompt(context);
        break;
      case "tool_result":
        userPrompt = buildToolResultPrompt(context);
        break;
      default:
        userPrompt = buildDialoguePrompt(context);
    }

    const result = await callLLM(input, systemPrompt, userPrompt, log);

    const duration = Date.now() - startTime;
    log.info(`Грануляция завершена за ${duration}ms: ${result}`);

    // Пост-обработка: автоматическое cross-namespace связывание
    if (config.enrichLinks) {
      try {
        await enrichLinks(context, config, log);
      } catch (linkErr) {
        log.debug(
          `enrichLinks ошибка: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`
        );
      }
    }
  } catch (err) {
    const duration = Date.now() - startTime;
    log.error(
      `Грануляция не удалась за ${duration}ms: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── Вызов LLM через служебную сессию ──

async function callLLM(
  input: PluginInput,
  systemPrompt: string,
  userPrompt: string,
  log: Logger
): Promise<string> {
  const { client } = input;

  // Создаём служебную сессию
  const sessionResult = await client.session.create({
    body: { title: "akame-granulation" },
  });

  const sessionId = sessionResult.data?.id;
  if (!sessionId) {
    throw new Error("Не удалось создать служебную сессию");
  }
  serviceSessions.add(sessionId);
  log.debug(`Создана служебная сессия: ${sessionId}`);

  try {
    // Отправляем промпт — LLM вызовет granulate_output тул
    await client.session.prompt({
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
    });

    // Получаем сообщения
    const messagesResult = await client.session.messages({
      path: { id: sessionId },
    });

    const messages = messagesResult.data ?? [];
    if (messages.length === 0) {
      throw new Error("LLM не вернул ответ");
    }

    // Ищем ответ ассистента
    const lastAssistant = messages
      .filter((m: { info?: { role?: string } }) => m.info?.role === "assistant")
      .pop();

    if (!lastAssistant) {
      throw new Error("Нет ответа ассистента");
    }

    // Извлекаем текст из parts
    const parts = (lastAssistant as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
    const textParts = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "");

    return textParts.join("\n") || "OK (тул вызван)";
  } finally {
    try {
      await client.session.delete({ path: { id: sessionId } });
    } catch {
      // silent
    }
    serviceSessions.delete(sessionId);
    log.debug(`Служебная сессия удалена: ${sessionId}`);
  }
}

// ── Триминг сообщений ──

function truncateMessages(
  messages: GranulateContext["messages"],
  max: number
): GranulateContext["messages"] {
  if (messages.length <= max) return messages;
  return messages.slice(-max);
}

// ── Билдеры промптов для разных режимов ──

function buildDialoguePrompt(context: GranulateContext): string {
  return `Проанализируй диалог и извлеки гранулы знаний.

ID сессии: ${context.sessionId}
Агент: ${context.agent}
Проект: ${context.projectId}
Участники: ${context.participants.join(", ")}

Сообщения диалога:
${context.messages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n")}

Используй инструмент granulate_output для сохранения результатов анализа.`;
}

function buildCodeDiffPrompt(context: GranulateContext): string {
  return `Проанализируй изменения в коде (diff) и создай code_knowledge гранулы.

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

Используй инструмент granulate_output для сохранения результатов.`;
}

function buildToolResultPrompt(context: GranulateContext): string {
  return `Проанализируй результат выполнения инструментов (git) и создай code_knowledge гранулы.

ID сессии: ${context.sessionId}
Проект: ${context.projectId}

Результаты операций:
${context.messages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n")}

Создай гранулы с:
- namespace: "code_knowledge"
- entity_type: "change"
- links типа "follows" и "references" где применимо

Используй инструмент granulate_output для сохранения результатов.`;
}