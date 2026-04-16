import { describe, expect, it } from "vitest";

import { FlamecastApiError, resolveFlamecastBaseUrl, unwrapResponse } from "./flamecast-api";

describe("resolveFlamecastBaseUrl", () => {
  it("prefers an explicit env origin", () => {
    expect(
      resolveFlamecastBaseUrl({
        envOrigin: "https://api.example.com/",
        isDev: true,
      }),
    ).toBe("https://api.example.com");
  });

  it("falls back to the local server during development", () => {
    expect(resolveFlamecastBaseUrl({ isDev: true })).toBe("http://localhost:3000");
  });

  it("uses the browser origin outside development", () => {
    expect(
      resolveFlamecastBaseUrl({
        browserOrigin: "https://dashboard.example.com/",
        isDev: false,
      }),
    ).toBe("https://dashboard.example.com");
  });
});

describe("unwrapResponse", () => {
  it("returns typed data for successful responses", async () => {
    const response = new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
    });

    await expect(unwrapResponse<{ status: string }>(response)).resolves.toEqual({
      status: "ok",
    });
  });

  it("throws a FlamecastApiError with the server error message", async () => {
    const response = new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
    });

    await expect(unwrapResponse<{ status: string }>(response)).rejects.toMatchObject(
      new FlamecastApiError(404, "Session not found"),
    );
  });

  it("falls back to the HTTP status when the response body is not JSON", async () => {
    const response = new Response("gateway timeout", {
      status: 504,
    });

    await expect(unwrapResponse<{ status: string }>(response)).rejects.toMatchObject(
      new FlamecastApiError(504, "Request failed with status 504"),
    );
  });
});
