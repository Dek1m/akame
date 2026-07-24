// ── Схема грануляции — типы и JSON Schema для structured output LLM ──

import type { Namespace } from "../constants.js";

// ── Базовые типы ──

export interface GranuleMetadata {
  session_id: string;
  agent: string;
  project_id: string;
  title: string; // до 80 символов
  message_ids: string[];
  participants: string[];
}

export interface Granule {
  content: string; // самодостаточное описание
  namespace: Namespace;
  importance: 1 | 2 | 3 | 4 | 5; // 1 — мелочь, 5 — критично
  metadata: GranuleMetadata;
}

export interface GranulatorOutput {
  summary: string; // о чём диалог одной строкой
  granules: Granule[];
}

// ── JSON Schema для LLM structured output ──

export const GRANULATOR_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Краткое описание диалога одной строкой (до 200 символов)",
    },
    granules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "Самодостаточное описание факта без отсылок к другим гранулам",
          },
          namespace: {
            type: "string",
            enum: [
              "user_facts",
              "project_meta",
              "dialogue_insights",
              "code_knowledge",
            ],
            description: "Категория гранулы",
          },
          importance: {
            type: "integer",
            enum: [1, 2, 3, 4, 5],
            description:
              "Важность: 1 — мелочь, 2 — заметка, 3 — важно, 4 — очень важно, 5 — критично",
          },
          metadata: {
            type: "object",
            properties: {
              session_id: {
                type: "string",
                description: "ID сессии, из которой извлечена гранула",
              },
              agent: {
                type: "string",
                description: "Имя агента, участвовавшего в диалоге",
              },
              project_id: {
                type: "string",
                description: "ID проекта",
              },
              title: {
                type: "string",
                description: "Заголовок гранулы (до 80 символов)",
                maxLength: 80,
              },
              message_ids: {
                type: "array",
                items: { type: "string" },
                description: "ID сообщений, из которых извлечена информация",
              },
              participants: {
                type: "array",
                items: { type: "string" },
                description: "Участники диалога",
              },
            },
            required: [
              "session_id",
              "agent",
              "project_id",
              "title",
              "message_ids",
              "participants",
            ],
            additionalProperties: false,
          },
        },
        required: ["content", "namespace", "importance", "metadata"],
        additionalProperties: false,
      },
      minItems: 0,
      maxItems: 20,
    },
  },
  required: ["summary", "granules"],
  additionalProperties: false,
} as const;

// ── Валидация ответа LLM ──

export function validateGranules(
  output: unknown
): GranulatorOutput {
  if (!output || typeof output !== "object") {
    throw new Error("Ответ LLM не является объектом");
  }

  const obj = output as Record<string, unknown>;

  if (typeof obj.summary !== "string" || obj.summary.length === 0) {
    throw new Error("Поле summary должно быть непустой строкой");
  }

  if (!Array.isArray(obj.granules)) {
    throw new Error("Поле granules должно быть массивом");
  }

  const granules: Granule[] = [];

  for (let i = 0; i < obj.granules.length; i++) {
    const g = validateGranule(obj.granules[i], i);
    granules.push(g);
  }

  return { summary: obj.summary, granules };
}

function validateGranule(
  g: unknown,
  index: number
): Granule {
  if (!g || typeof g !== "object") {
    throw new Error(`Гранула [${index}]: не является объектом`);
  }

  const raw = g as Record<string, unknown>;

  if (typeof raw.content !== "string" || raw.content.length === 0) {
    throw new Error(`Гранула [${index}]: content должен быть непустой строкой`);
  }

  const validNamespaces = [
    "user_facts",
    "project_meta",
    "dialogue_insights",
    "code_knowledge",
  ];
  if (!validNamespaces.includes(raw.namespace as string)) {
    throw new Error(
      `Гранула [${index}]: namespace должен быть одним из: ${validNamespaces.join(", ")}`
    );
  }

  const importance = Number(raw.importance);
  if (![1, 2, 3, 4, 5].includes(importance)) {
    throw new Error(
      `Гранула [${index}]: importance должен быть 1-5, получено ${raw.importance}`
    );
  }

  if (!raw.metadata || typeof raw.metadata !== "object") {
    throw new Error(`Гранула [${index}]: metadata обязателен`);
  }

  const meta = raw.metadata as Record<string, unknown>;

  const requiredMeta = [
    "session_id",
    "agent",
    "project_id",
    "title",
    "message_ids",
    "participants",
  ];
  for (const field of requiredMeta) {
    if (meta[field] === undefined || meta[field] === null) {
      throw new Error(`Гранула [${index}]: metadata.${field} обязателен`);
    }
  }

  if (typeof meta.title === "string" && meta.title.length > 80) {
    throw new Error(
      `Гранула [${index}]: metadata.title не длиннее 80 символов`
    );
  }

  if (!Array.isArray(meta.message_ids)) {
    throw new Error(
      `Гранула [${index}]: metadata.message_ids должен быть массивом`
    );
  }

  if (!Array.isArray(meta.participants)) {
    throw new Error(
      `Гранула [${index}]: metadata.participants должен быть массивом`
    );
  }

  return {
    content: raw.content,
    namespace: raw.namespace as Namespace,
    importance: importance as 1 | 2 | 3 | 4 | 5,
    metadata: {
      session_id: String(meta.session_id),
      agent: String(meta.agent),
      project_id: String(meta.project_id),
      title: String(meta.title),
      message_ids: meta.message_ids.map(String),
      participants: meta.participants.map(String),
    },
  };
}