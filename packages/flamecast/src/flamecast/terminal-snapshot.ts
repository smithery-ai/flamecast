const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "gu");

function isBlankTerminalLine(line: string): boolean {
  return line.replace(ANSI_RE, "").trimEnd() === "";
}

export function serializeTerminalSnapshot(
  output: string,
  cursorX: number,
  cursorY: number,
): string {
  const lines = output.split(/\r?\n/u);

  let lastContentLine = lines.length - 1;
  while (lastContentLine > 0 && isBlankTerminalLine(lines[lastContentLine])) {
    lastContentLine--;
  }

  const trimmedLines = lines.slice(0, lastContentLine + 1);
  const formattedOutput = trimmedLines.join("\r\n");
  const clampedCursorY = Math.min(cursorY, trimmedLines.length - 1);

  return `${formattedOutput}\x1b[${clampedCursorY + 1};${cursorX + 1}H`;
}
