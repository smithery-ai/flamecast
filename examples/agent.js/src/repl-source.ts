const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function canReturnExpression(expression) {
  try {
    // Parse-only check for whether this can be wrapped as a returned expression.
    new AsyncFunction(`return (\n${expression}\n);`);
    return true;
  } catch {
    return false;
  }
}

function lastNonEmptyLineIndex(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) {
      return index;
    }
  }
  return -1;
}

function stripTrailingSemicolon(text) {
  return text.trim().replace(/;$/, "").trimEnd();
}

export function makeReplFriendlySource(source) {
  const text = String(source ?? "");
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  if (canReturnExpression(trimmed)) {
    return `return (\n${trimmed}\n);`;
  }

  const lines = text.split("\n");
  const index = lastNonEmptyLineIndex(lines);
  if (index === -1) {
    return text;
  }

  const line = lines[index];
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const trimmedLine = line.trim();
  const lastSemicolon = trimmedLine.lastIndexOf(";");

  const tryReplace = (prefix, candidate) => {
    const expression = stripTrailingSemicolon(candidate);
    if (!expression || !canReturnExpression(expression)) {
      return null;
    }

    lines[index] = `${indent}${prefix}return (${expression});`;
    return lines.join("\n");
  };

  if (lastSemicolon !== -1 && lastSemicolon < trimmedLine.length - 1) {
    const prefix = `${trimmedLine.slice(0, lastSemicolon + 1)} `;
    const candidate = trimmedLine.slice(lastSemicolon + 1);
    const updated = tryReplace(prefix, candidate);
    if (updated) {
      return updated;
    }
  }

  const updated = tryReplace("", trimmedLine);
  return updated ?? text;
}
