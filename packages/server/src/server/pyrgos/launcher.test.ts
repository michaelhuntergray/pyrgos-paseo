import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDispatchLauncher, resolveProjectDir, type SpawnFn } from "./launcher.js";
import type { LedgerItem } from "./ledger/ledger.js";

function item(overrides: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id: "abc",
    state: "agreed",
    item: "Fix MIC-12 readme",
    scope: "README only",
    project: "demo",
    doneCriteria: "one line",
    transcriptRef: null,
    launchError: null,
    launchId: null,
    announcedAt: null,
    launchedAt: null,
    dropReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "launch-"));
  mkdirSync(join(root, "Professional", "demo"), { recursive: true });
  return { root, env: { ALCHEMIST_WORKSHOP: root, PYRGOS_DISPATCH_CMD: "/bin/dispatch.sh" } };
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  return child;
}

describe("dispatch launcher", () => {
  it("runs a PowerShell dispatcher with Windows flags and a fixed argv", async () => {
    const { root, env } = fixture();
    const spawnFn = vi.fn(() => fakeChild()) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
    await createDispatchLauncher({
      env: {
        ...env,
        PYRGOS_DISPATCH_CMD: "C:\\harness\\tools\\dispatch\\dispatch.PS1",
        PYRGOS_DISPATCH_EXTRA_ARGS: "-DryRun -Test none",
      },
      spawnFn,
      settleMs: 5,
      logDir: root,
    })(item());
    expect(spawnFn).toHaveBeenCalledWith(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\harness\\tools\\dispatch\\dispatch.PS1",
        "worker",
        "Fix MIC-12 readme. Scope: README only. Done when: one line. item:abc",
        "-Cwd",
        join(root, "Professional", "demo"),
        "-Ticket",
        "MIC-12",
        "-DryRun",
        "-Test",
        "none",
      ],
      expect.any(Number),
    );
  });

  it("runs the dispatcher with a fixed argv, the project cwd and the ticket", async () => {
    const { root, env } = fixture();
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
    const launch = createDispatchLauncher({ env, spawnFn, settleMs: 5, logDir: root });
    await launch(item());
    const [file, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe("bash");
    expect(args.slice(0, 2)).toEqual(["/bin/dispatch.sh", "worker"]);
    expect(args[2]).toContain("item:abc");
    expect(args.slice(3)).toEqual([
      "--cwd",
      join(root, "Professional", "demo"),
      "--ticket",
      "MIC-12",
    ]);
    expect(child.unref).toHaveBeenCalled();
  });

  it("runs a plain executable with its original argv", async () => {
    const { root, env } = fixture();
    const spawnFn = vi.fn(() => fakeChild()) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
    await createDispatchLauncher({
      env: { ...env, PYRGOS_DISPATCH_CMD: "dispatch.exe" },
      spawnFn,
      settleMs: 5,
      logDir: root,
    })(item());
    expect(spawnFn).toHaveBeenCalledWith(
      "dispatch.exe",
      [
        "worker",
        "Fix MIC-12 readme. Scope: README only. Done when: one line. item:abc",
        "--cwd",
        join(root, "Professional", "demo"),
        "--ticket",
        "MIC-12",
      ],
      expect.any(Number),
    );
  });

  it("rejects on a start error and on an early non-zero exit", async () => {
    const { root, env } = fixture();
    const failing = (emit: (c: EventEmitter) => void): SpawnFn =>
      (() => {
        const c = fakeChild();
        queueMicrotask(() => emit(c));
        return c;
      }) as unknown as SpawnFn;
    await expect(
      createDispatchLauncher({
        env,
        spawnFn: failing((c) => c.emit("error", new Error("ENOENT"))),
        logDir: root,
      })(item()),
    ).rejects.toThrow(/failed to start: ENOENT/);
    await expect(
      createDispatchLauncher({
        env,
        spawnFn: failing((c) => c.emit("exit", 3)),
        logDir: root,
      })(item()),
    ).rejects.toThrow(/code 3/);
  });

  it("rejects when config or the project is missing, without spawning", async () => {
    const { root, env } = fixture();
    const spawnFn = vi.fn() as unknown as SpawnFn;
    await expect(
      createDispatchLauncher({ env: { ...env, PYRGOS_DISPATCH_CMD: "" }, spawnFn })(item()),
    ).rejects.toThrow(/PYRGOS_DISPATCH_CMD/);
    await expect(
      createDispatchLauncher({ env, spawnFn, logDir: root })(item({ project: "nope" })),
    ).rejects.toThrow(/project folder not found/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("only resolves a single plain folder name", () => {
    const { root } = fixture();
    expect(resolveProjectDir(root, "demo")).toBe(join(root, "Professional", "demo"));
    for (const bad of ["../demo", "a/b", ".hidden", "", "demo;rm"]) {
      expect(resolveProjectDir(root, bad)).toBeNull();
    }
  });
});

describe("resolveProjectDir: reviewer inputs", () => {
  it("rejects a symlink named demo that points outside the workshop", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-"));
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    mkdirSync(join(root, "Professional"), { recursive: true });
    symlinkSync(outside, join(root, "Professional", "demo"));
    expect(resolveProjectDir(root, "demo")).toBeNull();
  });
  it("rejects a file named demo", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-"));
    mkdirSync(join(root, "Professional"), { recursive: true });
    writeFileSync(join(root, "Professional", "demo"), "x");
    expect(resolveProjectDir(root, "demo")).toBeNull();
  });
  it("returns null when two groups contain demo", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-"));
    mkdirSync(join(root, "Professional", "demo"), { recursive: true });
    mkdirSync(join(root, "Personal", "demo"), { recursive: true });
    expect(resolveProjectDir(root, "demo")).toBeNull();
  });
});

describe("dispatch launcher: extra args", () => {
  it("drops PowerShell cwd and ticket flags from extras regardless of case", async () => {
    const { root, env } = fixture();
    const spawnFn = vi.fn(() => fakeChild()) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
    await createDispatchLauncher({
      env: {
        ...env,
        PYRGOS_DISPATCH_CMD: "C:\\harness\\dispatch.ps1",
        PYRGOS_DISPATCH_EXTRA_ARGS:
          "-DryRun -cWd C:\\outside -TICKET MIC-99 -CWD=C:\\other -ticket=MIC-98 -Test none",
      },
      spawnFn,
      settleMs: 5,
      logDir: root,
    })(item());
    const [, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(args.slice(7)).toEqual([
      "-Cwd",
      join(root, "Professional", "demo"),
      "-Ticket",
      "MIC-12",
      "-DryRun",
      "-Test",
      "none",
    ]);
  });

  it("never lets PYRGOS_DISPATCH_EXTRA_ARGS override --cwd or --ticket", async () => {
    const { root, env } = fixture();
    const spawnFn = vi.fn(() => fakeChild()) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
    const launch = createDispatchLauncher({
      env: {
        ...env,
        PYRGOS_DISPATCH_EXTRA_ARGS: "--dry-run --cwd /tmp/outside --cwd=/tmp/o2 --ticket MIC-99",
      },
      spawnFn,
      settleMs: 5,
      logDir: root,
    });
    await launch(item());
    const [, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(args).not.toContain("/tmp/outside");
    expect(args.join(" ")).not.toContain("/tmp/o2");
    expect(args).not.toContain("MIC-99");
    expect(args).toContain("--dry-run");
    expect(args.slice(3, 7)).toEqual([
      "--cwd",
      join(root, "Professional", "demo"),
      "--ticket",
      "MIC-12",
    ]);
    expect(args.filter((a) => a === "--cwd")).toHaveLength(1);
  });
});

describe("dispatch launcher: malformed reserved flag", () => {
  it.each(["--cwd --dry-run", "--ticket", "--dry-run --cwd"])(
    "rejects PYRGOS_DISPATCH_EXTRA_ARGS=%s without spawning",
    async (extra) => {
      const { root, env } = fixture();
      const spawnFn = vi.fn(() => fakeChild()) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
      const launch = createDispatchLauncher({
        env: { ...env, PYRGOS_DISPATCH_EXTRA_ARGS: extra },
        spawnFn,
        settleMs: 5,
        logDir: root,
      });
      await expect(launch(item())).rejects.toThrow("needs a value");
      expect(spawnFn).not.toHaveBeenCalled();
    },
  );
});

describe("dispatch launcher: end-of-options marker", () => {
  it("drops a bare -- from PYRGOS_DISPATCH_EXTRA_ARGS so --cwd stays an option", async () => {
    const { root, env } = fixture();
    const spawnFn = vi.fn(() => fakeChild()) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
    const launch = createDispatchLauncher({
      env: { ...env, PYRGOS_DISPATCH_EXTRA_ARGS: "--" },
      spawnFn,
      settleMs: 5,
      logDir: root,
    });
    await launch(item());
    const [, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(args).not.toContain("--");
  });
});

describe("dispatch launcher: fixed flags first", () => {
  it("keeps --cwd and --ticket ahead of extra args that take a value", async () => {
    const { root, env } = fixture();
    const spawnFn = vi.fn(() => fakeChild()) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
    const launch = createDispatchLauncher({
      env: { ...env, PYRGOS_DISPATCH_EXTRA_ARGS: "--test" },
      spawnFn,
      settleMs: 5,
      logDir: root,
    });
    await launch(item());
    const [, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(args.slice(3)).toEqual([
      "--cwd",
      join(root, "Professional", "demo"),
      "--ticket",
      "MIC-12",
      "--test",
    ]);
  });
});
