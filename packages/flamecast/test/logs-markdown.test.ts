import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";
import { sessionLogsToSegments } from "../src/client/lib/logs-markdown.js";
import { buildDiffLines, extractToolCallDiffs } from "../src/client/lib/tool-call-diffs.js";

describe("tool call diff helpers", () => {
  test("extracts ACP diff content blocks", () => {
    expect(
      extractToolCallDiffs([
        {
          type: "diff",
          path: "/tmp/demo.md",
          oldText: "before\n",
          newText: "after\n",
        },
        {
          type: "content",
          content: { type: "text", text: "ignored" },
        },
      ]),
    ).toEqual([{ path: "/tmp/demo.md", oldText: "before\n", newText: "after\n" }]);
  });

  test("threads tool call diffs through markdown segments", () => {
    const segments = sessionLogsToSegments([
      {
        timestamp: "2026-03-22T00:00:00.000Z",
        type: "rpc",
        data: {
          method: acp.CLIENT_METHODS.session_update,
          direction: "agent_to_client",
          phase: "notification",
          payload: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-1",
              title: "Edit file",
              status: "pending",
              content: [
                {
                  type: "diff",
                  path: "/tmp/demo.md",
                  oldText: "before\n",
                  newText: "after\n",
                },
              ],
            },
          },
        },
      },
      {
        timestamp: "2026-03-22T00:00:01.000Z",
        type: "permission_rejected",
        data: { toolCallId: "tool-1" },
      },
    ]);

    expect(segments).toEqual([
      {
        kind: "tool",
        toolCallId: "tool-1",
        title: "Edit file",
        status: "rejected",
        diffs: [{ path: "/tmp/demo.md", oldText: "before\n", newText: "after\n" }],
      },
    ]);
  });

  test("builds a line-oriented diff preview", () => {
    expect(buildDiffLines("alpha\nbeta\n", "alpha\ngamma\n")).toEqual([
      { kind: "context", text: "alpha" },
      { kind: "remove", text: "beta" },
      { kind: "add", text: "gamma" },
    ]);
  });
});
