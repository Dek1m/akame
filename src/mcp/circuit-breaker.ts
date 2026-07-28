// ── Circuit Breaker ──

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Количество последовательных ошибок до открытия цепи */
  failureThreshold: number;
  /** Время восстановления (мс) */
  resetTimeoutMs: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
};

/**
 * Circuit breaker для MCP-клиента.
 * После failureThreshold последовательных ошибок — "открывает" цепь
 * и не пропускает запросы в течение resetTimeoutMs.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  getState(): CircuitState {
    if (this.state === "open") {
      // Проверяем, прошло ли время восстановления
      if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state = "half_open";
      }
    }
    return this.state;
  }

  /** Вызывается при успешном запросе */
  onSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  /** Вызывается при ошибке */
  onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = "open";
    }
  }

  /** Проверка: можно ли делать запрос */
  canExecute(): boolean {
    const state = this.getState();
    return state !== "open";
  }

  /** Сбросить circuit breaker */
  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }

  getFailureCount(): number {
    return this.failureCount;
  }
}
