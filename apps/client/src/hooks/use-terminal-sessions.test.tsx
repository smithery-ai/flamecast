// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "#/lib/api";
import { createSession, deleteSession, fetchSessions } from "#/lib/api";
import { useTerminalSessions } from "./use-terminal-sessions";

vi.mock("#/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("#/lib/api")>();
  return {
    ...original,
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    fetchSessions: vi.fn(),
  };
});

const createSessionMock = vi.mocked(createSession);
const deleteSessionMock = vi.mocked(deleteSession);
const fetchSessionsMock = vi.mocked(fetchSessions);

function buildSession(sessionId: string): TerminalSession {
  return {
    created: "2026-04-16T00:00:00.000Z",
    cwd: "/tmp",
    lastActivity: "2026-04-16T00:00:00.000Z",
    sessionId,
    shell: "/bin/zsh",
    status: "running",
    streamUrl: `/terminals/${sessionId}/stream`,
    timeout: 0,
  };
}

function createDeferred() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve() {
      if (!resolvePromise) {
        throw new Error("Deferred promise was not initialized");
      }
      resolvePromise();
    },
  };
}

type HookState = ReturnType<typeof useTerminalSessions>;

function Probe({ onState }: { onState: (state: HookState) => void }) {
  const state = useTerminalSessions();

  useEffect(() => {
    onState(state);
  }, [onState, state]);

  return null;
}

describe("useTerminalSessions", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let sessions: TerminalSession[] = [];
  let sessionCounter = 0;

  function renderProbe(onState: (state: HookState) => void) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Probe onState={onState} />
        </QueryClientProvider>,
      );
    });
  }

  beforeEach(() => {
    sessions = [];
    sessionCounter = 0;

    fetchSessionsMock.mockImplementation(async () =>
      sessions.map((session) => ({
        ...session,
      })),
    );
    createSessionMock.mockImplementation(async () => {
      sessionCounter += 1;
      const sessionId = `session-${sessionCounter}`;
      sessions = [...sessions, buildSession(sessionId)];
      return sessionId;
    });
    deleteSessionMock.mockImplementation(async (sessionId) => {
      sessions = sessions.filter((session) => session.sessionId !== sessionId);
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    vi.clearAllMocks();
  });

  it("creates a terminal when the fetched list is empty", async () => {
    let latestState: HookState | null = null;
    renderProbe((state) => {
      latestState = state;
    });

    await vi.waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(latestState?.sessions.map((session) => session.sessionId)).toEqual(["session-1"]);
    });

    expect(latestState?.activeSessionId).toBe("session-1");
    expect(latestState?.emptyStateMessage).toBeNull();
  });

  it("optimistically removes the last terminal and provisions a replacement", async () => {
    sessions = [buildSession("session-1")];
    sessionCounter = 1;

    const deferredDelete = createDeferred();
    deleteSessionMock.mockImplementation(async (sessionId) => {
      await deferredDelete.promise;
      sessions = sessions.filter((session) => session.sessionId !== sessionId);
    });

    let latestState: HookState | null = null;
    renderProbe((state) => {
      latestState = state;
    });

    await vi.waitFor(() => {
      expect(latestState?.sessions.map((session) => session.sessionId)).toEqual(["session-1"]);
    });

    await act(async () => {
      if (!latestState) {
        throw new Error("Expected hook state to be available");
      }
      latestState.deleteSession("session-1");
    });

    await vi.waitFor(() => {
      expect(latestState?.sessions).toHaveLength(0);
    });
    expect(createSessionMock).toHaveBeenCalledTimes(0);

    await act(async () => {
      deferredDelete.resolve();
      await deferredDelete.promise;
    });

    await vi.waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(latestState?.sessions.map((session) => session.sessionId)).toEqual(["session-2"]);
    });

    expect(latestState?.activeSessionId).toBe("session-2");
  });

  it("hides closed sessions returned by the API", async () => {
    sessions = [
      buildSession("session-1"),
      {
        ...buildSession("session-closed"),
        status: "closed",
      },
    ];
    sessionCounter = 1;

    let latestState: HookState | null = null;
    renderProbe((state) => {
      latestState = state;
    });

    await vi.waitFor(() => {
      expect(latestState?.sessions.map((session) => session.sessionId)).toEqual(["session-1"]);
    });

    expect(latestState?.activeSessionId).toBe("session-1");
    expect(createSessionMock).toHaveBeenCalledTimes(0);
  });

  it("keeps a newly created session selected until the sidebar list catches up", async () => {
    sessions = [buildSession("session-1")];
    sessionCounter = 1;

    createSessionMock.mockImplementation(async () => {
      sessionCounter += 1;
      return `session-${sessionCounter}`;
    });

    let latestState: HookState | null = null;
    renderProbe((state) => {
      latestState = state;
    });

    await vi.waitFor(() => {
      expect(latestState?.activeSessionId).toBe("session-1");
    });

    await act(async () => {
      if (!latestState) {
        throw new Error("Expected hook state to be available");
      }
      latestState.createSession();
    });

    await vi.waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledTimes(1);
    });

    expect(latestState?.sessions.map((session) => session.sessionId)).toEqual(["session-1"]);
    expect(latestState?.activeSessionId).toBe("session-2");
  });
});
