package main

import (
	"bytes"
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
	"github.com/smithery-ai/flamecast/packages/session-host-go/terminal"
	"github.com/smithery-ai/flamecast/packages/session-host-go/ws"
)

// ---------- Session state ----------

type session struct {
	mu          sync.Mutex
	id          string
	workspace   string
	cmd         *exec.Cmd
	conn        *acp.Connection
	handler     *clientHandler
	busy        bool
	fileWatcher *filewatcher.Watcher
	exitCh      chan error
}

// ---------- Session registry ----------

type sessionRegistry struct {
	mu       sync.RWMutex
	sessions map[string]*session
}

func newSessionRegistry() *sessionRegistry {
	return &sessionRegistry{sessions: make(map[string]*session)}
}

func (r *sessionRegistry) get(id string) *session {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.sessions[id]
}

func (r *sessionRegistry) set(id string, s *session) {
	r.mu.Lock()
	r.sessions[id] = s
	r.mu.Unlock()
}

func (r *sessionRegistry) remove(id string) {
	r.mu.Lock()
	if s, ok := r.sessions[id]; ok {
		if s.fileWatcher != nil {
			s.fileWatcher.Close()
		}
		if s.handler != nil && s.handler.terminals != nil {
			s.handler.terminals.ReleaseAll()
		}
		delete(r.sessions, id)
	}
	r.mu.Unlock()
}

func (r *sessionRegistry) list() []map[string]any {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]map[string]any, 0, len(r.sessions))
	for _, s := range r.sessions {
		status := "idle"
		s.mu.Lock()
		if s.busy {
			status = "running"
		}
		s.mu.Unlock()
		result = append(result, map[string]any{"sessionId": s.id, "status": status})
	}
	return result
}

func (r *sessionRegistry) terminateAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, s := range r.sessions {
		if s.cmd != nil && s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
		if s.fileWatcher != nil {
			s.fileWatcher.Close()
		}
		delete(r.sessions, id)
	}
}

// ---------- Request/Response types ----------

type startRequest struct {
	Command     string            `json:"command"`
	Args        []string          `json:"args"`
	Workspace   string            `json:"workspace"`
	Setup       string            `json:"setup,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	CallbackUrl string            `json:"callbackUrl,omitempty"`
}

type startResponse struct {
	ACPSessionID string `json:"acpSessionId"`
	SessionID    string `json:"sessionId"`
}

// ---------- ACP client handler (agent → runtime-host → WebSocket clients) ----------

type clientHandler struct {
	hub                 *ws.Hub
	sessionID           string
	agentID             string
	workspace           string
	permissionResolvers map[string]chan json.RawMessage
	terminals           *terminal.Registry
	mu                  sync.Mutex
}

func newClientHandler(hub *ws.Hub, sessionID, workspace string) *clientHandler {
	h := &clientHandler{
		hub:                 hub,
		sessionID:           sessionID,
		agentID:             sessionID, // 1:1 for now
		workspace:           workspace,
		permissionResolvers: make(map[string]chan json.RawMessage),
	}
	h.terminals = terminal.NewRegistry(func(terminalID string, data []byte) {
		h.emitEvent("terminal.data", map[string]any{
			"terminalId": terminalID,
			"data":       string(data),
		})
	})
	return h
}

func (h *clientHandler) emitEvent(eventType string, data map[string]any) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	h.hub.PublishEvent(h.sessionID, h.agentID, eventType, data, now)
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

func (h *clientHandler) hasPermissionRequest(requestID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.permissionResolvers[requestID]
	return ok
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

	var req struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
		Cols    uint16   `json:"cols"`
		Rows    uint16   `json:"rows"`
	}
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}

	command := req.Command
	if command == "" {
		command = "/bin/sh"
	}

	termID := "term-" + generateUUID()
	t, err := h.terminals.Create(termID, command, req.Args, h.workspace, nil, req.Cols, req.Rows)
	if err != nil {
		return nil, fmt.Errorf("terminal create: %w", err)
	}

	h.emitEvent("terminal.started", map[string]any{
		"terminalId": t.ID,
		"command":    command,
	})

	// Watch for exit in background
	go func() {
		exitCode, _ := h.terminals.WaitForExit(termID)
		h.emitEvent("terminal.exit", map[string]any{
			"terminalId": termID,
			"exitCode":   exitCode,
		})
	}()

	resp := map[string]string{"terminalId": termID}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodTerminalCreate, "client_to_agent", "response", resp)
	return result, nil
}

func (h *clientHandler) TerminalOutput(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodTerminalOutput, "agent_to_client", "request", json.RawMessage(params))

	var req struct {
		TerminalID string `json:"terminalId"`
	}
	_ = json.Unmarshal(params, &req)

	output, truncated := h.terminals.Output(req.TerminalID)
	resp := map[string]any{"output": output, "truncated": truncated}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodTerminalOutput, "client_to_agent", "response", resp)
	return result, nil
}

func (h *clientHandler) TerminalRelease(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodTerminalRelease, "agent_to_client", "request", json.RawMessage(params))

	var req struct {
		TerminalID string `json:"terminalId"`
	}
	_ = json.Unmarshal(params, &req)

	_ = h.terminals.Release(req.TerminalID)

	resp := map[string]any{}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodTerminalRelease, "client_to_agent", "response", resp)
	return result, nil
}

func (h *clientHandler) TerminalWaitExit(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodTerminalWaitExit, "agent_to_client", "request", json.RawMessage(params))

	var req struct {
		TerminalID string `json:"terminalId"`
	}
	_ = json.Unmarshal(params, &req)

	exitCode, err := h.terminals.WaitForExit(req.TerminalID)
	if err != nil {
		return nil, err
	}

	resp := map[string]any{"exitCode": exitCode}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodTerminalWaitExit, "client_to_agent", "response", resp)
	return result, nil
}

func (h *clientHandler) TerminalKill(params json.RawMessage) (json.RawMessage, error) {
	h.emitRPC(acp.MethodTerminalKill, "agent_to_client", "request", json.RawMessage(params))

	var req struct {
		TerminalID string `json:"terminalId"`
	}
	_ = json.Unmarshal(params, &req)

	_ = h.terminals.Kill(req.TerminalID)

	resp := map[string]any{}
	result, _ := json.Marshal(resp)
	h.emitRPC(acp.MethodTerminalKill, "client_to_agent", "response", resp)
	return result, nil
}

// ---------- Session lifecycle ----------

func startSession(sessionID string, req startRequest, hub *ws.Hub, registry *sessionRegistry) (*startResponse, error) {
	if existing := registry.get(sessionID); existing != nil {
		return nil, fmt.Errorf("session %q already running", sessionID)
	}

	workspace := req.Workspace
	if workspace == "" {
		workspace, _ = os.Getwd()
	}

	// Build environment: inherit from parent, overlay user-provided env vars.
	var procEnv []string
	if len(req.Env) > 0 {
		procEnv = os.Environ()
		for k, v := range req.Env {
			procEnv = append(procEnv, k+"="+v)
		}
	}

	// Run optional setup script
	if req.Setup != "" && os.Getenv("RUNTIME_SETUP_ENABLED") != "" {
		var setupOutput bytes.Buffer
		setupCmd := exec.Command("sh", "-c", req.Setup)
		setupCmd.Dir = workspace
		setupCmd.Stdout = io.MultiWriter(os.Stderr, &setupOutput)
		setupCmd.Stderr = io.MultiWriter(os.Stderr, &setupOutput)
		if procEnv != nil {
			setupCmd.Env = procEnv
		}
		if err := setupCmd.Run(); err != nil {
			return nil, fmt.Errorf("setup script failed: %w%s", err, formatStartupOutput(setupOutput.String()))
		}
	}

	// Spawn agent subprocess
	cmd := exec.Command(req.Command, req.Args...)
	cmd.Dir = workspace
	var agentStderr bytes.Buffer
	cmd.Stderr = io.MultiWriter(os.Stderr, &agentStderr)
	if procEnv != nil {
		cmd.Env = procEnv
	}

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

	handler := newClientHandler(hub, sessionID, workspace)

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
	var acpSessionID string
	select {
	case hs := <-hsCh:
		if hs.err != nil {
			_ = cmd.Process.Kill()
			return nil, fmt.Errorf("%w%s", hs.err, formatStartupOutput(agentStderr.String()))
		}
		acpSessionID = hs.sessionID
	case err := <-exitCh:
		exitCode := -1
		if cmd.ProcessState != nil {
			exitCode = cmd.ProcessState.ExitCode()
		}
		return nil, fmt.Errorf(
			"agent process exited during startup (code=%d, err=%v). Is %q available in this environment?%s",
			exitCode, err, req.Command, formatStartupOutput(agentStderr.String()),
		)
	}

	// Start file watcher
	fw := filewatcher.New(workspace, []string{"node_modules", ".git"}, func(changes []filewatcher.Change) {
		handler.emitEvent("filesystem.changed", map[string]any{"changes": changes})
		entries, err := filewatcher.WalkDirectory(workspace)
		if err == nil {
			handler.emitEvent("filesystem.snapshot", map[string]any{
				"snapshot": map[string]any{"root": workspace, "entries": entries},
			})
		}
	})

	sess := &session{
		id:          acpSessionID,
		workspace:   workspace,
		cmd:         cmd,
		conn:        conn,
		handler:     handler,
		fileWatcher: fw,
		exitCh:      exitCh,
	}

	registry.set(sessionID, sess)

	// Broadcast session.created lifecycle event
	hub.BroadcastLifecycle("session.created", sessionID, sessionID)

	// Handle agent exit after successful startup
	go func() {
		<-exitCh
		exitCode := -1
		if cmd.ProcessState != nil {
			exitCode = cmd.ProcessState.ExitCode()
		}
		handler.emitEvent("session.terminated", map[string]any{"exitCode": exitCode})
		hub.BroadcastLifecycle("session.terminated", sessionID, sessionID)
		registry.remove(sessionID)
	}()

	return &startResponse{
		ACPSessionID: acpSessionID,
		SessionID:    sessionID,
	}, nil
}

func formatStartupOutput(output string) string {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return ""
	}
	const limit = 4000
	if len(trimmed) > limit {
		trimmed = trimmed[len(trimmed)-limit:]
	}
	return "\nStartup output:\n" + trimmed
}

func terminateSession(sessionID string, registry *sessionRegistry, hub *ws.Hub) {
	sess := registry.get(sessionID)
	if sess == nil {
		return
	}
	if sess.cmd != nil && sess.cmd.Process != nil {
		_ = sess.cmd.Process.Kill()
	}
	hub.ClearSessionLog(sessionID)
	registry.remove(sessionID)
}

// ---------- WebSocket control messages (ws-channels protocol) ----------

type channelControlMessage struct {
	Action     string          `json:"action"`
	Channel    string          `json:"channel,omitempty"`
	Since      int64           `json:"since,omitempty"`
	SessionID  string          `json:"sessionId,omitempty"`
	Text       string          `json:"text,omitempty"`
	RequestID  string          `json:"requestId,omitempty"`
	Body       json.RawMessage `json:"body,omitempty"`
	Path       string          `json:"path,omitempty"`
	Order      []string        `json:"order,omitempty"`
	TerminalID string          `json:"terminalId,omitempty"`
	Data       string          `json:"data,omitempty"`
	Cols       uint16          `json:"cols,omitempty"`
	Rows       uint16          `json:"rows,omitempty"`
}

func executePrompt(sess *session, text string) (*acp.PromptResponse, error) {
	if sess == nil || sess.conn == nil || sess.handler == nil {
		return nil, fmt.Errorf("No active session")
	}
	if text == "" {
		return nil, fmt.Errorf("Missing 'text' field")
	}

	sess.mu.Lock()
	if sess.busy {
		sess.mu.Unlock()
		return nil, fmt.Errorf("Prompt already running")
	}
	sess.busy = true
	sess.mu.Unlock()
	defer func() {
		sess.mu.Lock()
		sess.busy = false
		sess.mu.Unlock()
	}()

	promptReq := acp.PromptRequest{
		SessionID: sess.id,
		Prompt:    []acp.ContentPart{{Type: "text", Text: text}},
	}
	sess.handler.emitRPC(acp.MethodPrompt, "client_to_agent", "request", promptReq)
	resp, err := sess.conn.Prompt(promptReq)
	if err != nil {
		sess.handler.emitEvent("error", map[string]any{"message": err.Error()})
		return nil, err
	}
	sess.handler.emitRPC(acp.MethodPrompt, "agent_to_client", "response", resp)
	return resp, nil
}

func handleChannelControl(clientID string, raw json.RawMessage, registry *sessionRegistry, hub *ws.Hub, runtimeTerminals *terminal.Registry) {
	var msg channelControlMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		hub.SendTo(clientID, map[string]any{"type": "error", "message": "Invalid message"})
		return
	}

	switch msg.Action {
	case "subscribe":
		if msg.Channel == "" {
			hub.SendTo(clientID, map[string]any{"type": "error", "message": "Missing channel"})
			return
		}
		hub.Subscribe(clientID, msg.Channel, msg.Since)

	case "unsubscribe":
		if msg.Channel == "" {
			hub.SendTo(clientID, map[string]any{"type": "error", "message": "Missing channel"})
			return
		}
		hub.Unsubscribe(clientID, msg.Channel)

	case "prompt":
		sess := registry.get(msg.SessionID)
		if sess == nil {
			hub.SendTo(clientID, map[string]any{"type": "error", "message": fmt.Sprintf("Session %q not found", msg.SessionID)})
			return
		}
		_, err := executePrompt(sess, msg.Text)
		if err != nil {
			hub.SendTo(clientID, map[string]any{"type": "error", "message": err.Error()})
		}

	case "permission.respond":
		sess := registry.get(msg.SessionID)
		if sess == nil || sess.handler == nil {
			hub.SendTo(clientID, map[string]any{"type": "error", "message": "Session not found"})
			return
		}
		sess.handler.resolvePermission(msg.RequestID, msg.Body)

	case "terminate":
		terminateSession(msg.SessionID, registry, hub)

	case "cancel":
		// TODO: implement queue cancellation
		hub.SendTo(clientID, map[string]any{"type": "error", "message": "cancel not yet implemented"})

	case "ping":
		hub.SendTo(clientID, map[string]any{"type": "pong"})

	case "fs.snapshot":
		sess := registry.get(msg.SessionID)
		if sess == nil || sess.workspace == "" {
			return
		}
		entries, err := filewatcher.WalkDirectory(sess.workspace)
		if err != nil {
			return
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		hub.SendTo(clientID, map[string]any{
			"type":      "event",
			"channel":   "session:" + msg.SessionID + ":fs",
			"sessionId": msg.SessionID,
			"agentId":   msg.SessionID,
			"seq":       0,
			"event": map[string]any{
				"type":      "filesystem.snapshot",
				"data":      map[string]any{"snapshot": map[string]any{"root": sess.workspace, "entries": entries}},
				"timestamp": now,
			},
		})

	case "file.preview":
		sess := registry.get(msg.SessionID)
		if sess == nil || sess.workspace == "" {
			return
		}
		fullPath := filepath.Join(sess.workspace, msg.Path)
		content, err := os.ReadFile(fullPath)
		now := time.Now().UTC().Format(time.RFC3339Nano)
		if err != nil {
			hub.SendTo(clientID, map[string]any{"type": "error", "message": "Cannot read: " + msg.Path})
			return
		}
		hub.SendTo(clientID, map[string]any{
			"type":      "event",
			"channel":   "session:" + msg.SessionID + ":fs",
			"sessionId": msg.SessionID,
			"agentId":   msg.SessionID,
			"seq":       0,
			"event": map[string]any{
				"type":      "file.preview",
				"data":      map[string]any{"path": msg.Path, "content": string(content)},
				"timestamp": now,
			},
		})

	case "terminal.create":
		command := msg.Data
		if command == "" {
			command = "/bin/sh"
		}
		cwd, _ := os.Getwd()
		// Use session workspace if available
		if msg.SessionID != "" {
			if sess := registry.get(msg.SessionID); sess != nil && sess.workspace != "" {
				cwd = sess.workspace
			}
		}
		termID := "term-" + generateUUID()
		t, err := runtimeTerminals.Create(termID, command, nil, cwd, nil, msg.Cols, msg.Rows)
		if err != nil {
			hub.SendTo(clientID, map[string]any{"type": "error", "message": "terminal.create: " + err.Error()})
			return
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		hub.PublishTerminalEvent("terminal.started", map[string]any{
			"terminalId": t.ID,
			"command":    command,
		}, now)
		go func() {
			exitCode, _ := runtimeTerminals.WaitForExit(termID)
			now := time.Now().UTC().Format(time.RFC3339Nano)
			hub.PublishTerminalEvent("terminal.exit", map[string]any{
				"terminalId": termID,
				"exitCode":   exitCode,
			}, now)
		}()

	case "terminal.input":
		if err := runtimeTerminals.Write(msg.TerminalID, []byte(msg.Data)); err != nil {
			hub.SendTo(clientID, map[string]any{"type": "error", "message": "terminal.input: " + err.Error()})
		}

	case "terminal.resize":
		if err := runtimeTerminals.Resize(msg.TerminalID, msg.Cols, msg.Rows); err != nil {
			hub.SendTo(clientID, map[string]any{"type": "error", "message": "terminal.resize: " + err.Error()})
		}

	case "terminal.kill":
		_ = runtimeTerminals.Release(msg.TerminalID)
	}
}

// ---------- Session-scoped HTTP handlers ----------

func handleSessionStart(sessionID string, w http.ResponseWriter, r *http.Request, hub *ws.Hub, registry *sessionRegistry) {
	var req startRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}

	resp, err := startSession(sessionID, req, hub, registry)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func handleSessionPrompt(sessionID string, w http.ResponseWriter, r *http.Request, registry *sessionRegistry) {
	sess := registry.get(sessionID)
	if sess == nil || sess.conn == nil {
		writeJSON(w, 400, map[string]any{"error": fmt.Sprintf("Session %q not found", sessionID)})
		return
	}

	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if body.Text == "" {
		writeJSON(w, 400, map[string]any{"error": "Missing 'text' field"})
		return
	}

	resp, err := executePrompt(sess, body.Text)
	if err != nil {
		status := 500
		if err.Error() == "Prompt already running" {
			status = 409
		}
		writeJSON(w, status, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, resp)
}

func handleSessionPermission(sessionID, requestID string, w http.ResponseWriter, r *http.Request, registry *sessionRegistry) {
	sess := registry.get(sessionID)
	if sess == nil || sess.handler == nil || !sess.handler.hasPermissionRequest(requestID) {
		writeJSON(w, 404, map[string]any{"error": fmt.Sprintf("Permission request %s not found or already resolved", requestID)})
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}

	sess.handler.resolvePermission(requestID, body)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func handleSessionTerminate(sessionID string, w http.ResponseWriter, registry *sessionRegistry, hub *ws.Hub) {
	terminateSession(sessionID, registry, hub)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func handleSessionFiles(sessionID string, w http.ResponseWriter, r *http.Request, registry *sessionRegistry) {
	sess := registry.get(sessionID)
	if sess == nil || sess.workspace == "" {
		writeJSON(w, 400, map[string]any{"error": fmt.Sprintf("Session %q not found", sessionID)})
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
}

func handleSessionFsSnapshot(sessionID string, w http.ResponseWriter, registry *sessionRegistry) {
	sess := registry.get(sessionID)
	if sess == nil || sess.workspace == "" {
		writeJSON(w, 400, map[string]any{"error": fmt.Sprintf("Session %q not found", sessionID)})
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
	registry := newSessionRegistry()

	// Runtime-level terminal registry (not tied to any session)
	runtimeTerminals := terminal.NewRegistry(func(terminalID string, data []byte) {
		now := time.Now().UTC().Format(time.RFC3339Nano)
		hub.PublishTerminalEvent("terminal.data", map[string]any{
			"terminalId": terminalID,
			"data":       string(data),
		}, now)
	})

	// Set up channel-based control handler
	hub.SetControlHandler(func(clientID string, msg json.RawMessage) {
		handleChannelControl(clientID, msg, registry, hub, runtimeTerminals)
	})

	mux := http.NewServeMux()

	// ---- Runtime-level endpoints ----

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"status":   "ok",
			"sessions": registry.list(),
		})
	})

	mux.HandleFunc("GET /terminals", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"terminals": runtimeTerminals.List()})
	})

	mux.HandleFunc("GET /terminals/{terminalId}", func(w http.ResponseWriter, r *http.Request) {
		terminalID := r.PathValue("terminalId")
		output, truncated := runtimeTerminals.Output(terminalID)
		t := runtimeTerminals.Get(terminalID)
		if t == nil {
			writeJSON(w, 404, map[string]any{"error": fmt.Sprintf("Terminal %q not found", terminalID)})
			return
		}
		writeJSON(w, 200, map[string]any{"terminalId": terminalID, "output": output, "truncated": truncated})
	})

	// ---- Multi-session endpoints: /sessions/{sessionId}/... ----

	mux.HandleFunc("POST /sessions/{sessionId}/start", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("sessionId")
		handleSessionStart(sessionID, w, r, hub, registry)
	})

	mux.HandleFunc("POST /sessions/{sessionId}/terminate", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("sessionId")
		handleSessionTerminate(sessionID, w, registry, hub)
	})

	mux.HandleFunc("POST /sessions/{sessionId}/prompt", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("sessionId")
		handleSessionPrompt(sessionID, w, r, registry)
	})

	mux.HandleFunc("POST /sessions/{sessionId}/permissions/{requestID}", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("sessionId")
		requestID := r.PathValue("requestID")
		handleSessionPermission(sessionID, requestID, w, r, registry)
	})

	mux.HandleFunc("GET /sessions/{sessionId}/files", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("sessionId")
		handleSessionFiles(sessionID, w, r, registry)
	})

	mux.HandleFunc("GET /sessions/{sessionId}/fs/snapshot", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("sessionId")
		handleSessionFsSnapshot(sessionID, w, registry)
	})

	mux.HandleFunc("GET /sessions/{sessionId}/health", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("sessionId")
		sess := registry.get(sessionID)
		if sess == nil {
			writeJSON(w, 404, map[string]any{"error": fmt.Sprintf("Session %q not found", sessionID)})
			return
		}
		status := "idle"
		sess.mu.Lock()
		if sess.busy {
			status = "running"
		}
		sess.mu.Unlock()
		writeJSON(w, 200, map[string]any{"status": status, "sessionId": sess.id})
	})

	mux.HandleFunc("GET /sessions/{sessionId}/terminals", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("sessionId")
		sess := registry.get(sessionID)
		if sess == nil || sess.handler == nil {
			writeJSON(w, 404, map[string]any{"error": fmt.Sprintf("Session %q not found", sessionID)})
			return
		}
		writeJSON(w, 200, map[string]any{"terminals": sess.handler.terminals.List()})
	})

	mux.HandleFunc("GET /sessions/{sessionId}/terminals/{terminalId}", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("sessionId")
		terminalID := r.PathValue("terminalId")
		sess := registry.get(sessionID)
		if sess == nil || sess.handler == nil {
			writeJSON(w, 404, map[string]any{"error": fmt.Sprintf("Session %q not found", sessionID)})
			return
		}
		output, truncated := sess.handler.terminals.Output(terminalID)
		if output == "" && !truncated {
			t := sess.handler.terminals.Get(terminalID)
			if t == nil {
				writeJSON(w, 404, map[string]any{"error": fmt.Sprintf("Terminal %q not found", terminalID)})
				return
			}
		}
		writeJSON(w, 200, map[string]any{"terminalId": terminalID, "output": output, "truncated": truncated})
	})

	// ---- Legacy single-session endpoints (backward compat) ----

	mux.HandleFunc("POST /start", func(w http.ResponseWriter, r *http.Request) {
		// Legacy: use a generated session ID
		sessionID := generateUUID()
		handleSessionStart(sessionID, w, r, hub, registry)
	})

	mux.HandleFunc("POST /terminate", func(w http.ResponseWriter, r *http.Request) {
		// Legacy: terminate all sessions
		registry.terminateAll()
		hub.ClearLog()
		writeJSON(w, 200, map[string]any{"ok": true})
	})

	mux.HandleFunc("POST /prompt", func(w http.ResponseWriter, r *http.Request) {
		// Legacy: find the first (only) session
		sessions := registry.list()
		if len(sessions) == 0 {
			writeJSON(w, 400, map[string]any{"error": "No active session"})
			return
		}
		sessionID := sessions[0]["sessionId"].(string)
		handleSessionPrompt(sessionID, w, r, registry)
	})

	mux.HandleFunc("POST /permissions/{requestID}", func(w http.ResponseWriter, r *http.Request) {
		requestID := r.PathValue("requestID")
		// Legacy: find session with this permission request
		sessions := registry.list()
		for _, s := range sessions {
			sid := s["sessionId"].(string)
			sess := registry.get(sid)
			if sess != nil && sess.handler != nil && sess.handler.hasPermissionRequest(requestID) {
				handleSessionPermission(sid, requestID, w, r, registry)
				return
			}
		}
		writeJSON(w, 404, map[string]any{"error": fmt.Sprintf("Permission request %s not found", requestID)})
	})

	mux.HandleFunc("GET /files", func(w http.ResponseWriter, r *http.Request) {
		sessions := registry.list()
		if len(sessions) == 0 {
			writeJSON(w, 400, map[string]any{"error": "No active session"})
			return
		}
		sessionID := sessions[0]["sessionId"].(string)
		handleSessionFiles(sessionID, w, r, registry)
	})

	mux.HandleFunc("GET /fs/snapshot", func(w http.ResponseWriter, r *http.Request) {
		sessions := registry.list()
		if len(sessions) == 0 {
			writeJSON(w, 400, map[string]any{"error": "No active session"})
			return
		}
		sessionID := sessions[0]["sessionId"].(string)
		handleSessionFsSnapshot(sessionID, w, registry)
	})

	// ---- WebSocket endpoint ----

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
	fmt.Printf("[runtime-host] listening on port %d (ready for sessions)\n", actualPort)

	// Graceful shutdown on SIGINT/SIGTERM
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		runtimeTerminals.ReleaseAll()
		registry.terminateAll()
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
