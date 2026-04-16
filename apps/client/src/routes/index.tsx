import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { PlusIcon, TerminalIcon } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { SidebarInset, SidebarTrigger } from "#/components/ui/sidebar";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Button } from "#/components/ui/button";
import { TerminalSidebar } from "#/components/terminal-sidebar";
import { writeTerminalData } from "#/lib/terminal-stream";
import { API_BASE, createSession, fetchSessions } from "#/lib/api";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["terminals"],
    queryFn: fetchSessions,
    refetchInterval: 5000,
  });

  const createMutation = useMutation({
    mutationFn: () => createSession(80, 24),
    onSuccess: (sessionId) => {
      queryClient.invalidateQueries({ queryKey: ["terminals"] });
      setActiveSessionId(sessionId);
    },
  });

  useEffect(() => {
    if (!sessions || sessions.length === 0) return;
    if (activeSessionId && sessions.some((s) => s.sessionId === activeSessionId)) return;
    setActiveSessionId(sessions[0].sessionId);
  }, [sessions, activeSessionId]);

  const hasSessions = !!sessions && sessions.length > 0;

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
        {activeSessionId && hasSessions ? (
          <TerminalView key={activeSessionId} sessionId={activeSessionId} />
        ) : isLoading ? (
          <div className="flex flex-1" />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <TerminalIcon />
                </EmptyMedia>
                <EmptyTitle>No terminal sessions</EmptyTitle>
                <EmptyDescription>Create a new session to start running commands.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
                  <PlusIcon />
                  New session
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        )}
      </SidebarInset>
    </>
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
