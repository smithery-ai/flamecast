package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/smithery-ai/flamecast/packages/session-host-go/acp"
	"github.com/smithery-ai/flamecast/packages/session-host-go/filewatcher"
	"github.com/smithery-ai/flamecast/packages/session-host-go/ws"
)

// ---------- Session state ----------

type session struct {
	mu          sync.Mutex
	id          string
	workspace   string
	cmd         *exec.Cmd
	conn        *acp.Connection
	hub         *ws.Hub
	fileWatcher *filewatcher.Watcher
}

var current struct {
	sync.Mutex
	sess *session
}

// ---------- Request/Response types ----------

type startRequest struct {
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	Workspace string   `json:"workspace"`
	Setup     string   `json:"setup,omitempty"`
}

type startResponse struct {
	ACPSessionID string `json:"acpSessionId"`
	HostURL      string `json:"hostUrl"`
	WebSocketURL string `json:"websocketUrl"`
}

// ---------- ACP client handler (agent → session-host → WebSocket clients) ----------

type clientHandler struct {
	hub                 *ws.Hub
	workspace           string
	permissionResolvers map[string]chan json.RawMessage
	mu                  sync.Mutex
}

func newClientHandler(hub *ws.Hub, workspace string) *clientHandler {
	return &clientHandler{
		hub:                 hub,
		workspace:           workspace,
		permissionResolvers: make(map[string]chan json.RawMessage),
	}
}

func (h *clientHandler) emitEvent(eventType string, data map[string]any) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	h.hub.Broadcast(map[string]any{
		"type":      "event",
		"timestamp": now,
		"event":     map[string]any{"type": eventType, "data": data, "timestamp": now},
	})
}

func (h *clientHandler) emitRPC(method, direction, phase string, payload any) {
	data := map[string]any{"method": method, "direction": direction, "phase": phase}
	if payload != nil {
		data["payload"] = payload
	}
	h.emitEvent("rpc", data)
}

func (h *clientHandler) SessionUpdate(params json.RawMessage) {
	h.emitRPC(acp.MethodSessionUpdate, "agent_to_client", "notification", json.RawMessage(params))
}

func (h *clientHandler) RequestPermission(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodRequestPermission, "agent_to_client", "request", json.RawMessage(params))

	var parsed struct {
		ToolCall struct {
			ToolCallID string `json:"toolCallId"`
			Title      string `json:"title"`
			Kind       string `json:"kind"`
		} `json:"toolCall"`
		Options []struct {
			OptionID string `json:"optionId"`
			Name     string `json:"name"`
			Kind     string `json:"kind"`
		} `json:"options"`
	}
	_ = json.Unmarshal(params, &parsed)

	requestID := generateUUID()
	ch := make(chan json.RawMessage, 1)

	h.mu.Lock()
	h.permissionResolvers[requestID] = ch
	h.mu.Unlock()

	options := make([]map[string]any, len(parsed.Options))
	for i, o := range parsed.Options {
		options[i] = map[string]any{"optionId": o.OptionID, "name": o.Name, "kind": o.Kind}
	}
	h.emitEvent("permission_request", map[string]any{
		"requestId":  requestID,
		"toolCallId": parsed.ToolCall.ToolCallID,
		"title":      parsed.ToolCall.Title,
		"kind":       parsed.ToolCall.Kind,
		"options":    options,
	})

	// Block until the WebSocket client responds
	resp := <-ch

	h.mu.Lock()
	delete(h.permissionResolvers, requestID)
	h.mu.Unlock()

	return resp, nil
}

func (h *clientHandler) resolvePermission(requestID string, body json.RawMessage) {
	var parsed struct {
		OptionID string `json:"optionId"`
	}
	_ = json.Unmarshal(body, &parsed)

	var response map[string]any
	if parsed.OptionID != "" {
		response = map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": parsed.OptionID}}
	} else {
		response = map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}
	}

	respBytes, _ := json.Marshal(response)

	h.mu.Lock()
	ch, ok := h.permissionResolvers[requestID]
	h.mu.Unlock()

	if ok {
		ch <- respBytes
		h.emitRPC(acp.MethodRequestPermission, "client_to_agent", "response", response)

		outcome := "rejected"
		if parsed.OptionID != "" {
			outcome = "approved"
		}
		h.emitEvent("permission_"+outcome, map[string]any{"requestId": requestID, "response": response})
	}
}

func (h *clientHandler) ReadTextFile(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodReadTextFile, "agent_to_client", "request", json.RawMessage(params))

	var req struct {
		Path  string `json:"path"`
		Line  *int   `json:"line,omitempty"`
		Limit *int   `json:"limit,omitempty"`
	}
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}

	data, err := os.ReadFile(req.Path)
	if err != nil {
		return nil, err
	}

	content := string(data)
	// Apply line/limit slicing
	if req.Line != nil || req.Limit != nil {
		lines := splitLines(content)
		start := 0
		if req.Line != nil && *req.Line > 0 {
			start = *req.Line
		}
		if start > len(lines) {
			start = len(lines)
		}
		end := len(lines)
		if req.Limit != nil {
			end = start + *req.Limit
			if end > len(lines) {
				end = len(lines)
			}
		}
		content = joinLines(lines[start:end])
	}

	resp := map[string]string{"content": content}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodReadTextFile, "client_to_agent", "response", resp)
	return result, nil
}

func (h *clientHandler) WriteTextFile(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodWriteTextFile, "agent_to_client", "request", json.RawMessage(params))

	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}

	if err := os.WriteFile(req.Path, []byte(req.Content), 0644); err != nil {
		return nil, err
	}

	resp := map[string]any{}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodWriteTextFile, "client_to_agent", "response", resp)
	return result, nil
}

func (h *clientHandler) TerminalCreate(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodTerminalCreate, "agent_to_client", "request", json.RawMessage(params))
	resp := map[string]string{"terminalId": "stub-" + generateUUID()}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodTerminalCreate, "client_to_agent", "response", resp)
	return result, nil
}

func (h *clientHandler) TerminalOutput(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodTerminalOutput, "agent_to_client", "request", json.RawMessage(params))
	resp := map[string]any{"output": "", "truncated": false}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodTerminalOutput, "client_to_agent", "response", resp)
	return result, nil
}

func (h *clientHandler) TerminalRelease(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodTerminalRelease, "agent_to_client", "request", json.RawMessage(params))
	resp := map[string]any{}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodTerminalRelease, "client_to_agent", "response", resp)
	return result, nil
}

func (h *clientHandler) TerminalWaitExit(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodTerminalWaitExit, "agent_to_client", "request", json.RawMessage(params))
	resp := map[string]any{"exitCode": 0}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodTerminalWaitExit, "client_to_agent", "response", resp)
	return result, nil
}

func (h *clientHandler) TerminalKill(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodTerminalKill, "agent_to_client", "request", json.RawMessage(params))
	resp := map[string]any{}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodTerminalKill, "client_to_agent", "response", resp)
	return result, nil
}

// ---------- Session lifecycle ----------

func startSession(req startRequest, serverPort int, hub *ws.Hub) (*startResponse, error) {
	current.Lock()
	defer current.Unlock()

	if current.sess != nil {
		return nil, fmt.Errorf("session already running")
	}

	// Clear any leftover events from a previous session
	hub.ClearLog()

	workspace := req.Workspace
	if workspace == "" {
		workspace, _ = os.Getwd()
	}

	// Run optional setup script
	if req.Setup != "" && os.Getenv("RUNTIME_SETUP_ENABLED") != "" {
		setupCmd := exec.Command("sh", "-c", req.Setup)
		setupCmd.Dir = workspace
		setupCmd.Stdout = os.Stderr
		setupCmd.Stderr = os.Stderr
		if err := setupCmd.Run(); err != nil {
			return nil, fmt.Errorf("setup script failed: %w", err)
		}
	}

	// Spawn agent subprocess
	cmd := exec.Command(req.Command, req.Args...)
	cmd.Dir = workspace
	cmd.Stderr = os.Stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start agent: %w", err)
	}

	handler := newClientHandler(hub, workspace)

	// Race handshake against agent exit
	type handshakeResult struct {
		sessionID string
		err       error
	}
	hsCh := make(chan handshakeResult, 1)
	exitCh := make(chan error, 1)

	go func() {
		exitCh <- cmd.Wait()
	}()

	conn := acp.NewConnection(stdout, stdin, handler)

	go func() {
		initParams := acp.InitializeRequest{
			ProtocolVersion: acp.ProtocolVersion,
			ClientCapabilities: acp.ClientCapabilities{
				FS:       &acp.FSCapabilities{ReadTextFile: true, WriteTextFile: true},
				Terminal: true,
			},
		}
		handler.emitRPC(acp.MethodInitialize, "client_to_agent", "request", initParams)
		initResp, err := conn.Initialize(initParams)
		if err != nil {
			hsCh <- handshakeResult{err: fmt.Errorf("initialize: %w", err)}
			return
		}
		handler.emitRPC(acp.MethodInitialize, "agent_to_client", "response", initResp)

		newSessionParams := acp.NewSessionRequest{
			CWD:        workspace,
			MCPServers: json.RawMessage("[]"),
		}
		handler.emitRPC(acp.MethodNewSession, "client_to_agent", "request", newSessionParams)
		sessResp, err := conn.NewSession(newSessionParams)
		if err != nil {
			hsCh <- handshakeResult{err: fmt.Errorf("new session: %w", err)}
			return
		}
		handler.emitRPC(acp.MethodNewSession, "agent_to_client", "response", sessResp)
		hsCh <- handshakeResult{sessionID: sessResp.SessionID}
	}()

	// Wait for either handshake or early exit
	var sessionID string
	select {
	case hs := <-hsCh:
		if hs.err != nil {
			_ = cmd.Process.Kill()
			return nil, hs.err
		}
		sessionID = hs.sessionID
	case err := <-exitCh:
		exitCode := -1
		if cmd.ProcessState != nil {
			exitCode = cmd.ProcessState.ExitCode()
		}
		return nil, fmt.Errorf(
			"agent process exited during startup (code=%d, err=%v). Is %q available in this environment?",
			exitCode, err, req.Command,
		)
	}

	// Start file watcher
	fw := filewatcher.New(workspace, []string{"node_modules", ".git"}, func(changes []filewatcher.Change) {
		handler.emitEvent("filesystem.changed", map[string]any{"changes": changes})
		// Broadcast filesystem snapshot after changes
		entries, err := filewatcher.WalkDirectory(workspace)
		if err == nil {
			handler.emitEvent("filesystem.snapshot", map[string]any{
				"snapshot": map[string]any{"root": workspace, "entries": entries},
			})
		}
	})

	sess := &session{
		id:          sessionID,
		workspace:   workspace,
		cmd:         cmd,
		conn:        conn,
		hub:         hub,
		fileWatcher: fw,
	}

	// Handle agent exit after successful startup
	go func() {
		<-exitCh
		exitCode := -1
		if cmd.ProcessState != nil {
			exitCode = cmd.ProcessState.ExitCode()
		}
		handler.emitEvent("session.terminated", map[string]any{"exitCode": exitCode})
		resetSession()
	}()

	current.sess = sess

	// Register WebSocket control message handler
	hub.SetControlHandler(func(clientID string, msg json.RawMessage) {
		handleControl(clientID, msg, sess, handler)
	})

	return &startResponse{
		ACPSessionID: sessionID,
		HostURL:      fmt.Sprintf("http://localhost:%d", serverPort),
		WebSocketURL: fmt.Sprintf("ws://localhost:%d", serverPort),
	}, nil
}

func resetSession() {
	current.Lock()
	defer current.Unlock()
	if current.sess != nil {
		if current.sess.fileWatcher != nil {
			current.sess.fileWatcher.Close()
		}
		current.sess = nil
	}
}

func terminateSession() {
	current.Lock()
	sess := current.sess
	current.Unlock()
	if sess != nil {
		if sess.cmd.Process != nil {
			_ = sess.cmd.Process.Kill()
		}
		resetSession()
	}
}

// ---------- WebSocket control messages ----------

type controlMessage struct {
	Action    string          `json:"action"`
	Text      string          `json:"text,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	Body      json.RawMessage `json:"body,omitempty"`
	Path      string          `json:"path,omitempty"`
}

func handleControl(clientID string, raw json.RawMessage, sess *session, handler *clientHandler) {
	var msg controlMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		sess.hub.SendTo(clientID, map[string]any{"type": "error", "message": "Invalid message"})
		return
	}

	switch msg.Action {
	case "prompt":
		if sess.conn == nil {
			sess.hub.Broadcast(map[string]any{"type": "error", "message": "No active session"})
			return
		}
		promptReq := acp.PromptRequest{
			SessionID: sess.id,
			Prompt:    []acp.ContentPart{{Type: "text", Text: msg.Text}},
		}
		handler.emitRPC(acp.MethodPrompt, "client_to_agent", "request", promptReq)
		resp, err := sess.conn.Prompt(promptReq)
		if err != nil {
			sess.hub.Broadcast(map[string]any{"type": "error", "message": err.Error()})
			return
		}
		handler.emitRPC(acp.MethodPrompt, "agent_to_client", "response", resp)

	case "permission.respond":
		handler.resolvePermission(msg.RequestID, msg.Body)

	case "terminate":
		terminateSession()

	case "ping":
		// no-op

	case "fs.snapshot":
		if sess.workspace == "" {
			return
		}
		entries, err := filewatcher.WalkDirectory(sess.workspace)
		if err != nil {
			return
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		sess.hub.SendTo(clientID, map[string]any{
			"type":      "event",
			"timestamp": now,
			"event": map[string]any{
				"type": "filesystem.snapshot",
				"data": map[string]any{"snapshot": map[string]any{"root": sess.workspace, "entries": entries}},
				"timestamp": now,
			},
		})

	case "file.preview":
		if sess.workspace == "" {
			return
		}
		fullPath := filepath.Join(sess.workspace, msg.Path)
		content, err := os.ReadFile(fullPath)
		now := time.Now().UTC().Format(time.RFC3339Nano)
		if err != nil {
			sess.hub.SendTo(clientID, map[string]any{"type": "error", "message": "Cannot read: " + msg.Path})
			return
		}
		sess.hub.SendTo(clientID, map[string]any{
			"type":      "event",
			"timestamp": now,
			"event": map[string]any{
				"type":      "file.preview",
				"data":      map[string]any{"path": msg.Path, "content": string(content)},
				"timestamp": now,
			},
		})
	}
}

// ---------- HTTP server ----------

func main() {
	// PID 1 zombie reaping
	if os.Getpid() == 1 {
		go reapZombies()
	}

	port := 8787
	if p := os.Getenv("SESSION_HOST_PORT"); p != "" {
		if v, err := strconv.Atoi(p); err == nil {
			port = v
		}
	}

	hub := ws.NewHub()

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		current.Lock()
		sess := current.sess
		current.Unlock()

		w.Header().Set("Content-Type", "application/json")
		if sess != nil {
			writeJSON(w, 200, map[string]any{"status": "running", "sessionId": sess.id})
		} else {
			writeJSON(w, 200, map[string]any{"status": "idle"})
		}
	})

	mux.HandleFunc("POST /start", func(w http.ResponseWriter, r *http.Request) {
		var req startRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}

		addr := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
		serverPort := addr.(*net.TCPAddr).Port

		resp, err := startSession(req, serverPort, hub)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, resp)
	})

	mux.HandleFunc("POST /terminate", func(w http.ResponseWriter, r *http.Request) {
		terminateSession()
		writeJSON(w, 200, map[string]any{"ok": true})
	})

	mux.HandleFunc("GET /files", func(w http.ResponseWriter, r *http.Request) {
		current.Lock()
		sess := current.sess
		current.Unlock()
		if sess == nil || sess.workspace == "" {
			writeJSON(w, 400, map[string]any{"error": "No active session"})
			return
		}
		filePath := r.URL.Query().Get("path")
		if filePath == "" {
			writeJSON(w, 400, map[string]any{"error": "Missing ?path= parameter"})
			return
		}
		resolved := filepath.Join(sess.workspace, filePath)
		if !strings.HasPrefix(resolved, sess.workspace) {
			writeJSON(w, 403, map[string]any{"error": "Path outside workspace"})
			return
		}
		raw, err := os.ReadFile(resolved)
		if err != nil {
			writeJSON(w, 404, map[string]any{"error": "Cannot read: " + filePath})
			return
		}
		maxChars := 100_000
		content := string(raw)
		truncated := len(content) > maxChars
		if truncated {
			content = content[:maxChars]
		}
		writeJSON(w, 200, map[string]any{
			"path": filePath, "content": content, "truncated": truncated, "maxChars": maxChars,
		})
	})

	mux.HandleFunc("GET /fs/snapshot", func(w http.ResponseWriter, r *http.Request) {
		current.Lock()
		sess := current.sess
		current.Unlock()
		if sess == nil || sess.workspace == "" {
			writeJSON(w, 400, map[string]any{"error": "No active session"})
			return
		}
		entries, err := filewatcher.WalkDirectory(sess.workspace)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		maxEntries := 10_000
		truncated := len(entries) > maxEntries
		limited := entries
		if truncated {
			limited = entries[:maxEntries]
		}
		writeJSON(w, 200, map[string]any{
			"root": sess.workspace, "entries": limited, "truncated": truncated, "maxEntries": maxEntries,
		})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "OPTIONS" {
			setCORS(w)
			w.WriteHeader(204)
			return
		}
		if r.Header.Get("Upgrade") == "websocket" {
			hub.HandleUpgrade(w, r)
			return
		}
		http.NotFound(w, r)
	})

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	actualPort := ln.Addr().(*net.TCPAddr).Port
	fmt.Printf("[session-host] listening on port %d (idle, waiting for POST /start)\n", actualPort)

	// Graceful shutdown on SIGINT/SIGTERM
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		terminateSession()
		_ = ln.Close()
		os.Exit(0)
	}()

	if err := http.Serve(ln, mux); err != nil {
		log.Fatalf("serve: %v", err)
	}
}

// ---------- Helpers ----------

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	setCORS(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func reapZombies() {
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, 0, nil)
		if err != nil {
			// ECHILD = no children, sleep briefly then retry
			time.Sleep(100 * time.Millisecond)
			_ = pid
		}
	}
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func joinLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	result := lines[0]
	for _, l := range lines[1:] {
		result += "\n" + l
	}
	return result
}

func generateUUID() string {
	b := make([]byte, 16)
	_, _ = io.ReadFull(cryptoReader(), b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func cryptoReader() io.Reader {
	f, err := os.Open("/dev/urandom")
	if err != nil {
		panic(err)
	}
	return f
}
