import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { voiceFeedDir } from "./ledger/jsonl-store.js";
import type { LedgerItem } from "./ledger/ledger.js";

export type SpawnFn = (file: string, args: string[], logFd: number) => ChildProcess;

export interface DispatchLauncherOptions {
  env?: NodeJS.ProcessEnv;
  /** Seam for tests. Default spawns detached with output to the log file. */
  spawnFn?: SpawnFn;
  /** How long a non-zero exit still counts as a failed launch. */
  settleMs?: number;
  logDir?: string;
}

const defaultSpawn: SpawnFn = (file, args, logFd) =>
  spawn(file, args, { detached: true, stdio: ["ignore", logFd, logFd] });

/**
 * Folder of `project` under `<workshop>/<group>/`, or null. The name must be a single path
 * segment, a real directory (not a symlink) inside the workshop, and match in exactly one group.
 */
export function resolveProjectDir(workshop: string, project: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(project) || project.startsWith(".")) return null;
  const matches: string[] = [];
  for (const group of safeDirs(workshop)) {
    const candidate = join(workshop, group, project);
    if (isRealDirInside(workshop, candidate)) matches.push(candidate);
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function isRealDirInside(root: string, candidate: string): boolean {
  try {
    if (!lstatSync(candidate).isDirectory()) return false;
    return realpathSync(candidate).startsWith(realpathSync(root) + sep);
  } catch {
    return false;
  }
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The `dispatch` route from DESIGN.md 4.4: run `$PYRGOS_DISPATCH_CMD worker <spec>`
 * with a fixed argv (no shell). Rejects when the command is unset, the project cannot be found,
 * or the process fails to start or exits non-zero within `settleMs`. A longer run counts as launched.
 */
export function createDispatchLauncher(
  options: DispatchLauncherOptions = {},
): (item: LedgerItem) => Promise<void> {
  const env = options.env ?? process.env;
  const run = options.spawnFn ?? defaultSpawn;
  const settleMs = options.settleMs ?? 2000;

  return async (item) => {
    const command = env.PYRGOS_DISPATCH_CMD;
    if (!command) throw new Error("PYRGOS_DISPATCH_CMD is not set");
    const workshop = env.ALCHEMIST_WORKSHOP;
    if (!workshop) throw new Error("ALCHEMIST_WORKSHOP is not set");
    const cwd = resolveProjectDir(workshop, item.project ?? "");
    if (!cwd) throw new Error(`project folder not found: ${item.project ?? "(none)"}`);

    const spec = `${item.item}. Scope: ${item.scope}. Done when: ${item.doneCriteria}. item:${item.id}`;
    // Fixed extra flags for the dispatcher, e.g. "--dry-run --test none". Split on spaces, never a
    // shell. The validated cwd/ticket come first so an extra flag that takes a value cannot
    // swallow them; cwd/ticket in the extras are dropped along with their values.
    const isPowerShell = /\.ps1$/i.test(command);
    const isShellScript = /\.sh$/i.test(command);
    let file = command;
    if (isPowerShell) file = "powershell.exe";
    else if (isShellScript) file = "bash";
    const args = isPowerShell
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, "worker", spec, "-Cwd", cwd]
      : [...(isShellScript ? [command] : []), "worker", spec, "--cwd", cwd];
    const ticket = /\bMIC-\d+\b/.exec(`${item.item} ${item.scope ?? ""}`)?.[0];
    if (ticket) args.push(isPowerShell ? "-Ticket" : "--ticket", ticket);
    args.push(...extraDispatchArgs(env.PYRGOS_DISPATCH_EXTRA_ARGS));

    const logDir = options.logDir ?? voiceFeedDir(env);
    let logFd = -1;
    try {
      mkdirSync(logDir, { recursive: true });
      logFd = openSync(join(logDir, `launch-${item.id}.log`), "a");
    } catch {
      logFd = -1;
    }
    const child = run(file, args, logFd);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.removeAllListeners("exit");
          resolve();
        }, settleMs);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(new Error(`dispatch failed to start: ${error.message}`));
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`dispatch exited with code ${code ?? "signal"}`));
        });
      });
      child.unref();
    } finally {
      if (logFd >= 0) closeSync(logFd);
    }
  };
}

const RESERVED_FLAGS = new Set(["--cwd", "--ticket", "-cwd", "-ticket"]);

function extraDispatchArgs(raw: string | undefined): string[] {
  const out: string[] = [];
  const tokens = (raw ?? "").split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "--") continue; // an end-of-options marker would hide the validated --cwd
    const flag = tokens[i]!.split("=")[0]!;
    if (RESERVED_FLAGS.has(flag.toLowerCase())) {
      if (!tokens[i]!.includes("=")) {
        const value = tokens[i + 1];
        if (value === undefined || value.startsWith("-")) {
          throw new Error(`PYRGOS_DISPATCH_EXTRA_ARGS: ${flag} needs a value`);
        }
        i += 1;
      }
      continue;
    }
    out.push(tokens[i]!);
  }
  return out;
}
