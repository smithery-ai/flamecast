import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useRuntimes } from "@flamecast/ui";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/runtimes/$typeName")({
  component: RuntimeGroupPage,
});

function RuntimeGroupPage() {
  const { typeName } = Route.useParams();
  const navigate = useNavigate();
  const { data: runtimes } = useRuntimes();

  const runtimeInfo = runtimes?.find((rt) => rt.typeName === typeName);

  const hasChildMatch = useRouterState({
    select: (s) => s.matches.some((m) => m.routeId === "/runtimes/$typeName/$instanceName"),
  });

  // For onlyOne runtimes, redirect to the instance route (instance name = typeName)
  useEffect(() => {
    if (!runtimeInfo) return;
    if (runtimeInfo.onlyOne) {
      const instance =
        runtimeInfo.instances.find((i) => i.name === typeName) ?? runtimeInfo.instances[0];
      const instanceName = instance?.name ?? typeName;
      void navigate({
        to: "/runtimes/$typeName/$instanceName",
        params: { typeName, instanceName },
        replace: true,
      });
    }
  }, [runtimeInfo, typeName, navigate]);

  if (!runtimeInfo) {
    return (
      <div className="mx-auto w-full max-w-3xl px-1">
        <h1 className="text-2xl font-bold tracking-tight">Runtime not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          No runtime group named "{typeName}" exists.
        </p>
      </div>
    );
  }

  // onlyOne runtimes redirect to their instance child route above;
  // still need <Outlet /> so the child can render after redirect.
  if (runtimeInfo.onlyOne || hasChildMatch) return <Outlet />;

  // Otherwise show the instances list for this runtime group
  return (
    <div className="mx-auto w-full max-w-3xl px-1">
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{typeName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {runtimeInfo.instances.length} instance{runtimeInfo.instances.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {runtimeInfo.instances.map((instance) => (
            <Link
              key={instance.name}
              to="/runtimes/$typeName/$instanceName"
              params={{ typeName, instanceName: instance.name }}
              className="flex items-center justify-between rounded-lg border px-4 py-3 transition-colors hover:bg-muted"
            >
              <span className="font-medium">{instance.name}</span>
              <span
                className={cn(
                  "rounded px-2 py-0.5 text-xs font-medium",
                  instance.status === "running"
                    ? "bg-green-500/15 text-green-700 dark:text-green-400"
                    : instance.status === "paused"
                      ? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {instance.status}
              </span>
            </Link>
          ))}
          {runtimeInfo.instances.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No instances yet. Create one from the sidebar.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
