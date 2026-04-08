import { createContext, useCallback, useContext, useState } from "react";

const STORAGE_KEY = "flamecast_backend_url";

interface BackendUrlContextValue {
  backendUrl: string;
  defaultUrl: string;
  setBackendUrl: (url: string) => void;
  resetBackendUrl: () => void;
}

const BackendUrlContext = createContext<BackendUrlContextValue | null>(null);

export function BackendUrlProvider({
  defaultUrl,
  children,
}: {
  defaultUrl: string;
  children: React.ReactNode;
}) {
  const [backendUrl, setBackendUrlState] = useState(
    () => localStorage.getItem(STORAGE_KEY) || defaultUrl,
  );

  const setBackendUrl = useCallback(
    (url: string) => {
      if (url === defaultUrl) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, url);
      }
      setBackendUrlState(url);
    },
    [defaultUrl],
  );

  const resetBackendUrl = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setBackendUrlState(defaultUrl);
  }, [defaultUrl]);

  return (
    <BackendUrlContext.Provider value={{ backendUrl, defaultUrl, setBackendUrl, resetBackendUrl }}>
      {children}
    </BackendUrlContext.Provider>
  );
}

export function useBackendUrl() {
  const ctx = useContext(BackendUrlContext);
  if (!ctx) throw new Error("useBackendUrl must be used within <BackendUrlProvider>");
  return ctx;
}
