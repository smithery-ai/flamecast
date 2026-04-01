/**
 * Flamecast Client SDK — typed client for the Flamecast API.
 *
 * After 5a cleanup, session operations go through Restate ingress directly.
 * This client covers template and runtime management only.
 * Session lifecycle uses @restatedev/restate-sdk-clients.
 */

import type { AgentTemplate, RegisterAgentTemplateBody } from "../shared/session.js";
import type { RuntimeInfo, RuntimeInstance } from "@flamecast/protocol/runtime";

export type FlamecastClientOptions = {
  baseUrl: string | URL;
  fetch?: typeof fetch;
};

function normalizeBaseUrl(baseUrl: string | URL): string {
  return typeof baseUrl === "string" ? baseUrl : baseUrl.toString();
}

/** Factory function for backward compat. */
export function createFlamecastClient(opts: FlamecastClientOptions) {
  const client = new FlamecastClient(opts);
  return {
    // Template management
    fetchAgentTemplates: () => client.listAgentTemplates(),
    registerAgentTemplate: (body: RegisterAgentTemplateBody) => client.registerAgentTemplate(body),
    updateAgentTemplate: (id: string, patch: Partial<AgentTemplate>) =>
      client.updateAgentTemplate(id, patch),
    // Runtime management
    fetchRuntimes: () => client.listRuntimes(),
    startRuntime: (typeName: string, name?: string) => client.startRuntime(typeName, name),
    stopRuntime: (name: string) => client.stopRuntime(name),
    pauseRuntime: (name: string) => client.pauseRuntime(name),
    // Session stubs — these now go through Restate ingress directly
    createSession: async (_body: unknown) => {
      throw new Error("Session management moved to Restate VOs. Use @restatedev/restate-sdk-clients.");
    },
    fetchSession: async (_id: string) => {
      throw new Error("Session queries moved to Restate VOs. Use getStatus handler.");
    },
    fetchSessions: async () => {
      throw new Error("Session listing moved to Restate VOs.");
    },
    terminateSession: async (_id: string) => {
      throw new Error("Session termination moved to Restate VOs. Use terminateSession handler.");
    },
    fetchSessionFilePreview: async (_id: string, _path: string) => {
      throw new Error("File preview moved to HTTP bridge.");
    },
    fetchSessionFileSystem: async (_id: string) => {
      throw new Error("File system moved to HTTP bridge.");
    },
    fetchRuntimeFilePreview: async (_instance: string, _path: string) => {
      throw new Error("Runtime file preview not supported in VO architecture.");
    },
    fetchRuntimeFileSystem: async (_instance: string) => {
      throw new Error("Runtime file system not supported in VO architecture.");
    },
  };
}

export class FlamecastClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: FlamecastClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}/api${path}`;
    return this.fetchFn(url, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  }

  // ── Agent Templates ─────────────────────────────────────────────────

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    const res = await this.request("/agent-templates");
    return res.json();
  }

  async registerAgentTemplate(body: RegisterAgentTemplateBody): Promise<AgentTemplate> {
    const res = await this.request("/agent-templates", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async updateAgentTemplate(
    id: string,
    patch: Partial<AgentTemplate>,
  ): Promise<AgentTemplate> {
    const res = await this.request(`/agent-templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    return res.json();
  }

  // ── Runtimes ────────────────────────────────────────────────────────

  async listRuntimes(): Promise<RuntimeInfo[]> {
    const res = await this.request("/runtimes");
    return res.json();
  }

  async startRuntime(typeName: string, instanceName?: string): Promise<RuntimeInstance> {
    const res = await this.request(`/runtimes/${typeName}/start`, {
      method: "POST",
      body: instanceName ? JSON.stringify({ name: instanceName }) : "{}",
    });
    return res.json();
  }

  async stopRuntime(instanceName: string): Promise<void> {
    await this.request(`/runtimes/${instanceName}/stop`, { method: "POST" });
  }

  async pauseRuntime(instanceName: string): Promise<void> {
    await this.request(`/runtimes/${instanceName}/pause`, { method: "POST" });
  }

  // ── Health ──────────────────────────────────────────────────────────

  async health(): Promise<{ status: string }> {
    const res = await this.request("/health");
    return res.json();
  }
}
