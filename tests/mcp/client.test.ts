import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCPClient } from "../../src/mcp/client.js";

// Мокаем fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSSEResponse(data: unknown) {
  const lines = `data: ${JSON.stringify(data)}`;
  return new Response(lines, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("MCPClient", () => {
  const client = new MCPClient({
    mcpUrl: "http://localhost:8000/mcp/",
    apiKey: undefined,
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ingestBatch отправляет JSON-RPC", async () => {
    mockFetch.mockResolvedValueOnce(
      makeSSEResponse({
        result: {
          content: [
            {
              text: JSON.stringify({
                inserted: 1,
                skipped: 0,
                updated: 0,
                total: 1,
              }),
            },
          ],
        },
      })
    );

    const result = await client.ingestBatch(
      [{ content: "test", namespace: "user_facts" }],
      "test-user"
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/mcp",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      })
    );
    expect(result.inserted).toBe(1);
  });

  it("store отправляет memory_store", async () => {
    mockFetch.mockResolvedValueOnce(
      makeSSEResponse({
        result: {
          content: [{ text: JSON.stringify({ id: "123", content: "test" }) }],
        },
      })
    );

    const result = await client.store("test", "user");
    expect(result.id).toBe("123");
  });

  it("выбрасывает ошибку при HTTP 4xx", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(makeResponse({ error: "bad request" }, 400))
    );

    await expect(client.get("bad-id")).rejects.toThrow("MCP HTTP 400");
  });

  it("выбрасывает ошибку при MCP error", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        makeSSEResponse({
          error: { code: -32000, message: "not found" },
        })
      )
    );

    await expect(client.get("id")).rejects.toThrow("MCP error: not found");
  });

  it("добавляет Authorization при apiKey", async () => {
    const authedClient = new MCPClient({
      mcpUrl: "http://localhost:8000/mcp/",
      apiKey: "secret-key",
    });

    mockFetch.mockResolvedValueOnce(
      makeSSEResponse({
        result: { content: [{ text: JSON.stringify({}) }] },
      })
    );

    await authedClient.stats("user");

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Authorization"]).toBe("Bearer secret-key");
  });

  it("handleSessionIdle корректно парсит JSON-RPC ответ", async () => {
    mockFetch.mockResolvedValueOnce(
      makeSSEResponse({
        result: {
          content: [
            {
              text: JSON.stringify({
                namespace: "user_facts",
                count: 42,
              }),
            },
          ],
        },
      })
    );

    const result = await client.stats("user");
    expect(result).toEqual({ namespace: "user_facts", count: 42 });
  });

  it("handleSessionIdle обрабатывает прямой JSON-RPC ответ (без SSE)", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse({
        result: { items: [], total: 0 },
      })
    );

    const result = await client.list("user");
    expect(result).toEqual({ items: [], total: 0 });
  });

  it("handleSessionIdle обрабатывает прямой JSON-RPC error", async () => {
    // Фабрика для создания нового Response при каждом вызове
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        makeResponse({
          error: { code: -32600, message: "invalid request" },
        })
      )
    );

    await expect(client.get("id")).rejects.toThrow("MCP error: invalid request");
  });

  it("removeTrailingSlash обрезает слэши из URL", async () => {
    const slashClient = new MCPClient({
      mcpUrl: "http://localhost:8000/mcp///",
      apiKey: undefined,
    });

    mockFetch.mockResolvedValueOnce(
      makeSSEResponse({
        result: { content: [{ text: JSON.stringify({ count: 0 }) }] },
      })
    );

    await slashClient.stats("user");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/mcp");
  });
});
