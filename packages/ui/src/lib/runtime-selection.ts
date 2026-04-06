import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";

export function resolveRuntimeSelection(
  filter: string | undefined,
  runtimes: RuntimeInfo[] | undefined,
):
  | {
      runtimeInfo: RuntimeInfo;
      instance: RuntimeInstance;
    }
  | undefined {
  if (!filter || !runtimes) return undefined;

  for (const runtimeInfo of runtimes) {
    if (runtimeInfo.onlyOne && runtimeInfo.typeName === filter) {
      const instance = runtimeInfo.instances.find(
        (candidate) => candidate.name === runtimeInfo.typeName,
      ) ??
        runtimeInfo.instances[0] ?? {
          name: runtimeInfo.typeName,
          typeName: runtimeInfo.typeName,
          status: "stopped",
        };

      return { runtimeInfo, instance };
    }

    if (runtimeInfo.typeName === filter && runtimeInfo.instances.length === 1) {
      return {
        runtimeInfo,
        instance: runtimeInfo.instances[0],
      };
    }

    const instance = runtimeInfo.instances.find((candidate) => candidate.name === filter);
    if (instance) {
      return { runtimeInfo, instance };
    }
  }

  return undefined;
}
