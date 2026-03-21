import * as acp from "@agentclientprotocol/sdk";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAcpTransportStream } from "./acp-transport-stream.js";

export async function createAcpClientConnection(url: URL, opts: { fetch?: typeof fetch } = {}) {
  const transport = new StreamableHTTPClientTransport(
    url,
    opts.fetch ? { fetch: opts.fetch } : undefined,
  );
  transport.setProtocolVersion?.("2025-11-25");
  await transport.start();
  const stream = createAcpTransportStream(transport);
  const pendingPermissions = new Map<
    string,
    {
      request: acp.RequestPermissionRequest;
      resolve: (response: acp.RequestPermissionResponse) => void;
    }
  >();

  const client = {
    sessionUpdate: async (_params: acp.SessionNotification) => undefined,
    requestPermission: async (
      params: acp.RequestPermissionRequest,
    ): Promise<acp.RequestPermissionResponse> =>
      new Promise((resolve) => {
        pendingPermissions.set(params.toolCall.toolCallId, { request: params, resolve });
      }),
    readTextFile: async (_params: acp.ReadTextFileRequest) =>
      methodNotSupported(acp.CLIENT_METHODS.fs_read_text_file),
    writeTextFile: async (_params: acp.WriteTextFileRequest) =>
      methodNotSupported(acp.CLIENT_METHODS.fs_write_text_file),
    createTerminal: async (_params: acp.CreateTerminalRequest) =>
      methodNotSupported(acp.CLIENT_METHODS.terminal_create),
    extMethod: async (method: string) => methodNotSupported(method),
    extNotification: async () => undefined,
  } satisfies acp.Client;

  const connection = new acp.ClientSideConnection(() => client, stream);
  return { connection, transport, pendingPermissions, client };
}

function methodNotSupported(method: string): never {
  throw acp.RequestError.methodNotFound(method);
}
