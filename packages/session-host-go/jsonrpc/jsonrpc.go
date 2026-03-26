// Package jsonrpc implements a minimal JSON-RPC 2.0 transport over
// newline-delimited JSON (ndjson) on stdio streams.
package jsonrpc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

// Message is the JSON-RPC 2.0 wire format.
type Message struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
	Result  json.RawMessage  `json:"result,omitempty"`
	Error   *RPCError        `json:"error,omitempty"`
}

// RPCError is a JSON-RPC 2.0 error object.
type RPCError struct {
	Code    int              `json:"code"`
	Message string           `json:"message"`
	Data    *json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message) }

// Handler is called for incoming requests/notifications.
// For notifications (id == nil), the return value is ignored.
type Handler func(method string, params json.RawMessage) (json.RawMessage, error)

// Conn manages a bidirectional JSON-RPC 2.0 connection over ndjson streams.
type Conn struct {
	reader io.Reader
	writer io.Writer

	nextID   atomic.Int64
	pending  map[int64]chan *Message
	mu       sync.Mutex
	writeMu  sync.Mutex
	handler  Handler
	closed   chan struct{}
	closeErr error
}

// NewConn creates a connection over the given reader/writer pair (typically
// a subprocess's stdout/stdin).
func NewConn(r io.Reader, w io.Writer, h Handler) *Conn {
	c := &Conn{
		reader:  r,
		writer:  w,
		pending: make(map[int64]chan *Message),
		handler: h,
		closed:  make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// Call sends a request and waits for the response.
func (c *Conn) Call(method string, params any) (json.RawMessage, error) {
	id := c.nextID.Add(1) - 1
	ch := make(chan *Message, 1)

	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	idRaw := json.RawMessage(fmt.Sprintf("%d", id))
	paramBytes, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("marshal params: %w", err)
	}

	msg := Message{
		JSONRPC: "2.0",
		ID:      &idRaw,
		Method:  method,
		Params:  paramBytes,
	}
	if err := c.send(msg); err != nil {
		return nil, err
	}

	select {
	case resp := <-ch:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-c.closed:
		return nil, fmt.Errorf("connection closed: %v", c.closeErr)
	}
}

// Notify sends a notification (no response expected).
func (c *Conn) Notify(method string, params any) error {
	paramBytes, err := json.Marshal(params)
	if err != nil {
		return fmt.Errorf("marshal params: %w", err)
	}
	return c.send(Message{
		JSONRPC: "2.0",
		Method:  method,
		Params:  paramBytes,
	})
}

// Closed returns a channel that is closed when the connection ends.
func (c *Conn) Closed() <-chan struct{} { return c.closed }

func (c *Conn) send(msg Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	data = append(data, '\n')

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.writer.Write(data)
	return err
}

func (c *Conn) readLoop() {
	scanner := bufio.NewScanner(c.reader)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024) // 10MB max line

	defer func() {
		c.closeErr = fmt.Errorf("read loop ended")
		close(c.closed)
	}()

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var msg Message
		if err := json.Unmarshal(line, &msg); err != nil {
			fmt.Printf("Failed to parse JSON message: %s %v\n", string(line), err)
			continue
		}

		isResponse := msg.ID != nil && msg.Method == ""

		if isResponse {
			// Response to a pending request
			var id int64
			if err := json.Unmarshal(*msg.ID, &id); err == nil {
				c.mu.Lock()
				ch, ok := c.pending[id]
				c.mu.Unlock()
				if ok {
					ch <- &msg
				}
			}
			continue
		}

		if msg.Method != "" {
			// Incoming request or notification
			go c.handleIncoming(msg)
		}
	}
}

func (c *Conn) handleIncoming(msg Message) {
	result, err := c.handler(msg.Method, msg.Params)

	// Notifications (no ID) don't get a response
	if msg.ID == nil {
		return
	}

	resp := Message{JSONRPC: "2.0", ID: msg.ID}
	if err != nil {
		resp.Error = &RPCError{Code: -32603, Message: err.Error()}
	} else {
		resp.Result = result
	}
	_ = c.send(resp)
}

// MethodNotFoundError returns a JSON-RPC method-not-found error.
func MethodNotFoundError(method string) error {
	return &RPCError{Code: -32601, Message: fmt.Sprintf("Method not found: %s", method)}
}
