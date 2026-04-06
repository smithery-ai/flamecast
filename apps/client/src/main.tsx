import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { FlamecastProvider } from "@flamecast/ui";
import { routeTree } from "./routeTree.gen";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function resolveApiBaseUrl(env: { VITE_API_URL?: string; DEV?: boolean }): string {
  if (env.VITE_API_URL) return env.VITE_API_URL;
  return env.DEV ? "/api" : "http://localhost:3001/api";
}

// oxlint-disable-next-line no-type-assertion/no-type-assertion
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FlamecastProvider baseUrl={resolveApiBaseUrl(import.meta.env)}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </FlamecastProvider>
  </React.StrictMode>,
);
