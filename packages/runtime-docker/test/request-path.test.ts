import { describe, expect, it } from "vitest";
import { getRequestPath } from "../src/request-path.js";

describe("getRequestPath", () => {
  it("preserves query parameters for proxied runtime requests", () => {
    const request = new Request("http://host/files?path=package.json");

    expect(getRequestPath(request)).toBe("/files?path=package.json");
  });

  it("returns the pathname when there is no query string", () => {
    const request = new Request("http://host/fs/snapshot");

    expect(getRequestPath(request)).toBe("/fs/snapshot");
  });
});
