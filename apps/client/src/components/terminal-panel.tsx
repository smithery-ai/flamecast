import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export function XTermView({
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
