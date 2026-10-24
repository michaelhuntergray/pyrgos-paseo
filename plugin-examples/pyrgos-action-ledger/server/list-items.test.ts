import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listActionItems } from "./list-items";

const row = JSON.stringify({
  id: "a1",
  state: "draft",
  item: "Write the digest",
  scope: null,
  project: null,
  doneCriteria: null,
  transcriptRef: null,
  launchError: null,
  dropReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("listActionItems read errors", () => {
  let dir: string;
  let saved: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ledger-items-"));
    saved = process.env.PYRGOS_LEDGER_FILE;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.PYRGOS_LEDGER_FILE;
    else process.env.PYRGOS_LEDGER_FILE = saved;
    await rm(dir, { recursive: true, force: true });
  });

  it("yields no items when the ledger file does not exist (ENOENT)", async () => {
    process.env.PYRGOS_LEDGER_FILE = join(dir, "missing.ledger.jsonl");
    await expect(listActionItems()).resolves.toEqual({ session: "missing", items: [] });
  });

  it("reads items from an existing ledger file", async () => {
    const file = join(dir, "s1.ledger.jsonl");
    await writeFile(file, `${row}\n`);
    process.env.PYRGOS_LEDGER_FILE = file;
    const result = await listActionItems();
    expect(result.session).toBe("s1");
    expect(result.items.map((i) => i.id)).toEqual(["a1"]);
  });

  it("surfaces read errors other than ENOENT (EISDIR)", async () => {
    const asDir = join(dir, "bad.ledger.jsonl");
    await mkdir(asDir);
    process.env.PYRGOS_LEDGER_FILE = asDir;
    await expect(listActionItems()).rejects.toMatchObject({ code: "EISDIR" });
  });

  // Windows reports ENOENT when a path descends through a regular file.
  it.skipIf(process.platform === "win32")(
    "surfaces ENOTDIR instead of treating it as an empty ledger",
    async () => {
      const plain = join(dir, "plain");
      await writeFile(plain, "x");
      process.env.PYRGOS_LEDGER_FILE = join(plain, "child.ledger.jsonl");
      await expect(listActionItems()).rejects.toMatchObject({ code: "ENOTDIR" });
    },
  );
});
