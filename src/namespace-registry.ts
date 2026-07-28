// ── NamespaceRegistry — динамическая загрузка namespace из athena-memory ──
// Загружает список namespace из MCP сервера и кэширует в памяти.
// Используется вместо хардкода в constants.ts.

import type { NamespaceRecord } from "./mcp/client.js";
import type { MCPClient } from "./mcp/client.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут

export class NamespaceRegistry {
  private client: MCPClient;
  private cache: NamespaceRecord[] | null = null;
  private cacheTime = 0;
  private fetchPromise: Promise<NamespaceRecord[]> | null = null;

  constructor(client: MCPClient) {
    this.client = client;
  }

  /**
   * Получить все namespace из реестра.
   * При первом вызове загружает с сервера, потом кэширует.
   */
  async getAll(): Promise<NamespaceRecord[]> {
    // Проверяем кэш
    if (this.cache && Date.now() - this.cacheTime < CACHE_TTL_MS) {
      return this.cache;
    }

    // Дедупликация параллельных запросов
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    this.fetchPromise = this.fetchFromServer();
    try {
      this.cache = await this.fetchPromise;
      this.cacheTime = Date.now();
      return this.cache;
    } finally {
      this.fetchPromise = null;
    }
  }

  /**
   * Получить только uid namespace (для использования в enum и промптах).
   */
  async getUids(): Promise<string[]> {
    const all = await this.getAll();
    return all.map((ns) => ns.uid);
  }

  /**
   * Получить описание namespace по uid.
   */
  async getDescription(uid: string): Promise<string | undefined> {
    const all = await this.getAll();
    return all.find((ns) => ns.uid === uid)?.description;
  }

  /**
   * Проверить существует ли namespace.
   */
  async exists(uid: string): Promise<boolean> {
    const all = await this.getAll();
    return some((ns) => ns.uid === uid, all);
  }

  /**
   * Принудительно обновить кэш.
   */
  async refresh(): Promise<NamespaceRecord[]> {
    this.cache = null;
    this.cacheTime = 0;
    return this.getAll();
  }

  private async fetchFromServer(): Promise<NamespaceRecord[]> {
    try {
      return await this.client.namespaces();
    } catch (err) {
      // Fallback: дефолтные namespace если сервер недоступен
      console.error("Failed to fetch namespaces from server, using defaults:", err);
      return [
        { uid: "user_facts", name: "User Facts", description: "Профили, характеры, предпочтения пользователя" },
        { uid: "project_meta", name: "Project Meta", description: "Архитектурные решения, статус проекта" },
        { uid: "dialogue_insights", name: "Dialogue Insights", description: "Инсайты и договорённости из диалогов" },
        { uid: "code_knowledge", name: "Code Knowledge", description: "Гранулы кода: модули, классы, функции" },
        { uid: "infrastructure", name: "Infrastructure", description: "Серверы, контейнеры, сети, API" },
      ];
    }
  }
}

// ── Вспомогательная функция ──

function some(predicate: (item: NamespaceRecord) => boolean, list: NamespaceRecord[]): boolean {
  for (const item of list) {
    if (predicate(item)) return true;
  }
  return false;
}
