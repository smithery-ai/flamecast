const STATEMENT_PREFIX =
  /^(?:return|const|let|var|if|for|while|switch|try|catch|finally|class|function|async function|import|export|throw|break|continue|do)\b/;

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

function looksLikeExpression(expression) {
  const trimmed = stripTrailingSemicolon(expression);

  if (!trimmed || STATEMENT_PREFIX.test(trimmed)) {
    return false;
  }

  return trimmed !== "{" && trimmed !== "}";
}

export function rewritePersistentBindings(source) {
  return source
    .replace(/(^|\n)(\s*)(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, "$1$2scope.$4 =")
    .replace(
      /(^|\n)(\s*)async function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      "$1$2scope.$3 = async function $3(",
    )
    .replace(/(^|\n)(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(/g, "$1$2scope.$3 = function $3(")
    .replace(/(^|\n)(\s*)class\s+([A-Za-z_$][\w$]*)\s*/g, "$1$2scope.$3 = class $3 ")
    .replace(/\bimport\s*\(/g, "__import__(");
}

export function makeReplFriendlySource(source) {
  const text = String(source ?? "");
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  if (!trimmed.includes("\n") && looksLikeExpression(trimmed)) {
    return `return (\n${stripTrailingSemicolon(trimmed)}\n);`;
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
    if (!looksLikeExpression(expression)) {
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

export function prepareExecuteJsSource(source) {
  return makeReplFriendlySource(rewritePersistentBindings(String(source ?? "")));
}
