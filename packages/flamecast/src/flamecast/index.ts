/**
 * Flamecast — agent orchestration SDK.
 *
 * After the 5a cleanup, Flamecast is a thin shell:
 * - Agent template management (in-memory, passed at init)
 * - Runtime lifecycle (Docker/E2B container start/stop)
 * - Hono app with API routes that delegate session ops to Restate VOs
 *
 * Session lifecycle, event streaming, permissions, and recovery are all
 * handled by IbmAgentSession / ZedAgentSession VOs in @flamecast/restate.
 */

import type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  RegisterAgentTemplateBody,
} from "../shared/session.js";
import { createServerApp } from "./app.js";
import type {
  Runtime,
  RuntimeInfo,
  RuntimeInstance,
  RuntimeNames,
} from "@flamecast/protocol/runtime";

const randomUUID = (): string => crypto.randomUUID();

// ─── Public API types ───────────────────────────────────────────────────────

export type {
  AgentSpawn,
  AgentTemplate,
  AgentTemplateRuntime,
  RegisterAgentTemplateBody,
} from "../shared/session.js";

export type { RuntimeInstance, RuntimeInfo } from "@flamecast/protocol/runtime";

export { NodeRuntime } from "./runtime-node.js";

// ─── Flamecast class ────────────────────────────────────────────────────────

export type FlamecastOptions<
  R extends Record<string, Runtime<Record<string, unknown>>> = Record<string, Runtime>,
> = {
  runtimes: R;
  agentTemplates?: AgentTemplate[];
  /** Restate ingress URL for VO calls (default: http://localhost:18080). */
  restateUrl?: string;
};

export class Flamecast<
  R extends Record<string, Runtime<Record<string, unknown>>> = Record<string, Runtime>,
> {
  private readonly templates: AgentTemplate[];
  private readonly runtimesMap: Record<string, Runtime<Record<string, unknown>>>;
  readonly restateUrl: string;

  /** The Hono app. Use with any runtime: Node, CF Workers, Vercel, etc. */
  readonly app;

  constructor(opts: FlamecastOptions<R>) {
    this.templates = opts.agentTemplates ? [...opts.agentTemplates] : [];
    this.runtimesMap = opts.runtimes;
    this.restateUrl = opts.restateUrl ?? "http://localhost:18080";
    this.app = createServerApp(this);
  }

  /** Names of registered runtimes. */
  get runtimeNames(): string[] {
    return Object.keys(this.runtimesMap);
  }

  async close(): Promise<void> {
    // No-op — VOs manage their own state via Restate
  }

  async shutdown(): Promise<void> {
    await this.close();
    for (const runtime of Object.values(this.runtimesMap)) {
      await runtime.dispose?.();
    }
  }

  // ─── Agent Templates (in-memory) ───────────────────────────────────────

  listAgentTemplates(): AgentTemplate[] {
    return [...this.templates];
  }

  getAgentTemplate(id: string): AgentTemplate | undefined {
    return this.templates.find((t) => t.id === id);
  }

  registerAgentTemplate(
    body: Omit<RegisterAgentTemplateBody, "runtime"> & {
      runtime?: { provider?: RuntimeNames<R> | string } & Record<string, unknown>;
    },
  ): AgentTemplate {
    const provider = body.runtime?.provider ?? this.runtimeNames[0] ?? "default";

    if (!this.runtimesMap[provider]) {
      throw new Error(`Unknown runtime: "${provider}". Available: ${this.runtimeNames.join(", ")}`);
    }

    const template: AgentTemplate = {
      id: randomUUID(),
      name: body.name,
      spawn: {
        command: body.spawn.command,
        args: [...body.spawn.args],
      },
      runtime: body.runtime ? { ...body.runtime, provider } : { provider },
      ...(body.env ? { env: body.env } : {}),
    };

    this.templates.push(template);
    return template;
  }

  updateAgentTemplate(
    id: string,
    patch: {
      name?: string;
      spawn?: AgentTemplate["spawn"];
      runtime?: Partial<AgentTemplate["runtime"]>;
      env?: Record<string, string>;
    },
  ): AgentTemplate {
    const idx = this.templates.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Agent template "${id}" not found`);

    const existing = this.templates[idx];
    const updated: AgentTemplate = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.spawn ? { spawn: patch.spawn } : {}),
      ...(patch.runtime ? { runtime: { ...existing.runtime, ...patch.runtime } } : {}),
      ...(patch.env !== undefined ? { env: patch.env } : {}),
    };

    this.templates[idx] = updated;
    return updated;
  }

  /**
   * Resolve a session definition from a template ID or inline spawn config.
   * Used by the API layer before calling the VO's startSession handler.
   */
  resolveSessionConfig(opts: {
    agentTemplateId?: string;
    spawn?: AgentSpawn;
    name?: string;
    runtimeInstance?: string;
  }): {
    agentName: string;
    spawn: AgentSpawn;
    runtime: AgentTemplateRuntime;
  } {
    if (opts.agentTemplateId) {
      const template = this.getAgentTemplate(opts.agentTemplateId);
      if (!template) {
        throw new Error(`Unknown agent template "${opts.agentTemplateId}"`);
      }

      const mergedEnv =
        template.runtime?.env || template.env
          ? { ...template.runtime?.env, ...template.env }
          : undefined;

      return {
        agentName: template.name,
        spawn: { command: template.spawn.command, args: [...template.spawn.args] },
        runtime: { ...template.runtime, ...(mergedEnv ? { env: mergedEnv } : {}) },
      };
    }

    if (!opts.spawn) {
      throw new Error("Provide agentTemplateId or spawn");
    }

    return {
      agentName:
        opts.name?.trim() ||
        [opts.spawn.command, ...(opts.spawn.args ?? [])].filter(Boolean).join(" "),
      spawn: { command: opts.spawn.command, args: [...(opts.spawn.args ?? [])] },
      runtime: { provider: "local" },
    };
  }

  // ─── Runtime Lifecycle ─────────────────────────────────────────────────

  async listRuntimes(): Promise<RuntimeInfo[]> {
    return Object.entries(this.runtimesMap).map(([typeName, runtime]) => ({
      typeName,
      onlyOne: runtime.onlyOne ?? false,
      instances: [], // Runtime instance tracking moved to VO state
    }));
  }

  async startRuntime(typeName: string, instanceName?: string): Promise<RuntimeInstance> {
    const runtime = this.runtimesMap[typeName];
    if (!runtime) {
      throw new Error(`Unknown runtime type: "${typeName}". Available: ${this.runtimeNames.join(", ")}`);
    }

    const name = instanceName ?? typeName;
    if (runtime.start) {
      await runtime.start(name);
    }

    const websocketUrl = runtime.getWebsocketUrl?.(name);
    return {
      name,
      typeName,
      status: "running",
      ...(websocketUrl ? { websocketUrl } : {}),
    };
  }

  async stopRuntime(instanceName: string): Promise<void> {
    // Find the runtime type for this instance
    for (const runtime of Object.values(this.runtimesMap)) {
      if (runtime.stop) {
        try {
          await runtime.stop(instanceName);
          return;
        } catch {
          // Not this runtime — try next
        }
      }
    }
    throw new Error(`Runtime instance "${instanceName}" not found`);
  }

  async pauseRuntime(instanceName: string): Promise<void> {
    for (const runtime of Object.values(this.runtimesMap)) {
      if (runtime.pause) {
        try {
          await runtime.pause(instanceName);
          return;
        } catch {
          // Not this runtime
        }
      }
    }
    throw new Error(`Runtime instance "${instanceName}" not found or pause not supported`);
  }
}
