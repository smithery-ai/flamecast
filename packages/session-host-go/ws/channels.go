package ws

import "strings"

// eventToChannels returns channels an event belongs to, most specific first.
// Mirrors the TypeScript eventToChannels in packages/flamecast/src/flamecast/events/channels.ts.
func eventToChannels(sessionID, agentID, eventType string, data map[string]any) []string {
	var channels []string

	if isTerminalEvent(eventType, data) {
		if tid, ok := data["terminalId"].(string); ok && tid != "" {
			channels = append(channels, "session:"+sessionID+":terminal:"+tid)
		}
		channels = append(channels, "session:"+sessionID+":terminal")
	}

	if isQueueEvent(eventType, data) {
		channels = append(channels, "session:"+sessionID+":queue")
	}

	if isFsEvent(eventType, data) {
		channels = append(channels, "session:"+sessionID+":fs")
		channels = append(channels, "agent:"+agentID+":fs")
	}

	channels = append(channels, "session:"+sessionID)
	channels = append(channels, "agent:"+agentID)
	channels = append(channels, "agents")

	return channels
}

var terminalTypes = map[string]bool{
	"terminal.create":       true,
	"terminal.output":       true,
	"terminal.release":      true,
	"terminal.wait_for_exit": true,
	"terminal.kill":         true,
}

var queueTypes = map[string]bool{
	"queue.updated": true,
	"queue.paused":  true,
	"queue.resumed": true,
}

var fsTypes = map[string]bool{
	"filesystem.changed":  true,
	"filesystem.snapshot": true,
	"file.preview":        true,
	"fs.read_text_file":   true,
	"fs.write_text_file":  true,
}

func isTerminalEvent(eventType string, data map[string]any) bool {
	if terminalTypes[eventType] {
		return true
	}
	if eventType == "rpc" {
		if method, ok := data["method"].(string); ok && terminalTypes[method] {
			return true
		}
	}
	return false
}

func isQueueEvent(eventType string, data map[string]any) bool {
	if queueTypes[eventType] {
		return true
	}
	if eventType == "rpc" {
		if method, ok := data["method"].(string); ok && queueTypes[method] {
			return true
		}
	}
	return false
}

func isFsEvent(eventType string, data map[string]any) bool {
	if fsTypes[eventType] {
		return true
	}
	if eventType == "rpc" {
		if method, ok := data["method"].(string); ok && fsTypes[method] {
			return true
		}
	}
	return false
}

// channelMatches returns true if a channel matches a subscription.
// A subscription to "session:abc" matches "session:abc" exactly, as well as
// events published to more specific sub-channels like "session:abc:terminal".
func channelMatches(subscription, channel string) bool {
	if subscription == channel {
		return true
	}
	return strings.HasPrefix(channel, subscription+":")
}
