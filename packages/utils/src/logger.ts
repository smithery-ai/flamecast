import pino, { type Logger } from "pino"

export type { Logger }

const DEBUGGER_URL = "http://localhost:8099/logs"

// Dev mode flag - set from request context on first request
let isDevMode: boolean | null = null

// Disable debugger in test environments
const isTestEnv =
	typeof process !== "undefined" &&
	(process.env.VITEST === "true" || process.env.NODE_ENV === "test")

/**
 * Set dev mode for debugger logging.
 * Pass env object from Cloudflare Worker - checks DEV_MODE env var.
 * Only sets on first call (sticky for the worker instance).
 */
export function setDevMode<T extends object>(env: T) {
	if (isTestEnv) return
	if (isDevMode === null) {
		const devMode = (env as { DEV_MODE?: string }).DEV_MODE
		isDevMode = devMode === "true" || devMode === "'true'"
	}
}

function sendToDebugger(entry: object) {
	if (isDevMode !== true) return
	fetch(DEBUGGER_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(entry),
	}).catch(() => {})
}

export function createLogger(service: string) {
	const baseLogger = pino({
		level: "debug",
		base: { service },
		timestamp: pino.stdTimeFunctions.isoTime,
	})

	// Wrap logger methods to send to debugger (pino hooks don't work in CF Workers)
	const wrap =
		(level: string, method: (...args: unknown[]) => void) =>
		(...args: unknown[]) => {
			if (isDevMode === true) {
				const entry: Record<string, unknown> = {
					level,
					time: new Date().toISOString(),
					service,
				}
				if (args[0] && typeof args[0] === "object") {
					Object.assign(entry, args[0])
					if (typeof args[1] === "string") entry.msg = args[1]
				} else if (typeof args[0] === "string") {
					entry.msg = args[0]
				}
				sendToDebugger(entry)
			}
			method.apply(baseLogger, args)
		}

	return Object.assign(baseLogger, {
		debug: wrap("debug", baseLogger.debug),
		info: wrap("info", baseLogger.info),
		warn: wrap("warn", baseLogger.warn),
		error: wrap("error", baseLogger.error),
		fatal: wrap("fatal", baseLogger.fatal),
	}) as Logger
}

/**
 * Create a timing context for measuring operation durations.
 * Logs timing breakdown to the debugger service.
 *
 * @example
 * ```ts
 * const t = createTiming(logger, "mcp-request")
 * await doDbQuery()
 * t.mark("dbQuery")
 * await callGateway()
 * t.mark("gateway")
 * t.finish({ status: 200 })
 * // Logs: ⏱ mcp-request 1234ms with timings breakdown
 * ```
 */
export function createTiming(
	baseLogger: Logger,
	operation: string,
): {
	mark: (label: string) => void
	markDelta: (label: string) => void
	finish: (extra?: Record<string, unknown>) => void
} {
	const start = performance.now()
	const timings: Record<string, number> = {}
	let lastMark = start

	return {
		/** Mark a checkpoint. Records time since start. */
		mark(label: string) {
			timings[label] = performance.now() - start
		},

		/** Mark with delta from last mark (useful for seeing individual step times) */
		markDelta(label: string) {
			const now = performance.now()
			timings[label] = now - lastMark
			lastMark = now
		},

		/** Finish and log the timing summary */
		finish(extra?: Record<string, unknown>) {
			const total = performance.now() - start
			const roundedTimings: Record<string, number> = {}
			for (const [k, v] of Object.entries(timings)) {
				roundedTimings[k] = Math.round(v)
			}

			baseLogger.info(
				{
					op: operation,
					ms: Math.round(total),
					timings: roundedTimings,
					...extra,
				},
				`⏱ ${operation} ${Math.round(total)}ms`,
			)
		},
	}
}
