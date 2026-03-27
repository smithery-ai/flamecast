import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface XtermTerminalHandle {
  /** Write data to the terminal (from server/PTY output). */
  write(data: string): void;
  /** Get the underlying xterm.js Terminal instance. */
  terminal(): Terminal | null;
  /** Re-fit the terminal to its container. */
  fit(): void;
}

interface XtermTerminalProps {
  /** Called when the user types into the terminal (raw xterm onData). */
  onInput?: (data: string) => void;
  /** Additional CSS class for the container */
  className?: string;
}

/**
 * Renders an xterm.js terminal that auto-fits its container.
 *
 * Exposes a ref-based `XtermTerminalHandle` so the parent can write
 * server output directly — no intermediate data-array re-renders.
 */
export const XtermTerminal = forwardRef<XtermTerminalHandle, XtermTerminalProps>(
  function XtermTerminal({ onInput, className }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        write(data: string) {
          termRef.current?.write(data);
        },
        terminal() {
          return termRef.current;
        },
        fit() {
          try {
            fitRef.current?.fit();
          } catch {
            // ignore fit errors during teardown
          }
        },
      }),
      [],
    );

    // Initialize terminal once
    useEffect(() => {
      if (!containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'Geist Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        theme: {
          background: "hsl(0 0% 3.9%)",
          foreground: "hsl(0 0% 98%)",
          cursor: "hsl(0 0% 98%)",
          selectionBackground: "hsla(0, 0%, 98%, 0.15)",
        },
        convertEol: true,
        scrollback: 5000,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);

      // Fit after a frame so the container has dimensions
      requestAnimationFrame(() => fit.fit());

      termRef.current = term;
      fitRef.current = fit;

      return () => {
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    // Forward user input
    useEffect(() => {
      const term = termRef.current;
      if (!term || !onInput) return;
      const disposable = term.onData(onInput);
      return () => disposable.dispose();
    }, [onInput]);

    // Resize on container size changes
    useEffect(() => {
      const container = containerRef.current;
      const fit = fitRef.current;
      if (!container || !fit) return;

      const observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          // ignore fit errors during teardown
        }
      });
      observer.observe(container);
      return () => observer.disconnect();
    }, []);

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ width: "100%", height: "100%", minHeight: 0 }}
      />
    );
  },
);
