/**
 * Session lifecycle logic — uses SessionRuntime, no Restate imports.
 *
 * Testable without Docker/testcontainers via a mock SessionRuntime.
 */

import type { WebhookConfig, WebhookEventType } from "@flamecast/protocol/session";
import type { SessionRuntime } from "./session-runtime.js";
import type {
  SessionMeta,
  StartSessionInput,
  SessionCallbackEvent,
} from "./session-object.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateMeta(
  rt: SessionRuntime,
  patch: Partial<SessionMeta>,
): Promise<void> {
  const meta = await rt.state.get<SessionMeta>("meta");
  if (!meta) return;
  rt.state.set("meta", { ...meta, ...patch });
}

function dispatchWebhooks(
  rt: SessionRuntime,
  event: SessionCallbackEvent,
  webhooks: WebhookConfig[],
): void {
  for (const wh of webhooks) {
    if (wh.events && !wh.events.includes(event.type as WebhookEventType)) continue;
    rt.sendService("WebhookDelivery", "deliver", {
      webhook: wh,
      sessionId: rt.key,
      event,
    });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle operations
// ---------------------------------------------------------------------------

export async function startSession(
  rt: SessionRuntime,
  input: StartSessionInput,
): Promise<{ sessionId: string; hostUrl: string; websocketUrl: string }> {
  await rt.step("spawn-agent", async () => {
    const resp = await fetch(`${input.runtimeUrl}/sessions/${rt.key}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: rt.key,
        command: input.spawn.command,
        args: input.spawn.args,
        workspace: input.cwd,
        setup: input.setup,
        env: input.env,
        callbackUrl: input.callbackUrl,
      }),
    });
    if (!resp.ok) throw new Error(`Session-host /start failed: ${resp.status}`);
    return await resp.json();
  });

  const hostUrl = input.runtimeUrl;
  const websocketUrl = input.runtimeUrl.replace(/^http/, "ws");
  const startedAt = await rt.now();

  rt.state.set("meta", {
    id: rt.key,
    agentName: input.agentName,
    hostUrl,
    websocketUrl,
    runtimeName: input.runtimeName,
    status: "active",
    startedAt,
    lastUpdatedAt: startedAt,
    spawn: input.spawn,
    pendingPermission: null,
  } satisfies SessionMeta);
  rt.state.set("webhooks", input.webhooks ?? []);
  rt.emit(`session:${rt.key}`, { type: "session.created", sessionId: rt.key });

  return { sessionId: rt.key, hostUrl, websocketUrl };
}

export async function terminateSession(rt: SessionRuntime): Promise<void> {
  const meta = await rt.state.get<SessionMeta>("meta");
  if (!meta) return;

  await rt.step("terminate-agent", async () => {
    await fetch(`${meta.hostUrl}/sessions/${rt.key}/terminate`, { method: "POST" });
  });

  const now = await rt.now();
  rt.state.set("meta", { ...meta, status: "killed", lastUpdatedAt: now, pendingPermission: null });
  rt.emit(`session:${rt.key}`, { type: "session.terminated", sessionId: rt.key });
}

export async function handleCallback(
  rt: SessionRuntime,
  event: SessionCallbackEvent,
): Promise<unknown> {
  if (event.type === "permission_request") {
    return await handlePermissionRequest(rt, event.data);
  }

  const now = await rt.now();
  if (event.type === "session_end") {
    await updateMeta(rt, { status: "killed", lastUpdatedAt: now, pendingPermission: null });
  } else {
    await updateMeta(rt, { lastUpdatedAt: now });
  }
  if (event.type === "end_turn") {
    rt.state.set("currentTurn", null);
  }

  rt.emit(`session:${rt.key}`, event);
  const webhooks = (await rt.state.get<WebhookConfig[]>("webhooks")) ?? [];
  dispatchWebhooks(rt, event, webhooks);
  return { ok: true };
}

async function handlePermissionRequest(
  rt: SessionRuntime,
  data: unknown,
): Promise<unknown> {
  const { id, promise } = rt.awakeable<unknown>();
  const now = await rt.now();
  const permData = { ...(data as Record<string, unknown>), awakeableId: id };

  rt.state.set("pending_permission", { awakeableId: id, data });
  await updateMeta(rt, { lastUpdatedAt: now, pendingPermission: permData });
  rt.emit(`session:${rt.key}`, { type: "permission_request", data: permData });

  const response = await promise;

  rt.state.clear("pending_permission");
  await updateMeta(rt, { lastUpdatedAt: await rt.now(), pendingPermission: null });
  return response;
}
