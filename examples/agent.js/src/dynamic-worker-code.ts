const DYNAMIC_WORKER_COMPATIBILITY_DATE = "2026-03-25";
const DYNAMIC_WORKER_MAIN_MODULE = "execute-js.js";

function buildDynamicWorkerSource(source) {
  return `
const SOURCE = ${JSON.stringify(source)};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runner = new AsyncFunction("__scope", "__console", "__import__", \`const scope = __scope;\\nconst globals = new Proxy(scope, {\\n  has(_target, key) { return key !== "console" && key !== "__import__" && key !== "scope"; },\\n  get(target, key) {\\n    if (key === Symbol.unscopables) return undefined;\\n    return key in target ? target[key] : globalThis[key];\\n  },\\n  set(target, key, value) {\\n    target[key] = value;\\n    return true;\\n  },\\n});\\nconst console = __console;\\nwith (globals) {\\n\${SOURCE}\\n}\`);

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
    return { name: value.name, message: value.message, stack: value.stack };
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

export default {
  async fetch(request) {
    const { scope } = await request.json();
    const logs = [];
    const console = {
      log: (...args) => logs.push(formatLogEntry(args)),
      info: (...args) => logs.push(formatLogEntry(args)),
      warn: (...args) => logs.push(formatLogEntry(args)),
      error: (...args) => logs.push(formatLogEntry(args)),
    };

    try {
      const result = await runner(scope, console, (specifier) => import(specifier));
      return Response.json({
        ok: true,
        result: normalizeValue(result),
        scope: normalizeValue(scope),
        logs,
      });
    } catch (error) {
      return Response.json({
        ok: false,
        error: normalizeValue(error),
        scope: normalizeValue(scope),
        logs,
      });
    }
  },
};
`;
}

export async function hashText(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildDynamicWorkerCode(source) {
  return {
    compatibilityDate: DYNAMIC_WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: DYNAMIC_WORKER_MAIN_MODULE,
    modules: {
      [DYNAMIC_WORKER_MAIN_MODULE]: buildDynamicWorkerSource(source),
    },
  };
}
