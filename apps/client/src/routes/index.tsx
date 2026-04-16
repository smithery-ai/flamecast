import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { SidebarInset, SidebarTrigger } from "#/components/ui/sidebar";
import { TerminalSidebar } from "#/components/terminal-sidebar";
import { writeTerminalData } from "#/lib/terminal-stream";
import { API_BASE, fetchSessions } from "#/lib/api";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const { isError } = useQuery({
    queryKey: ["terminals"],
    queryFn: fetchSessions,
    refetchInterval: 5000,
    retry: false,
  });

  if (isError) {
    return <ConnectionError />;
  }

  return (
    <>
      <TerminalSidebar
        activeSessionId={activeSessionId}
        onSelectSession={setActiveSessionId}
        onNewSession={setActiveSessionId}
      />
      <SidebarInset className="flex h-dvh flex-col overflow-hidden">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
          <SidebarTrigger />
          {activeSessionId && (
            <span className="text-xs text-muted-foreground">{activeSessionId}</span>
          )}
        </header>
        {activeSessionId ? (
          <TerminalView key={activeSessionId} sessionId={activeSessionId} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            Select or create a session
          </div>
        )}
      </SidebarInset>
    </>
  );
}

function ConnectionError() {
  return (
    <div className="flex h-dvh flex-1 items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-lg font-semibold">Can't connect to Flamecast</h1>
        <p className="text-sm text-muted-foreground">
          No Flamecast instance is running at <code>{API_BASE}</code>. Start one by running:
        </p>
        <pre className="rounded-md bg-muted px-3 py-2 text-left text-sm">
          <code>npx flamecast@latest up</code>
        </pre>
      </div>
    </div>
  );
}

function TerminalView({ sessionId }: { sessionId: string }) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!termRef.current) return;

    const container = termRef.current;
    const term = new Terminal({ cursorBlink: true, fontSize: 14 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    terminalRef.current = term;

    let active = true;
    let resizeTimer: ReturnType<typeof setTimeout>;
    let lastCols = 0;
    let lastRows = 0;

    function doFit() {
      fit.fit();
      term.focus();
    }

    async function connect() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!active) return;

      doFit();
      const wsUrl = `${API_BASE.replace("http", "ws")}/terminals/${sessionId}/stream`;
      const openLiveStream = () => {
        const ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onmessage = (e) => {
          void writeTerminalData(term, e.data);
        };
        ws.onerror = () => {
          term.write("\r\n[connection error]\r\n");
        };
        ws.onclose = (e) => {
          if (wsRef.current === ws) {
            term.write(`\r\n[disconnected (${e.code})]\r\n`);
          }
        };
      };

      const resizeWs = new WebSocket(wsUrl);
      resizeWs.binaryType = "arraybuffer";
      wsRef.current = resizeWs;
      let handoffToLiveStream = false;

      resizeWs.onopen = async () => {
        doFit();
        const { cols, rows } = term;
        lastCols = cols;
        lastRows = rows;
        resizeWs.send(JSON.stringify({ type: "resize", cols, rows }));

        // Let the shell settle after the resize, then reconnect so the
        // server's initial replay reflects the resized pane state.
        await new Promise((r) => setTimeout(r, 150));
        if (!active) return;
        handoffToLiveStream = true;
        resizeWs.close();
      };
      resizeWs.onerror = () => {
        term.write("\r\n[connection error]\r\n");
      };
      resizeWs.onclose = (e) => {
        if (!active || wsRef.current !== resizeWs) return;
        if (handoffToLiveStream) {
          openLiveStream();
          return;
        }
        term.write(`\r\n[disconnected (${e.code})]\r\n`);
      };
    }

    void connect();

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
  }, [sessionId]);

  return (
    <div
      ref={termRef}
      className="flex-1 overflow-hidden bg-black"
      onClick={() => terminalRef.current?.focus()}
    />
  );
}
