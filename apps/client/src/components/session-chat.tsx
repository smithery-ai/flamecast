/**
 * Session chat — connects via ACP, renders chunks from durable stream.
 *
 * Uses standard @agentclientprotocol/sdk via useAcpSession() for prompt/cancel.
 * Uses durable-session via useSessionState() for reactive state (chunks, turns, permissions).
 */

import { useState } from "react";
import { useSessionState, useAcpSession, type MarkdownSegment } from "@flamecast/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { SendIcon, LoaderCircleIcon, XIcon } from "lucide-react";

function SegmentView({ segment }: { segment: MarkdownSegment }) {
  if (segment.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
          {segment.text}
        </div>
      </div>
    );
  }

  if (segment.kind === "assistant") {
    return (
      <div className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
        {segment.text}
      </div>
    );
  }

  if (segment.kind === "tool") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="text-[10px]">
          {segment.title}
        </Badge>
        <span>{segment.status}</span>
      </div>
    );
  }

  return null;
}

export function SessionChat({ sessionId }: { sessionId: string }) {
  const [promptText, setPromptText] = useState("");
  const acpSession = useAcpSession();
  const state = useSessionState(sessionId);

  const handleSend = async () => {
    const text = promptText.trim();
    if (!text || !acpSession.isReady) return;
    setPromptText("");
    try {
      await state.prompt(text);
    } catch (e) {
      console.error("Prompt failed:", e);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Connection status */}
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <span
          className={`size-2 rounded-full ${acpSession.isReady ? "bg-green-500" : "bg-yellow-500"}`}
        />
        {acpSession.isReady
          ? `Connected — session ${acpSession.sessionId?.slice(0, 8) ?? "..."}`
          : acpSession.error
            ? `Error: ${acpSession.error.message}`
            : "Connecting to conductor..."}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {state.markdownSegments.length === 0 && !state.isProcessing && (
          <p className="text-sm text-muted-foreground text-center pt-8">
            Send a prompt to get started.
          </p>
        )}
        {state.markdownSegments.map((seg, i) => (
          <SegmentView key={i} segment={seg} />
        ))}
        {state.isProcessing && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3 animate-spin" />
            Agent is working...
          </div>
        )}
      </div>

      {/* Pending permissions */}
      {state.pendingPermissions.length > 0 && (
        <div className="border-t px-4 py-2 space-y-2">
          {state.pendingPermissions.map((perm) => (
            <Card key={perm.requestId}>
              <CardContent className="flex items-center gap-2 p-3 text-sm">
                <span className="flex-1">{perm.title ?? "Permission requested"}</span>
                {perm.options?.map((opt) => (
                  <Button
                    key={opt.optionId}
                    size="sm"
                    variant={opt.kind === "approve" ? "default" : "outline"}
                    onClick={() => {
                      // TODO: wire permission response through ACP
                    }}
                  >
                    {opt.name}
                  </Button>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Prompt input */}
      <div className="flex gap-2 border-t p-4">
        <Input
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          placeholder={acpSession.isReady ? "Send a prompt..." : "Connecting..."}
          disabled={!acpSession.isReady}
          className="flex-1"
        />
        {state.isProcessing ? (
          <Button variant="outline" onClick={() => state.cancel()}>
            <XIcon className="size-4" />
          </Button>
        ) : (
          <Button onClick={handleSend} disabled={!acpSession.isReady || !promptText.trim()}>
            <SendIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
