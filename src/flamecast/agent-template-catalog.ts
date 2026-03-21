import { randomUUID } from "node:crypto";
import type { AgentTemplate, RegisterAgentTemplateBody } from "../shared/session.js";
import { localRuntime } from "./agent-templates.js";

export type AgentTemplateCatalog = {
  list(): AgentTemplate[];
  get(id: string): AgentTemplate | null;
  register(body: RegisterAgentTemplateBody): AgentTemplate;
};

export class MemoryAgentTemplateCatalog implements AgentTemplateCatalog {
  private readonly templates = new Map<string, AgentTemplate>();

  constructor(initialTemplates: AgentTemplate[]) {
    for (const template of initialTemplates) {
      this.templates.set(template.id, { ...template });
    }
  }

  list(): AgentTemplate[] {
    return [...this.templates.values()].map((template) => ({
      ...template,
      spawn: {
        command: template.spawn.command,
        args: [...template.spawn.args],
      },
      runtime: { ...template.runtime },
    }));
  }

  get(id: string): AgentTemplate | null {
    const template = this.templates.get(id);
    return template
      ? {
          ...template,
          spawn: {
            command: template.spawn.command,
            args: [...template.spawn.args],
          },
          runtime: { ...template.runtime },
        }
      : null;
  }

  register(body: RegisterAgentTemplateBody): AgentTemplate {
    const template: AgentTemplate = {
      id: randomUUID(),
      name: body.name,
      spawn: {
        command: body.spawn.command,
        args: [...body.spawn.args],
      },
      runtime: body.runtime ? { ...body.runtime } : localRuntime(),
    };

    this.templates.set(template.id, template);
    return {
      ...template,
      spawn: {
        command: template.spawn.command,
        args: [...template.spawn.args],
      },
      runtime: { ...template.runtime },
    };
  }
}
