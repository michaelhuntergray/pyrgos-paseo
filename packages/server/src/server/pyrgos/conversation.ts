import { randomUUID } from "node:crypto";
import {
  ConversationAgent,
  SdkBrain,
  VOICE_BRAIN_PROMPT,
  buildContext,
  createHarnessTools,
  parseModelFlag,
  type Brain,
  type ConversationEvent,
  type PaseoAgentsPort,
  type ToolDef,
} from "./conversation-agent/index.js";
import { createLedgerTools } from "./conversation-agent/ledger-tools.js";
import {
  ReplyPump,
  ReplyWatcher,
  TurnGate,
  createAnnouncer,
  createVoiceSession,
} from "./ledger/feed.js";
import { createJsonlLedgerStore, ledgerFilePath, voiceFeedDir } from "./ledger/jsonl-store.js";
import { createLedger, type Ledger } from "./ledger/ledger.js";
import { createDispatchLauncher } from "./launcher.js";

/** Appended to the voice prompt: how a spoken request becomes an action item. */
export const LEDGER_PROMPT =
  " When the user asks for work to be done, keep an action item: call propose_action, then ask for " +
  "whatever is missing (scope, which project folder, and how we will know it is done) and call " +
  "refine_action as he answers. When all three are filled, read the whole item back in one or two " +
  "sentences and ask whether to go ahead. Only after they say yes in their next message, call " +
  "agree_action; the system refuses it otherwise. If they change their mind, call drop_action. Never " +
  "say work has started unless agree_action succeeded.";

export interface PyrgosConversationOptions {
  env?: NodeJS.ProcessEnv;
  onEvent: (event: ConversationEvent) => void;
  /** Running Paseo agents, for the read-only agent tools. */
  agents?: PaseoAgentsPort;
  /** Test seam: replaces the SDK brain. Receives the ledger tools' ToolDefs source for wiring. */
  brainFactory?: (ctx: { ledger: Ledger; tools: ToolDef[] }) => Brain;
  sessionId?: string;
  /** Test seam for the dispatch launcher. */
  launch?: Parameters<typeof createLedger>[0]["launch"];
  announce?: Parameters<typeof createLedger>[0]["announce"];
  /**
   * Speaks an overseer reply; true once it was heard to the end. When set, replies the overseer
   * writes to this session's replies file are spoken at turn boundaries.
   */
  speakReply?: (line: string) => Promise<boolean>;
  /** How often to look for overseer replies; 0 turns the timer off (tests pump by hand). */
  replyPollMs?: number;
  /** Test seam for the turn gate's hold window. */
  clock?: () => number;
}

export const REPLY_POLL_MS = 2000;

export interface PyrgosConversation {
  readonly ledger: Ledger;
  readonly sessionId: string;
  handleTranscript(text: string): Promise<void>;
  bargeIn(): Promise<void>;
  /** The user stopped talking: replies wait out the hold window from here. */
  speechStopped(): void;
  /** Speak any overseer replies the turn gate allows now; returns the ones heard. */
  pumpReplies(): Promise<string[]>;
  close(): Promise<void>;
}

/** Voice conversation for one daemon voice session: transcript in, speak events out, ledger inside. */
export async function createPyrgosConversation(
  options: PyrgosConversationOptions,
): Promise<PyrgosConversation> {
  const env = options.env ?? process.env;
  const sessionId = options.sessionId ?? `voice-${randomUUID().slice(0, 8)}`;
  const dir = voiceFeedDir(env);
  const feed = createVoiceSession({ dir, session: sessionId });
  const ledger = createLedger({
    store: createJsonlLedgerStore(ledgerFilePath({ dir, session: sessionId })),
    announce: options.announce ?? createAnnouncer({ session: feed, env }),
    launch: options.launch ?? createDispatchLauncher({ env }),
  });

  let turn = 0;
  let latestTicket = 0;
  let latestText = "";
  let latestRef: string | null = null;
  const model = parseModelFlag(env.PYRGOS_CONVERSATION_MODEL);
  const harnessRoot = env.ALCHEMIST_HARNESS;

  const tools = [
    ...createHarnessTools({
      harnessRoot,
      workshopRoot: env.ALCHEMIST_WORKSHOP,
      agents: options.agents,
    }),
    ...createLedgerTools({
      ledger,
      latestUserText: () => latestText,
      turn: () => turn,
      transcriptRef: () => latestRef,
    }),
  ];
  const brain: Brain =
    options.brainFactory?.({ ledger, tools }) ??
    new SdkBrain({
      model,
      tools,
      systemPrompt: VOICE_BRAIN_PROMPT + LEDGER_PROMPT,
      context: await buildContext(harnessRoot).catch(() => undefined),
    });

  const gate = new TurnGate(options.clock);
  const speakReply = options.speakReply;
  const replies = speakReply
    ? new ReplyPump({
        watcher: new ReplyWatcher(feed.repliesPath),
        gate,
        session: feed,
        speak: speakReply,
      })
    : null;
  const pumpReplies = (): Promise<string[]> =>
    replies ? replies.pump().catch(() => []) : Promise.resolve([]);

  const spoken: string[] = [];
  const agent = new ConversationAgent({
    brain,
    model,
    onEvent: (event) => {
      if (event.type === "assistant_chunk") spoken.push(event.text);
      if (event.type === "turn_end" || event.type === "interrupted") {
        const text = spoken.splice(0).join("").trim();
        if (text) void feed.append("assistant", text).catch(() => undefined);
      }
      options.onEvent(event);
    },
  });

  const pollMs = options.replyPollMs ?? REPLY_POLL_MS;
  const timer = replies && pollMs > 0 ? setInterval(() => void pumpReplies(), pollMs) : null;
  timer?.unref?.();

  function userStopped(): void {
    gate.set("user", false);
    gate.hold();
  }

  // One turn at a time: handleTranscript awaits the old turn's settle before the next runTurn.
  async function runTurn(text: string): Promise<void> {
    gate.set("llm", true);
    try {
      await agent.handleTranscript(text);
    } finally {
      gate.set("llm", false);
    }
    // A turn boundary: let a waiting overseer reply in.
    void pumpReplies();
  }

  return {
    ledger,
    sessionId,
    async handleTranscript(text) {
      const trimmed = text.trim();
      // A transcript means an utterance ended, even one whose VAD events this conversation missed
      // (it starts on the first transcript): hold replies from here. It leaves the user flag alone:
      // the VAD stop always precedes transcription, so a set flag means a newer utterance is live.
      gate.hold();
      if (!trimmed) return;
      // Stop the running turn before this transcript becomes the consent text, so the old turn
      // cannot agree an item on the new turn's yes. Only the newest transcript goes on.
      const ticket = ++latestTicket;
      await agent.bargeIn();
      if (ticket !== latestTicket) return;
      turn += 1;
      latestText = trimmed;
      try {
        const line = await feed.append("user", trimmed);
        latestRef = `${feed.path}#${line}`;
      } catch {
        latestRef = null;
      }
      if (ticket !== latestTicket) return;
      await runTurn(trimmed);
    },
    bargeIn: () => {
      // The user started talking: no reply plays until they stop and stay quiet for the hold window.
      gate.set("user", true);
      gate.hold();
      return agent.bargeIn();
    },
    speechStopped: userStopped,
    pumpReplies,
    close: () => {
      if (timer) clearInterval(timer);
      return agent.close();
    },
  };
}
