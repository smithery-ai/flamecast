import * as acp from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { AcpStreamableHttpClientTransport } from "../src/shared/acp-streamable-http-client.js";
import { AcpStreamableHttpServerTransport } from "../src/shared/acp-streamable-http-server.js";

function createTransportFetch(transport: AcpStreamableHttpServerTransport): typeof fetch {
  return async (input, init) => transport.handleRequest(new Request(String(input), init));
}

async function readSingleSseMessage(response: Response) {
  if (!response.body) {
    throw new Error("Expected SSE response body");
  }

  const reader = response.body.getReader();
  const { value } = await reader.read();
  reader.releaseLock();

  const payload = new TextDecoder().decode(value ?? new Uint8Array());
  const data = payload
    .split(/\r?\n/u)
    .find((line) => line.startsWith("data:"))
    ?.slice(5)
    .trimStart();

  if (!data) {
    throw new Error("Expected SSE data payload");
  }

  return JSON.parse(data);
}

test("buffers unsolicited ACP messages until the GET event stream is attached", async () => {
  const transport = new AcpStreamableHttpServerTransport({
    sessionIdGenerator: () => "transport-1",
  });
  const inboundReader = transport.stream.readable.getReader();
  const writer = transport.stream.writable.getWriter();

  const initializeResponsePromise = transport.handleRequest(
    new Request("http://localhost/api/agents/agent-1/acp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        },
      }),
    }),
  );

  const initializeRequest = await inboundReader.read();
  expect(initializeRequest.value).toMatchObject({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });

  const initializeResult = {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "Flamecast", version: "test" },
    agentCapabilities: {},
  } satisfies acp.InitializeResponse;

  await writer.write({
    jsonrpc: "2.0",
    id: 1,
    result: initializeResult,
  });

  const initializeResponse = await initializeResponsePromise;
  expect(initializeResponse.status).toBe(200);
  expect(initializeResponse.headers.get("acp-session-id")).toBe("transport-1");
  expect(await readSingleSseMessage(initializeResponse)).toMatchObject({
    jsonrpc: "2.0",
    id: 1,
  });

  const sessionUpdate = {
    jsonrpc: "2.0",
    method: acp.CLIENT_METHODS.session_update,
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      },
    },
  } satisfies acp.AnyMessage;

  await writer.write(sessionUpdate);

  const eventResponse = await transport.handleRequest(
    new Request("http://localhost/api/agents/agent-1/acp", {
      method: "GET",
      headers: { "acp-session-id": "transport-1" },
    }),
  );

  expect(eventResponse.status).toBe(200);
  expect(eventResponse.headers.get("acp-session-id")).toBe("transport-1");
  expect(await readSingleSseMessage(eventResponse)).toEqual(sessionUpdate);

  inboundReader.releaseLock();
  writer.releaseLock();
  await transport.close();
});

test("delivers requestPermission over the GET event stream and posts the client response back", async () => {
  const transport = new AcpStreamableHttpServerTransport({
    sessionIdGenerator: () => "transport-1",
  });
  const inboundReader = transport.stream.readable.getReader();
  const outboundWriter = transport.stream.writable.getWriter();

  let resolvePermissionRequest!: (value: {
    params: acp.RequestPermissionRequest;
    resolve: (response: acp.RequestPermissionResponse) => void;
  }) => void;
  const permissionRequest = new Promise<{
    params: acp.RequestPermissionRequest;
    resolve: (response: acp.RequestPermissionResponse) => void;
  }>((resolve) => {
    resolvePermissionRequest = resolve;
  });

  const clientTransport = new AcpStreamableHttpClientTransport(new URL("http://localhost/acp"), {
    fetch: createTransportFetch(transport),
  });
  const clientConnection = new acp.ClientSideConnection(
    () =>
      ({
        sessionUpdate: async () => undefined,
        requestPermission: async (params: acp.RequestPermissionRequest) =>
          new Promise((resolve) => {
            resolvePermissionRequest({ params, resolve });
          }),
        readTextFile: async () => {
          throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.fs_read_text_file);
        },
        writeTextFile: async () => {
          throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.fs_write_text_file);
        },
        createTerminal: async () => {
          throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.terminal_create);
        },
        extMethod: async (method: string) => {
          throw acp.RequestError.methodNotFound(method);
        },
        extNotification: async () => undefined,
      }) satisfies acp.Client,
    clientTransport.stream,
  );

  await clientTransport.start();

  const initializePromise = clientConnection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  const initializeRequest = await inboundReader.read();
  expect(initializeRequest.value).toMatchObject({
    method: "initialize",
  });
  const initializeResult = {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "Flamecast", version: "test" },
    agentCapabilities: {},
  } satisfies acp.InitializeResponse;

  await outboundWriter.write({
    jsonrpc: "2.0",
    id: "id" in (initializeRequest.value ?? {}) ? initializeRequest.value.id : null,
    result: initializeResult,
  });
  await initializePromise;

  const newSessionPromise = clientConnection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });

  const newSessionRequest = await inboundReader.read();
  expect(newSessionRequest.value).toMatchObject({
    method: acp.AGENT_METHODS.session_new,
  });
  const newSessionResult = {
    sessionId: "session-1",
  } satisfies acp.NewSessionResponse;

  await outboundWriter.write({
    jsonrpc: "2.0",
    id: "id" in (newSessionRequest.value ?? {}) ? newSessionRequest.value.id : null,
    result: newSessionResult,
  });
  await expect(newSessionPromise).resolves.toEqual({ sessionId: "session-1" });

  await outboundWriter.write({
    jsonrpc: "2.0",
    id: 99,
    method: acp.CLIENT_METHODS.session_request_permission,
    params: {
      sessionId: "session-1",
      toolCall: {
        toolCallId: "call-1",
        title: "Need permission",
        kind: "edit",
        status: "pending",
        rawInput: {},
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    } satisfies acp.RequestPermissionRequest,
  });

  const pending = await permissionRequest;
  expect(pending.params.toolCall.toolCallId).toBe("call-1");
  pending.resolve({
    outcome: {
      outcome: "selected",
      optionId: "allow",
    },
  });

  const permissionResponse = await inboundReader.read();
  expect(permissionResponse.value).toMatchObject({
    id: 99,
    result: {
      outcome: {
        outcome: "selected",
        optionId: "allow",
      },
    },
  });

  inboundReader.releaseLock();
  outboundWriter.releaseLock();
  await clientTransport.close();
  await transport.close();
});

test("supports requestPermission while a prompt response stream is still in flight", async () => {
  const transport = new AcpStreamableHttpServerTransport({
    sessionIdGenerator: () => "transport-1",
  });
  const inboundReader = transport.stream.readable.getReader();
  const outboundWriter = transport.stream.writable.getWriter();

  let resolvePermissionRequest!: (value: {
    params: acp.RequestPermissionRequest;
    resolve: (response: acp.RequestPermissionResponse) => void;
  }) => void;
  const permissionRequest = new Promise<{
    params: acp.RequestPermissionRequest;
    resolve: (response: acp.RequestPermissionResponse) => void;
  }>((resolve) => {
    resolvePermissionRequest = resolve;
  });

  const clientTransport = new AcpStreamableHttpClientTransport(new URL("http://localhost/acp"), {
    fetch: createTransportFetch(transport),
  });
  const clientConnection = new acp.ClientSideConnection(
    () =>
      ({
        sessionUpdate: async () => undefined,
        requestPermission: async (params: acp.RequestPermissionRequest) =>
          new Promise((resolve) => {
            resolvePermissionRequest({ params, resolve });
          }),
        readTextFile: async () => {
          throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.fs_read_text_file);
        },
        writeTextFile: async () => {
          throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.fs_write_text_file);
        },
        createTerminal: async () => {
          throw acp.RequestError.methodNotFound(acp.CLIENT_METHODS.terminal_create);
        },
        extMethod: async (method: string) => {
          throw acp.RequestError.methodNotFound(method);
        },
        extNotification: async () => undefined,
      }) satisfies acp.Client,
    clientTransport.stream,
  );

  await clientTransport.start();

  const initializePromise = clientConnection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const initializeRequest = await inboundReader.read();
  const initializeResult = {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "Flamecast", version: "test" },
    agentCapabilities: {},
  } satisfies acp.InitializeResponse;

  await outboundWriter.write({
    jsonrpc: "2.0",
    id: "id" in (initializeRequest.value ?? {}) ? initializeRequest.value.id : null,
    result: initializeResult,
  });
  await initializePromise;

  const newSessionPromise = clientConnection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  const newSessionRequest = await inboundReader.read();
  const newSessionResult = {
    sessionId: "session-1",
  } satisfies acp.NewSessionResponse;

  await outboundWriter.write({
    jsonrpc: "2.0",
    id: "id" in (newSessionRequest.value ?? {}) ? newSessionRequest.value.id : null,
    result: newSessionResult,
  });
  await newSessionPromise;

  const promptPromise = clientConnection.prompt({
    sessionId: "session-1",
    prompt: [{ type: "text", text: "hello" }],
  });
  const promptRequest = await inboundReader.read();
  expect(promptRequest.value).toMatchObject({
    method: acp.AGENT_METHODS.session_prompt,
  });

  await outboundWriter.write({
    jsonrpc: "2.0",
    id: 101,
    method: acp.CLIENT_METHODS.session_request_permission,
    params: {
      sessionId: "session-1",
      toolCall: {
        toolCallId: "call-2",
        title: "Need permission",
        kind: "edit",
        status: "pending",
        rawInput: {},
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    } satisfies acp.RequestPermissionRequest,
  });

  const pending = await permissionRequest;
  expect(pending.params.sessionId).toBe("session-1");
  pending.resolve({
    outcome: {
      outcome: "selected",
      optionId: "allow",
    },
  });

  const permissionResponse = await inboundReader.read();
  expect(permissionResponse.value).toMatchObject({
    id: 101,
    result: {
      outcome: {
        outcome: "selected",
        optionId: "allow",
      },
    },
  });

  const promptResult = {
    stopReason: "end_turn",
  } satisfies acp.PromptResponse;

  await outboundWriter.write({
    jsonrpc: "2.0",
    id: "id" in (promptRequest.value ?? {}) ? promptRequest.value.id : null,
    result: promptResult,
  });

  await expect(promptPromise).resolves.toEqual({
    stopReason: "end_turn",
  });

  inboundReader.releaseLock();
  outboundWriter.releaseLock();
  await clientTransport.close();
  await transport.close();
});
