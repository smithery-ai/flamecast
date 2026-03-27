import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { FlamecastProvider } from "@/components/flamecast-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const queryClient = new QueryClient();
const router = createRouter({ routeTree });

function resolveFlamecastWsUrl(): string {
  const url = new URL("/ws", window.location.origin);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// oxlint-disable-next-line no-type-assertion/no-type-assertion
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <FlamecastProvider url={resolveFlamecastWsUrl()}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </FlamecastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
