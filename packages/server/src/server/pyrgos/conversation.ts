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
import { createAnnouncer, createVoiceSession } from "./ledger/feed.js";
import { createJsonlLedgerStore, ledgerFilePath, voiceFeedDir } from "./ledger/jsonl-store.js";
import { createLedger, type Ledger } from "./ledger/ledger.js";
import { createDispatchLauncher } from "./launcher.js";

/** Appended to the voice prompt: how a spoken request becomes an action item. */
export const LEDGER_PROMPT =
  " When Michael asks for work to be done, keep an action item: call propose_action, then ask for " +
  "whatever is missing (scope, which project folder, and how we will know it is done) and call " +
  "refine_action as he answers. When all three are filled, read the whole item back in one or two " +
  "sentences and ask whether to go ahead. Only after he says yes in his next message, call " +
  "agree_action; the system refuses it otherwise. If he changes his mind, call drop_action. Never " +
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
}

export interface PyrgosConversation {
  readonly ledger: Ledger;
  readonly sessionId: string;
  handleTranscript(text: string): Promise<void>;
  bargeIn(): Promise<void>;
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

  return {
    ledger,
    sessionId,
    async handleTranscript(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      turn += 1;
      latestText = trimmed;
      try {
        const line = await feed.append("user", trimmed);
        latestRef = `${feed.path}#${line}`;
      } catch {
        latestRef = null;
      }
      await agent.handleTranscript(trimmed);
    },
    bargeIn: () => agent.bargeIn(),
    close: () => agent.close(),
  };
}
