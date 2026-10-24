# Skill log

- 2026-10-23, MIC-753: Reproduced both Windows-only test failures, keyed fake readers with `path.join`, reduced oversized cap fixtures while retaining exact-cap assertions, and skipped the POSIX `ENOTDIR` case on Windows. Fresh worktree setup needed dependency patches and workspace builds before the commit hook's typecheck passed; captured the repeatable procedure in `.claude/skills/bootstrap-paseo-worktree/SKILL.md`.
