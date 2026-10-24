---
name: bootstrap-paseo-worktree
description: Prepare a fresh Paseo worktree when Vitest or typecheck cannot resolve workspace packages or declarations.
---

# Bootstrap a Paseo worktree

Run from the repository root on a fresh checkout:

1. `npm ci` to install the locked dependencies and run the repository patches.
2. `npm run build:server-deps` to generate protocol and client declarations and build the relay, highlight, and plugin packages.
3. `npm run build --workspace=@getpaseo/server` when CLI typecheck reports missing server declarations.
4. Rerun the focused test and `npm run typecheck`. If typecheck still fails, inspect the first error before changing source.

These builds can touch generated or line-ending-sensitive tracked files. Inspect `git diff --name-only` afterward and keep only intended edits. On Windows, the full `npm run format` can make many files appear modified from line-ending changes; use `npm run format:files -- <paths>` for the files in the ticket.
