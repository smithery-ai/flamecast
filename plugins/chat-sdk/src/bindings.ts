import type { Thread } from "chat";

export type ThreadBinding = {
  threadId: string;
  bindingId: string;
  thread: Thread;
};

export class InMemoryThreadBindingStore {
  private readonly byThreadId = new Map<string, ThreadBinding>();
  private readonly threadIdByBindingId = new Map<string, string>();

  getByThreadId(threadId: string): ThreadBinding | null {
    return this.byThreadId.get(threadId) ?? null;
  }

  getByBindingId(bindingId: string): ThreadBinding | null {
    const threadId = this.threadIdByBindingId.get(bindingId);
    return threadId ? (this.byThreadId.get(threadId) ?? null) : null;
  }

  set(binding: ThreadBinding): void {
    const existing = this.byThreadId.get(binding.threadId);
    if (existing) {
      this.threadIdByBindingId.delete(existing.bindingId);
    }

    this.byThreadId.set(binding.threadId, binding);
    this.threadIdByBindingId.set(binding.bindingId, binding.threadId);
  }

  deleteByThreadId(threadId: string): ThreadBinding | null {
    const binding = this.byThreadId.get(threadId) ?? null;
    if (!binding) {
      return null;
    }

    this.byThreadId.delete(threadId);
    this.threadIdByBindingId.delete(binding.bindingId);
    return binding;
  }

  list(): ThreadBinding[] {
    return [...this.byThreadId.values()];
  }

  clear(): void {
    this.byThreadId.clear();
    this.threadIdByBindingId.clear();
  }
}
