# Skill log

- 2026-10-23, MIC-753: Reproduced both Windows-only test failures, keyed fake readers with `path.join`, reduced oversized cap fixtures while retaining exact-cap assertions, and skipped the POSIX `ENOTDIR` case on Windows. Fresh worktree setup needed dependency patches and workspace builds before the commit hook's typecheck passed; captured the repeatable procedure in `.claude/skills/bootstrap-paseo-worktree/SKILL.md`.
- 2026-10-24, MIC-753: Added fixed PowerShell and Bash dispatcher argv selection, protected Windows cwd/ticket flags in extra arguments, documented the Windows dry run, and retained the verified Android build fixes. Installed dependencies and built server workspace declarations before the Pyrgos suite and typecheck.
