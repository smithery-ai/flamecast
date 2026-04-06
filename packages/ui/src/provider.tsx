import { createContext, useContext, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createFlamecastClient } from "@flamecast/sdk/client";
import type { FlamecastClient } from "@flamecast/sdk/client";

const FlamecastContext = createContext<FlamecastClient | null>(null);

export function FlamecastProvider({
  children,
  baseUrl,
}: {
  children: React.ReactNode;
  baseUrl: string;
}) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const client = useMemo(() => createFlamecastClient({ baseUrl }), [baseUrl]);

  return (
    <QueryClientProvider client={queryClient}>
      <FlamecastContext.Provider value={client}>{children}</FlamecastContext.Provider>
    </QueryClientProvider>
  );
}

export function useFlamecastClient(): FlamecastClient {
  const client = useContext(FlamecastContext);
  if (!client) throw new Error("useFlamecastClient must be used within <FlamecastProvider>");
  return client;
}
