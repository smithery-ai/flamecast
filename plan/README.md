# Implementation Plan: PR #58 → Production-Ready

Restore feature parity with main branch while keeping the decoupled control plane / data plane architecture.

**Branch:** `feat/alchemy-container-migration-v2` (based on PR #58 commit `815f0c2`)

**Tickets delivered:** SMI-1680 (named runtimes), SMI-1677 (workspace setup), SMI-1665 (permission handlers)

---

## MVP Session Lifecycle Model

Session lifecycle state is intentionally **memory-backed rather than durable**. `SessionService` owns an in-memory registry of active session routing metadata. A control-plane restart may orphan active session hosts and lose routing state; recovery and durable session handles are deferred.

**Failure model:** Active sessions lost on restart. No multi-instance support. Event replay is best-effort.

---

## Work Units

Each unit is scoped for a single agent to execute independently. Units within a phase can be parallelized where noted.

### Phase 1: Fix Critical Gaps (Feature Parity)

| # | Unit | File | Parallelizable |
|---|------|------|----------------|
| 1.1 | [Shared protocol contract](./01-shared-protocol.md) | `session-host-protocol.ts` | Yes (with 1.4) |
| 1.2 | [Fix permission prompting](./02-fix-permissions.md) | session host + frontend | Depends on 1.1 |
| 1.3 | [Fix file browser](./03-fix-filesystem.md) | session host + walk-directory | Depends on 1.1 |
| 1.4 | [Seed local templates](./04-seed-templates.md) | seed.ts | Yes (with 1.1) |
| 1.5 | [Phase 1 tests](./05-phase1-tests.md) | test files | Depends on 1.2, 1.3, 1.4 |

### Phase 2: Named Runtimes + Typed SDK API (SMI-1680, SMI-1665)

| # | Unit | File | Parallelizable |
|---|------|------|----------------|
| 2.1 | [Runtime interface + types](./06-runtime-interface.md) | `runtime.ts` | Yes (with 2.2, 2.3) |
| 2.2 | [LocalRuntime](./07-local-runtime.md) | `runtimes/local.ts` | Yes (with 2.1, 2.3) |
| 2.3 | [RemoteRuntime](./08-remote-runtime.md) | `runtimes/remote.ts` | Yes (with 2.1, 2.2) |
| 2.4 | [SessionService](./09-session-service.md) | `session-service.ts` | Depends on 2.1 |
| 2.5 | [Typed Flamecast constructor + event handlers](./10-flamecast-constructor.md) | `index.ts` | Depends on 2.1, 2.4 |
| 2.6 | [Update entry points + dev workflow](./11-entry-points.md) | `apps/server`, `apps/worker`, `alchemy.run.ts` | Depends on 2.2, 2.3, 2.5 |
| 2.7 | [Phase 2 tests](./12-phase2-tests.md) | test files | Depends on 2.4, 2.5, 2.6 |

### Phase 3: Production Hardening

| # | Unit | File | Parallelizable |
|---|------|------|----------------|
| 3.1 | [SessionHost Docker image](./16-docker-image.md) | Dockerfile | Yes |
| 3.2 | [Graceful shutdown](./17-graceful-shutdown.md) | index.ts, alchemy.run.ts | Yes |
| 3.3 | [Health checks + idle timeout](./18-health-checks.md) | session host, api.ts | Yes |
| 3.4 | [Error handling](./19-error-handling.md) | LocalRuntime, session host | Yes |
| 3.5 | [Integration test suite](./20-integration-tests.md) | test files | Depends on all above |

### Phase 4: Deploy

| # | Unit | File | Parallelizable |
|---|------|------|----------------|
| 4.1 | [Publish session host image + CI/CD](./21-deploy.md) | CI config | — |

---

## Reference

- [Architecture & design](./00-architecture.md) — semantic model, system diagrams, interfaces, responsibility map, event persistence tradeoffs, open questions

## Prior Analysis

Research docs (baseline evaluations, PR #58 evaluations, gap findings, screenshots) were used during planning and have been archived. Key findings are captured in the architecture doc and individual work units.
