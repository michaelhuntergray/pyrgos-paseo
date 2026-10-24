import { describe, expect, it, vi } from "vitest";
import { createLedger, type LedgerItem } from "../ledger/ledger.js";
import { createLedgerTools, isAffirmative } from "./ledger-tools.js";

function setup() {
  const rows: LedgerItem[] = [];
  const launch = vi.fn(async () => {});
  const ledger = createLedger({
    store: { append: (i) => void rows.push(i), load: () => rows },
    launch,
  });
  let text = "";
  let turn = 1;
  const tools = new Map(
    createLedgerTools({ ledger, latestUserText: () => text, turn: () => turn }).map((t) => [
      t.name,
      t,
    ]),
  );
  return {
    ledger,
    launch,
    run: (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args),
    say: (t: string) => {
      text = t;
      turn += 1;
    },
  };
}

describe("isAffirmative", () => {
  it.each(["yes", "Yeah, go ahead", "do it", "yes please do"])("accepts %s", (t) => {
    expect(isAffirmative(t)).toBe(true);
  });
  it.each(["no", "yes but wait", "not yet", "tell me more", "don't do it", ""])(
    "rejects %s",
    (t) => {
      expect(isAffirmative(t)).toBe(false);
    },
  );
});

describe("ledger tools", () => {
  it("agree needs a yes in the latest message and an item read back in an earlier turn", async () => {
    const t = setup();
    t.say("yes, sketch it");
    const out = await t.run("propose_action", { item: "ship it" });
    const id = /id (\S+)/.exec(out)![1]!;
    await t.run("refine_action", { id, scope: "s", project: "p", doneCriteria: "d" });

    expect(await t.run("agree_action", { id })).toContain("not heard this item read back");

    t.say("what is the weather");
    expect(await t.run("agree_action", { id })).toContain("has not said yes");
    expect(t.launch).not.toHaveBeenCalled();

    t.say("yes go ahead");
    expect(await t.run("agree_action", { id })).toContain("Agreed and handed");
    expect(t.launch).toHaveBeenCalledTimes(1);
  });

  it("returns ledger errors as text the brain can speak, and lists open items", async () => {
    const t = setup();
    const id = /id (\S+)/.exec(await t.run("propose_action", { item: "x" }))![1]!;
    t.say("yes");
    expect(await t.run("agree_action", { id })).toContain("Not done");
    expect(await t.run("list_actions", {})).toContain(id);
    await t.run("drop_action", { id, reason: "changed mind" });
    expect(await t.run("list_actions", {})).toBe("No open action items.");
    expect(await t.run("refine_action", { id: "missing", scope: "s" })).toContain("Not done");
  });
});

describe("isAffirmative: reviewer inputs", () => {
  it.each(["I never said yes", "I didn't say yes", "she said yes to something else"])(
    "rejects %s",
    (t) => {
      expect(isAffirmative(t)).toBe(false);
    },
  );
  it.each(["okay, yes", "Well yes please"])("accepts %s", (t) => {
    expect(isAffirmative(t)).toBe(true);
  });
});

describe("isAffirmative: reviewer inputs", () => {
  it.each(["Yes, after I review it", "yes if the tests pass", "yeah but only on Friday"])(
    "rejects a conditional yes: %s",
    (t) => {
      expect(isAffirmative(t)).toBe(false);
    },
  );
  it.each(["yes please", "Okay, yes, go ahead.", "yes thanks"])("still accepts %s", (t) => {
    expect(isAffirmative(t)).toBe(true);
  });
});

describe("agree_action needs a plain yes", () => {
  it.each(["do it", "go ahead", "make it so"])("refuses %s on a refined item", async (said) => {
    const t = setup();
    const id = /id (\S+)/.exec(await t.run("propose_action", { item: "ship it" }))![1]!;
    await t.run("refine_action", { id, scope: "s", project: "p", doneCriteria: "d" });
    t.say(said);
    expect(await t.run("agree_action", { id })).toContain("has not said yes");
    expect(t.launch).not.toHaveBeenCalled();
  });
});

describe("agree_action refuses a yes that names something else", () => {
  it("refuses 'Yes, to the other proposal.'", async () => {
    const t = setup();
    const id = /id (\S+)/.exec(await t.run("propose_action", { item: "ship it" }))![1]!;
    await t.run("refine_action", { id, scope: "s", project: "p", doneCriteria: "d" });
    t.say("Yes, to the other proposal.");
    expect(await t.run("agree_action", { id })).toContain("has not said yes");
    expect(t.launch).not.toHaveBeenCalled();
  });
});
