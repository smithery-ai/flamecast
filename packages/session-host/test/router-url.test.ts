import { describe, expect, it } from "vitest";
import { buildForwardUrl } from "../src/router-url.js";

describe("buildForwardUrl", () => {
  it("preserves query parameters when forwarding to a session host", () => {
    expect(buildForwardUrl(43123, "/files", "?path=package.json")).toBe(
      "http://localhost:43123/files?path=package.json",
    );
  });

  it("handles requests without a query string", () => {
    expect(buildForwardUrl(43123, "/fs/snapshot", "")).toBe(
      "http://localhost:43123/fs/snapshot",
    );
  });
});
