// TODO: Terminal management via ACP terminal protocol.
// Previously used deleted WS channel protocol.

export interface TerminalSession {
  terminalId: string;
  command?: string;
  state: "open" | "exited" | "released" | "broken";
}

export function useTerminal(_sessionId: string) {
  return {
    terminals: [] as TerminalSession[],
    createTerminal: () => { throw new Error("Not yet implemented"); },
    sendInput: (_terminalId: string, _data: string) => { throw new Error("Not yet implemented"); },
  };
}
