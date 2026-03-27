import { createContext, useContext } from "react";
import type { FlamecastConnection } from "./flamecast-connection.js";

interface FlamecastContextValue {
  connection: FlamecastConnection;
}

export const FlamecastContext = createContext<FlamecastContextValue | null>(null);

export function useFlamecastContext(): FlamecastContextValue {
  const ctx = useContext(FlamecastContext);
  if (!ctx) {
    throw new Error("useFlamecast* hooks must be used within <FlamecastProvider>");
  }
  return ctx;
}
