import type { SessionDiff } from "@/shared/session";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export type DiffLine = {
  kind: "context" | "add" | "remove";
  text: string;
};

export function extractToolCallDiffs(content: unknown): SessionDiff[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((item) => {
    if (!isRecord(item) || item.type !== "diff") {
      return [];
    }

    if (typeof item.path !== "string" || typeof item.newText !== "string") {
      return [];
    }

    return [
      {
        path: item.path,
        oldText: typeof item.oldText === "string" ? item.oldText : null,
        newText: item.newText,
      } satisfies SessionDiff,
    ];
  });
}

export function buildDiffLines(oldText: string | null | undefined, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText ?? "");
  const newLines = splitLines(newText);
  const matrix = Array.from({ length: oldLines.length + 1 }, () =>
    Array<number>(newLines.length + 1).fill(0),
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? matrix[oldIndex + 1][newIndex + 1] + 1
          : Math.max(matrix[oldIndex + 1][newIndex], matrix[oldIndex][newIndex + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      lines.push({ kind: "context", text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (matrix[oldIndex + 1][newIndex] >= matrix[oldIndex][newIndex + 1]) {
      lines.push({ kind: "remove", text: oldLines[oldIndex] });
      oldIndex += 1;
      continue;
    }

    lines.push({ kind: "add", text: newLines[newIndex] });
    newIndex += 1;
  }

  while (oldIndex < oldLines.length) {
    lines.push({ kind: "remove", text: oldLines[oldIndex] });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    lines.push({ kind: "add", text: newLines[newIndex] });
    newIndex += 1;
  }

  return lines;
}
