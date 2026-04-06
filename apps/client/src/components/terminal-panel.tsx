import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PlusIcon, XIcon, TerminalSquareIcon } from "lucide-react";
import type { TerminalSession } from "@flamecast/ui";

export function TerminalPanel({
  terminals,
  sendInput,
  resize,
  onData,
  onCreateTerminal,
  onRemoveTerminal,
}: {
  terminals: TerminalSession[];
  sendInput: (terminalId: string, data: string) => void;
  resize: (terminalId: string, cols: number, rows: number) => void;
  onData: (terminalId: string, listener: (data: string) => void) => () => void;
  onCreateTerminal: () => void;
  onRemoveTerminal: (terminalId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<string | undefined>();

  // Auto-select new terminals
  useEffect(() => {
    if (terminals.length > 0 && !activeTab) {
      setActiveTab(terminals[0].terminalId);
    }
  }, [terminals, activeTab]);

  // When a new terminal appears, switch to it
  const prevLengthRef = useRef(terminals.length);
  useEffect(() => {
    if (terminals.length > prevLengthRef.current) {
      setActiveTab(terminals[terminals.length - 1].terminalId);
    }
    prevLengthRef.current = terminals.length;
  }, [terminals]);

  // When active terminal is removed, switch to another
  useEffect(() => {
    if (activeTab && !terminals.find((t) => t.terminalId === activeTab)) {
      setActiveTab(terminals[terminals.length - 1]?.terminalId);
    }
  }, [terminals, activeTab]);

  if (terminals.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-card">
        <TerminalSquareIcon className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No terminals open.</p>
        <Button variant="outline" size="sm" onClick={onCreateTerminal}>
          <PlusIcon className="mr-1 size-3.5" />
          New Terminal
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Terminal tab bar */}
      <div className="flex shrink-0 items-center border-b bg-muted/30 px-1">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          {terminals.map((term, i) => (
            <div
              key={term.terminalId}
              className={cn(
                "group/tab flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs transition-colors cursor-pointer select-none",
                activeTab === term.terminalId
                  ? "border-primary bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
              onClick={() => setActiveTab(term.terminalId)}
              role="tab"
              aria-selected={activeTab === term.terminalId}
            >
              <TerminalSquareIcon className="size-3 shrink-0" />
              <span className="max-w-24 truncate">
                {`Terminal ${i + 1}`}
              </span>
              {term.exitCode !== null && (
                <span className="text-[10px] text-muted-foreground">({term.exitCode})</span>
              )}
              <button
                type="button"
                className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover/tab:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveTerminal(term.terminalId);
                }}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={onCreateTerminal}
          title="New terminal"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>

      {/* Terminal content */}
      {terminals.map((term) => (
        <div
          key={term.terminalId}
          className="min-h-0 flex-1 flex-col overflow-hidden bg-black"
          style={{ display: activeTab === term.terminalId ? "flex" : "none" }}
        >
          <XTermView
            terminalId={term.terminalId}
            initialOutput={term.output}
            sendInput={sendInput}
            resize={resize}
            onData={onData}
            visible={activeTab === term.terminalId}
          />
        </div>
      ))}
    </div>
  );
}

function XTermView({
  terminalId,
  initialOutput,
  sendInput,
  resize,
  onData,
  visible,
}: {
  terminalId: string;
  initialOutput: string;
  sendInput: (terminalId: string, data: string) => void;
  resize: (terminalId: string, cols: number, rows: number) => void;
  onData: (terminalId: string, listener: (data: string) => void) => () => void;
  visible: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wroteInitialRef = useRef(false);

  // Create xterm instance once
  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.1,
      fontFamily: "'Menlo', 'Monaco', 'Cascadia Code', 'Courier New', monospace",
      theme: {
        background: "#09090b",
        foreground: "#fafafa",
        cursor: "#fafafa",
        selectionBackground: "#27272a",
      },
      convertEol: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Write buffered output
    if (initialOutput && !wroteInitialRef.current) {
      xterm.write(initialOutput);
      wroteInitialRef.current = true;
    }

    // Fit after a frame
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
        resize(terminalId, xterm.cols, xterm.rows);
      } catch {
        // Container may not be visible yet
      }
    });

    // Forward user keystrokes to the PTY
    const inputDisposable = xterm.onData((data) => {
      sendInput(terminalId, data);
    });

    // Subscribe to live output from the WebSocket
    const unsubOutput = onData(terminalId, (data) => {
      xterm.write(data);
    });

    return () => {
      inputDisposable.dispose();
      unsubOutput();
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId]); // intentionally run only when terminalId changes

  // Re-fit when visibility changes
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        const xterm = xtermRef.current;
        if (xterm) {
          resize(terminalId, xterm.cols, xterm.rows);
        }
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, terminalId, resize]);

  // Handle window resize
  const handleResize = useCallback(() => {
    try {
      fitAddonRef.current?.fit();
      const xterm = xtermRef.current;
      if (xterm) {
        resize(terminalId, xterm.cols, xterm.rows);
      }
    } catch {
      // ignore
    }
  }, [terminalId, resize]);

  useEffect(() => {
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [handleResize]);

  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-1 p-1"
      style={{ display: visible ? undefined : "none" }}
    />
  );
}
