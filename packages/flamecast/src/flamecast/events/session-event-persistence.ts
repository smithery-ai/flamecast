import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ChannelEvent } from "./channels.js";

/**
 * Persists session events as NDJSON (newline-delimited JSON) files.
 *
 * Each session gets a file at `<sessionsDir>/<sessionId>.jsonl`.
 * Events are appended synchronously so no data is lost on crash.
 */
export class SessionEventPersistence {
  private readonly sessionsDir: string;
  private readonly ensuredDirs = new Set<string>();

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  /** Append a single event to the session's NDJSON file. */
  appendEvent(event: ChannelEvent): void {
    const filePath = this.sessionFilePath(event.sessionId);
    this.ensureDir(filePath);
    const line = JSON.stringify({
      seq: event.seq,
      sessionId: event.sessionId,
      agentId: event.agentId,
      event: event.event,
    });
    appendFileSync(filePath, line + "\n");
  }

  /** Read all persisted events for a session from its NDJSON file. */
  readEvents(sessionId: string): ChannelEvent[] {
    const filePath = this.sessionFilePath(sessionId);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, "utf-8");
    const events: ChannelEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        // oxlint-disable-next-line no-type-assertion/no-type-assertion -- JSON from our own persistence format
        events.push(JSON.parse(line) as ChannelEvent);
      } catch {
        // Skip malformed lines
      }
    }
    return events;
  }

  /** Check whether a persisted session file exists. */
  hasSession(sessionId: string): boolean {
    return existsSync(this.sessionFilePath(sessionId));
  }

  private sessionFilePath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  private ensureDir(filePath: string): void {
    const dir = dirname(filePath);
    if (this.ensuredDirs.has(dir)) return;
    mkdirSync(dir, { recursive: true });
    this.ensuredDirs.add(dir);
  }
}
