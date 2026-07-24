// ── MCP HTTP клиент для athena-memory ──
// JSON-RPC 2.0 over HTTP POST
// Все методы: store, ingestBatch, search, get, update, delete, list, forget, stats, findSimilar

import type { AkameConfig } from "../constants.js";

// ── Типы ──

export interface GranuleEntry {
  content: string;
  metadata?: Record<string, unknown>;
  namespace?: string;
}

export interface IngestBatchResult {
  inserted: number;
  skipped: number;
  updated: number;
  total: number;
}

export interface MemoryRecord {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  namespace: string;
  created_at: string;
  updated_at: string;
  content_hash?: string;
}

export interface SearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface MemoryStats {
  namespace: string;
  count: number;
  last_updated: string | null;
}

// ── MCP Client ──

export class MCPClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;

  constructor(config: Pick<AkameConfig, "mcpUrl" | "apiKey">) {
    this.baseUrl = config.mcpUrl.replace(/\/+$/, "");
    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream, */*",
    };
    if (config.apiKey) {
      this.headers["Authorization"] = `Bearer ${config.apiKey}`;
    }
    this.timeout = 30000;
  }

  // ── Публичные методы ──

  async ingestBatch(
    entries: GranuleEntry[],
    userId: string
  ): Promise<IngestBatchResult> {
    return this.call("memory_ingest_batch", {
      entries,
      user_id: userId,
    }) as Promise<IngestBatchResult>;
  }

  async store(
    content: string,
    userId: string,
    metadata?: Record<string, unknown>,
    namespace?: string
  ): Promise<Record<string, unknown>> {
    return this.call("memory_store", {
      content,
      user_id: userId,
      metadata,
      namespace,
    }) as Promise<Record<string, unknown>>;
  }

  async search(
    query: string,
    userId: string,
    limit?: number,
    threshold?: number,
    namespace?: string
  ): Promise<SearchResult[]> {
    return this.call("memory_search", {
      query,
      user_id: userId,
      limit,
      threshold,
      namespace,
    }) as Promise<SearchResult[]>;
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.call("memory_get", { id }) as Promise<MemoryRecord | null>;
  }

  async update(
    id: string,
    content?: string,
    metadata?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.call("memory_update", { id, content, metadata }) as Promise<
      Record<string, unknown>
    >;
  }

  async delete(id: string): Promise<Record<string, unknown>> {
    return this.call("memory_delete", { id }) as Promise<
      Record<string, unknown>
    >;
  }

  async list(
    userId?: string,
    namespace?: string,
    limit?: number,
    offset?: number
  ): Promise<{ items: MemoryRecord[]; total: number }> {
    return this.call("memory_list", {
      user_id: userId,
      namespace,
      limit,
      offset,
    }) as Promise<{ items: MemoryRecord[]; total: number }>;
  }

  async forget(
    userId: string,
    namespace?: string
  ): Promise<{ deleted_count: number }> {
    return this.call("memory_forget", {
      user_id: userId,
      namespace,
    }) as Promise<{ deleted_count: number }>;
  }

  async stats(userId: string): Promise<MemoryStats[]> {
    return this.call("memory_stats", { user_id: userId }) as Promise<
      MemoryStats[]
    >;
  }

  async findSimilar(
    content: string,
    userId: string,
    limit?: number,
    threshold?: number,
    namespace?: string
  ): Promise<SearchResult[]> {
    return this.call("memory_find_similar", {
      content,
      user_id: userId,
      limit,
      threshold,
      namespace,
    }) as Promise<SearchResult[]>;
  }

  // ── Внутренние методы ──

  private async call(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const id = crypto.randomUUID();
    const payload = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: method,
        arguments: params,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `MCP HTTP ${response.status}: ${text.slice(0, 200)}`
        );
      }

      const raw = await response.text();

      // SSE-совместимый ответ: может быть data: {...} строками
      const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
      if (lines.length > 0) {
        const lastData = lines[lines.length - 1];
        const parsed = JSON.parse(lastData.slice(6));
        if (parsed.error) {
          throw new Error(
            `MCP error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`
          );
        }
        return parsed.result?.content?.[0]?.text
          ? JSON.parse(parsed.result.content[0].text)
          : parsed.result;
      }

      // Прямой JSON-RPC ответ
      const parsed = JSON.parse(raw);
      if (parsed.error) {
        throw new Error(
          `MCP error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`
        );
      }
      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  }
}