import { describe, expect, it } from "vitest";
import { reduceRuntimeTerminalSessions } from "@flamecast/ui";

describe("reduceRuntimeTerminalSessions", () => {
  it("removes terminals when a release event is replayed", () => {
    let terminals = reduceRuntimeTerminalSessions(
      [],
      {
        eventType: "terminal.started",
        terminalId: "term-1",
        timestamp: "2026-03-29T00:00:00.000Z",
        command: "/bin/sh",
      },
      new Set(),
    );

    terminals = reduceRuntimeTerminalSessions(
      terminals,
      {
        eventType: "terminal.exit",
        terminalId: "term-1",
        timestamp: "2026-03-29T00:00:01.000Z",
        exitCode: -1,
      },
      new Set(),
    );

    terminals = reduceRuntimeTerminalSessions(
      terminals,
      {
        eventType: "terminal.release",
        terminalId: "term-1",
        timestamp: "2026-03-29T00:00:02.000Z",
      },
      new Set(),
    );

    expect(terminals).toEqual([]);
  });

  it("ignores replayed events for terminals dismissed by the user", () => {
    const dismissed = new Set(["term-1"]);

    const terminals = reduceRuntimeTerminalSessions(
      [],
      {
        eventType: "terminal.started",
        terminalId: "term-1",
        timestamp: "2026-03-29T00:00:00.000Z",
        command: "/bin/sh",
      },
      dismissed,
    );

    expect(terminals).toEqual([]);
  });
});
