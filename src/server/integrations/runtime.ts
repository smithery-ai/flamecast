import { type CapturedPromptResult, Flamecast } from "@/flamecast/index.js";
import type { CreateConnectionBody } from "@/shared/connection.js";
import type {
  ConversationBinding,
  ConversationSource,
  IntegrationInstall,
  IntegrationProvider,
} from "@/shared/integrations.js";
import { getIntegrationConfig } from "./config.js";
import { IntegrationBroker, makeBearerInstallSecret } from "./broker.js";
import { IntegrationStore } from "./store.js";

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
}

function formatTranscriptLine(kind: string, payload: Record<string, unknown>): string {
  if (kind === "user_message" && typeof payload.text === "string") {
    return `User: ${payload.text}`;
  }
  if (kind === "assistant_message" && typeof payload.text === "string") {
    return `Assistant: ${payload.text}`;
  }
  return `${kind}: ${JSON.stringify(payload)}`;
}

export interface RuntimePromptResult {
  binding: ConversationBinding;
  captured: CapturedPromptResult;
}

export class ConversationRuntime {
  constructor(
    private flamecast: Flamecast,
    private broker: IntegrationBroker,
    private store: IntegrationStore,
  ) {}

  async ensureDefaultInstall(provider: IntegrationProvider): Promise<IntegrationInstall | null> {
    const config = getIntegrationConfig();
    if (provider === "linear" && config.linear.accessToken) {
      return this.store.upsertInstall({
        credential: makeBearerInstallSecret(config.linear.accessToken),
        externalId: "linear-default",
        label: "Linear default",
        metadata: { mode: "server_env" },
        provider: "linear",
      });
    }
    return null;
  }

  async resolveBinding(
    source: ConversationSource,
    metadata: Record<string, unknown> = {},
  ): Promise<ConversationBinding> {
    let installId = source.installId;
    if (!installId && source.platform !== "slack") {
      const install = await this.ensureDefaultInstall("linear");
      installId = install?.id ?? null;
    }
    return this.store.findOrCreateBinding({
      metadata,
      source: {
        ...source,
        installId,
      },
    });
  }

  private async ensureConnection(binding: ConversationBinding): Promise<{
    binding: ConversationBinding;
    replayTranscript: boolean;
  }> {
    if (binding.connectionId) {
      try {
        this.flamecast.get(binding.connectionId);
        return { binding, replayTranscript: false };
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    }

    const token = await this.broker.mintToken({
      installId: binding.source.installId,
      metadata: {
        bindingId: binding.id,
        sourcePlatform: binding.source.platform,
      },
      services: ["linear", "slack"],
    });

    const body: CreateConnectionBody = {
      agentProcessId: "codex",
      cwd: process.cwd(),
    };
    const info = await this.flamecast.create(body, {
      autoApprovePermissions: true,
      envOverrides: {
        FLAMECAST_INSTALL_ID: binding.source.installId ?? "",
        FLAMECAST_PROXY_BASE: getIntegrationConfig().proxyBaseUrl,
        FLAMECAST_PROXY_TOKEN: token,
        FLAMECAST_SOURCE_PLATFORM: binding.source.platform,
      },
    });

    const updated = await this.store.updateBindingSession(binding.id, {
      connectionId: info.id,
      metadata: {
        ...binding.metadata,
        lastBootAt: new Date().toISOString(),
      },
      sessionId: info.sessionId,
    });
    return { binding: updated, replayTranscript: true };
  }

  private buildBrokerInstructions(source: ConversationSource): string {
    const base = getIntegrationConfig().proxyBaseUrl;
    return [
      "Integration access is brokered. Never expect raw Slack or Linear secrets in the environment.",
      `Use curl with Proxy-Authorization against ${base}.`,
      'Example Linear call: curl "$FLAMECAST_PROXY_BASE/linear/graphql" -H "Proxy-Authorization: Bearer $FLAMECAST_PROXY_TOKEN" -H "Content-Type: application/json" -d \'{"query":"{ viewer { id name } }"}\'',
      'Example Slack call: curl "$FLAMECAST_PROXY_BASE/slack/api/chat.postMessage" -H "Proxy-Authorization: Bearer $FLAMECAST_PROXY_TOKEN" -H "Content-Type: application/json" -d \'{"channel":"C123","text":"hello"}\'',
      `Current source platform: ${source.platform}.`,
    ].join("\n");
  }

  private async buildPrompt(
    binding: ConversationBinding,
    message: string,
    replayTranscript: boolean,
  ): Promise<string> {
    const transcript = replayTranscript ? await this.store.listTranscript(binding.id, 20) : [];
    const transcriptBlock =
      transcript.length === 0
        ? ""
        : `\nRecent conversation transcript:\n${transcript
            .map((entry) => `- ${formatTranscriptLine(entry.kind, entry.payload)}`)
            .join("\n")}\n`;

    return [
      "You are responding inside an integrated Flamecast chat surface.",
      `Source thread: ${binding.source.threadId}`,
      binding.source.externalThreadLabel
        ? `Source label: ${binding.source.externalThreadLabel}`
        : null,
      this.buildBrokerInstructions(binding.source),
      transcriptBlock,
      `Latest user message:\n${message}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async runPrompt(source: ConversationSource, message: string): Promise<RuntimePromptResult> {
    const binding = await this.resolveBinding(source, {
      lastInboundAt: new Date().toISOString(),
    });
    await this.store.appendTranscript(binding.id, "user_message", { text: message });

    const ensured = await this.ensureConnection(binding);
    const prompt = await this.buildPrompt(ensured.binding, message, ensured.replayTranscript);
    const captured = await this.flamecast.promptCaptured(
      ensured.binding.connectionId ?? "",
      prompt,
    );

    if (captured.assistantText.trim()) {
      await this.store.appendTranscript(ensured.binding.id, "assistant_message", {
        stopReason: captured.result.stopReason,
        text: captured.assistantText,
      });
    }

    return {
      binding: ensured.binding,
      captured,
    };
  }
}
