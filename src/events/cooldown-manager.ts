export class CooldownManager {
  private cooldowns: Map<string, number> = new Map();
  private lastGlobal: number = 0;
  private granulatedSessions: Set<string> = new Set();
  readonly GLOBAL_COOLDOWN: number = 5000;

  /** true если глобальный кулдаун ещё не прошёл (надо пропустить) */
  checkGlobal(): boolean {
    return Date.now() - this.lastGlobal < this.GLOBAL_COOLDOWN;
  }

  setGlobal(): void {
    this.lastGlobal = Date.now();
  }

  /** true если ключ на кулдауне (ещё не прошло ms с последней установки) */
  check(key: string, ms: number): boolean {
    const last = this.cooldowns.get(key) || 0;
    return Date.now() - last < ms;
  }

  set(key: string): void {
    this.cooldowns.set(key, Date.now());
  }

  /** Сессия уже гранулирована через session.idle */
  isSessionGranulated(sessionId: string): boolean {
    return this.granulatedSessions.has(sessionId);
  }

  markSessionGranulated(sessionId: string): void {
    this.granulatedSessions.add(sessionId);
  }

  reset(): void {
    this.lastGlobal = 0;
    this.cooldowns.clear();
    this.granulatedSessions.clear();
  }
}
