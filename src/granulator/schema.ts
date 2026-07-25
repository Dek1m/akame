// ── Схема грануляции — типы и JSON Schema для structured output LLM ──

import type { Namespace } from "../constants.js";

// ── Универсальный тип EntityType для ВСЕХ namespace ──

export type EntityType =
  // Для code_knowledge
  | "module" | "class" | "interface" | "function"
  | "sql_query" | "table" | "index"
  | "architecture" | "dependency" | "config" | "change" | "test"
  // Для project_meta
  | "adr" | "decision" | "risk" | "requirement" | "status"
  // Для user_facts
  | "person" | "preference" | "habit" | "skill" | "pain_point" | "contact"
  // Для dialogue_insights
  | "insight" | "agreement" | "conclusion" | "context" | "pattern" | "question"
  // Для infrastructure
  | "server" | "container" | "service" | "api" | "network" | "volume" | "os"
  // Общее
  | "unknown";

// ── Универсальный тип LinkType ──

export type LinkType =
  // Кодовые и архитектурные
  | "depends_on" | "used_by" | "extends" | "implements"
  | "contains" | "contained_by" | "calls" | "called_by"
  // Общие
  | "related_to" | "contradicts"
  // Семантические
  | "solves" | "tested_by" | "implements_adr"
  | "references" | "follows" | "precedes" | "alternative_to"
  | "causes" | "prevents"
  // Инфраструктурные
  | "runs_on" | "exposes" | "mounts"
  // Cross-namespace
  | "derived_from" | "motivates" | "informs" | "informed_by" | "connected_to";

export interface CodeLink {
  type: LinkType;
  target: string;
  description?: string;
}

// ── Базовые типы ──

export interface GranuleMetadata {
  session_id: string;
  agent: string;
  project_id: string;
  title: string; // до 80 символов
  message_ids: string[];
  participants: string[];

  // Универсальные поля (опциональны, для любого namespace)
  entity_type?: EntityType;
  entity_name?: string;

  // Поля для code_knowledge (опциональны)
  module_path?: string;
  signature?: string;
  is_deprecated?: boolean;
  source_location?: string;

  // Поля для project_meta (опциональны)
  adr_status?: "proposed" | "accepted" | "deprecated" | "superseded";

  // Поля для user_facts (опциональны)
  confidence?: number;   // 0.0 — 1.0, насколько уверены в факте

  // Графовые связи
  links?: CodeLink[];
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

// ── Полный список всех EntityType для валидации и JSON Schema ──

export const ALL_ENTITY_TYPES = [
  // code_knowledge
  "module", "class", "interface", "function",
  "sql_query", "table", "index",
  "architecture", "dependency", "config", "change", "test",
  // project_meta
  "adr", "decision", "risk", "requirement", "status",
  // user_facts
  "person", "preference", "habit", "skill", "pain_point", "contact",
  // dialogue_insights
  "insight", "agreement", "conclusion", "context", "pattern", "question",
  // infrastructure
  "server", "container", "service", "api", "network", "volume", "os",
  // общее
  "unknown",
] as const;

export const ALL_LINK_TYPES = [
  "depends_on", "used_by", "extends", "implements",
  "contains", "contained_by", "calls", "called_by",
  "related_to", "contradicts",
  "solves", "tested_by", "implements_adr",
  "references", "follows", "precedes", "alternative_to",
  "causes", "prevents",
  "runs_on", "exposes", "mounts",
  "derived_from", "motivates", "informs", "informed_by", "connected_to",
] as const;

// ── CNLM-матрица: разрешённые типы связей между namespace ──
// source namespace → target namespace → разрешённые link types
// "*" означает все code-intrinsic типы (depends_on, used_by, extends, implements,
// contains, contained_by, calls, called_by, related_to, references, и др.)
export const CROSS_NAMESPACE_LINK_RULES: Record<string, Record<string, string[]>> = {
  user_facts: {
    dialogue_insights: ["derived_from", "references"],
    project_meta:      ["motivates", "references"],
    code_knowledge:    ["references"],
    infrastructure:    ["references"],
    user_facts:        ["related_to", "contradicts", "references"],
  },
  dialogue_insights: {
    user_facts:        ["derived_from", "references"],
    project_meta:      ["informs", "references"],
    code_knowledge:    ["references", "solves"],
    infrastructure:    ["references"],
    dialogue_insights: ["related_to", "contradicts", "follows", "precedes", "references"],
  },
  project_meta: {
    user_facts:        ["informed_by", "references"],
    dialogue_insights: ["informed_by", "references"],
    code_knowledge:    ["implements_adr", "references"],
    infrastructure:    ["references"],
    project_meta:      ["related_to", "contradicts", "follows", "precedes", "alternative_to", "causes", "prevents", "references"],
  },
  code_knowledge: {
    user_facts:        ["references"],
    dialogue_insights: ["references", "solves"],
    project_meta:      ["implements_adr", "references"],
    infrastructure:    ["references"],
    code_knowledge:    ["*"], // все code-intrinsic
  },
  infrastructure: {
    user_facts:        ["references"],
    dialogue_insights: ["references"],
    project_meta:      ["references"],
    code_knowledge:    ["references"],
    infrastructure:    ["runs_on", "contains", "contained_by", "exposes", "mounts", "depends_on", "connected_to", "references"],
  },
};

// Рекомендации по entity_type для каждого namespace
export const ENTITY_TYPE_BY_NAMESPACE: Record<string, string[]> = {
  code_knowledge: ["module", "class", "interface", "function", "sql_query", "table", "index", "architecture", "dependency", "config", "change", "test"],
  project_meta: ["adr", "decision", "architecture", "risk", "requirement", "status", "config"],
  user_facts: ["person", "preference", "habit", "skill", "pain_point", "contact"],
  dialogue_insights: ["insight", "agreement", "conclusion", "context", "pattern", "question"],
  infrastructure: ["server", "container", "service", "api", "network", "volume", "os"],
};

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
              "infrastructure",
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
                description: "ID проекта или контекста",
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
              // Универсальные поля для любого namespace
              entity_type: {
                type: "string",
                enum: [...ALL_ENTITY_TYPES],
                description: "Тип сущности. Рекомендуемый набор по namespace: code_knowledge → module/class/interface/function/sql_query/table/architecture, project_meta → adr/decision/architecture/risk, user_facts → person/preference/habit/skill/pain, dialogue_insights → insight/agreement/conclusion/context/pattern",
              },
              entity_name: {
                type: "string",
                description: "Имя сущности (класса, функции, ADR, человека, паттерна)",
              },
              // Для code_knowledge
              module_path: {
                type: "string",
                description: "Путь к файлу от корня проекта (для кода)",
              },
              signature: {
                type: "string",
                description: "Сигнатура функции/класса (для кода)",
              },
              is_deprecated: {
                type: "boolean",
                description: "true если информация устарела",
              },
              source_location: {
                type: "string",
                description: "Локация в коде, например L42",
              },
              // Для project_meta
              adr_status: {
                type: "string",
                enum: ["proposed", "accepted", "deprecated", "superseded"],
                description: "Статус ADR (для project_meta)",
              },
              // Для user_facts
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "Уверенность в факте 0.0–1.0 (для user_facts)",
              },
              // Графовые связи
              links: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: [...ALL_LINK_TYPES],
                    },
                    target: {
                      type: "string",
                      description: "ID или имя связанной гранулы",
                    },
                    description: {
                      type: "string",
                      description: "Пояснение связи",
                    },
                  },
                  required: ["type", "target"],
                },
                description: "Связи с другими гранулами (граф знаний). Типы: depends_on, used_by, extends, implements, contains, related_to, contradicts, solves, references, follows, precedes, causes, prevents и др.",
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
          },
        },
        required: ["content", "namespace", "importance", "metadata"],
      },
      minItems: 0,
      maxItems: 20,
    },
  },
  required: ["summary", "granules"],
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
    "infrastructure",
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

  // Валидация entity_type — универсальный список
  if (meta.entity_type !== undefined && meta.entity_type !== null) {
    const et = String(meta.entity_type);
    if (!(ALL_ENTITY_TYPES as readonly string[]).includes(et)) {
      throw new Error(
        `Гранула [${index}]: metadata.entity_type должен быть одним из: ${ALL_ENTITY_TYPES.join(", ")}`
      );
    }
  }

  // Валидация adr_status
  if (meta.adr_status !== undefined && meta.adr_status !== null) {
    const validStatuses = ["proposed", "accepted", "deprecated", "superseded"];
    if (!validStatuses.includes(String(meta.adr_status))) {
      throw new Error(
        `Гранула [${index}]: metadata.adr_status должен быть одним из: ${validStatuses.join(", ")}`
      );
    }
  }

  // Валидация confidence
  if (meta.confidence !== undefined && meta.confidence !== null) {
    const c = Number(meta.confidence);
    if (isNaN(c) || c < 0 || c > 1) {
      throw new Error(
        `Гранула [${index}]: metadata.confidence должен быть числом 0.0–1.0`
      );
    }
  }

  // Валидация links
  if (meta.links !== undefined && meta.links !== null) {
    if (!Array.isArray(meta.links)) {
      throw new Error(`Гранула [${index}]: metadata.links должен быть массивом`);
    }
    for (let li = 0; li < meta.links.length; li++) {
      const link = meta.links[li] as Record<string, unknown>;
      if (!link || typeof link !== "object") {
        throw new Error(`Гранула [${index}]: links[${li}] не является объектом`);
      }
      if (typeof link.type !== "string" || !(ALL_LINK_TYPES as readonly string[]).includes(link.type)) {
        throw new Error(
          `Гранула [${index}]: links[${li}].type должен быть одним из: ${ALL_LINK_TYPES.join(", ")}`
        );
      }
      if (typeof link.target !== "string" || link.target.length === 0) {
        throw new Error(`Гранула [${index}]: links[${li}].target обязателен`);
      }
    }

    // Проверка cross-namespace link rules (warn, не ошибка)
    const sourceNs = raw.namespace as string;
    const rules = CROSS_NAMESPACE_LINK_RULES[sourceNs];
    if (rules) {
      for (let li = 0; li < meta.links.length; li++) {
        const link = meta.links[li] as Record<string, unknown>;
        const linkType = String(link.type);
        // Проверяем, разрешён ли linkType хотя бы для одного target namespace
        const isAllowed = Object.values(rules).some(
          (allowedTypes) => allowedTypes.includes("*") || allowedTypes.includes(linkType)
        );
        if (!isAllowed) {
          console.warn(
            `[akame] Гранула [${index}]: links[${li}].type="${linkType}" не найден в CROSS_NAMESPACE_LINK_RULES для source="${sourceNs}"`
          );
        }
      }
    }
  }

  // Собираем metadata, включая опциональные поля
  const metadata: GranuleMetadata = {
    session_id: String(meta.session_id),
    agent: String(meta.agent),
    project_id: String(meta.project_id),
    title: String(meta.title),
    message_ids: (meta.message_ids as unknown[]).map(String),
    participants: (meta.participants as unknown[]).map(String),
  };

  // Универсальные опциональные поля
  if (meta.entity_type !== undefined && meta.entity_type !== null) {
    metadata.entity_type = String(meta.entity_type) as EntityType;
  }
  if (meta.entity_name !== undefined && meta.entity_name !== null) {
    metadata.entity_name = String(meta.entity_name);
  }

  // Поля code_knowledge
  if (meta.module_path !== undefined && meta.module_path !== null) {
    metadata.module_path = String(meta.module_path);
  }
  if (meta.signature !== undefined && meta.signature !== null) {
    metadata.signature = String(meta.signature);
  }
  if (meta.is_deprecated !== undefined && meta.is_deprecated !== null) {
    metadata.is_deprecated = Boolean(meta.is_deprecated);
  }
  if (meta.source_location !== undefined && meta.source_location !== null) {
    metadata.source_location = String(meta.source_location);
  }

  // Поля project_meta
  if (meta.adr_status !== undefined && meta.adr_status !== null) {
    metadata.adr_status = String(meta.adr_status) as GranuleMetadata["adr_status"];
  }

  // Поля user_facts
  if (meta.confidence !== undefined && meta.confidence !== null) {
    metadata.confidence = Number(meta.confidence);
  }

  // Links
  if (meta.links !== undefined && meta.links !== null && Array.isArray(meta.links)) {
    metadata.links = (meta.links as unknown[]).map((l) => {
      const link = l as Record<string, unknown>;
      return {
        type: String(link.type) as LinkType,
        target: String(link.target),
        description: link.description ? String(link.description) : undefined,
      };
    });
  }

  return {
    content: String(raw.content),
    namespace: raw.namespace as Namespace,
    importance: importance as 1 | 2 | 3 | 4 | 5,
    metadata,
  };
}
