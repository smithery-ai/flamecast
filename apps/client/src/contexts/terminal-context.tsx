import { createContext, useContext, type ReactNode } from "react";
import { useTerminal, type TerminalSession } from "@flamecast/ui";

interface TerminalContextValue {
  terminals: TerminalSession[];
  sendInput: (terminalId: string, data: string) => void;
  resize: (terminalId: string, cols: number, rows: number) => void;
  onData: (terminalId: string, listener: (data: string) => void) => () => void;
  createTerminal: (command?: string) => void;
  killTerminal: (terminalId: string) => void;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

export function TerminalProvider({
  websocketUrl,
  children,
}: {
  websocketUrl: string | undefined;
  children: ReactNode;
}) {
  const { terminals, sendInput, resize, onData, createTerminal, killTerminal } =
    useTerminal(websocketUrl);

  return (
    <TerminalContext.Provider
      value={{ terminals, sendInput, resize, onData, createTerminal, killTerminal }}
    >
      {children}
    </TerminalContext.Provider>
  );
}

export function useTerminalContext() {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error("useTerminalContext must be used within a TerminalProvider");
  }
  return context;
}
