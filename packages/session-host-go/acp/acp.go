// Package acp implements the client side of the Agent Client Protocol.
// It drives an ACP-compatible agent subprocess over stdio.
package acp

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/smithery-ai/flamecast/packages/session-host-go/jsonrpc"
)

// Protocol version advertised during the initialize handshake.
const ProtocolVersion = 1

// Agent method names (client → agent).
const (
	MethodInitialize  = "initialize"
	MethodNewSession  = "session/new"
	MethodPrompt      = "session/prompt"
)

// Client method names (agent → client).
const (
	MethodSessionUpdate     = "session/update"
	MethodRequestPermission = "session/request_permission"
	MethodReadTextFile      = "fs/read_text_file"
	MethodWriteTextFile     = "fs/write_text_file"
	MethodTerminalCreate    = "terminal/create"
	MethodTerminalOutput    = "terminal/output"
	MethodTerminalRelease   = "terminal/release"
	MethodTerminalWaitExit  = "terminal/wait_for_exit"
	MethodTerminalKill      = "terminal/kill"
	MethodWaitFor           = "session/wait_for"
	MethodWait              = "session/wait"
	MethodSchedule          = "session/schedule"
)

// ---------- Request/Response types ----------

type InitializeRequest struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientCapabilities ClientCapabilities `json:"clientCapabilities"`
}

type ClientCapabilities struct {
	FS       *FSCapabilities `json:"fs,omitempty"`
	Terminal bool            `json:"terminal,omitempty"`
}

type FSCapabilities struct {
	ReadTextFile  bool `json:"readTextFile,omitempty"`
	WriteTextFile bool `json:"writeTextFile,omitempty"`
}

// ServerCapabilities advertises platform-provided capabilities during initialize.
type ServerCapabilities struct {
	Platform *PlatformCapabilities `json:"platform,omitempty"`
}

// PlatformCapabilities describes temporal primitive support from the hosting platform.
type PlatformCapabilities struct {
	DurableSleep bool `json:"durableSleep,omitempty"`
	WaitFor      bool `json:"waitFor,omitempty"`
	Schedule     bool `json:"schedule,omitempty"`
}

type InitializeResponse struct {
	ProtocolVersion    int                 `json:"protocolVersion"`
	AgentInfo          json.RawMessage     `json:"agentInfo,omitempty"`
	ServerCapabilities *ServerCapabilities `json:"serverCapabilities,omitempty"`
}

type NewSessionRequest struct {
	CWD        string          `json:"cwd"`
	MCPServers json.RawMessage `json:"mcpServers"`
}

type NewSessionResponse struct {
	SessionID string `json:"sessionId"`
}

type PromptRequest struct {
	SessionID string        `json:"sessionId"`
	Prompt    []ContentPart `json:"prompt"`
}

type ContentPart struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type PromptResponse struct {
	StopReason string `json:"stopReason,omitempty"`
}

// ClientHandler receives agent→client calls. Each method should return the
// JSON-encoded response, or an error.
type ClientHandler interface {
	SessionUpdate(params json.RawMessage)
	RequestPermission(params json.RawMessage) (json.RawMessage, error)
	ReadTextFile(params json.RawMessage) (json.RawMessage, error)
	WriteTextFile(params json.RawMessage) (json.RawMessage, error)
	TerminalCreate(params json.RawMessage) (json.RawMessage, error)
	TerminalOutput(params json.RawMessage) (json.RawMessage, error)
	TerminalRelease(params json.RawMessage) (json.RawMessage, error)
	TerminalWaitExit(params json.RawMessage) (json.RawMessage, error)
	TerminalKill(params json.RawMessage) (json.RawMessage, error)
	WaitFor(params json.RawMessage) (json.RawMessage, error)
	Wait(params json.RawMessage) (json.RawMessage, error)
	Schedule(params json.RawMessage) (json.RawMessage, error)
}

// Connection wraps a JSON-RPC conn and presents typed ACP operations.
type Connection struct {
	rpc *jsonrpc.Conn
}

// NewConnection creates an ACP connection over the given stdio streams.
// Incoming agent→client calls are dispatched to handler.
func NewConnection(agentStdout io.Reader, agentStdin io.Writer, handler ClientHandler) *Connection {
	var conn *Connection
	rpc := jsonrpc.NewConn(agentStdout, agentStdin, func(method string, params json.RawMessage) (json.RawMessage, error) {
		_ = conn // capture
		switch method {
		case MethodSessionUpdate:
			handler.SessionUpdate(params)
			return json.Marshal(struct{}{})
		case MethodRequestPermission:
			return handler.RequestPermission(params)
		case MethodReadTextFile:
			return handler.ReadTextFile(params)
		case MethodWriteTextFile:
			return handler.WriteTextFile(params)
		case MethodTerminalCreate:
			return handler.TerminalCreate(params)
		case MethodTerminalOutput:
			return handler.TerminalOutput(params)
		case MethodTerminalRelease:
			return handler.TerminalRelease(params)
		case MethodTerminalWaitExit:
			return handler.TerminalWaitExit(params)
		case MethodTerminalKill:
			return handler.TerminalKill(params)
		case MethodWaitFor:
			return handler.WaitFor(params)
		case MethodWait:
			return handler.Wait(params)
		case MethodSchedule:
			return handler.Schedule(params)
		default:
			return nil, jsonrpc.MethodNotFoundError(method)
		}
	})
	conn = &Connection{rpc: rpc}
	return conn
}

// Initialize performs the ACP handshake.
func (c *Connection) Initialize(req InitializeRequest) (*InitializeResponse, error) {
	raw, err := c.rpc.Call(MethodInitialize, req)
	if err != nil {
		return nil, fmt.Errorf("initialize: %w", err)
	}
	var resp InitializeResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("unmarshal initialize response: %w", err)
	}
	return &resp, nil
}

// NewSession creates a new agent session.
func (c *Connection) NewSession(req NewSessionRequest) (*NewSessionResponse, error) {
	raw, err := c.rpc.Call(MethodNewSession, req)
	if err != nil {
		return nil, fmt.Errorf("new session: %w", err)
	}
	var resp NewSessionResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("unmarshal new session response: %w", err)
	}
	return &resp, nil
}

// Prompt sends a user prompt and waits for the agent's response.
func (c *Connection) Prompt(req PromptRequest) (*PromptResponse, error) {
	raw, err := c.rpc.Call(MethodPrompt, req)
	if err != nil {
		return nil, fmt.Errorf("prompt: %w", err)
	}
	var resp PromptResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("unmarshal prompt response: %w", err)
	}
	return &resp, nil
}

// Closed returns a channel closed when the underlying connection ends.
func (c *Connection) Closed() <-chan struct{} { return c.rpc.Closed() }
