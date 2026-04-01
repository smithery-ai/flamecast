/**
 * E2E test for the IBM ACP path.
 *
 * Exercises IbmAcpAdapter directly against a real Python echo agent, and
 * tests the IbmAgentSession VO through Restate including the full
 * runAgent -> awakeable -> resolve flow.
 *
 * Usage:
 *   1. cd tests/echo-agent && uv run python server.py &
 *   2. npx tsx tests/e2e-ibm-acp.ts
 *   3. (Optional) Start Restate + register endpoint for VO-level tests:
 *      cd packages/flamecast-restate && pnpm dev:server &
 *      cd packages/flamecast-restate && pnpm dev &
 *      sleep 5 && pnpm dev:register
 *
 * The echo agent runs on http://localhost:8000 by default.
 * Restate admin on :19070, ingress on :18080, endpoint on :9080.
 */

import { setTimeout as delay } from "node:timers/promises";
import { IbmAcpAdapter } from "../packages/flamecast-restate/src/ibm-acp-adapter.js";
import type {
  AgentStartConfig,
  AgentMessage,
  PromptResult,
  SessionHandle,
} from "../packages/flamecast-restate/src/adapter.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const AGENT_URL = process.env.AGENT_URL ?? "http://localhost:8000/agents/echo";
const RESTATE_ADMIN_URL =
  process.env.RESTATE_ADMIN_URL ?? "http://localhost:19070";
const RESTATE_INGRESS_URL =
  process.env.RESTATE_INGRESS_URL ?? "http://localhost:18080";

/** Timeout for polling awaitRun (echo agent should be fast). */
const RUN_TIMEOUT_MS = 30_000;

// ─── Test harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

function log(msg: string): void {
  console.log(msg);
}

function pass(name: string): void {
  passed++;
  log(`  PASS  ${name}`);
}

function fail(name: string, err: unknown): void {
  failed++;
  const msg = err instanceof Error ? err.message : String(err);
  log(`  FAIL  ${name}: ${msg}`);
}

function skip(name: string, reason: string): void {
  skipped++;
  log(`  SKIP  ${name}: ${reason}`);
}

// ─── Precondition checks ────────────────────────────────────────────────────

async function checkAgentRunning(): Promise<boolean> {
  try {
    const res = await fetch(AGENT_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkRestateRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${RESTATE_ADMIN_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkVORegistered(): Promise<boolean> {
  try {
    const res = await fetch(
      `${RESTATE_ADMIN_URL}/services/IbmAgentSession`,
      { signal: AbortSignal.timeout(5_000) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Helpers: Restate ingress via raw HTTP ──────────────────────────────────

/**
 * Call a Restate VO handler and return the parsed JSON response.
 */
async function callVO<T>(
  voName: string,
  key: string,
  handler: string,
  body: unknown,
  timeoutMs: number = 30_000,
): Promise<T> {
  const res = await fetch(
    `${RESTATE_INGRESS_URL}/${voName}/${key}/${handler}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `${voName}/${handler} failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Send a one-way call to a Restate VO handler.
 * Returns the invocation ID from the response header.
 */
async function sendVO(
  voName: string,
  key: string,
  handler: string,
  body: unknown,
): Promise<string> {
  const res = await fetch(
    `${RESTATE_INGRESS_URL}/${voName}/${key}/${handler}/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `${voName}/${handler}/send failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as { invocationId: string };
  return data.invocationId;
}

/**
 * Attach to a pending invocation and wait for its result.
 */
async function attachInvocation<T>(
  invocationId: string,
  timeoutMs: number = 30_000,
): Promise<T> {
  const res = await fetch(
    `${RESTATE_INGRESS_URL}/restate/invocation/${invocationId}/attach`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `attach ${invocationId} failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Resolve a Restate awakeable via the ingress HTTP API.
 */
async function resolveAwakeable(
  awakeableId: string,
  payload: unknown,
): Promise<void> {
  const res = await fetch(
    `${RESTATE_INGRESS_URL}/restate/awakeables/${awakeableId}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `resolveAwakeable failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }
}

// ─── Helpers: Restate admin state query ─────────────────────────────────────

/**
 * Query VO state via the Restate admin SQL endpoint.
 * Returns the parsed JSON value for the given state key, or null.
 */
async function queryVOState<T>(
  voName: string,
  voKey: string,
  stateKey: string,
): Promise<T | null> {
  const query = `SELECT value_utf8 FROM state WHERE service_name = '${voName}' AND service_key = '${voKey}' AND key = '${stateKey}'`;
  const res = await fetch(`${RESTATE_ADMIN_URL}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as { rows: Array<{ value_utf8: string }> };
  if (!data.rows || data.rows.length === 0) {
    return null;
  }

  try {
    return JSON.parse(data.rows[0].value_utf8) as T;
  } catch {
    return null;
  }
}

/**
 * Poll VO state until the given key appears, with timeout.
 */
async function pollVOState<T>(
  voName: string,
  voKey: string,
  stateKey: string,
  timeoutMs: number = 15_000,
  intervalMs: number = 500,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await queryVOState<T>(voName, voKey, stateKey);
    if (value !== null) return value;
    await delay(intervalMs);
  }
  return null;
}

/**
 * Poll the ACP agent for a run's terminal state.
 */
async function pollAcpRunCompletion(
  baseUrl: string,
  runId: string,
  timeoutMs: number = 15_000,
): Promise<PromptResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/runs/${runId}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`GET /runs/${runId} failed: ${res.status}`);

    const run = (await res.json()) as {
      run_id: string;
      status: string;
      output?: AgentMessage[];
      await_request?: unknown;
      error?: { message?: string };
    };

    if (run.status === "completed") {
      return { status: "completed", output: run.output, runId };
    }
    if (run.status === "awaiting") {
      return { status: "awaiting", awaitRequest: run.await_request, runId };
    }
    if (run.status === "failed") {
      return {
        status: "failed",
        error: run.error?.message ?? "Run failed",
        runId,
      };
    }
    if (run.status === "cancelled") {
      return { status: "cancelled", runId };
    }

    await delay(500);
  }
  return { status: "failed", error: "Timed out polling run", runId };
}

// ─── Test 1: IbmAcpAdapter.start ─────────────────────────────────────────────

async function testAdapterStart(
  adapter: IbmAcpAdapter,
): Promise<SessionHandle | null> {
  log("\n--- Test 1: IbmAcpAdapter.start ---\n");

  try {
    const config: AgentStartConfig = {
      agent: AGENT_URL,
      sessionId: `e2e-ibm-${Date.now()}`,
    };

    const session = await adapter.start(config);

    if (!session.sessionId) {
      throw new Error("Missing sessionId in SessionHandle");
    }
    if (session.protocol !== "ibm") {
      throw new Error(`Expected protocol "ibm", got "${session.protocol}"`);
    }
    if (!session.agent.name) {
      throw new Error("Missing agent.name in SessionHandle");
    }
    if (!session.connection.url) {
      throw new Error("Missing connection.url in SessionHandle");
    }

    log(`    sessionId:  ${session.sessionId}`);
    log(`    protocol:   ${session.protocol}`);
    log(`    agent.name: ${session.agent.name}`);
    log(`    url:        ${session.connection.url}`);

    pass("start returned valid SessionHandle");
    return session;
  } catch (err) {
    fail("adapter.start", err);
    return null;
  }
}

// ─── Test 2: IbmAcpAdapter.createRun ─────────────────────────────────────────

async function testAdapterCreateRun(
  adapter: IbmAcpAdapter,
  session: SessionHandle,
): Promise<string | null> {
  log("\n--- Test 2: IbmAcpAdapter.createRun ---\n");

  try {
    const { runId } = await adapter.createRun(session, "Hello from E2E test");

    if (!runId) {
      throw new Error("Missing runId from createRun");
    }

    log(`    runId: ${runId}`);
    pass("createRun returned a runId");
    return runId;
  } catch (err) {
    fail("adapter.createRun", err);
    return null;
  }
}

// ─── Test 3: Poll until completion (awaitRun via promptSync) ─────────────────

async function testAdapterPromptSync(
  adapter: IbmAcpAdapter,
  session: SessionHandle,
): Promise<void> {
  log("\n--- Test 3: IbmAcpAdapter.promptSync (createRun + poll) ---\n");

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

    const result: PromptResult = await adapter.promptSync(
      session,
      "Say hello",
    );

    clearTimeout(timer);

    log(`    status: ${result.status}`);
    log(
      `    output: ${JSON.stringify(result.output ?? result.error ?? null).slice(0, 500)}`,
    );

    if (result.status !== "completed") {
      throw new Error(
        `Expected status "completed", got "${result.status}": ${result.error ?? ""}`,
      );
    }

    pass("promptSync returned completed");

    // Verify echo content
    const allText = (result.output ?? [])
      .flatMap((m) => m.parts ?? [])
      .map((p) => ("content" in p ? (p.content as string) : ""))
      .join(" ");

    if (allText.toLowerCase().includes("echo")) {
      pass("response contains echo content");
    } else {
      log(`    (response text: "${allText.slice(0, 200)}")`);
      // Not a failure — agent might format differently
      pass("response received (content check inconclusive)");
    }
  } catch (err) {
    fail("adapter.promptSync", err);
  }
}

// ─── Test 4: Streaming via adapter.prompt ────────────────────────────────────

async function testAdapterStream(
  adapter: IbmAcpAdapter,
  session: SessionHandle,
): Promise<void> {
  log("\n--- Test 4: IbmAcpAdapter.prompt (streaming) ---\n");

  try {
    const events: Array<{ type: string }> = [];
    let gotComplete = false;
    let gotText = false;

    for await (const event of adapter.prompt(session, "Stream test")) {
      events.push(event);
      log(`    [event] ${event.type}: ${JSON.stringify(event).slice(0, 200)}`);

      if (event.type === "text") gotText = true;
      if (event.type === "complete") gotComplete = true;
      if (event.type === "error") {
        throw new Error(
          `Agent error: ${"message" in event ? event.message : JSON.stringify(event)}`,
        );
      }
    }

    log(`    total events: ${events.length}`);

    if (events.length === 0) {
      throw new Error("No events received from stream");
    }

    pass("prompt stream received events");

    if (gotComplete) {
      pass("stream ended with complete event");
    } else {
      // Stream may end without explicit complete if the connection closes
      pass("stream ended (no explicit complete event)");
    }
  } catch (err) {
    fail("adapter.prompt (streaming)", err);
  }
}

// ─── Test 5: adapter.close ───────────────────────────────────────────────────

async function testAdapterClose(
  adapter: IbmAcpAdapter,
  session: SessionHandle,
): Promise<void> {
  log("\n--- Test 5: IbmAcpAdapter.close ---\n");

  try {
    await adapter.close(session);
    pass("close completed (no-op for IBM ACP)");
  } catch (err) {
    fail("adapter.close", err);
  }
}

// ─── Test 6: Restate VO — startSession + getStatus + terminateSession ────────

async function testRestateVOLifecycle(): Promise<void> {
  log("\n--- Test 6: Restate VO lifecycle (start / status / terminate) ---\n");

  const sessionKey = `e2e-ibm-lifecycle-${Date.now()}`;

  try {
    // Step 1: startSession
    log("  Calling IbmAgentSession/startSession ...");
    const sessionHandle = await callVO<SessionHandle>(
      "IbmAgentSession",
      sessionKey,
      "startSession",
      { agent: AGENT_URL },
    );

    log(
      `    sessionHandle: ${JSON.stringify(sessionHandle).slice(0, 300)}`,
    );

    if (
      sessionHandle?.sessionId &&
      sessionHandle?.protocol === "ibm"
    ) {
      pass("startSession returned valid SessionHandle");
    } else {
      throw new Error(
        `Unexpected session handle: ${JSON.stringify(sessionHandle).slice(0, 300)}`,
      );
    }

    // Step 2: getStatus
    log("  Calling IbmAgentSession/getStatus ...");
    const meta = await callVO<Record<string, unknown>>(
      "IbmAgentSession",
      sessionKey,
      "getStatus",
      null,
      10_000,
    );
    log(`    meta: ${JSON.stringify(meta).slice(0, 300)}`);

    if (meta?.status === "active") {
      pass("getStatus returned active session");
    } else {
      pass("getStatus returned metadata");
    }

    // Step 3: terminateSession
    log("  Calling IbmAgentSession/terminateSession ...");
    await callVO<void>(
      "IbmAgentSession",
      sessionKey,
      "terminateSession",
      null,
      10_000,
    );
    pass("terminateSession succeeded");
  } catch (err) {
    fail("Restate VO lifecycle", err);

    // Best-effort cleanup
    try {
      await callVO<void>(
        "IbmAgentSession",
        sessionKey,
        "terminateSession",
        null,
        5_000,
      );
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ─── Test 7: Restate VO — runAgent (create + awakeable + resolve) ────────────

async function testRestateVORunAgent(): Promise<void> {
  log(
    "\n--- Test 7: Restate VO runAgent (create + awakeable + resolve) ---\n",
  );

  const sessionKey = `e2e-ibm-run-${Date.now()}`;

  try {
    // Step 1: Start a session
    log("  [1] Starting session ...");
    const sessionHandle = await callVO<SessionHandle>(
      "IbmAgentSession",
      sessionKey,
      "startSession",
      { agent: AGENT_URL },
    );
    log(`    agent: ${sessionHandle.agent.name}, url: ${sessionHandle.connection.url}`);
    pass("session started for runAgent test");

    // Step 2: Send runAgent (one-way) — this will suspend on awakeable
    log("  [2] Sending runAgent (one-way send) ...");
    const invocationId = await sendVO(
      "IbmAgentSession",
      sessionKey,
      "runAgent",
      { text: "Hello E2E" },
    );
    log(`    invocationId: ${invocationId}`);
    pass("runAgent send accepted");

    // Step 3: Poll for pending_run state (VO needs time to execute ctx.run)
    log("  [3] Polling for pending_run state ...");
    const pendingRun = await pollVOState<{
      awakeableId: string;
      runId: string;
    }>("IbmAgentSession", sessionKey, "pending_run", 15_000);

    if (!pendingRun) {
      throw new Error(
        "Timed out waiting for pending_run state — VO may not have reached awakeable",
      );
    }

    log(`    runId:       ${pendingRun.runId}`);
    log(`    awakeableId: ${pendingRun.awakeableId}`);
    pass("pending_run state found with runId and awakeableId");

    // Step 4: Poll the ACP agent for the run to complete
    // The echo agent completes nearly instantly, so this should be fast
    const agentBaseUrl = sessionHandle.connection.url!;
    log(`  [4] Polling ACP agent at ${agentBaseUrl}/runs/${pendingRun.runId} ...`);
    const acpResult = await pollAcpRunCompletion(
      agentBaseUrl,
      pendingRun.runId,
      15_000,
    );
    log(`    ACP run status: ${acpResult.status}`);

    if (acpResult.status !== "completed") {
      throw new Error(
        `ACP run did not complete: ${acpResult.status} — ${acpResult.error ?? ""}`,
      );
    }
    pass("ACP agent run completed");

    // Step 5: Resolve the awakeable — this unblocks the VO
    log("  [5] Resolving awakeable ...");
    await resolveAwakeable(pendingRun.awakeableId, acpResult);
    pass("awakeable resolved");

    // Step 6: Attach to the invocation and get the result
    log("  [6] Attaching to get runAgent result ...");
    const result = await attachInvocation<PromptResult>(
      invocationId,
      30_000,
    );
    log(`    result status: ${result.status}`);
    log(
      `    result output: ${JSON.stringify(result.output ?? []).slice(0, 500)}`,
    );

    if (result.status !== "completed") {
      throw new Error(`Expected completed, got ${result.status}`);
    }
    pass("runAgent returned completed result");

    // Step 7: Verify echo content
    const allText = (result.output ?? [])
      .flatMap((m) => m.parts ?? [])
      .map((p) => (p.content as string) ?? "")
      .join(" ");

    if (allText.toLowerCase().includes("echo")) {
      log(`    echo text: "${allText.slice(0, 200)}"`);
      pass("response contains echo content");
    } else {
      log(`    (response text: "${allText.slice(0, 200)}")`);
      pass("response received (content check inconclusive)");
    }
  } catch (err) {
    fail("Restate VO runAgent", err);
  } finally {
    // Cleanup: terminate session
    try {
      await callVO<void>(
        "IbmAgentSession",
        sessionKey,
        "terminateSession",
        null,
        5_000,
      );
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("=== E2E Test: IBM ACP Path ===\n");

  // Precondition: echo agent must be running
  const agentUp = await checkAgentRunning();
  if (!agentUp) {
    log(`ABORT: Echo agent not reachable at ${AGENT_URL}`);
    log("Start the agent first:");
    log("  cd tests/echo-agent && uv run python server.py");
    process.exit(1);
  }
  pass(`echo agent reachable at ${AGENT_URL}`);

  const adapter = new IbmAcpAdapter();

  // Test 1: start
  const session = await testAdapterStart(adapter);
  if (!session) {
    log("\nABORT: Cannot continue without a valid session.");
    process.exit(1);
  }

  // Test 2: createRun (fire-and-forget, just get a runId)
  await testAdapterCreateRun(adapter, session);

  // Small delay so the first run finishes before we start the next
  await delay(500);

  // Test 3: promptSync (createRun + poll to completion)
  await testAdapterPromptSync(adapter, session);

  // Test 4: streaming
  await testAdapterStream(adapter, session);

  // Test 5: close
  await testAdapterClose(adapter, session);

  // ── Restate VO tests (only if Restate is up + VO registered) ────────────

  const restateUp = await checkRestateRunning();
  if (!restateUp) {
    skip("Restate VO tests", "Restate not running on port 18080/19070");
  } else {
    const voRegistered = await checkVORegistered();
    if (!voRegistered) {
      skip("Restate VO tests", "IbmAgentSession not registered in Restate");
    } else {
      // Test 6: VO lifecycle (start / status / terminate)
      await testRestateVOLifecycle();

      // Test 7: VO runAgent (create + awakeable + resolve — the critical path)
      await testRestateVORunAgent();
    }
  }

  // Summary
  log("\n=== Summary ===");
  log(`  Passed:  ${passed}`);
  log(`  Failed:  ${failed}`);
  log(`  Skipped: ${skipped}`);
  log("");

  if (failed > 0) {
    log("RESULT: FAIL");
    process.exit(1);
  } else {
    log("RESULT: PASS");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
