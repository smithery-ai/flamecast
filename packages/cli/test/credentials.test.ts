import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteMachineCredentials,
  readMachineCredentials,
  writeMachineCredentials,
} from "../src/lib/credentials.js";
import { getFlamecastPaths } from "../src/lib/paths.js";

const originalHome = process.env.FLAMECAST_HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.FLAMECAST_HOME;
    return;
  }

  process.env.FLAMECAST_HOME = originalHome;
});

describe("machine credentials", () => {
  it("writes, reads, and deletes saved machine credentials", () => {
    process.env.FLAMECAST_HOME = mkdtempSync(join(tmpdir(), "flamecast-cli-test-"));

    writeMachineCredentials({
      machineId: "mach_123",
      machineSecret: "secret_123",
      tunnelToken: "token_123",
      subdomain: "anirudh",
    });

    expect(readMachineCredentials()).toEqual({
      machineId: "mach_123",
      machineSecret: "secret_123",
      tunnelToken: "token_123",
      subdomain: "anirudh",
    });

    const credentialsPath = getFlamecastPaths().credentialsFile;
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);

    deleteMachineCredentials();
    expect(readMachineCredentials()).toBeNull();
  });
});
