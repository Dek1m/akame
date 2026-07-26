export class DebounceManager {
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private defaultMs: number;

  constructor(defaultMs: number) {
    this.defaultMs = defaultMs;
  }

  debounce(key: string, fn: () => Promise<void>, ms?: number): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.timers.delete(key);
      await fn();
    }, ms ?? this.defaultMs);

    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  cancelAll(): void {
    for (const [, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
