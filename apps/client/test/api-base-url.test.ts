import { describe, expect, it } from "vitest";
import { resolveApiBaseUrl } from "../src/lib/api-base-url.js";

describe("resolveApiBaseUrl", () => {
  it("uses the configured VITE_API_URL when present", () => {
    expect(
      resolveApiBaseUrl({
        VITE_API_URL: "https://example.com/api",
        DEV: true,
      }),
    ).toBe("https://example.com/api");
  });

  it("uses the local API proxy during dev when no explicit API URL is set", () => {
    expect(resolveApiBaseUrl({ DEV: true })).toBe("/api");
  });

  it("falls back to the default server URL outside dev when no explicit API URL is set", () => {
    expect(resolveApiBaseUrl({ DEV: false })).toBe("http://localhost:3001/api");
  });
});
