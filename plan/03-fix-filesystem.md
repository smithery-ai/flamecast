# 1.3 — Fix File Browser (Gap #3 + #6)

**Goal:** The Files tab shows the agent's workspace directory tree and supports file preview.

**Depends on:** 1.1 (shared protocol types)

## Root cause

The session host emits `filesystem.changed` (incremental) but never `filesystem.snapshot` (full tree with `{ root, entries }`). The frontend needs `filesystem.snapshot` to populate the tree view. The session host also doesn't handle `fs.snapshot` or `file.preview` client actions.

## What to do

### Port `walkDirectory` utility

Create `packages/session-host/src/walk-directory.ts`. Port the directory walking logic from the baseline's `FlamecastWsServer`. Must:

- Recursively walk a directory
- Return `FileSystemEntry[]` with `{ path, type }` for each entry
- Respect ignore patterns: `node_modules`, `.git`, and any patterns from `FILE_WATCHER_IGNORE` env var

### SessionHost changes (`packages/session-host/src/index.ts`)

1. **Emit `filesystem.snapshot` on WS connect** — after sending `"connected"`, send the current workspace tree:

```typescript
ws.send(
  JSON.stringify({
    type: "filesystem.snapshot",
    data: { snapshot: { root: workspace, entries: await walkDirectory(workspace) } },
  }),
);
```

2. **Handle `fs.snapshot` client action:**

```typescript
case "fs.snapshot": {
  const entries = await walkDirectory(workspace);
  ws.send(JSON.stringify({
    type: "fs.snapshot",
    data: { snapshot: { root: workspace, entries } }
  }));
  break;
}
```

3. **Handle `file.preview` client action:**

```typescript
case "file.preview": {
  try {
    const content = await readFile(resolve(workspace, msg.path), "utf8");
    ws.send(JSON.stringify({ type: "file.preview", data: { path: msg.path, content } }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", data: { message: `Cannot read: ${msg.path}` } }));
  }
  break;
}
```

4. **Re-emit `filesystem.snapshot` after file changes** — when the file watcher detects changes, emit a full snapshot. Simpler than incremental diffing and the file trees are small.

## Files

- **New:** `packages/session-host/src/walk-directory.ts`
- **Modify:** `packages/session-host/src/index.ts`

## Test Coverage

Integration tests (real Flamecast instance + real session host process, no mocks):

1. **Snapshot on connect:** Create session → connect WS → verify `filesystem.snapshot` event arrives with `{ root, entries }` where root matches workspace path
2. **Request snapshot:** Send `fs.snapshot` action → verify response contains directory tree
3. **File preview:** Send `file.preview` for a known file → verify content matches
4. **File preview error:** Send `file.preview` for nonexistent path → verify error response
5. **File watcher:** Agent modifies a file → verify updated `filesystem.snapshot` arrives

## Acceptance criteria

- Files tab shows workspace directory tree on session load
- Clicking a file shows its content in the preview pane
- File tree updates when the agent modifies files
- "Show ignored files" toggle works
- Workspace root path displayed correctly at top
