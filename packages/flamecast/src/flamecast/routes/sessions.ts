import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { SessionManager } from "../sessions/session-manager.js";
import { SessionError } from "../sessions/session-manager.js";

// --- schemas ---

const SessionIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "fc_a1b2c3d4" }),
});

const CreateBody = z
  .object({
    cwd: z.string().optional().openapi({ example: "/home/user" }),
    shell: z.string().optional().openapi({ example: "/bin/bash" }),
    timeout: z.number().nullable().optional().openapi({ example: 300 }),
  })
  .openapi("CreateSessionBody");

const CreateResponse = z
  .object({
    sessionId: z.string(),
    streamUrl: z.string(),
    cwd: z.string(),
    shell: z.string(),
    timeout: z.number().nullable(),
  })
  .openapi("CreateSessionResponse");

const ExecBody = z
  .object({
    command: z.string().openapi({ example: "ls -la" }),
    timeout: z.number().positive().optional().openapi({ example: 30 }),
  })
  .openapi("ExecBody");

const ExecResponse = z
  .object({
    sessionId: z.string(),
    output: z.string(),
    exitCode: z.number().nullable(),
  })
  .openapi("ExecResponse");

const ExecAsyncBody = z
  .object({
    command: z.string().openapi({ example: "npm run dev" }),
  })
  .openapi("ExecAsyncBody");

const ExecAsyncResponse = z
  .object({
    sessionId: z.string(),
    status: z.literal("running"),
  })
  .openapi("ExecAsyncResponse");

const InputBody = z
  .object({
    text: z.string().nullable().optional().openapi({ example: "hello" }),
    keys: z
      .array(z.string())
      .nullable()
      .optional()
      .openapi({ example: ["enter"] }),
  })
  .openapi("InputBody");

const InputResponse = z
  .object({
    sessionId: z.string(),
    sent: z.boolean(),
  })
  .openapi("InputResponse");

const SessionStatusSchema = z.enum(["running", "exited", "expired", "closed"]);

const GetResponse = z
  .object({
    sessionId: z.string(),
    output: z.string(),
    lineCount: z.number(),
    byteOffset: z.number(),
    status: SessionStatusSchema,
    exitCode: z.number().nullable(),
    cwd: z.string(),
    streamUrl: z.string(),
  })
  .openapi("GetSessionResponse");

const SessionSummary = z.object({
  sessionId: z.string(),
  status: SessionStatusSchema,
  cwd: z.string(),
  shell: z.string(),
  created: z.string(),
  lastActivity: z.string(),
  timeout: z.number().nullable(),
  streamUrl: z.string(),
});

const ListResponse = z
  .object({
    sessions: z.array(SessionSummary),
  })
  .openapi("ListSessionsResponse");

const CloseResponse = z
  .object({
    sessionId: z.string(),
    finalOutput: z.string(),
    status: z.literal("closed"),
  })
  .openapi("CloseSessionResponse");

const ErrorResponse = z
  .object({
    error: z.string(),
  })
  .openapi("ErrorResponse");

// --- route definitions ---

const createSession = createRoute({
  method: "post",
  path: "/terminals",
  tags: ["Terminals"],
  summary: "Create a new terminal session",
  request: { body: { content: { "application/json": { schema: CreateBody } } } },
  responses: {
    201: {
      content: { "application/json": { schema: CreateResponse } },
      description: "Session created",
    },
    500: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Server error",
    },
  },
});

const listSessions = createRoute({
  method: "get",
  path: "/terminals",
  tags: ["Terminals"],
  summary: "List all terminal sessions",
  responses: {
    200: { content: { "application/json": { schema: ListResponse } }, description: "Session list" },
  },
});

const getSession = createRoute({
  method: "get",
  path: "/terminals/{id}",
  tags: ["Terminals"],
  summary: "Get session output and status",
  request: {
    params: SessionIdParam,
    query: z.object({
      tail: z.string().optional().openapi({ example: "50" }),
      since: z.string().optional().openapi({ example: "8391" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: GetResponse } },
      description: "Session details",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Session not found",
    },
  },
});

const closeSession = createRoute({
  method: "delete",
  path: "/terminals/{id}",
  tags: ["Terminals"],
  summary: "Kill a session",
  request: { params: SessionIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: CloseResponse } },
      description: "Session closed",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Session not found",
    },
  },
});

const execInSession = createRoute({
  method: "post",
  path: "/terminals/{id}/exec",
  tags: ["Terminals"],
  summary: "Run a command synchronously in a session",
  request: {
    params: SessionIdParam,
    body: { content: { "application/json": { schema: ExecBody } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ExecResponse } },
      description: "Command output",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Session not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Session not running",
    },
  },
});

const execAutoCreate = createRoute({
  method: "post",
  path: "/terminals/exec",
  tags: ["Terminals"],
  summary: "Auto-create a session and run a command synchronously",
  request: { body: { content: { "application/json": { schema: ExecBody } } } },
  responses: {
    200: {
      content: { "application/json": { schema: ExecResponse } },
      description: "Command output",
    },
    500: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Server error",
    },
  },
});

const execAsyncInSession = createRoute({
  method: "post",
  path: "/terminals/{id}/exec/async",
  tags: ["Terminals"],
  summary: "Run a command without waiting for completion",
  request: {
    params: SessionIdParam,
    body: { content: { "application/json": { schema: ExecAsyncBody } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ExecAsyncResponse } },
      description: "Command started",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Session not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Session not running",
    },
  },
});

const execAsyncAutoCreate = createRoute({
  method: "post",
  path: "/terminals/exec/async",
  tags: ["Terminals"],
  summary: "Auto-create a session and run a command without waiting",
  request: { body: { content: { "application/json": { schema: ExecAsyncBody } } } },
  responses: {
    200: {
      content: { "application/json": { schema: ExecAsyncResponse } },
      description: "Command started",
    },
    500: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Server error",
    },
  },
});

const sendInput = createRoute({
  method: "post",
  path: "/terminals/{id}/input",
  tags: ["Terminals"],
  summary: "Send keystrokes or control sequences",
  request: {
    params: SessionIdParam,
    body: { content: { "application/json": { schema: InputBody } } },
  },
  responses: {
    200: { content: { "application/json": { schema: InputResponse } }, description: "Input sent" },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Session not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Session not running",
    },
  },
});

// --- app ---

function parseIntQuery(value: string | undefined): number | null {
  if (value == null) return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

export function sessionRoutes(sessions: SessionManager) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.message }, 422);
      }
    },
  });

  app.onError((err, c) => {
    if (err instanceof SessionError) {
      return c.json({ error: err.message }, err.statusCode);
    }
    return c.json({ error: err.message }, 500);
  });

  return app
    .openapi(createSession, async (c) => {
      const body = c.req.valid("json");
      const result = await sessions.create(body);
      return c.json(result, 201);
    })
    .openapi(listSessions, async (c) => {
      const result = await sessions.list();
      return c.json(result, 200);
    })
    .openapi(getSession, async (c) => {
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const result = await sessions.get({
        sessionId: id,
        tail: parseIntQuery(query.tail),
        since: parseIntQuery(query.since),
      });
      return c.json(result, 200);
    })
    .openapi(closeSession, async (c) => {
      const { id } = c.req.valid("param");
      const result = await sessions.close({ sessionId: id });
      return c.json(result, 200);
    })
    .openapi(execInSession, async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await sessions.exec({
        command: body.command,
        sessionId: id,
        timeout: body.timeout,
      });
      return c.json(result, 200);
    })
    .openapi(execAutoCreate, async (c) => {
      const body = c.req.valid("json");
      const result = await sessions.exec({
        command: body.command,
        timeout: body.timeout,
      });
      return c.json(result, 200);
    })
    .openapi(execAsyncInSession, async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await sessions.execAsync({
        command: body.command,
        sessionId: id,
      });
      return c.json(result, 200);
    })
    .openapi(execAsyncAutoCreate, async (c) => {
      const body = c.req.valid("json");
      const result = await sessions.execAsync({ command: body.command });
      return c.json(result, 200);
    })
    .openapi(sendInput, async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await sessions.input({
        sessionId: id,
        text: body.text,
        keys: body.keys,
      });
      return c.json(result, 200);
    });
}
