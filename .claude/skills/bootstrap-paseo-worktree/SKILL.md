---
name: bootstrap-paseo-worktree
description: Prepare a fresh Paseo worktree on Windows for server tests and repository typechecking when workspace imports or patched dependency types fail.
---

# Bootstrap a Windows worktree

Run from the repository root:

1. `npm ci --ignore-scripts --no-audit --no-fund`, then `npm run postinstall`. The second command applies the repository's dependency patches; without it, app typechecking sees upstream types that do not match the source.
2. `npm run build:server-deps`, then `npm run build --workspace=@getpaseo/server`. These builds provide the workspace exports consumed by server tests, desktop, and CLI.
3. Run the requested test command and `npm run typecheck`. Completion requires both commands to exit 0.

Use the package scripts from `package.json` if their names change. This procedure prepares local dependencies and build output; it does not call for source edits.
