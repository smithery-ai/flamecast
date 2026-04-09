import { useTerminal, useRuntimeWebSocket } from "@flamecast/ui";
import { XTermView } from "@/components/terminal-panel";
import { LoaderCircleIcon } from "lucide-react";

export function RuntimeTerminalTab({
  runtimeWebsocketUrl,
  cwd,
}: {
  runtimeWebsocketUrl?: string;
  cwd?: string;
}) {
  const ws = useRuntimeWebSocket(runtimeWebsocketUrl);
  const { terminals, sendInput, resize, onData } = useTerminal(ws, runtimeWebsocketUrl, {
    autoCreate: { cwd },
  });

  const terminal = terminals[0];

  if (!terminal) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-black">
      <XTermView
        terminalId={terminal.terminalId}
        initialOutput={terminal.output}
        sendInput={sendInput}
        resize={resize}
        onData={onData}
        visible
      />
    </div>
  );
}
