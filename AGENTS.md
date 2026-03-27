# AGENTS

## Pull Requests

- Use conventional commit titles for commits and PR titles.
- Before opening a PR, run `pnpm run knip` and prune any genuinely dead code it reports to keep the codebase lean.
- If a `knip` finding is intentional, document why or update `knip` configuration instead of silently ignoring it.
- Ensure the PR passes all checks before requesting review or merging.

## Session-host Go Binary

The `packages/session-host-go/` binary is critical infrastructure — it runs inside every Docker and E2B sandbox to manage agent process lifecycle. When modifying it:

- **Always build for `GOARCH=amd64`** — E2B sandboxes are x86_64 regardless of host architecture.
- **Update the rolling release** after building: `gh release delete session-host-latest -y && gh release create session-host-latest dist/session-host-amd64 --title "session-host (latest)" --prerelease`
- The `@flamecast/runtime-e2b` package downloads this binary into sandboxes at runtime. If the binary is missing or incompatible, agent creation will fail with `exit status 2`.
- Test E2B changes end-to-end (not just locally) since the binary resolution path differs between Node.js and bundled environments (Cloudflare Workers, Vercel Edge).

## Code Quality

- Prefer static top-level imports in source files. Do not use function-scoped dynamic imports for internal modules unless there is a clear runtime reason such as optional dependencies, code splitting, or cycle avoidance.
- Preserve typed API clients. Do not replace generated or typed clients with ad hoc `fetch` wrappers unless there is a clear, documented reason.
- Test-only helpers belong under `test/` or `examples/`, not `src/`.
- When a refactor changes boundaries or you find a bug, add a regression test for the failure mode before the fix.

## Type Safety — No Lint Evasion

- **Never** use `oxlint-disable` or `eslint-disable` for `no-type-assertion` to silence `as` casts. Fix the types instead.
- When parsing JSON (e.g., `JSON.parse(body)`), type the variable directly: `const parsed: MyType = JSON.parse(text)`. Do not use `JSON.parse(text) as MyType`.
- When a function receives untyped data, import or construct the correct type. Use shared protocol types from `@flamecast/sdk/shared/session-host-protocol` and extend them locally for provider-specific fields (e.g., `type DockerStartBody = SessionHostStartRequest & { image?: string }`).
- When an object literal doesn't match `RequestInit` or similar built-in types, widen the type annotation (e.g., `const init: RequestInit & { duplex?: string } = { ... }`) rather than casting with `as`.
- The **only** acceptable use of `as` is at generic type boundaries where TypeScript structurally cannot narrow (e.g., `string` to `Extract<keyof R, string>` inside a generic class). In that case, keep the `oxlint-disable` inline with a `--` comment explaining why.
