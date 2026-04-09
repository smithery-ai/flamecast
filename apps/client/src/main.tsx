import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { FlamecastProvider } from "@flamecast/ui";
import { routeTree } from "./routeTree.gen";
import { resolveApiBaseUrl } from "./lib/api-base-url";
import { BackendUrlProvider, useBackendUrl } from "./lib/backend-url-context";
import { DefaultAgentConfigProvider } from "./lib/default-agent-config-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectionOverlay } from "@/components/connection-overlay";
import "./globals.css";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const defaultUrl = resolveApiBaseUrl(import.meta.env);

function App() {
  const { backendUrl } = useBackendUrl();
  return (
    <FlamecastProvider key={backendUrl} baseUrl={backendUrl}>
      <TooltipProvider>
        <ConnectionOverlay />
        <RouterProvider router={router} />
      </TooltipProvider>
    </FlamecastProvider>
  );
}

// oxlint-disable-next-line no-type-assertion/no-type-assertion
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BackendUrlProvider defaultUrl={defaultUrl}>
      <DefaultAgentConfigProvider>
        <App />
      </DefaultAgentConfigProvider>
    </BackendUrlProvider>
  </React.StrictMode>,
);
