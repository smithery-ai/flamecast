import { useTerminal } from "@flamecast/ui";
import { XTermView } from "@/components/terminal-panel";
import { useEffect, useRef } from "react";
import { LoaderCircleIcon } from "lucide-react";

export function RuntimeTerminalTab({
  runtimeWebsocketUrl,
  cwd,
}: {
  runtimeWebsocketUrl?: string;
  cwd?: string;
}) {
  const { terminals, sendInput, resize, onData, createTerminal } = useTerminal(runtimeWebsocketUrl);

  // Auto-create a single terminal on mount
  const createdRef = useRef(false);
  useEffect(() => {
    if (!createdRef.current) {
      createdRef.current = true;
      createTerminal({ cwd });
    }
  }, [createTerminal, cwd]);

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
