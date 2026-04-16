import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "#/components/ui/button";
import { writeTerminalData } from "#/lib/terminal-stream";

const API_BASE = "http://localhost:3000";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<string>("idle");
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const createSession = useCallback(async (cols: number, rows: number) => {
    setError(null);
    const res = await fetch(`${API_BASE}/api/terminals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 0, cols, rows }),
    });
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    const data: { sessionId: string } = await res.json();
    return data.sessionId;
  }, []);

  useEffect(() => {
    if (!terminalVisible || !termRef.current) return;

    const container = termRef.current;
    const term = new Terminal({ cursorBlink: true, fontSize: 14 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    terminalRef.current = term;
    wsRef.current = null;

    let active = true;
    let resizeTimer: ReturnType<typeof setTimeout>;
    let lastCols = 0;
    let lastRows = 0;
    let currentSessionId: string | null = null;

    function doFit() {
      fit.fit();
      term.focus();
    }

    async function initializeTerminal(): Promise<void> {
      setWsStatus("creating...");
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!active) return;

      doFit();
      const cols = Math.max(term.cols, 80);
      const rows = Math.max(term.rows, 24);

      try {
        currentSessionId = await createSession(cols, rows);
        if (!active || currentSessionId == null) return;
        setSessionId(currentSessionId);
      } catch (e) {
        if (!active) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        setWsStatus("error");
        term.write(`\r\n[session creation failed: ${message}]\r\n`);
        return;
      }

      const wsUrl = `${API_BASE.replace("http", "ws")}/terminals/${currentSessionId}/stream`;
      setWsStatus("connecting...");
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setWsStatus("connected");
        doFit();
        const { cols: nextCols, rows: nextRows } = term;
        lastCols = nextCols;
        lastRows = nextRows;
        ws.send(JSON.stringify({ type: "resize", cols: nextCols, rows: nextRows }));
      };
      ws.onmessage = (e) => {
        void writeTerminalData(term, e.data);
      };
      ws.onerror = () => {
        setWsStatus("error");
        term.write("\r\n[connection error]\r\n");
      };
      ws.onclose = (e) => {
        setWsStatus(`closed (${e.code})`);
        term.write("\r\n[disconnected]\r\n");
      };
    }

    void initializeTerminal();

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    term.onResize(({ cols, rows }) => {
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    const onWindowResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doFit, 100);
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      active = false;
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onWindowResize);
      wsRef.current?.close();
      wsRef.current = null;
      terminalRef.current = null;
      term.dispose();
    };
  }, [createSession, terminalVisible]);

  if (!terminalVisible) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
        <h1 className="text-2xl font-bold">Flamecast Terminal</h1>
        <Button
          onClick={() => {
            setSessionId(null);
            setWsStatus("idle");
            setTerminalVisible(true);
          }}
        >
          New Session
        </Button>
        {error && <p className="text-red-500">{error}</p>}
      </main>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "#000" }}>
      <div className="flex items-center gap-2 px-2 py-1 text-sm text-neutral-400">
        <span>Session: {sessionId ?? "starting..."}</span>
        <span className="text-neutral-500">WS: {wsStatus}</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            wsRef.current?.close();
            setSessionId(null);
            setWsStatus("idle");
            setTerminalVisible(false);
          }}
        >
          Disconnect
        </Button>
      </div>
      <div
        ref={termRef}
        style={{ flex: 1, overflow: "hidden" }}
        onClick={() => terminalRef.current?.focus()}
      />
    </div>
  );
}
