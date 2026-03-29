import { describe, expect, it } from "vitest";
import { resolveRuntimeSelection } from "../src/lib/runtime-selection.js";
import type { RuntimeInfo } from "@flamecast/protocol/runtime";

describe("resolveRuntimeSelection", () => {
  it("uses the real instance metadata for onlyOne runtimes", () => {
    const runtimes: RuntimeInfo[] = [
      {
        typeName: "local",
        onlyOne: true,
        instances: [
          {
            name: "local",
            typeName: "local",
            status: "running",
            websocketUrl: "ws://localhost:9000",
          },
        ],
      },
    ];

    expect(resolveRuntimeSelection("local", runtimes)).toEqual({
      runtimeInfo: runtimes[0],
      instance: runtimes[0].instances[0],
    });
  });

  it("returns a stopped placeholder when an onlyOne runtime has no live instance yet", () => {
    const runtimes: RuntimeInfo[] = [
      {
        typeName: "local",
        onlyOne: true,
        instances: [],
      },
    ];

    expect(resolveRuntimeSelection("local", runtimes)).toEqual({
      runtimeInfo: runtimes[0],
      instance: {
        name: "local",
        typeName: "local",
        status: "stopped",
      },
    });
  });
});
