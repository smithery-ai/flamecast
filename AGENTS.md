# AGENTS

## Pull Requests

- Use conventional commit titles for commits and PR titles.
- Before opening a PR, run `pnpm run knip` and prune any genuinely dead code it reports to keep the codebase lean.
- If a `knip` finding is intentional, document why or update `knip` configuration instead of silently ignoring it.
- Ensure the PR passes all checks before requesting review or merging.

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
