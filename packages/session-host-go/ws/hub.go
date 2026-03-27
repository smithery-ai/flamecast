// Package ws provides a WebSocket hub for channel-based pub/sub messaging.
package ws

import (
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"

	"golang.org/x/net/websocket"
)

// ControlHandler is called when a WebSocket client sends a control message.
type ControlHandler func(clientID string, msg json.RawMessage)

// ChannelEvent is a single event stored in the per-session event log.
type ChannelEvent struct {
	Seq       int64          `json:"seq"`
	SessionID string         `json:"sessionId"`
	AgentID   string         `json:"agentId"`
	Channel   string         `json:"channel"` // most specific channel
	Channels  []string       `json:"-"`        // all channels (for matching)
	Raw       []byte         `json:"-"`        // pre-serialized WS message
}

// Hub manages connected WebSocket clients with channel-based subscriptions.
type Hub struct {
	mu             sync.RWMutex
	clients        map[string]*client
	nextID         int
	controlHandler ControlHandler

	// Per-session event logs (sessionId → ring buffer of events)
	eventLogs map[string]*eventLog

	// Global sequence counter across all sessions
	seq atomic.Int64
}

type client struct {
	id            string
	conn          *websocket.Conn
	subscriptions map[string]bool // channel → subscribed
	mu            sync.Mutex
}

type eventLog struct {
	events []ChannelEvent
	cap    int
}

const defaultEventLogCap = 5000

// NewHub creates a new WebSocket hub.
func NewHub() *Hub {
	return &Hub{
		clients:   make(map[string]*client),
		eventLogs: make(map[string]*eventLog),
	}
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
			id := generateClientID(h.nextID)
			c := &client{
				id:            id,
				conn:          conn,
				subscriptions: make(map[string]bool),
			}
			h.clients[id] = c
			h.mu.Unlock()

			// Send connected message
			connMsg, _ := json.Marshal(map[string]any{
				"type":         "connected",
				"connectionId": id,
			})
			_, _ = conn.Write(connMsg)

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
		Handshake: func(config *websocket.Config, r *http.Request) error {
			return nil
		},
	}
	server.ServeHTTP(w, r)
}

// Subscribe adds a channel subscription for a client and replays matching
// history events with seq > since.
func (h *Hub) Subscribe(clientID, channel string, since int64) {
	h.mu.RLock()
	c, ok := h.clients[clientID]
	h.mu.RUnlock()
	if !ok {
		return
	}

	c.mu.Lock()
	c.subscriptions[channel] = true
	c.mu.Unlock()

	// Replay matching history
	h.mu.RLock()
	var replay [][]byte
	for _, log := range h.eventLogs {
		for _, evt := range log.events {
			if evt.Seq <= since {
				continue
			}
			for _, ch := range evt.Channels {
				if channelMatches(channel, ch) {
					replay = append(replay, evt.Raw)
					break
				}
			}
		}
	}
	h.mu.RUnlock()

	for _, data := range replay {
		if _, err := c.conn.Write(data); err != nil {
			break
		}
	}

	// Send subscribed confirmation
	ack, _ := json.Marshal(map[string]any{
		"type":    "subscribed",
		"channel": channel,
	})
	_, _ = c.conn.Write(ack)
}

// Unsubscribe removes a channel subscription for a client.
func (h *Hub) Unsubscribe(clientID, channel string) {
	h.mu.RLock()
	c, ok := h.clients[clientID]
	h.mu.RUnlock()
	if !ok {
		return
	}

	c.mu.Lock()
	delete(c.subscriptions, channel)
	c.mu.Unlock()

	ack, _ := json.Marshal(map[string]any{
		"type":    "unsubscribed",
		"channel": channel,
	})
	_, _ = c.conn.Write(ack)
}

// PublishEvent stores an event in the session log and sends it to matching
// subscribers. Returns the assigned sequence number.
func (h *Hub) PublishEvent(sessionID, agentID, eventType string, data map[string]any, timestamp string) int64 {
	channels := eventToChannels(sessionID, agentID, eventType, data)
	primaryChannel := channels[0] // most specific

	seq := h.seq.Add(1)

	msg := map[string]any{
		"type":      "event",
		"channel":   primaryChannel,
		"sessionId": sessionID,
		"agentId":   agentID,
		"seq":       seq,
		"event": map[string]any{
			"type":      eventType,
			"data":      data,
			"timestamp": timestamp,
		},
	}
	raw, _ := json.Marshal(msg)

	evt := ChannelEvent{
		Seq:       seq,
		SessionID: sessionID,
		AgentID:   agentID,
		Channel:   primaryChannel,
		Channels:  channels,
		Raw:       raw,
	}

	// Store in session log
	h.mu.Lock()
	log := h.eventLogs[sessionID]
	if log == nil {
		log = &eventLog{cap: defaultEventLogCap}
		h.eventLogs[sessionID] = log
	}
	if len(log.events) >= log.cap {
		// Drop oldest 10%
		drop := log.cap / 10
		if drop < 1 {
			drop = 1
		}
		log.events = log.events[drop:]
	}
	log.events = append(log.events, evt)
	h.mu.Unlock()

	// Broadcast to matching subscribers
	h.mu.RLock()
	clients := make([]*client, 0, len(h.clients))
	for _, c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	for _, c := range clients {
		if h.clientMatchesEvent(c, channels) {
			_, _ = c.conn.Write(raw)
		}
	}

	return seq
}

// BroadcastLifecycle sends a session lifecycle message (session.created or
// session.terminated) to all clients subscribed to matching channels.
func (h *Hub) BroadcastLifecycle(msgType, sessionID, agentID string) {
	msg, _ := json.Marshal(map[string]any{
		"type":      msgType,
		"sessionId": sessionID,
		"agentId":   agentID,
	})

	channels := []string{
		"session:" + sessionID,
		"agent:" + agentID,
		"agents",
	}

	h.mu.RLock()
	clients := make([]*client, 0, len(h.clients))
	for _, c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	for _, c := range clients {
		if h.clientMatchesEvent(c, channels) {
			_, _ = c.conn.Write(msg)
		}
	}
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
		_, _ = c.conn.Write(data)
	}
}

// ClearSessionLog removes the event log for a specific session.
func (h *Hub) ClearSessionLog(sessionID string) {
	h.mu.Lock()
	delete(h.eventLogs, sessionID)
	h.mu.Unlock()
}

// clientMatchesEvent checks if a client is subscribed to any of the event's channels.
func (h *Hub) clientMatchesEvent(c *client, eventChannels []string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for sub := range c.subscriptions {
		for _, ch := range eventChannels {
			if channelMatches(sub, ch) {
				return true
			}
		}
	}
	return false
}

func generateClientID(n int) string {
	return "ws-" + string(rune('0'+n/100%10)) + string(rune('0'+n/10%10)) + string(rune('0'+n%10))
}

// ---------- Legacy compat (used during transition) ----------

// Broadcast sends a JSON message to ALL connected clients (no channel filtering).
// Deprecated: use PublishEvent for channel-aware broadcasting.
func (h *Hub) Broadcast(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		if _, err := c.conn.Write(data); err != nil {
			_ = err
		}
	}
}

// ClearLog resets all event logs.
// Deprecated: use ClearSessionLog for per-session cleanup.
func (h *Hub) ClearLog() {
	h.mu.Lock()
	h.eventLogs = make(map[string]*eventLog)
	h.mu.Unlock()
}
