import { createContext, useCallback, useContext, useState } from "react";

const STORAGE_KEY = "flamecast_default_agent_config";

interface DefaultAgentConfig {
  agentTemplateId: string;
  defaultDirectory: string;
  createWorktree: boolean;
}

interface DefaultAgentConfigContextValue {
  config: DefaultAgentConfig;
  setConfig: (config: DefaultAgentConfig) => void;
  updateConfig: (partial: Partial<DefaultAgentConfig>) => void;
}

const DefaultAgentConfigContext = createContext<DefaultAgentConfigContextValue | null>(null);

const initialConfig: DefaultAgentConfig = {
  agentTemplateId: "",
  defaultDirectory: "",
  createWorktree: false,
};

export function DefaultAgentConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfigState] = useState<DefaultAgentConfig>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? { ...initialConfig, ...JSON.parse(stored) } : initialConfig;
    } catch {
      return initialConfig;
    }
  });

  const setConfig = useCallback((newConfig: DefaultAgentConfig) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig));
    setConfigState(newConfig);
  }, []);

  const updateConfig = useCallback((partial: Partial<DefaultAgentConfig>) => {
    setConfigState((prev) => {
      const next = { ...prev, ...partial };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <DefaultAgentConfigContext.Provider value={{ config, setConfig, updateConfig }}>
      {children}
    </DefaultAgentConfigContext.Provider>
  );
}

export function useDefaultAgentConfig() {
  const ctx = useContext(DefaultAgentConfigContext);
  if (!ctx)
    throw new Error("useDefaultAgentConfig must be used within <DefaultAgentConfigProvider>");
  return ctx;
}
