## PR Review: Chat SDK Connector

The architecture is solid and the test coverage is thorough, but I think we should simplify before merging. Three main things:

### 1. Drop MCP — just use end-turn response text

The connector currently spins up a full MCP server so the agent can call `chat.reply` as a tool. For v1 where the goal is "chat message in, agent response out," this is premature. We can just wait for the `session/prompt` response and post the result text back to the thread.

What this removes: `mcp.ts`, the `/mcp` route, auth token binding, `@modelcontextprotocol/sdk` dependency, and the `mcpServers` passthrough we added to Flamecast core (`session.ts`, `flamecast/index.ts`). That's roughly half the plugin and avoids a core API change for a plugin concern.

**Reasoning**: MCP tools would earn their keep if we need mid-turn interactions (typing indicators before long responses, agent choosing not to reply, multi-message replies). None of those are v1 requirements. When they are, we add the MCP layer on top — the end-turn approach doesn't close that door.

### 2. Move the HTTP-only MCP restriction out of Flamecast core

If we do keep MCP, `McpServerSchema` in `packages/flamecast/src/shared/session.ts` hardcodes `type: "http"` for all of Flamecast, not just this plugin. ACP is transport-agnostic — agents can support stdio, HTTP, or SSE for MCP. The connector only serves HTTP, but that's the plugin's constraint, not core's.

**Reasoning**: Putting the restriction in core means no Flamecast session can ever use SSE or stdio MCP servers without a core change. The plugin should validate its own config; core should accept whatever ACP allows.

### 3. Invert the dependency — connector shouldn't own Flamecast

The current API has the connector wrapping the Flamecast client and holding agent config (`agentTemplateId`, `cwd`, `spawn`). Those are Flamecast concepts leaking into the chat layer. The connector should only know "I got a message, here's the text, give me a response." How that response is produced is the caller's concern.

Something like:

```ts
const flamecast = new FlamecastHttpClient({
  baseUrl: "http://127.0.0.1:3001",
  agentTemplateId: "codex",
});

const connector = new ChatSdkConnector({
  chat,
  bindings: new InMemoryThreadAgentBindingStore(),
  onMessage: async (text) => flamecast.prompt(text),
});
```

**Reasoning**: This makes the connector testable without faking Flamecast, reusable with non-Flamecast backends, and keeps the plugin's public API surface small. The binding store still handles thread-to-agent mapping — that's the connector's actual job.

### 4. Be aware of the stateless/pubsub direction

We're heading toward Flamecast being fully stateless/serverless — a thin relay that bridges HTTP to a pubsub store. Agents manage their own state and publish updates to pubsub; clients subscribe (websockets instead of polling). Flamecast on main is already stateful (`runtimes` Map holds live subprocess handles, `permissionResolvers` holds in-flight callbacks), so this is a broader migration, not something this PR alone breaks.

But this PR adds more in-memory state to eventually remove:

- `promptQueues` — in-memory promise chain per session. In the pubsub model, serialization moves to the queue layer (FIFO per session ID) or to the agent itself.
- `mcpServers` passthrough on `session/new` — assumes Flamecast holds the agent connection and can forward config to it. In pubsub, MCP config is just data published alongside the session command.

Neither change blocks the migration, but neither moves toward it. The simplified end-turn approach (point 1) avoids adding the MCP passthrough to core entirely, which is one less thing to rearchitect later.

**Reasoning**: Every piece of in-process state we add is something that has to be externalized later. The `runtimes` Map is the big one and it's already on main — that refactor will be significant regardless. But we shouldn't grow the surface area of stateful core if we can avoid it.

### What's good and should stay

- **Prompt queue serialization** (`runInPromptQueue`) — necessary and correct, ACP can't handle concurrent prompts per session. Note it won't work on serverless (in-memory promise chain), but that's a separate Flamecast core issue.
- **Binding store** with triple-indexed lookups — clean design, needed regardless of approach.
- **Test coverage** — 596 lines of tests with proper fakes is the right bar for a new package.
