import { Outlet, createRootRoute } from "@tanstack/react-router";
import { TooltipProvider } from "#/components/ui/tooltip";
import { SidebarProvider } from "#/components/ui/sidebar";

import "../styles.css";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    </TooltipProvider>
  );
}
