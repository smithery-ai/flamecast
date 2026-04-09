import { useTerminal } from "@flamecast/ui";
import { TerminalPanel } from "@/components/terminal-panel";

export function RuntimeTerminalTab({
  runtimeWebsocketUrl,
  cwd,
}: {
  runtimeWebsocketUrl?: string;
  cwd?: string;
}) {
  const { terminals, sendInput, resize, onData, createTerminal, killTerminal } =
    useTerminal(runtimeWebsocketUrl);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <TerminalPanel
        terminals={terminals}
        sendInput={sendInput}
        resize={resize}
        onData={onData}
        onCreateTerminal={() => createTerminal({ cwd })}
        onRemoveTerminal={killTerminal}
      />
    </div>
  );
}
