export type TerminalWriter = {
  write: (data: string | Uint8Array) => void;
};

export async function writeTerminalData(
  terminal: TerminalWriter,
  data: string | ArrayBuffer | Blob,
): Promise<void> {
  if (typeof data === "string") {
    terminal.write(data);
    return;
  }

  if (data instanceof ArrayBuffer) {
    terminal.write(new Uint8Array(data));
    return;
  }

  terminal.write(new Uint8Array(await data.arrayBuffer()));
}
