export interface RuntimeTerminalSession {
  terminalId: string;
  command: string;
  output: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

type TerminalEventInput = {
  eventType: string;
  terminalId: string;
  timestamp: string;
  command?: string;
  data?: string;
  exitCode?: number;
};

const STORAGE_KEY_PREFIX = "flamecast:dismissed-runtime-terminals:";

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
}

function getStorageKey(websocketUrl: string): string {
  return `${STORAGE_KEY_PREFIX}${websocketUrl}`;
}

export function loadDismissedRuntimeTerminals(websocketUrl?: string): Set<string> {
  if (!websocketUrl) return new Set();
  const storage = getStorage();
  if (!storage) return new Set();

  try {
    const raw = storage.getItem(getStorageKey(websocketUrl));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

export function dismissRuntimeTerminal(websocketUrl: string | undefined, terminalId: string): void {
  if (!websocketUrl) return;
  const storage = getStorage();
  if (!storage) return;

  const next = loadDismissedRuntimeTerminals(websocketUrl);
  next.add(terminalId);
  storage.setItem(getStorageKey(websocketUrl), JSON.stringify([...next]));
}

export function reduceRuntimeTerminalSessions(
  previous: RuntimeTerminalSession[],
  event: TerminalEventInput,
  dismissedTerminalIds: Set<string>,
): RuntimeTerminalSession[] {
  if (dismissedTerminalIds.has(event.terminalId)) {
    return previous.filter((terminal) => terminal.terminalId !== event.terminalId);
  }

  switch (event.eventType) {
    case "terminal.started":
      if (previous.some((terminal) => terminal.terminalId === event.terminalId)) {
        return previous;
      }
      return [
        ...previous,
        {
          terminalId: event.terminalId,
          command: event.command ?? "",
          output: "",
          exitCode: null,
          startedAt: event.timestamp,
          endedAt: null,
        },
      ];

    case "terminal.data":
      return previous.map((terminal) =>
        terminal.terminalId === event.terminalId
          ? { ...terminal, output: terminal.output + (event.data ?? "") }
          : terminal,
      );

    case "terminal.exit":
      return previous.map((terminal) =>
        terminal.terminalId === event.terminalId
          ? {
              ...terminal,
              exitCode: typeof event.exitCode === "number" ? event.exitCode : -1,
              endedAt: event.timestamp,
            }
          : terminal,
      );

    case "terminal.release":
      return previous.filter((terminal) => terminal.terminalId !== event.terminalId);

    default:
      return previous;
  }
}
