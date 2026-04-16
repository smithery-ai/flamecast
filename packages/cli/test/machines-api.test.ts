import { afterEach, describe, expect, it } from "vitest";
import { getMachinesApiUrl } from "../src/lib/machines-api.js";

const originalMachinesApiUrl = process.env.FLAMECAST_MACHINES_API_URL;
const originalMachinesUrl = process.env.FLAMECAST_MACHINES_URL;
const originalBridgeUrl = process.env.FLAMECAST_BRIDGE_URL;

afterEach(() => {
  if (originalMachinesApiUrl === undefined) {
    delete process.env.FLAMECAST_MACHINES_API_URL;
  } else {
    process.env.FLAMECAST_MACHINES_API_URL = originalMachinesApiUrl;
  }

  if (originalMachinesUrl === undefined) {
    delete process.env.FLAMECAST_MACHINES_URL;
  } else {
    process.env.FLAMECAST_MACHINES_URL = originalMachinesUrl;
  }

  if (originalBridgeUrl === undefined) {
    delete process.env.FLAMECAST_BRIDGE_URL;
  } else {
    process.env.FLAMECAST_BRIDGE_URL = originalBridgeUrl;
  }
});

describe("getMachinesApiUrl", () => {
  it("prefers FLAMECAST_MACHINES_API_URL", () => {
    process.env.FLAMECAST_MACHINES_API_URL = "http://localhost:8788";
    process.env.FLAMECAST_MACHINES_URL = "https://example.com";
    process.env.FLAMECAST_BRIDGE_URL = "https://legacy.example.com";

    expect(getMachinesApiUrl()).toBe("http://localhost:8788");
  });
});
