import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { FlamecastProvider } from "@flamecast/ui";
import { routeTree } from "./routeTree.gen";
import { resolveApiBaseUrl } from "./lib/api-base-url";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
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
