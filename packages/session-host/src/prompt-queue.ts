/**
 * Standalone prompt queue — manages queue data only.
 * Does not call connection.prompt() or broadcast WS events.
 * The caller (session-host index.ts) drives execution and broadcasting.
 */

export interface QueueItem {
  queueId: string;
  text: string;
  createdAt: string;
  position: number;
}

export interface ProcessingItem {
  queueId: string;
  text: string;
  startedAt: string;
}

export interface QueueState {
  processing: boolean;
  paused: boolean;
  items: Array<{
    queueId: string;
    text: string;
    enqueuedAt: string;
    position: number;
  }>;
  size: number;
}

export class PromptQueue {
  static readonly MAX_SIZE = 50;

  private items: QueueItem[] = [];
  private processing: ProcessingItem | null = null;
  private paused = false;

  enqueue(text: string): { queueId: string; position: number } {
    if (this.items.length >= PromptQueue.MAX_SIZE) {
      throw new Error(`Queue is full (max ${PromptQueue.MAX_SIZE} items)`);
    }
    const queueId = crypto.randomUUID();
    const position = this.items.length;
    this.items.push({
      queueId,
      text,
      createdAt: new Date().toISOString(),
      position,
    });
    return { queueId, position };
  }

  markProcessing(queueId: string): void {
    const idx = this.items.findIndex((i) => i.queueId === queueId);
    if (idx === -1) throw new Error(`Queue item "${queueId}" not found`);
    const [item] = this.items.splice(idx, 1);
    this.reindex();
    this.processing = {
      queueId: item.queueId,
      text: item.text,
      startedAt: new Date().toISOString(),
    };
  }

  completeProcessing(): void {
    this.processing = null;
  }

  /** Returns the next item to process, or null if paused or empty. Does NOT remove it from the queue. */
  dequeueNext(): QueueItem | null {
    if (this.paused || this.items.length === 0) return null;
    return this.items[0];
  }

  cancel(queueId: string): boolean {
    if (this.processing?.queueId === queueId) return false;
    const idx = this.items.findIndex((i) => i.queueId === queueId);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    this.reindex();
    return true;
  }

  /** Removes all queued items (does not affect the currently processing item). Returns count removed. */
  clear(): number {
    const count = this.items.length;
    this.items = [];
    return count;
  }

  /** Reorder the queue. `orderedQueueIds` must contain exactly the current queue IDs. */
  reorder(orderedQueueIds: string[]): void {
    if (orderedQueueIds.length !== this.items.length) {
      throw new Error(
        `Reorder array length (${orderedQueueIds.length}) does not match queue size (${this.items.length})`,
      );
    }

    const seen = new Set<string>();
    for (const id of orderedQueueIds) {
      if (seen.has(id)) throw new Error(`Duplicate queue ID: "${id}"`);
      seen.add(id);
    }

    const byId = new Map(this.items.map((item) => [item.queueId, item]));
    const reordered: QueueItem[] = [];

    for (const id of orderedQueueIds) {
      const item = byId.get(id);
      if (!item) throw new Error(`Unknown queue ID: "${id}"`);
      reordered.push(item);
    }

    this.items = reordered;
    this.reindex();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isProcessing(): boolean {
    return this.processing !== null;
  }

  get size(): number {
    return this.items.length;
  }

  getState(): QueueState {
    return {
      processing: this.processing !== null,
      paused: this.paused,
      items: this.items.map((item) => ({
        queueId: item.queueId,
        text: item.text,
        enqueuedAt: item.createdAt,
        position: item.position,
      })),
      size: this.items.length,
    };
  }

  private reindex(): void {
    for (let i = 0; i < this.items.length; i++) {
      this.items[i].position = i;
    }
  }
}
