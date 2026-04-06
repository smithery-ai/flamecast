import { createContext, useContext, type ReactNode } from "react";

interface RuntimeFileSystemContextValue {
  showAllFiles: boolean;
  setShowAllFiles: (showAllFiles: boolean) => void;
  loadPreview: (path: string) => Promise<{ content: string; truncated: boolean }>;
}

const RuntimeFileSystemContext = createContext<RuntimeFileSystemContextValue | null>(null);

export function RuntimeFileSystemProvider({
  showAllFiles,
  setShowAllFiles,
  loadPreview,
  children,
}: RuntimeFileSystemContextValue & { children: ReactNode }) {
  return (
    <RuntimeFileSystemContext.Provider value={{ showAllFiles, setShowAllFiles, loadPreview }}>
      {children}
    </RuntimeFileSystemContext.Provider>
  );
}

export function useRuntimeFileSystemContext() {
  const context = useContext(RuntimeFileSystemContext);
  if (!context) {
    throw new Error(
      "useRuntimeFileSystemContext must be used within a RuntimeFileSystemProvider",
    );
  }
  return context;
}
