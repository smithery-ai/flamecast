import { describe, it, expect, beforeEach } from "vitest";
import { PromptQueue } from "../src/prompt-queue.js";

/** Helper: dequeue and assert non-null. */
function mustDequeue(queue: PromptQueue) {
  const item = queue.dequeueNext();
  if (!item) throw new Error("Expected a queue item but got null");
  return item;
}

describe("PromptQueue", () => {
  let queue: PromptQueue;

  beforeEach(() => {
    queue = new PromptQueue();
  });

  // ---- enqueue / dequeue ----

  it("enqueues and dequeues in FIFO order", () => {
    queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("third");

    const next = mustDequeue(queue);
    expect(next.text).toBe("first");

    queue.markProcessing(next.queueId);
    queue.completeProcessing();

    const second = mustDequeue(queue);
    expect(second.text).toBe("second");
  });

  it("returns position starting from 0", () => {
    const a = queue.enqueue("a");
    const b = queue.enqueue("b");
    const c = queue.enqueue("c");

    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
    expect(c.position).toBe(2);
  });

  it("returns null when empty", () => {
    expect(queue.dequeueNext()).toBeNull();
  });

  it("throws when queue is full", () => {
    for (let i = 0; i < PromptQueue.MAX_SIZE; i++) {
      queue.enqueue(`prompt-${i}`);
    }
    expect(() => queue.enqueue("overflow")).toThrow(/full/);
  });

  // ---- markProcessing / completeProcessing ----

  it("tracks processing state", () => {
    queue.enqueue("test");
    expect(queue.isProcessing).toBe(false);

    const item = mustDequeue(queue);
    queue.markProcessing(item.queueId);
    expect(queue.isProcessing).toBe(true);
    expect(queue.size).toBe(0); // removed from queue

    queue.completeProcessing();
    expect(queue.isProcessing).toBe(false);
  });

  it("throws when markProcessing with unknown id", () => {
    expect(() => queue.markProcessing("nonexistent")).toThrow(/not found/);
  });

  // ---- cancel ----

  it("cancels a queued item", () => {
    const { queueId } = queue.enqueue("to-cancel");
    queue.enqueue("keep");

    expect(queue.cancel(queueId)).toBe(true);
    expect(queue.size).toBe(1);

    const next = mustDequeue(queue);
    expect(next.text).toBe("keep");
  });

  it("returns false when cancelling the processing item", () => {
    queue.enqueue("processing");
    const item = mustDequeue(queue);
    queue.markProcessing(item.queueId);

    expect(queue.cancel(item.queueId)).toBe(false);
  });

  it("returns false for unknown queueId", () => {
    expect(queue.cancel("unknown")).toBe(false);
  });

  it("reindexes positions after cancel", () => {
    queue.enqueue("a");
    const { queueId } = queue.enqueue("b");
    queue.enqueue("c");

    queue.cancel(queueId);
    const state = queue.getState();
    expect(state.items.map((i) => i.position)).toEqual([0, 1]);
  });

  // ---- clear ----

  it("clears all queued items", () => {
    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");

    const count = queue.clear();
    expect(count).toBe(3);
    expect(queue.size).toBe(0);
    expect(queue.dequeueNext()).toBeNull();
  });

  it("clear does not affect processing item", () => {
    queue.enqueue("processing");
    queue.enqueue("queued");
    const item = mustDequeue(queue);
    queue.markProcessing(item.queueId);

    queue.clear();
    expect(queue.isProcessing).toBe(true);
    expect(queue.size).toBe(0);
  });

  // ---- reorder ----

  it("reorders the queue", () => {
    const a = queue.enqueue("a");
    const b = queue.enqueue("b");
    const c = queue.enqueue("c");

    queue.reorder([c.queueId, a.queueId, b.queueId]);

    const state = queue.getState();
    expect(state.items.map((i) => i.text)).toEqual(["c", "a", "b"]);
    expect(state.items.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it("throws on reorder with wrong length", () => {
    queue.enqueue("a");
    queue.enqueue("b");

    expect(() => queue.reorder(["only-one"])).toThrow(/length/);
  });

  it("throws on reorder with unknown ID", () => {
    const a = queue.enqueue("a");
    queue.enqueue("b");

    expect(() => queue.reorder([a.queueId, "unknown"])).toThrow(/Unknown/);
  });

  it("throws on reorder with duplicate ID", () => {
    const a = queue.enqueue("a");
    queue.enqueue("b");

    expect(() => queue.reorder([a.queueId, a.queueId])).toThrow(/Duplicate/);
  });

  // ---- pause / resume ----

  it("pause prevents dequeueNext from returning items", () => {
    queue.enqueue("blocked");
    queue.pause();

    expect(queue.isPaused).toBe(true);
    expect(queue.dequeueNext()).toBeNull();
    expect(queue.size).toBe(1); // still there
  });

  it("resume allows dequeueNext again", () => {
    queue.enqueue("waiting");
    queue.pause();
    queue.resume();

    expect(queue.isPaused).toBe(false);
    expect(queue.dequeueNext()).not.toBeNull();
  });

  // ---- getState ----

  it("returns correct state shape", () => {
    queue.enqueue("a");
    queue.enqueue("b");

    const state = queue.getState();
    expect(state).toEqual({
      processing: false,
      paused: false,
      items: [
        {
          queueId: expect.any(String),
          text: "a",
          enqueuedAt: expect.any(String),
          position: 0,
        },
        {
          queueId: expect.any(String),
          text: "b",
          enqueuedAt: expect.any(String),
          position: 1,
        },
      ],
      size: 2,
    });
  });

  it("reflects processing state in getState", () => {
    queue.enqueue("test");
    const item = mustDequeue(queue);
    queue.markProcessing(item.queueId);

    const state = queue.getState();
    expect(state.processing).toBe(true);
    expect(state.items).toEqual([]);
    expect(state.size).toBe(0);
  });

  it("reflects paused state in getState", () => {
    queue.pause();
    const state = queue.getState();
    expect(state.paused).toBe(true);
  });
});

/**
 * Tests that simulate the exact sequence of queue operations performed by
 * session-host's index.ts execution loop. No HTTP/WS/ACP infra needed —
 * just verifies the queue state machine drives correctly.
 */
describe("Execution loop simulation", () => {
  /** Mimics the flow in handleControl/HTTP: enqueue → maybe execute → on complete, dequeue next. */
  function simulateLoop() {
    const queue = new PromptQueue();
    let busy = false;
    const executed: string[] = [];

    function submitPrompt(text: string): { queued: boolean; queueId: string } {
      if (busy) {
        const { queueId } = queue.enqueue(text);
        return { queued: true, queueId };
      }
      queue.enqueue(text);
      const next = queue.dequeueNext();
      if (!next) throw new Error("Unexpected empty queue");
      queue.markProcessing(next.queueId);
      busy = true;
      executed.push(next.text);
      return { queued: false, queueId: next.queueId };
    }

    function completeCurrentPrompt(): void {
      busy = false;
      queue.completeProcessing();
      const next = queue.dequeueNext();
      if (next) {
        queue.markProcessing(next.queueId);
        busy = true;
        executed.push(next.text);
      }
    }

    return { queue, submitPrompt, completeCurrentPrompt, executed, isBusy: () => busy };
  }

  it("first prompt executes immediately", () => {
    const loop = simulateLoop();
    const result = loop.submitPrompt("hello");

    expect(result.queued).toBe(false);
    expect(loop.executed).toEqual(["hello"]);
    expect(loop.isBusy()).toBe(true);
  });

  it("second prompt queues when busy", () => {
    const loop = simulateLoop();
    loop.submitPrompt("first");
    const result = loop.submitPrompt("second");

    expect(result.queued).toBe(true);
    expect(loop.executed).toEqual(["first"]);
    expect(loop.queue.size).toBe(1);
  });

  it("auto-dequeues on completion", () => {
    const loop = simulateLoop();
    loop.submitPrompt("first");
    loop.submitPrompt("second");

    loop.completeCurrentPrompt();

    expect(loop.executed).toEqual(["first", "second"]);
    expect(loop.isBusy()).toBe(true);
    expect(loop.queue.size).toBe(0);
  });

  it("drains full queue in FIFO order", () => {
    const loop = simulateLoop();
    loop.submitPrompt("a");
    loop.submitPrompt("b");
    loop.submitPrompt("c");

    loop.completeCurrentPrompt(); // a done → b starts
    loop.completeCurrentPrompt(); // b done → c starts
    loop.completeCurrentPrompt(); // c done → idle

    expect(loop.executed).toEqual(["a", "b", "c"]);
    expect(loop.isBusy()).toBe(false);
  });

  it("pause stops auto-dequeue", () => {
    const loop = simulateLoop();
    loop.submitPrompt("first");
    loop.submitPrompt("second");

    loop.queue.pause();
    loop.completeCurrentPrompt();

    expect(loop.executed).toEqual(["first"]);
    expect(loop.isBusy()).toBe(false); // idle despite queued item
    expect(loop.queue.size).toBe(1);
  });

  it("resume after pause triggers dequeue", () => {
    const loop = simulateLoop();
    loop.submitPrompt("first");
    loop.submitPrompt("second");

    loop.queue.pause();
    loop.completeCurrentPrompt(); // first done, second stays queued

    loop.queue.resume();
    // Simulate what index.ts does on resume: check for next item
    const next = loop.queue.dequeueNext();
    expect(next).not.toBeNull();
    if (next) {
      loop.queue.markProcessing(next.queueId);
      loop.executed.push(next.text);
    }

    expect(loop.executed).toEqual(["first", "second"]);
  });

  it("cancel removes item and dequeue skips it", () => {
    const loop = simulateLoop();
    loop.submitPrompt("first");
    const { queueId } = loop.submitPrompt("second");
    loop.submitPrompt("third");

    loop.queue.cancel(queueId);
    loop.completeCurrentPrompt(); // first done → third starts (second was cancelled)

    expect(loop.executed).toEqual(["first", "third"]);
  });

  it("reorder changes dequeue order", () => {
    const loop = simulateLoop();
    loop.submitPrompt("first");
    const b = loop.submitPrompt("second");
    const c = loop.submitPrompt("third");

    loop.queue.reorder([c.queueId, b.queueId]);
    loop.completeCurrentPrompt(); // first done → third starts (reordered)

    expect(loop.executed).toEqual(["first", "third"]);

    loop.completeCurrentPrompt(); // third done → second starts
    expect(loop.executed).toEqual(["first", "third", "second"]);
  });
});
