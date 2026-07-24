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

  it("выбрасывает ошибку при невалидном namespace", () => {
    const input = {
      summary: "test",
      granules: [
        {
          content: "test",
          namespace: "wrong_namespace",
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

    expect(() => validateGranules(input)).toThrow("namespace");
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
});
