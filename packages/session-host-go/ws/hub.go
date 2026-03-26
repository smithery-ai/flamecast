// Package ws provides a WebSocket hub for broadcasting JSON messages.
package ws

import (
	"encoding/json"
	"net/http"
	"sync"

	"golang.org/x/net/websocket"
)

// ControlHandler is called when a WebSocket client sends a control message.
type ControlHandler func(clientID string, msg json.RawMessage)

// Hub manages connected WebSocket clients and broadcasts messages.
type Hub struct {
	mu             sync.RWMutex
	clients        map[string]*client
	nextID         int
	controlHandler ControlHandler
	// Append-only log so late-connecting clients receive the full history
	// (initialize, session/new, available_commands_update, etc.).
	eventLog [][]byte
}

type client struct {
	id   string
	conn *websocket.Conn
}

// NewHub creates a new WebSocket hub.
func NewHub() *Hub {
	return &Hub{clients: make(map[string]*client)}
}

// SetControlHandler sets the callback for incoming control messages.
func (h *Hub) SetControlHandler(fn ControlHandler) {
	h.mu.Lock()
	h.controlHandler = fn
	h.mu.Unlock()
}

// HandleUpgrade upgrades an HTTP request to a WebSocket connection.
func (h *Hub) HandleUpgrade(w http.ResponseWriter, r *http.Request) {
	server := websocket.Server{
		Handler: func(conn *websocket.Conn) {
		h.mu.Lock()
		h.nextID++
		id := json.Number(json.Number(string(rune('0' + h.nextID%10)))).String()
		id = "ws-" + string(rune('0'+h.nextID/100%10)) + string(rune('0'+h.nextID/10%10)) + string(rune('0'+h.nextID%10))
		c := &client{id: id, conn: conn}
		h.clients[id] = c
		// Snapshot event log for replay while holding the lock
		replay := make([][]byte, len(h.eventLog))
		copy(replay, h.eventLog)
		h.mu.Unlock()

		// Replay full event history to this late-connecting client
		for _, entry := range replay {
			if _, err := conn.Write(entry); err != nil {
				break
			}
		}

		defer func() {
			h.mu.Lock()
			delete(h.clients, id)
			h.mu.Unlock()
		}()

		// Read loop for control messages
		for {
			var msg json.RawMessage
			if err := websocket.JSON.Receive(conn, &msg); err != nil {
				return // Connection closed
			}
			h.mu.RLock()
			handler := h.controlHandler
			h.mu.RUnlock()
			if handler != nil {
				go handler(id, msg)
			}
		}
		},
		// Accept all origins — the bridge connects from the control plane
		// without a browser Origin header, which the default check rejects.
		Handshake: func(config *websocket.Config, r *http.Request) error {
			return nil
		},
	}
	server.ServeHTTP(w, r)
}

// Broadcast sends a JSON message to all connected clients and appends it
// to the event log for replay to late-connecting clients.
func (h *Hub) Broadcast(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.mu.Lock()
	h.eventLog = append(h.eventLog, data)
	h.mu.Unlock()

	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		if _, err := c.conn.Write(data); err != nil {
			_ = err
		}
	}
}

// ClearLog resets the event log. Call when starting a new session.
func (h *Hub) ClearLog() {
	h.mu.Lock()
	h.eventLog = h.eventLog[:0]
	h.mu.Unlock()
}

// SendTo sends a JSON message to a specific client.
func (h *Hub) SendTo(clientID string, msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.mu.RLock()
	c, ok := h.clients[clientID]
	h.mu.RUnlock()
	if ok {
		if _, err := c.conn.Write(data); err != nil {
			_ = err
		}
	}
}
