import { useState, useEffect, useCallback } from "react";

interface ConnectionLog {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

interface ConnectionInfo {
  id: string;
  agentType: string;
  sessionId: string;
  startedAt: string;
  lastUpdatedAt: string;
  logs: ConnectionLog[];
}

export default function App() {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConn, setSelectedConn] = useState<ConnectionInfo | null>(null);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const fetchConnections = useCallback(async () => {
    const res = await fetch("/api/connections");
    const data = await res.json();
    setConnections(data);
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedConn(null);
      return;
    }
    const interval = setInterval(async () => {
      const res = await fetch(`/api/connections/${selectedId}`);
      if (res.ok) {
        setSelectedConn(await res.json());
      }
    }, 1000);
    // Fetch immediately too
    fetch(`/api/connections/${selectedId}`)
      .then((r) => r.json())
      .then(setSelectedConn);
    return () => clearInterval(interval);
  }, [selectedId]);

  const createConnection = async (agent: string) => {
    setCreating(true);
    const res = await fetch("/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent }),
    });
    const conn = await res.json();
    await fetchConnections();
    setSelectedId(conn.id);
    setCreating(false);
  };

  const sendPrompt = async () => {
    if (!selectedId || !prompt.trim()) return;
    setLoading(true);
    await fetch(`/api/connections/${selectedId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    });
    setPrompt("");
    setLoading(false);
    // Refresh connection details
    const res = await fetch(`/api/connections/${selectedId}`);
    if (res.ok) setSelectedConn(await res.json());
  };

  const killConnection = async (id: string) => {
    await fetch(`/api/connections/${id}`, { method: "DELETE" });
    if (selectedId === id) {
      setSelectedId(null);
      setSelectedConn(null);
    }
    fetchConnections();
  };

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 900, margin: "0 auto", padding: 20 }}>
      <h1>🔥 Flamecast</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button onClick={() => createConnection("example")} disabled={creating}>
          {creating ? "Creating..." : "+ Example Agent"}
        </button>
        <button onClick={() => createConnection("codex")} disabled={creating}>
          {creating ? "Creating..." : "+ Codex Agent"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 20 }}>
        {/* Sidebar */}
        <div style={{ minWidth: 200 }}>
          <h3>Connections</h3>
          {connections.length === 0 && <p style={{ color: "#888" }}>No active connections</p>}
          {connections.map((c) => (
            <div
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              style={{
                padding: 10,
                marginBottom: 8,
                border: selectedId === c.id ? "2px solid #0070f3" : "1px solid #ddd",
                borderRadius: 6,
                cursor: "pointer",
                background: selectedId === c.id ? "#f0f7ff" : "white",
              }}
            >
              <strong>#{c.id}</strong> — {c.agentType}
              <br />
              <small style={{ color: "#888" }}>{c.logs.length} logs</small>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  killConnection(c.id);
                }}
                style={{ float: "right", color: "red", border: "none", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* Main panel */}
        <div style={{ flex: 1 }}>
          {selectedConn ? (
            <>
              <h3>
                Connection #{selectedConn.id} ({selectedConn.agentType})
              </h3>
              <p>
                <strong>Session:</strong> <code>{selectedConn.sessionId}</code>
              </p>

              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <input
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendPrompt()}
                  placeholder="Send a prompt..."
                  style={{ flex: 1, padding: 8, borderRadius: 4, border: "1px solid #ddd" }}
                  disabled={loading}
                />
                <button onClick={sendPrompt} disabled={loading || !prompt.trim()}>
                  {loading ? "Sending..." : "Send"}
                </button>
              </div>

              <h4>Logs ({selectedConn.logs.length})</h4>
              <div
                style={{
                  maxHeight: 500,
                  overflow: "auto",
                  border: "1px solid #ddd",
                  borderRadius: 6,
                  padding: 10,
                }}
              >
                {selectedConn.logs.map((log, i) => (
                  <div key={i} style={{ marginBottom: 8, fontSize: 13 }}>
                    <span style={{ color: "#888" }}>
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>{" "}
                    <strong style={{ color: getLogColor(log.type) }}>{log.type}</strong>
                    <pre
                      style={{
                        margin: "4px 0 0 0",
                        padding: 6,
                        background: "#f5f5f5",
                        borderRadius: 4,
                        fontSize: 12,
                        overflow: "auto",
                      }}
                    >
                      {JSON.stringify(log.data, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p style={{ color: "#888", marginTop: 40 }}>
              Select or create a connection to get started.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function getLogColor(type: string): string {
  switch (type) {
    case "initialized":
    case "session_created":
      return "#0070f3";
    case "prompt_sent":
      return "#e67e22";
    case "prompt_completed":
      return "#27ae60";
    case "session_update":
      return "#8e44ad";
    case "permission_requested":
      return "#e74c3c";
    case "killed":
      return "#c0392b";
    default:
      return "#333";
  }
}
