import { XTermView } from "@/components/terminal-panel";
import { LoaderCircleIcon } from "lucide-react";

export function RuntimeTerminalTab({
  terminalId,
  sendInput,
  resize,
  onData,
}: {
  terminalId?: string;
  sendInput: (terminalId: string, data: string) => void;
  resize: (terminalId: string, cols: number, rows: number) => void;
  onData: (terminalId: string, listener: (data: string) => void) => () => void;
}) {
  if (!terminalId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-black">
      <XTermView
        terminalId={terminalId}
        initialOutput=""
        sendInput={sendInput}
        resize={resize}
        onData={onData}
        visible
      />
    </div>
  );
}
