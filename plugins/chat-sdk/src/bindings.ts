export type ThreadBinding = {
  threadId: string;
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
};

export type ThreadBindingStore = {
  get(threadId: string): Promise<ThreadBinding | null>;
  set(binding: ThreadBinding): Promise<void>;
  touch(threadId: string, timestamp: string): Promise<void>;
};

export class InMemoryThreadBindingStore implements ThreadBindingStore {
  private readonly bindings = new Map<string, ThreadBinding>();

  async get(threadId: string): Promise<ThreadBinding | null> {
    return this.bindings.get(threadId) ?? null;
  }

  async set(binding: ThreadBinding): Promise<void> {
    this.bindings.set(binding.threadId, { ...binding });
  }

  async touch(threadId: string, timestamp: string): Promise<void> {
    const binding = this.bindings.get(threadId);
    if (!binding) {
      return;
    }
    this.bindings.set(threadId, {
      ...binding,
      lastSeenAt: timestamp,
    });
  }
}
