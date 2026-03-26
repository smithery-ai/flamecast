import { createServer } from "node:http";

function normalizeValue(value, seen = new WeakSet()) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, seen));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = normalizeValue(entry, seen);
    }
    return output;
  }

  return String(value);
}

function formatLogEntry(args) {
  return args
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      return JSON.stringify(normalizeValue(value));
    })
    .join(" ");
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function executeSource(source, scope) {
  const logs = [];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runner = new AsyncFunction(
    "scope",
    "__console",
    "__import__",
    `const console = __console;\nwith (scope) {\n${source}\n}`,
  );

  try {
    const result = await runner(
      scope,
      {
        log: (...args) => logs.push(formatLogEntry(args)),
        info: (...args) => logs.push(formatLogEntry(args)),
        warn: (...args) => logs.push(formatLogEntry(args)),
        error: (...args) => logs.push(formatLogEntry(args)),
      },
      (specifier) => import(specifier),
    );

    return { ok: true, result: normalizeValue(result), scope: normalizeValue(scope), logs };
  } catch (error) {
    return {
      ok: false,
      error: normalizeValue(error),
      scope: normalizeValue(scope),
      logs,
    };
  }
}

export async function startLocalExecutor() {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/execute") {
      response.writeHead(404).end("Not found");
      return;
    }

    const { source, scope = {} } = await readJson(request);
    const result = await executeSource(String(source ?? ""), scope);

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local executor did not expose a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/execute`,
    dispose: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
