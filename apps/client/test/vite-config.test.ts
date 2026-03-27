import { describe, expect, it } from "vitest";
import config from "../vite.config.js";

describe("client vite config", () => {
  it("proxies websocket traffic to the Flamecast server in dev", () => {
    const proxy = config.server?.proxy;
    expect(proxy).toBeDefined();
    if (!proxy || Array.isArray(proxy)) {
      throw new Error("Expected object proxy config");
    }

    const wsProxy = proxy["/ws"];
    expect(wsProxy).toBeDefined();
    if (!wsProxy || Array.isArray(wsProxy)) {
      throw new Error("Expected /ws proxy config");
    }

    expect(wsProxy.target).toBe("ws://localhost:3001");
    expect(wsProxy.ws).toBe(true);
  });
});
