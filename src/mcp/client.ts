// ── MCP HTTP клиент для athena-memory ──
// JSON-RPC 2.0 over HTTP POST
// Все методы: store, ingestBatch, search, get, update, delete, list, forget, stats, findSimilar

import type { AkameConfig } from "../constants.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { withRetry, type RetryConfig } from "./retry.js";

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
  private readonly circuit: CircuitBreaker;
  private readonly retryConfig: Partial<RetryConfig>;

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
    this.circuit = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 });
    this.retryConfig = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 5000 };
  }

  // ── Публичные методы ──

  /**
   * Вызов произвольного MCP tool по имени.
   * Используется для серверных tools (memory_graph_stats, memory_get_relations и т.д.)
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    isReadOperation: boolean = true,
  ): Promise<unknown> {
    return this.call(name, args, isReadOperation);
  }

  async ingestBatch(
    entries: GranuleEntry[],
    userId: string
  ): Promise<IngestBatchResult> {
    return this.call("memory_ingest_batch", {
      entries,
      user_id: userId,
    }, false) as Promise<IngestBatchResult>;
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
    }, false) as Promise<Record<string, unknown>>;
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
    }, true) as Promise<SearchResult[]>;
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.call("memory_get", { id }, true) as Promise<MemoryRecord | null>;
  }

  async update(
    id: string,
    content?: string,
    metadata?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.call("memory_update", { id, content, metadata }, false) as Promise<
      Record<string, unknown>
    >;
  }

  async delete(id: string): Promise<Record<string, unknown>> {
    return this.call("memory_delete", { id }, false) as Promise<
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
    }, true) as Promise<{ items: MemoryRecord[]; total: number }>;
  }

  async forget(
    userId: string,
    namespace?: string
  ): Promise<{ deleted_count: number }> {
    return this.call("memory_forget", {
      user_id: userId,
      namespace,
    }, false) as Promise<{ deleted_count: number }>;
  }

  async stats(userId: string): Promise<MemoryStats[]> {
    return this.call("memory_stats", { user_id: userId }, true) as Promise<
      MemoryStats[]
    >;
  }

  async recent(
    namespace?: string,
    limit?: number,
    since?: string
  ): Promise<MemoryRecord[]> {
    return this.call("memory_recent", {
      namespace,
      limit,
      since,
    }, true) as Promise<MemoryRecord[]>;
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
    }, true) as Promise<SearchResult[]>;
  }

  // ── Внутренние методы ──

  /**
   * Вызов MCP-сервера с retry и circuit breaker.
   * @param isReadOperation — если true, используются retry. Write-операции (store, update, delete, ingestBatch) — без retry.
   */
  private async call(
    method: string,
    params: Record<string, unknown>,
    isReadOperation: boolean = true,
  ): Promise<unknown> {
    // Circuit breaker check
    if (!this.circuit.canExecute()) {
      throw new Error(
        `Circuit breaker OPEN: too many failures. Retry after ${this.circuit.getState()}`,
      );
    }

    const doRequest = async (): Promise<unknown> => {
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
            `MCP HTTP ${response.status}: ${text.slice(0, 200)}`,
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
              `MCP error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
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
            `MCP error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
          );
        }
        return parsed.result;
      } finally {
        clearTimeout(timer);
      }
    };

    // Retry только для read-операций
    if (isReadOperation) {
      try {
        const result = await withRetry(doRequest, this.retryConfig);
        this.circuit.onSuccess();
        return result;
      } catch (err) {
        this.circuit.onFailure();
        throw err;
      }
    }

    // Write-операции — без retry
    try {
      const result = await doRequest();
      this.circuit.onSuccess();
      return result;
    } catch (err) {
      this.circuit.onFailure();
      throw err;
    }
  }
}