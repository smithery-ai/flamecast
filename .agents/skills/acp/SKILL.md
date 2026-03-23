---
name: Acp
description: Use when implementing or integrating agents and clients that communicate via the Agent Client Protocol. Reach for this skill when building AI coding agents, editor integrations, or tools that need to standardize communication between code editors/IDEs and AI agents.
metadata:
    mintlify-proj: acp
    version: "1.0"
---

# Agent Client Protocol (ACP) Skill

## Product Summary

The Agent Client Protocol (ACP) is a standardized JSON-RPC 2.0-based protocol for bidirectional communication between code editors/IDEs and AI coding agents. It enables agents to work with any compatible editor and editors to support any ACP-compatible agent, similar to how LSP standardized language servers.

ACP supports both local agents (running as subprocesses via stdio) and remote agents (via HTTP/WebSocket). The protocol handles initialization, session management, prompt turns, tool execution, file system access, and extensibility through custom methods and metadata fields.

**Key files and concepts:**
- JSON-RPC 2.0 message format (requests, responses, notifications)
- Transport: stdio (required), HTTP (draft)
- Core methods: `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/update`
- Capabilities negotiation during initialization
- Session-based conversation context with MCP server integration

**Primary documentation:** https://agentclientprotocol.com

## When to Use

Reach for this skill when:

- **Building an ACP agent**: Implementing a coding agent that needs to communicate with editors (Claude Agent, Cline, Cursor, etc.)
- **Building an ACP client**: Creating an editor plugin, IDE integration, or standalone client that connects to agents
- **Integrating MCP servers**: Configuring Model Context Protocol servers for agents to access tools and data
- **Implementing tool calls**: Designing how agents report file modifications, code execution, and tool results
- **Handling permissions**: Building permission request flows for sensitive agent operations
- **Session management**: Implementing session persistence, loading, and configuration
- **Extending the protocol**: Adding custom methods, notifications, or metadata for proprietary features

## Quick Reference

### Core Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `initialize` | Client → Agent | Negotiate protocol version and capabilities |
| `session/new` | Client → Agent | Create new conversation session |
| `session/load` | Client → Agent | Resume existing session (if supported) |
| `session/prompt` | Client → Agent | Send user message with content |
| `session/cancel` | Client → Agent | Cancel ongoing operations (notification) |
| `session/update` | Agent → Client | Stream output, tool calls, plans (notification) |
| `session/request_permission` | Agent → Client | Request user approval for tool execution |
| `fs/read_text_file` | Agent → Client | Read file from client's filesystem |
| `fs/write_text_file` | Agent → Client | Write file to client's filesystem |
| `terminal/create` | Agent → Client | Create terminal for command execution |

### Capability Flags

**Client capabilities** (advertise in `initialize`):
- `fs.readTextFile` - Can read files
- `fs.writeTextFile` - Can write files
- `terminal` - Can create and manage terminals

**Agent capabilities** (respond in `initialize`):
- `loadSession` - Supports `session/load`
- `promptCapabilities.image` - Accepts image content
- `promptCapabilities.audio` - Accepts audio content
- `promptCapabilities.embeddedContext` - Accepts embedded resources
- `mcpCapabilities.http` - Supports HTTP MCP transport
- `mcpCapabilities.sse` - Supports SSE MCP transport (deprecated)

### Content Types

| Type | Use Case | Capability Required |
|------|----------|-------------------|
| `text` | Plain text messages | None (baseline) |
| `image` | Visual context (base64) | `promptCapabilities.image` |
| `audio` | Audio data (base64) | `promptCapabilities.audio` |
| `resource` | Embedded file content | `promptCapabilities.embeddedContext` |
| `resource_link` | Reference to external resource | None |

### Tool Call Kinds

`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`

### Tool Call Status

`pending` → `in_progress` → `completed` (or `failed`)

## Decision Guidance

### When to Use Session Modes vs. Config Options

| Scenario | Use | Reason |
|----------|-----|--------|
| Simple on/off toggles | Config Options | Preferred, more flexible |
| Model selection | Config Options | Preferred, more flexible |
| Reasoning levels | Config Options | Preferred, more flexible |
| Legacy compatibility | Session Modes | Modes deprecated, use for backwards compat only |

### When to Request Permission vs. Auto-Execute

| Scenario | Approach | Reason |
|----------|----------|--------|
| Destructive operations (delete, modify) | Request permission | User safety |
| Reading files | Auto-execute | Non-destructive, agent needs context |
| Executing code | Request permission | Security risk |
| Fetching external data | Auto-execute | Non-destructive |

### Transport Selection

| Transport | Use When | Support |
|-----------|----------|---------|
| stdio | Local agents, subprocess model | Required for all agents |
| HTTP | Remote agents, cloud deployment | Optional, check `mcpCapabilities.http` |
| SSE | Legacy remote agents | Deprecated by MCP spec |

## Workflow

### For Agent Implementers

1. **Initialize connection**
   - Receive `initialize` request with client capabilities
   - Respond with protocol version, agent capabilities, and auth methods
   - Validate version compatibility; disconnect if unsupported

2. **Set up session**
   - Receive `session/new` with working directory and MCP servers
   - Connect to specified MCP servers (stdio required, HTTP/SSE optional)
   - Return unique session ID
   - Optionally return config options or modes

3. **Handle prompt turns**
   - Receive `session/prompt` with user message and content
   - Send `session/update` notifications for plans, agent messages, tool calls
   - For each tool call: report status (pending → in_progress → completed)
   - Request permission if needed via `session/request_permission`
   - Return `session/prompt` response with stop reason when complete

4. **Manage file access**
   - Check client capabilities before calling `fs/read_text_file` or `fs/write_text_file`
   - Use absolute paths only
   - Handle errors gracefully (file not found, permission denied)

5. **Support cancellation**
   - Listen for `session/cancel` notifications
   - Abort LLM requests and tool execution immediately
   - Respond to original `session/prompt` with `cancelled` stop reason

### For Client Implementers

1. **Initialize connection**
   - Send `initialize` with supported protocol version and client capabilities
   - Receive agent capabilities and protocol version
   - Validate version; disconnect if incompatible

2. **Create or load session**
   - Call `session/new` with working directory and MCP server configs
   - Or call `session/load` if agent supports `loadSession` capability
   - Receive session ID and optional config options/modes

3. **Send prompts and handle updates**
   - Call `session/prompt` with user message and content (respecting prompt capabilities)
   - Listen for `session/update` notifications (plans, messages, tool calls)
   - Display tool call progress and results in real-time
   - Handle permission requests via `session/request_permission`

4. **Provide file system access**
   - Implement `fs/read_text_file` if you advertised the capability
   - Implement `fs/write_text_file` if you advertised the capability
   - Use absolute paths; create files if they don't exist

5. **Manage terminals** (if supported)
   - Implement `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/release`, `terminal/kill`
   - Stream output in real-time
   - Handle cleanup on release

## Common Gotchas

- **Capability mismatch**: Always check capabilities before calling optional methods. Agents/clients must treat omitted capabilities as unsupported.
- **Absolute paths required**: All file paths in the protocol MUST be absolute. Relative paths will fail.
- **Line numbers are 1-based**: When specifying line numbers in file operations, use 1-based indexing, not 0-based.
- **Newline-delimited JSON**: In stdio transport, messages must be delimited by newlines and MUST NOT contain embedded newlines.
- **No stdout pollution**: Agents must write only valid ACP messages to stdout; any other output breaks the protocol.
- **Cancellation error handling**: When `session/cancel` is received, catch exceptions from API calls and return `cancelled` stop reason, not an error.
- **Session ID scope**: Session IDs are unique per agent instance; don't assume they're globally unique across multiple agent processes.
- **MCP server connection**: Agents must connect to all MCP servers specified by the client; failure to do so limits available tools.
- **Permission response timing**: Clients must respond to `session/request_permission` before the agent can proceed; don't leave requests hanging.
- **Deprecated session modes**: Session modes are deprecated in favor of config options; support both for backwards compatibility but prefer config options.
- **_meta field safety**: Implementations must not make assumptions about values in `_meta` fields; treat them as opaque extensions.
- **Tool call updates are partial**: When sending `tool_call_update`, only include fields that changed; omitted fields retain previous values.

## Verification Checklist

Before submitting agent or client implementations:

- [ ] Protocol version negotiation works (client and agent agree on version)
- [ ] All advertised capabilities are actually implemented
- [ ] All required baseline methods are implemented (`initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/update`)
- [ ] Absolute paths are used for all file operations
- [ ] Capabilities are checked before calling optional methods
- [ ] Error responses follow JSON-RPC 2.0 format
- [ ] Notifications (no `id` field) don't expect responses
- [ ] Tool call status transitions are correct (pending → in_progress → completed/failed)
- [ ] Permission requests are properly handled with valid outcomes
- [ ] Cancellation stops operations and returns `cancelled` stop reason
- [ ] MCP servers are connected if specified
- [ ] Custom methods/notifications start with underscore (`_`)
- [ ] Custom capabilities are advertised in `_meta` during initialization
- [ ] Session IDs are unique within the agent instance
- [ ] File writes create files if they don't exist
- [ ] Stderr is used for logging only, not protocol messages

## Resources

**Comprehensive navigation:** https://agentclientprotocol.com/llms.txt

**Critical documentation pages:**
- [Protocol Overview](https://agentclientprotocol.com/protocol/overview) — Core message flow and baseline methods
- [Initialization](https://agentclientprotocol.com/protocol/initialization) — Version and capability negotiation
- [Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn) — Complete conversation lifecycle with tool calls

---

> For additional documentation and navigation, see: https://agentclientprotocol.com/llms.txt