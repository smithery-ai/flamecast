import { describe, expect, it } from "vitest";
import config from "../vite.config.js";

describe("client vite config", () => {
  it("proxies API traffic to the Flamecast server in dev", () => {
    const proxy = config.server?.proxy;
    expect(proxy).toBeDefined();
    if (!proxy || Array.isArray(proxy)) {
      throw new Error("Expected object proxy config");
    }

    const apiProxy = proxy["/api"];
    expect(apiProxy).toBeDefined();
    if (!apiProxy || Array.isArray(apiProxy)) {
      throw new Error("Expected /api proxy config");
    }

    expect(apiProxy.target).toBe("http://localhost:3001");
    expect(apiProxy.changeOrigin).toBe(true);
  });
});
