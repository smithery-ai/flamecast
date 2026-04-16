import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { getFlamecastPaths } from "./paths.js";

export type MachineCredentials = {
  machineId: string;
  machineSecret: string;
  tunnelToken: string;
  subdomain: string;
};

function isMachineCredentials(value: unknown): value is MachineCredentials {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("machineId" in value) || typeof value.machineId !== "string") {
    return false;
  }

  if (!("machineSecret" in value) || typeof value.machineSecret !== "string") {
    return false;
  }

  if (!("tunnelToken" in value) || typeof value.tunnelToken !== "string") {
    return false;
  }

  if (!("subdomain" in value) || typeof value.subdomain !== "string") {
    return false;
  }

  return true;
}

export function readMachineCredentials(): MachineCredentials | null {
  const { credentialsFile } = getFlamecastPaths();
  if (!existsSync(credentialsFile)) {
    return null;
  }

  const parsed: unknown = JSON.parse(readFileSync(credentialsFile, "utf8"));
  if (!isMachineCredentials(parsed)) {
    throw new Error(`Invalid credentials file: ${credentialsFile}`);
  }

  return parsed;
}

export function writeMachineCredentials(credentials: MachineCredentials): void {
  const { homeDir, credentialsFile } = getFlamecastPaths();
  mkdirSync(homeDir, { recursive: true });

  writeFileSync(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(credentialsFile, 0o600);
}

export function deleteMachineCredentials(): void {
  const { credentialsFile } = getFlamecastPaths();
  if (existsSync(credentialsFile)) {
    unlinkSync(credentialsFile);
  }
}
