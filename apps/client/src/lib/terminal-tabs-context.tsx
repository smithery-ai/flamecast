import { createContext, useContext } from "react";

export interface TerminalTabInfo {
  id: string;
  cwd?: string;
}

export interface TerminalTabsContextValue {
  terminalTabs: TerminalTabInfo[];
  activeTerminalTabId?: string;
  focusTerminalTab: (id: string) => void;
  closeTerminalTab: (id: string) => void;
}

const TerminalTabsContext = createContext<TerminalTabsContextValue>({
  terminalTabs: [],
  focusTerminalTab: () => {},
  closeTerminalTab: () => {},
});

export const TerminalTabsProvider = TerminalTabsContext.Provider;

export function useTerminalTabs() {
  return useContext(TerminalTabsContext);
}
