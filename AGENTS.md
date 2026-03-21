# AGENTS

## Pull Requests

- Use conventional commit titles for commits and PR titles.
- Before opening a PR, run `pnpm run knip` and prune any genuinely dead code it reports to keep the codebase lean.
- If a `knip` finding is intentional, document why or update `knip` configuration instead of silently ignoring it.
- Ensure the PR passes all checks before requesting review or merging.

## Code Quality

- Preserve typed API clients. Do not replace generated or typed clients with ad hoc `fetch` wrappers unless there is a clear, documented reason.
- Test-only helpers belong under `test/` or `examples/`, not `src/`.
- When a refactor changes boundaries or you find a bug, add a regression test for the failure mode before the fix.
