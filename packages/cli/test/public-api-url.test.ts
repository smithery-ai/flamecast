import { describe, expect, it } from "vitest";
import { resolvePublicApiUrl } from "../src/lib/public-api-url.js";

describe("resolvePublicApiUrl", () => {
  it("keeps localhost on plain http", () => {
    const request = new Request("http://localhost:3001/");

    expect(resolvePublicApiUrl(request)).toBe("http://localhost:3001/api");
  });

  it("prefers forwarded https for tunneled requests", () => {
    const request = new Request("http://henry.flamecast.app/", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(resolvePublicApiUrl(request)).toBe("https://henry.flamecast.app/api");
  });

  it("falls back to https for non-local hosts when proxy headers are missing", () => {
    const request = new Request("http://henry.flamecast.app/");

    expect(resolvePublicApiUrl(request)).toBe("https://henry.flamecast.app/api");
  });
});
