import type { AkameConfig } from '../constants.js';
import type { Logger } from '../logger.js';
import type { GranulateContext } from './engine.js';

// ── Типы ──

export interface BatchEntry {
  sessionId: string;
  event: 'idle' | 'compacted' | 'diff' | 'file' | 'tool';
  enqueuedAt: number;
}

export interface PendingEntry extends BatchEntry {
  context: GranulateContext;
  resolve: () => void;
  reject: (err: Error) => void;
}

export type BatchFlushFn = (entries: PendingEntry[]) => Promise<void>;

// ── Класс ──

export class BatchAccumulator {
  private queue: PendingEntry[] = [];
  private queuedMap: Map<string, PendingEntry> = new Map();
  private recentlyFlushed: Set<string> = new Set();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: boolean = false;
  private disposed: boolean = false;

  constructor(
    private config: AkameConfig,
    private log: Logger,
    private flushFn: BatchFlushFn,
  ) {}

  // ── Геттеры ──

  get size(): number {
    return this.queue.length;
  }

  get pendingCount(): number {
    return this.queue.length + (this.flushing ? 1 : 0);
  }

  // ── Постановка в очередь ──

  async enqueue(entry: BatchEntry, context: GranulateContext): Promise<void> {
    if (this.disposed) {
      throw new Error('BatchAccumulator is disposed');
    }

    // Уже гранулировано недавно
    if (this.recentlyFlushed.has(entry.sessionId)) {
      this.log.debug(`batch: skip ${entry.sessionId} — recently flushed`);
      return;
    }

    // Правила замены при дубликате sessionId в очереди
    if (this.queuedMap.has(entry.sessionId)) {
      const existing = this.queuedMap.get(entry.sessionId)!;
      if (
        (existing.event === 'idle' && entry.event === 'compacted') ||
        (existing.event === 'diff' && entry.event === 'compacted')
      ) {
        // Заменить: новое событие «финальнее»
        this.removeFromQueue(existing);
        existing.reject(new Error('Replaced by higher-priority event'));
      } else if (existing.event === 'compacted' && entry.event === 'idle') {
        // skip: idle не заменяет compacted
        this.log.debug(`batch: skip ${entry.sessionId} — compacted already queued`);
        return;
      } else {
        // Добавить (разные события для одной сессии)
        // Продолжаем ниже
      }
    }

    return new Promise<void>((resolve, reject) => {
      const pending: PendingEntry = {
        ...entry,
        context,
        resolve,
        reject,
      };

      this.queue.push(pending);
      this.queuedMap.set(entry.sessionId, pending);

      if (this.queue.length >= this.config.batchSize) {
        this.doFlush();
      } else {
        this.scheduleMaxAgeFlush();
      }
    });
  }

  // ── Принудительный сброс (весь накопленный) ──

  async flush(): Promise<void> {
    // doFlush с размером batch = queue.length (всё, что есть)
    await this.doFlush(this.queue.length);
  }

  // ── Очистка ──

  async dispose(): Promise<void> {
    if (this.disposed) return;

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const err = new Error('BatchAccumulator disposed');
    for (const entry of this.queue) {
      entry.reject(err);
    }

    this.queue = [];
    this.queuedMap.clear();
    this.recentlyFlushed.clear();
    this.disposed = true;
  }

  // ── Приватные методы ──

  private shouldFlush(): boolean {
    return this.queue.length >= this.config.batchSize;
  }

  private scheduleMaxAgeFlush(): void {
    if (this.flushTimer !== null) return; // уже запланирован
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.doFlush();
    }, this.config.batchMaxAgeMs);
  }

  private async doFlush(count?: number): Promise<void> {
    const take = count ?? this.config.batchSize;

    if (this.flushing || this.queue.length === 0) return;

    this.flushing = true;

    // Снять таймер
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Атомарно взять batch
    const batch = this.queue.splice(0, Math.min(take, this.queue.length));

    // Очистить queuedMap для записей из batch
    for (const entry of batch) {
      this.queuedMap.delete(entry.sessionId);
    }

    try {
      this.log.debug(`batch: flushing ${batch.length} entries`);
      await this.flushFn(batch);

      // Успех — резолвим все, добавляем в recentlyFlushed
      for (const entry of batch) {
        entry.resolve();
        this.recentlyFlushed.add(entry.sessionId);
      }

      this.log.info(`batch: flushed ${batch.length} entries successfully`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error(`batch: flush failed — ${error.message}`);

      // Ошибка — реджектим все
      for (const entry of batch) {
        entry.reject(error);
      }
    } finally {
      this.flushing = false;
    }

    // Если в очереди ещё есть — продолжить
    if (this.queue.length > 0) {
      if (this.shouldFlush()) {
        this.doFlush();
      } else {
        this.scheduleMaxAgeFlush();
      }
    }
  }

  private removeFromQueue(entry: PendingEntry): void {
    const idx = this.queue.indexOf(entry);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }
    this.queuedMap.delete(entry.sessionId);
  }
}

// ── Module-level singleton ──

let _instance: BatchAccumulator | null = null;

export function initAccumulator(acc: BatchAccumulator): void {
  _instance = acc;
}

export function getAccumulator(): BatchAccumulator {
  if (!_instance) {
    throw new Error(
      'BatchAccumulator не инициализирован. Вызови initAccumulator() перед использованием.',
    );
  }
  return _instance;
}

export function resetAccumulator(): void {
  _instance = null;
}
