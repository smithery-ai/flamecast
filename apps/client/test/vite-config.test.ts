import { afterEach, describe, expect, it, vi } from "vitest";

describe("client vite config", () => {
  async function loadConfig() {
    vi.resetModules();
    return (await import("../vite.config.js")).default;
  }

  afterEach(() => {
    delete process.env.FLAMECAST_PORT;
    delete process.env.PORT;
  });

  it("proxies API traffic to the Flamecast server in dev", async () => {
    const config = await loadConfig();
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

  it("uses FLAMECAST_PORT when provided", async () => {
    process.env.FLAMECAST_PORT = "3101";
    const config = await loadConfig();
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

    expect(apiProxy.target).toBe("http://localhost:3101");
    expect(apiProxy.changeOrigin).toBe(true);
  });
});
