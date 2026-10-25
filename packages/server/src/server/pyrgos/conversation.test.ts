import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Brain, BrainEvent, ConversationEvent, ToolDef } from "./conversation-agent/index.js";
import { createPyrgosConversation } from "./conversation.js";
import { HOLD_SECONDS } from "./ledger/feed.js";
import type { LedgerItem } from "./ledger/ledger.js";

type Step = (tools: Map<string, ToolDef>) => Promise<string>;

/** A brain that runs scripted tool calls per turn, the way the SDK brain would. */
function scriptedBrain(tools: ToolDef[], turns: Step[][], reply = "ok."): Brain {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const pending = [...turns];
  return {
    async *runTurn(): AsyncGenerator<BrainEvent> {
      for (const step of pending.shift() ?? []) {
        yield { type: "tool_use", name: "x" };
        await step(byName);
        yield { type: "tool_result" };
      }
      yield { type: "text", text: reply };
    },
    async interrupt() {},
    async close() {},
  };
}

const call = (name: string, args: Record<string, unknown>) => (tools: Map<string, ToolDef>) =>
  tools.get(name)!.run(args);

function setup(turns: (idHolder: { id: string }) => Step[][], launch = vi.fn(async () => {})) {
  const root = mkdtempSync(join(tmpdir(), "conv-"));
  const inbox = join(root, "inbox.md");
  mkdirSync(join(root, ".agents/feedback/voice"), { recursive: true });
  const events: ConversationEvent[] = [];
  const holder = { id: "" };
  const results: string[] = [];
  const track =
    (step: Step): Step =>
    async (t) => {
      const out = await step(t);
      results.push(out);
      const m = /id ([0-9a-f-]{8,})/.exec(out);
      if (m && !holder.id) holder.id = m[1];
      return out;
    };
  const conversation = createPyrgosConversation({
    env: { ALCHEMIST_HARNESS: root, VOICE_OVERSEER_SURFACE: "" },
    onEvent: (e) => events.push(e),
    launch,
    announce: async (item: LedgerItem) => {
      appendFileSync(inbox, `[voice] ACTION: ${item.item}\n`);
    },
    brainFactory: ({ tools }) => ({
      ...scriptedBrain(
        tools,
        turns(holder).map((steps) => steps.map(track)),
        "Okay.",
      ),
    }),
  });
  return { conversation, events, launch, inbox, holder, results };
}

describe("conversation: spoken request to launched item", () => {
  it("proposes, refines, reads back, and launches only after a yes in a later turn", async () => {
    const launch = vi.fn(async () => {});
    const s = setup(
      (holder) => [
        [call("propose_action", { item: "Add a README line" })],
        [
          (t) =>
            call("refine_action", {
              id: holder.id,
              scope: "README.md only",
              project: "pyrgos-paseo",
              doneCriteria: "one line added",
            })(t),
        ],
        [(t) => call("agree_action", { id: holder.id })(t)],
      ],
      launch,
    );
    const conv = await s.conversation;
    await conv.handleTranscript("please add a readme line");
    expect(conv.ledger.list()).toHaveLength(1);
    await conv.handleTranscript(
      "scope readme only, project pyrgos-paseo, done when one line is added",
    );
    expect(conv.ledger.list()[0]?.state).toBe("refined");
    await conv.handleTranscript("yes go ahead");
    const item = conv.ledger.list()[0]!;
    expect(item.state).toBe("agreed");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(readFileSync(s.inbox, "utf8")).toContain("[voice] ACTION: Add a README line");
    expect(item.transcriptRef).toMatch(/#1$/);
    expect(s.events.some((e) => e.type === "speak" && e.kind === "reply")).toBe(true);
    await conv.close();
  });

  it("refuses to agree when the same turn changed the item, or the user did not say yes", async () => {
    const launch = vi.fn(async () => {});
    const s = setup(
      (holder) => [
        [
          call("propose_action", { item: "Delete nothing" }),
          (t) =>
            call("refine_action", {
              id: holder.id,
              scope: "s",
              project: "p",
              doneCriteria: "d",
            })(t),
          (t) => call("agree_action", { id: holder.id })(t),
        ],
        [(t) => call("agree_action", { id: holder.id })(t)],
      ],
      launch,
    );
    const conv = await s.conversation;
    await conv.handleTranscript("yes do it");
    expect(conv.ledger.list()[0]?.state).toBe("refined");
    await conv.handleTranscript("hmm, tell me more");
    expect(conv.ledger.list()[0]?.state).toBe("refined");
    expect(launch).not.toHaveBeenCalled();
    expect(s.results.at(-1)).toContain("has not said yes");
    await conv.close();
  });

  it("records a launch failure on the item", async () => {
    const launch = vi.fn(async () => {
      throw new Error("dispatch exited with code 3");
    });
    const s = setup(
      (holder) => [
        [
          call("propose_action", { item: "x" }),
          (t) =>
            call("refine_action", { id: holder.id, scope: "s", project: "p", doneCriteria: "d" })(
              t,
            ),
        ],
        [(t) => call("agree_action", { id: holder.id })(t)],
      ],
      launch,
    );
    const conv = await s.conversation;
    await conv.handleTranscript("make it so");
    await conv.handleTranscript("yes");
    expect(conv.ledger.list()[0]?.launchError).toContain("dispatch exited with code 3");
    expect(s.results.at(-1)).toContain("launch failed");
    await conv.close();
  });
});

import { LEDGER_PROMPT } from "./conversation.js";

describe("conversation: reviewer inputs", () => {
  it("LEDGER_PROMPT carries no personal name", () => {
    expect(LEDGER_PROMPT).not.toMatch(/michael/i);
  });

  it("a turn cannot agree an item on the next turn's yes", async () => {
    const launch = vi.fn(async () => {});
    const root = mkdtempSync(join(tmpdir(), "conv-"));
    mkdirSync(join(root, ".agents/feedback/voice"), { recursive: true });
    let toolMap = new Map<string, ToolDef>();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let agreeResult = "";
    let turnNo = 0;
    const conversation = await createPyrgosConversation({
      env: { ALCHEMIST_HARNESS: root, VOICE_OVERSEER_SURFACE: "" },
      onEvent: () => {},
      launch,
      announce: async () => {},
      brainFactory: ({ tools }) => {
        toolMap = new Map(tools.map((t) => [t.name, t]));
        return {
          async *runTurn(): AsyncGenerator<BrainEvent> {
            const n = ++turnNo;
            if (n === 1) {
              const out = await toolMap.get("propose_action")!.run({ item: "x" });
              const id = /id ([0-9a-f-]{8,})/.exec(out)![1]!;
              await toolMap
                .get("refine_action")!
                .run({ id, scope: "s", project: "p", doneCriteria: "d" });
              (globalThis as { __id?: string }).__id = id;
            } else if (n === 2) {
              await gate;
              agreeResult = await toolMap
                .get("agree_action")!
                .run({ id: (globalThis as { __id?: string }).__id });
            }
            yield { type: "text", text: "ok." };
          },
          async interrupt() {
            release();
          },
          async close() {},
        };
      },
    });
    await conversation.handleTranscript("make a thing"); // turn 1: draft + refine
    // Turn 2 hangs on the gate; "yes" arrives while it runs.
    const pending = conversation.handleTranscript("what is the status");
    await new Promise((r) => setTimeout(r, 20));
    await conversation.handleTranscript("yes");
    await pending;
    expect(agreeResult).toMatch(/^Not done/);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("conversation: overseer replies reach the voice", () => {
  const quietBrain = (): Brain => ({
    async *runTurn(): AsyncGenerator<BrainEvent> {
      yield { type: "text", text: "Okay." };
    },
    async interrupt() {},
    async close() {},
  });

  async function withReplies(speakReply: (line: string) => Promise<boolean>) {
    const root = mkdtempSync(join(tmpdir(), "conv-replies-"));
    let now = 0;
    const conversation = await createPyrgosConversation({
      env: { ALCHEMIST_HARNESS: root, VOICE_OVERSEER_SURFACE: "" },
      onEvent: () => {},
      launch: vi.fn(async () => {}),
      announce: async () => {},
      brainFactory: () => quietBrain(),
      sessionId: "voice-replies",
      speakReply,
      clock: () => now,
      replyPollMs: 0,
    });
    const reply = (text: string) =>
      appendFileSync(
        join(root, ".agents/feedback/voice/voice-replies.replies.jsonl"),
        `${JSON.stringify({ text })}\n`,
      );
    return { conversation, reply, advance: (ms: number) => (now += ms) };
  }

  it("speaks a reply the overseer writes to the session's replies file", async () => {
    const speakReply = vi.fn(async () => true);
    const { conversation, reply } = await withReplies(speakReply);
    reply("PR merged");
    expect(await conversation.pumpReplies()).toEqual(["PR merged"]);
    expect(speakReply).toHaveBeenCalledWith("The overseer says: PR merged");
    await conversation.close();
  });

  it("holds replies after the user starts talking, and re-speaks one the user cut off", async () => {
    const speakReply = vi
      .fn<(line: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { conversation, reply, advance } = await withReplies(speakReply);
    reply("tests green");
    await conversation.bargeIn();
    conversation.speechStopped();
    expect(await conversation.pumpReplies()).toEqual([]);
    expect(speakReply).not.toHaveBeenCalled();
    advance(HOLD_SECONDS * 1000);
    expect(await conversation.pumpReplies()).toEqual([]);
    expect(speakReply).toHaveBeenCalledTimes(1);
    advance(HOLD_SECONDS * 1000);
    expect(await conversation.pumpReplies()).toEqual(["tests green"]);
    expect(speakReply).toHaveBeenCalledTimes(2);
    await conversation.close();
  });

  it("holds replies for as long as the user keeps talking, then for the hold window", async () => {
    const speakReply = vi.fn(async () => true);
    const { conversation, reply, advance } = await withReplies(speakReply);
    reply("deploy done");
    await conversation.bargeIn();
    advance(HOLD_SECONDS * 3000); // a long utterance outlives the hold window
    expect(await conversation.pumpReplies()).toEqual([]);
    conversation.speechStopped();
    expect(await conversation.pumpReplies()).toEqual([]);
    advance(HOLD_SECONDS * 1000);
    expect(await conversation.pumpReplies()).toEqual(["deploy done"]);
    await conversation.close();
  });

  it("does not speak a reply while a turn is running", async () => {
    const speakReply = vi.fn(async () => true);
    let release: (() => void) | undefined;
    const root = mkdtempSync(join(tmpdir(), "conv-replies-"));
    const conversation = await createPyrgosConversation({
      env: { ALCHEMIST_HARNESS: root, VOICE_OVERSEER_SURFACE: "" },
      onEvent: () => {},
      launch: vi.fn(async () => {}),
      announce: async () => {},
      sessionId: "voice-busy",
      speakReply,
      clock: () => 0,
      replyPollMs: 0,
      brainFactory: () => ({
        async *runTurn(): AsyncGenerator<BrainEvent> {
          await new Promise<void>((r) => (release = r));
          yield { type: "text", text: "Okay." };
        },
        async interrupt() {
          release?.();
        },
        async close() {},
      }),
    });
    appendFileSync(
      join(root, ".agents/feedback/voice/voice-busy.replies.jsonl"),
      `${JSON.stringify({ text: "later" })}\n`,
    );
    const turn = conversation.handleTranscript("what is running");
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await conversation.pumpReplies()).toEqual([]);
    expect(speakReply).not.toHaveBeenCalled();
    release?.();
    await turn;
    // The end of the turn is a boundary: the reply plays without waiting for the poll timer.
    await vi.waitFor(() => expect(speakReply).toHaveBeenCalledWith("The overseer says: later"));
    expect(await conversation.pumpReplies()).toEqual([]);
    expect(speakReply).toHaveBeenCalledTimes(1);
    await conversation.close();
  });
});
