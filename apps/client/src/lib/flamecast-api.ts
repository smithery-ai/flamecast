import { queryOptions } from "@tanstack/react-query";
import { FlamecastClient } from "@flamecast/sdk/client";
import type { InferResponseType } from "hono/client";

interface ResolveBaseUrlOptions {
  browserOrigin?: string;
  envOrigin?: string;
  isDev?: boolean;
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function resolveFlamecastBaseUrl(options: ResolveBaseUrlOptions = {}) {
  const envOrigin = options.envOrigin ?? import.meta.env.VITE_FLAMECAST_API_ORIGIN;
  if (envOrigin) {
    return trimTrailingSlash(envOrigin);
  }

  if (options.isDev ?? import.meta.env.DEV) {
    return "http://localhost:3000";
  }

  if (options.browserOrigin) {
    return trimTrailingSlash(options.browserOrigin);
  }

  if (typeof window !== "undefined") {
    return trimTrailingSlash(window.location.origin);
  }

  return "http://localhost:3000";
}

export const flamecastBaseUrl = resolveFlamecastBaseUrl();
const flamecastClient = new FlamecastClient(flamecastBaseUrl);
export const flamecastApi = flamecastClient.api;

type SessionsRoute = typeof flamecastApi.sessions;
type SessionRoute = SessionsRoute[":id"];
type ErrorResponse = InferResponseType<SessionsRoute["$post"], 500>;

export type ListSessionsResponse = InferResponseType<SessionsRoute["$get"], 200>;
export type CreateSessionResponse = InferResponseType<SessionsRoute["$post"], 201>;
export type CreateSessionRequest = NonNullable<Parameters<SessionsRoute["$post"]>[0]>["json"];
export type SessionDetailsResponse = InferResponseType<SessionRoute["$get"], 200>;
export type RunCommandResponse = InferResponseType<SessionRoute["exec"]["$post"], 200>;
export type RunCommandRequest = {
  command: string;
  sessionId?: string | null;
  timeout?: number;
};
export type SendInputRequest = {
  keys?: string[] | null;
  sessionId: string;
  text?: string | null;
};
export type CloseSessionResponse = InferResponseType<SessionRoute["$delete"], 200>;

export class FlamecastApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FlamecastApiError";
    this.status = status;
  }
}

export async function unwrapResponse<TSuccess>(response: Response) {
  if (response.ok) {
    const body: TSuccess = await response.json();
    return body;
  }

  let message = `Request failed with status ${response.status}`;

  try {
    const body: ErrorResponse = await response.json();
    message = body.error;
  } catch {
    // Keep the default HTTP error text when the server does not return JSON.
  }

  throw new FlamecastApiError(response.status, message);
}

export async function listSessions() {
  const response = await flamecastApi.sessions.$get();
  return unwrapResponse<ListSessionsResponse>(response);
}

export async function createSession(payload: CreateSessionRequest) {
  const response = await flamecastApi.sessions.$post({ json: payload });
  return unwrapResponse<CreateSessionResponse>(response);
}

export async function getSession(sessionId: string) {
  const response = await flamecastApi.sessions[":id"].$get({
    param: { id: sessionId },
    query: {},
  });
  return unwrapResponse<SessionDetailsResponse>(response);
}

export async function runCommand(payload: RunCommandRequest) {
  if (payload.sessionId) {
    const response = await flamecastApi.sessions[":id"].exec.$post({
      param: { id: payload.sessionId },
      json: { command: payload.command, timeout: payload.timeout },
    });
    return unwrapResponse<RunCommandResponse>(response);
  }

  const response = await flamecastApi.sessions.exec.$post({
    json: { command: payload.command, timeout: payload.timeout },
  });
  return unwrapResponse<RunCommandResponse>(response);
}

export async function sendInput(payload: SendInputRequest) {
  const response = await flamecastApi.sessions[":id"].input.$post({
    param: { id: payload.sessionId },
    json: { keys: payload.keys, text: payload.text },
  });
  return unwrapResponse<{ sent: boolean; sessionId: string }>(response);
}

export async function closeSession(sessionId: string) {
  const response = await flamecastApi.sessions[":id"].$delete({
    param: { id: sessionId },
  });
  return unwrapResponse<CloseSessionResponse>(response);
}

export const sessionsQueryOptions = queryOptions({
  queryKey: ["sessions"],
  queryFn: listSessions,
  refetchInterval: 5_000,
});

export function sessionDetailsQueryOptions(sessionId: string) {
  return queryOptions({
    queryKey: ["sessions", sessionId],
    queryFn: () => getSession(sessionId),
    refetchInterval: 2_000,
  });
}
