export type RegisterMachineResponse = {
  deviceCode: string;
  verificationUrl: string;
};

export type PollMachineResponse =
  | { status: "pending" }
  | {
      status: "approved";
      machineId: string;
      machineSecret: string;
      tunnelToken: string;
    }
  | { status: "expired" };

type ApiErrorBody = {
  error?: string;
  message?: string;
};

const DEFAULT_MACHINES_URL = "https://flamecast.dev";

export function getMachinesApiUrl(): string {
  return (
    process.env.FLAMECAST_MACHINES_API_URL ??
    process.env.FLAMECAST_MACHINES_URL ??
    process.env.FLAMECAST_BRIDGE_URL ??
    DEFAULT_MACHINES_URL
  );
}

export function getMachineDomain(subdomain: string, machinesUrl: string): string {
  return `${subdomain}.${new URL(machinesUrl).host}`;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body: ApiErrorBody = await response.json().catch(() => ({
      error: response.statusText,
    }));
    throw new Error(body.error ?? body.message ?? `Machines API error: ${response.status}`);
  }

  const parsed: T = await response.json();
  return parsed;
}

export async function startMachineRegistration(
  machinesUrl: string,
  subdomain: string,
): Promise<RegisterMachineResponse> {
  const response = await fetch(`${machinesUrl}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subdomain }),
  });

  return readJsonResponse<RegisterMachineResponse>(response);
}

export async function pollMachineRegistration(
  machinesUrl: string,
  deviceCode: string,
): Promise<PollMachineResponse> {
  const response = await fetch(`${machinesUrl}/api/register/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });

  return readJsonResponse<PollMachineResponse>(response);
}

export async function sendMachineHeartbeat(
  machinesUrl: string,
  machineId: string,
  machineSecret: string,
): Promise<void> {
  const response = await fetch(`${machinesUrl}/api/machines/${machineId}/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineSecret}`,
    },
  });

  await readJsonResponse<{ status: string }>(response);
}

export async function deregisterMachine(
  machinesUrl: string,
  machineId: string,
  machineSecret: string,
): Promise<void> {
  const response = await fetch(`${machinesUrl}/api/machines/${machineId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${machineSecret}`,
    },
  });

  await readJsonResponse<{ ok: boolean }>(response);
}
