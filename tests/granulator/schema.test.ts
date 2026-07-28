import { describe, it, expect } from "vitest";
import { validateGranules } from "../../src/granulator/schema.js";

describe("validateGranules", () => {
  it("валидирует корректный объект", () => {
    const input = {
      summary: "Тестовый диалог",
      granules: [
        {
          content: "Факт из диалога",
          namespace: "user_facts",
          importance: 3,
          metadata: {
            session_id: "sess_1",
            agent: "programmer",
            project_id: "proj_1",
            title: "Тест",
            message_ids: ["msg_1"],
            participants: ["user", "agent"],
          },
        },
      ],
    };

    const result = validateGranules(input);
    expect(result.granules).toHaveLength(1);
    expect(result.granules[0].namespace).toBe("user_facts");
    expect(result.granules[0].importance).toBe(3);
    expect(result.granules[0].content).toBe("Факт из диалога");
    expect(result.summary).toBe("Тестовый диалог");
  });

  it("принимает пустой массив granules", () => {
    const result = validateGranules({ summary: "Пусто", granules: [] });
    expect(result.granules).toHaveLength(0);
  });

  it("принимает любой namespace (валидация на стороне сервера)", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "test",
          namespace: "any_namespace",
          importance: 3,
          metadata: {
            session_id: "s",
            agent: "a",
            project_id: "p",
            title: "t",
            message_ids: [],
            participants: [],
          },
        },
      ],
    };

    const result = validateGranules(input);
    expect(result.granules[0].namespace).toBe("any_namespace");
  });

  it("выбрасывает ошибку при importance вне диапазона", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "test",
          namespace: "user_facts",
          importance: 99,
          metadata: {
            session_id: "s",
            agent: "a",
            project_id: "p",
            title: "t",
            message_ids: [],
            participants: [],
          },
        },
      ],
    };

    expect(() => validateGranules(input)).toThrow("importance");
  });

  it("выбрасывает ошибку при importance = 0", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "test",
          namespace: "user_facts",
          importance: 0,
          metadata: {
            session_id: "s",
            agent: "a",
            project_id: "p",
            title: "t",
            message_ids: [],
            participants: [],
          },
        },
      ],
    };

    expect(() => validateGranules(input)).toThrow("importance");
  });

  it("выбрасывает ошибку при отсутствии metadata", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "test",
          namespace: "user_facts",
          importance: 3,
        },
      ],
    };

    expect(() => validateGranules(input)).toThrow("metadata");
  });

  it("выбрасывает ошибку при пустом summary", () => {
    expect(() => validateGranules({ summary: "", granules: [] })).toThrow(
      "summary"
    );
  });

  it("выбрасывает ошибку при не-объекте", () => {
    expect(() => validateGranules("string")).toThrow();
    expect(() => validateGranules(null)).toThrow();
    expect(() => validateGranules(42)).toThrow();
  });

  it("выбрасывает ошибку при отсутствии summary", () => {
    expect(() => validateGranules({ granules: [] })).toThrow();
  });

  it("выбрасывает ошибку когда granules — не массив", () => {
    expect(() =>
      validateGranules({ summary: "test", granules: "not_array" })
    ).toThrow("granules");
  });

  it("валидирует все 4 namespace", () => {
    const namespaces = [
      "user_facts",
      "project_meta",
      "dialogue_insights",
      "code_knowledge",
    ];

    for (const ns of namespaces) {
      const input = {
        summary: `test ${ns}`,
        granules: [
          {
            content: "test",
            namespace: ns,
            importance: 1,
            metadata: {
              session_id: "s",
              agent: "a",
              project_id: "p",
              title: "t",
              message_ids: [],
              participants: [],
            },
          },
        ],
      };

      const result = validateGranules(input);
      expect(result.granules[0].namespace).toBe(ns);
    }
  });

  it("валидирует granule с пустыми массивами в metadata", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "test",
          namespace: "project_meta",
          importance: 5,
          metadata: {
            session_id: "s1",
            agent: "test-agent",
            project_id: "proj1",
            title: "Test Title",
            message_ids: [],
            participants: [],
          },
        },
      ],
    };

    const result = validateGranules(input);
    expect(result.granules[0].metadata.message_ids).toEqual([]);
    expect(result.granules[0].metadata.participants).toEqual([]);
  });

  it("выбрасывает ошибку при title длиннее 80 символов", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "test",
          namespace: "user_facts",
          importance: 2,
          metadata: {
            session_id: "s",
            agent: "a",
            project_id: "p",
            title: "x".repeat(81),
            message_ids: [],
            participants: [],
          },
        },
      ],
    };

    expect(() => validateGranules(input)).toThrow("title");
  });

  it("выбрасывает ошибку при пустом content в granule", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "",
          namespace: "user_facts",
          importance: 3,
          metadata: {
            session_id: "s",
            agent: "a",
            project_id: "p",
            title: "t",
            message_ids: [],
            participants: [],
          },
        },
      ],
    };

    expect(() => validateGranules(input)).toThrow("content");
  });

  it("выбрасывает ошибку когда granule — не объект", () => {
    const input = {
      summary: "test",
      granules: ["not_object"],
    };

    expect(() => validateGranules(input)).toThrow();
  });

  // ── Тесты для code_knowledge полей ──

  it("принимает гранулу с entity_type для code_knowledge", () => {
    const input = {
      summary: "Класс MCPClient",
      granules: [
        {
          content: "MCPClient — HTTP JSON-RPC клиент",
          namespace: "code_knowledge",
          importance: 4,
          metadata: {
            session_id: "sess_1",
            agent: "programmer",
            project_id: "akame",
            title: "MCPClient",
            message_ids: ["msg_1"],
            participants: ["Сона"],
            entity_type: "class",
            module_path: "src/mcp/client.ts",
            entity_name: "MCPClient",
            signature: "class MCPClient { constructor(config) }",
          },
        },
      ],
    };

    const result = validateGranules(input);
    expect(result.granules[0].metadata.entity_type).toBe("class");
    expect(result.granules[0].metadata.module_path).toBe("src/mcp/client.ts");
    expect(result.granules[0].metadata.entity_name).toBe("MCPClient");
    expect(result.granules[0].metadata.signature).toBe("class MCPClient { constructor(config) }");
  });

  it("принимает гранулу с links", () => {
    const input = {
      summary: "Зависимости MCPClient",
      granules: [
        {
          content: "MCPClient зависит от AkameConfig",
          namespace: "code_knowledge",
          importance: 3,
          metadata: {
            session_id: "sess_1",
            agent: "programmer",
            project_id: "akame",
            title: "Связь MCPClient → AkameConfig",
            message_ids: ["msg_1"],
            participants: ["Сона"],
            entity_type: "class",
            entity_name: "MCPClient",
            links: [
              { type: "depends_on", target: "AkameConfig", description: "использует конфиг" },
              { type: "used_by", target: "granulate-tool.ts", description: "используется в createGranulateTool" },
            ],
          },
        },
      ],
    };

    const result = validateGranules(input);
    expect(result.granules[0].metadata.links).toHaveLength(2);
    expect(result.granules[0].metadata.links![0].type).toBe("depends_on");
    expect(result.granules[0].metadata.links![0].target).toBe("AkameConfig");
    expect(result.granules[0].metadata.links![1].description).toBe("используется в createGranulateTool");
  });

  it("принимает гранулу с is_deprecated = true", () => {
    const input = {
      summary: "Устаревшая гранула",
      granules: [
        {
          content: "Старое описание",
          namespace: "code_knowledge",
          importance: 2,
          metadata: {
            session_id: "sess_1",
            agent: "programmer",
            project_id: "akame",
            title: "Старая гранула",
            message_ids: [],
            participants: [],
            is_deprecated: true,
          },
        },
      ],
    };

    const result = validateGranules(input);
    expect(result.granules[0].metadata.is_deprecated).toBe(true);
  });

  it("выбрасывает ошибку при невалидном entity_type", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "test",
          namespace: "code_knowledge",
          importance: 3,
          metadata: {
            session_id: "s",
            agent: "a",
            project_id: "p",
            title: "t",
            message_ids: [],
            participants: [],
            entity_type: "invalid_type",
          },
        },
      ],
    };

    expect(() => validateGranules(input)).toThrow("entity_type");
  });

  it("выбрасывает ошибку при невалидном link type", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "test",
          namespace: "code_knowledge",
          importance: 3,
          metadata: {
            session_id: "s",
            agent: "a",
            project_id: "p",
            title: "t",
            message_ids: [],
            participants: [],
            entity_type: "class",
            links: [{ type: "invalid_link", target: "something" }],
          },
        },
      ],
    };

    expect(() => validateGranules(input)).toThrow("links");
  });

  it("выбрасывает ошибку при link без target", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "test",
          namespace: "code_knowledge",
          importance: 3,
          metadata: {
            session_id: "s",
            agent: "a",
            project_id: "p",
            title: "t",
            message_ids: [],
            participants: [],
            entity_type: "class",
            links: [{ type: "depends_on", target: "" }],
          },
        },
      ],
    };

    expect(() => validateGranules(input)).toThrow("target");
  });

  it("принимает гранулу с source_location", () => {
    const input = {
      summary: "Функция",
      granules: [
        {
          content: "Функция validateGranules",
          namespace: "code_knowledge",
          importance: 3,
          metadata: {
            session_id: "s",
            agent: "a",
            project_id: "p",
            title: "t",
            message_ids: [],
            participants: [],
            source_location: "L42",
          },
        },
      ],
    };

    const result = validateGranules(input);
    expect(result.granules[0].metadata.source_location).toBe("L42");
  });

  // ── Универсальные тесты для всех namespace ──

  it("принимает entity_type: adr для project_meta", () => {
    const input = {
      summary: "ADR репозиторий",
      granules: [{
        content: "Repository Pattern принят",
        namespace: "project_meta",
        importance: 5,
        metadata: {
          session_id: "s", agent: "a", project_id: "selti",
          title: "ADR: Repository Pattern",
          message_ids: [], participants: ["Эна"],
          entity_type: "adr",
          entity_name: "ADR-001",
          adr_status: "accepted",
        },
      }],
    };
    const result = validateGranules(input);
    expect(result.granules[0].metadata.entity_type).toBe("adr");
    expect(result.granules[0].metadata.entity_name).toBe("ADR-001");
    expect(result.granules[0].metadata.adr_status).toBe("accepted");
  });

  it("принимает entity_type: person для user_facts", () => {
    const input = {
      summary: "Факт о пользователе",
      granules: [{
        content: "Серёжа — IT-специалист",
        namespace: "user_facts",
        importance: 4,
        metadata: {
          session_id: "s", agent: "a", project_id: "argent",
          title: "Серёжа",
          message_ids: [], participants: ["Серёжа"],
          entity_type: "person",
          entity_name: "Серёжа",
          confidence: 0.95,
        },
      }],
    };
    const result = validateGranules(input);
    expect(result.granules[0].metadata.entity_type).toBe("person");
    expect(result.granules[0].metadata.confidence).toBe(0.95);
  });

  it("принимает entity_type: insight для dialogue_insights", () => {
    const input = {
      summary: "Инсайт",
      granules: [{
        content: "user_id не является security boundary",
        namespace: "dialogue_insights",
        importance: 4,
        metadata: {
          session_id: "s", agent: "a", project_id: "selti",
          title: "user_id не security boundary",
          message_ids: [], participants: ["Лита", "Серёжа"],
          entity_type: "insight",
          entity_name: "user_id security",
          links: [{ type: "references", target: "ADR-002", description: "подтверждает ADR" }],
        },
      }],
    };
    const result = validateGranules(input);
    expect(result.granules[0].metadata.entity_type).toBe("insight");
    expect(result.granules[0].metadata.links![0].type).toBe("references");
  });

  it("принимает entity_type: decision для project_meta", () => {
    const input = {
      summary: "Решение",
      granules: [{
        content: "Выбрали pgvector",
        namespace: "project_meta",
        importance: 4,
        metadata: {
          session_id: "s", agent: "a", project_id: "selti",
          title: "Выбор pgvector",
          message_ids: [], participants: ["Нора"],
          entity_type: "decision",
          links: [
            { type: "alternative_to", target: "Milvus", description: "альтернатива" },
            { type: "causes", target: "Нужен точный поиск", description: "причина выбора" },
          ],
        },
      }],
    };
    const result = validateGranules(input);
    expect(result.granules[0].metadata.entity_type).toBe("decision");
    expect(result.granules[0].metadata.links![0].type).toBe("alternative_to");
    expect(result.granules[0].metadata.links![1].type).toBe("causes");
  });

  it("выбрасывает ошибку при невалидном adr_status", () => {
    const input = {
      summary: "test",
      granules: [{
        content: "test",
        namespace: "project_meta",
        importance: 3,
        metadata: {
          session_id: "s", agent: "a", project_id: "p",
          title: "t", message_ids: [], participants: [],
          adr_status: "invalid_status",
        },
      }],
    };
    expect(() => validateGranules(input)).toThrow("adr_status");
  });

  it("выбрасывает ошибку при невалидном confidence", () => {
    const input = {
      summary: "test",
      granules: [{
        content: "test",
        namespace: "user_facts",
        importance: 3,
        metadata: {
          session_id: "s", agent: "a", project_id: "p",
          title: "t", message_ids: [], participants: [],
          confidence: 999,
        },
      }],
    };
    expect(() => validateGranules(input)).toThrow("confidence");
  });

  it("принимает гранулу с новыми типами связей (references, follows, precedes)", () => {
    const input = {
      summary: "Планирование",
      granules: [{
        content: "Фаза 2 следует за Фазой 1",
        namespace: "project_meta",
        importance: 3,
        metadata: {
          session_id: "s", agent: "a", project_id: "p",
          title: "Фазы", message_ids: [], participants: [],
          entity_type: "status",
          links: [
            { type: "follows", target: "Фаза-1", description: "следует за" },
            { type: "precedes", target: "Фаза-3", description: "предшествует" },
            { type: "prevents", target: "Риск-1", description: "предотвращает" },
          ],
        },
      }],
    };
    const result = validateGranules(input);
    expect(result.granules[0].metadata.links).toHaveLength(3);
    expect(result.granules[0].metadata.links![0].type).toBe("follows");
    expect(result.granules[0].metadata.links![1].type).toBe("precedes");
    expect(result.granules[0].metadata.links![2].type).toBe("prevents");
  });
});
